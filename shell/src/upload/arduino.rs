//! Arduino CLI compile + flash wrapper (also handles ESP32 via arduino-cli +
//! pre-erase via esptool). Port of `src/upload/arduino.js`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::ansi;
use crate::paths::resolve_tool_binary;
use crate::serial;
use crate::upload::limits::{
    ESP32_DEFAULT_16MB_APP_BYTES, MAX_FLASH_PROGRAM_BYTES, WINDIFY_ESP32_16MB_APP_BYTES,
    WINDIFY_ESP32_16MB_PARTITIONS_CSV,
};
use crate::upload::{configure_killable, SendStd, UploadResult};

/// Map Rust target_os → the Node `os.platform()` key used in `config.fqbn`.
fn node_platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

pub struct Arduino {
    peripheral_path: String,
    config: Value,
    arduino_path: PathBuf,
    firmware_dir: PathBuf,
    config_file_path: PathBuf,
    arduino_cli_path: PathBuf,
    code_folder_path: PathBuf,
    code_file_path: PathBuf,
    build_path: PathBuf,
    build_cache_path: PathBuf,
    fqbn: String,
    abort: Arc<AtomicBool>,
}

impl Arduino {
    /// Constructor. Mirrors the JS constructor: derives all paths, resolves the
    /// platform fqbn, and runs `initArduinoCli`.
    pub fn new(
        peripheral_path: &str,
        mut config: Value,
        user_data_path: &Path,
        tools_path: &Path,
        sendstd: &mut SendStd,
    ) -> Self {
        let arduino_path = tools_path.join("Arduino");
        let firmware_dir = tools_path
            .join("..")
            .join("firmwares")
            .join("arduino");

        // Resolve per-platform fqbn object → string.
        let fqbn = match config.get("fqbn") {
            Some(Value::Object(map)) => map
                .get(node_platform_key())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        // Write the resolved string back so the rest of the logic sees a string.
        if let Some(obj) = config.as_object_mut() {
            obj.insert("fqbn".to_string(), Value::String(fqbn.clone()));
        }

        // projectPathName = `${fqbn.replace(:→_)}_project`.split('_')[0..3].join('_')
        let project_path_name = {
            let replaced = format!("{}_project", fqbn.replace(':', "_"));
            replaced
                .split('_')
                .take(3)
                .collect::<Vec<_>>()
                .join("_")
        };

        let config_file_path = user_data_path.join("arduino").join("arduino-cli.yaml");
        let project_file_path = user_data_path.join("arduino").join(&project_path_name);
        let arduino_cli_path = resolve_tool_binary(tools_path, "Arduino/arduino-cli");
        let code_folder_path = project_file_path.join("code");
        let code_file_path = code_folder_path.join("code.ino");
        let build_path = project_file_path.join("build");
        let build_cache_path = project_file_path.join("buildCache");

        let me = Self {
            peripheral_path: peripheral_path.to_string(),
            config,
            arduino_path,
            firmware_dir,
            config_file_path,
            arduino_cli_path,
            code_folder_path,
            code_file_path,
            build_path,
            build_cache_path,
            fqbn,
            abort: Arc::new(AtomicBool::new(false)),
        };
        me.init_arduino_cli(sendstd);
        me
    }

    pub fn abort_flag(&self) -> Arc<AtomicBool> {
        self.abort.clone()
    }

    pub fn peripheral_path(&self) -> &str {
        &self.peripheral_path
    }

    fn run_cli_sync(&self, args: &[&str]) {
        let mut cmd = std::process::Command::new(&self.arduino_cli_path);
        cmd.args(args);
        configure_killable(&mut cmd);
        let _ = cmd.output();
    }

    /// Port of `initArduinoCli`: config init/dump/set.
    fn init_arduino_cli(&self, sendstd: &mut SendStd) {
        if !self.arduino_cli_path.exists() {
            sendstd(
                &format!(
                    "{}arduino-cli not found: {}\n",
                    ansi::RED,
                    self.arduino_cli_path.display()
                ),
                None,
            );
            return;
        }
        let cfg = self.config_file_path.to_string_lossy().to_string();
        self.run_cli_sync(&["config", "init", "--dest-file", &cfg]);

        let out = std::process::Command::new(&self.arduino_cli_path)
            .args(["config", "dump", "--config-file", &cfg])
            .output();
        if let Ok(out) = out {
            let parsed: Value = serde_yaml::from_slice(&out.stdout).unwrap_or(Value::Null);
            let directories = parsed.get("directories");
            let data = directories.and_then(|d| d.get("data")).and_then(|v| v.as_str());
            let downloads = directories
                .and_then(|d| d.get("downloads"))
                .and_then(|v| v.as_str());
            let user = directories.and_then(|d| d.get("user")).and_then(|v| v.as_str());
            let arduino = self.arduino_path.to_string_lossy().to_string();
            let staging = self.arduino_path.join("staging").to_string_lossy().to_string();
            if data != Some(arduino.as_str())
                || downloads != Some(staging.as_str())
                || user != Some(arduino.as_str())
            {
                sendstd(
                    &format!("{}arduino cli config has not been initialized yet.\n", ansi::YELLOW_DARK),
                    None,
                );
                sendstd(
                    &format!("{}set the path to {}.\n", ansi::GREEN_DARK, arduino),
                    None,
                );
                self.run_cli_sync(&["config", "set", "directories.data", &arduino, "--config-file", &cfg]);
                self.run_cli_sync(&["config", "set", "directories.downloads", &staging, "--config-file", &cfg]);
                self.run_cli_sync(&["config", "set", "directories.user", &arduino, "--config-file", &cfg]);
            }
        }
    }

    /// Port of `abortUpload`. The session normally drives aborts through the
    /// shared abort flag returned by `abort_flag()`, but this mirrors the JS API.
    #[allow(dead_code)]
    pub fn abort_upload(&self) {
        self.abort.store(true, Ordering::Relaxed);
    }

    // ── source transforms / parsing ──────────────────────────────────────

    fn is_esp32_target(&self) -> bool {
        self.fqbn.to_lowercase().starts_with("esp32:")
    }

    fn fqbn_has_16m_flash(&self) -> bool {
        self.fqbn.to_lowercase().contains("flashsize=16m")
    }

    /// Port of `_parseUploadSketchPayload`. Returns (main, extra_files).
    fn parse_upload_sketch_payload(raw: &str) -> (String, BTreeMap<String, String>) {
        let trimmed = raw.trim_start();
        if trimmed.starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
                let is_v1 = parsed.get("v").and_then(|v| v.as_i64()) == Some(1);
                let main = parsed.get("main").and_then(|v| v.as_str());
                let files = parsed.get("files").and_then(|v| v.as_object());
                if is_v1 {
                    if let (Some(main), Some(files)) = (main, files) {
                        let mut extra = BTreeMap::new();
                        for (k, v) in files {
                            if let Some(s) = v.as_str() {
                                extra.insert(k.clone(), s.to_string());
                            }
                        }
                        return (main.to_string(), extra);
                    }
                }
            }
        }
        (raw.to_string(), BTreeMap::new())
    }

    /// Port of `_applySourceTransforms`.
    fn apply_source_transforms(&self, code: &str) -> String {
        let transforms = match self.config.get("sourceTransforms").and_then(|v| v.as_array()) {
            Some(t) => t,
            None => return code.to_string(),
        };
        let mut out = code.to_string();
        for t in transforms {
            if t.get("type").and_then(|v| v.as_str()) != Some("replace") {
                continue;
            }
            let find = t.get("find").and_then(|v| v.as_str());
            let replace = t.get("replace").and_then(|v| v.as_str());
            if let (Some(find), Some(replace)) = (find, replace) {
                out = out.replace(find, replace);
            }
        }
        out
    }

    /// Port of `_extractWindifyExtraSketchFiles`.
    fn extract_windify_extra_sketch_files(code: &str) -> (String, BTreeMap<String, String>) {
        const START_PREFIX: &str = "// WINDIFY_EXTRA_SKETCH_FILE:";
        const END_MARKER: &str = "// END_WINDIFY_EXTRA_SKETCH_FILE";
        let mut extra = BTreeMap::new();
        if code.is_empty() {
            return (code.to_string(), extra);
        }
        let lines: Vec<&str> = code.split('\n').map(|l| l.trim_end_matches('\r')).collect();
        let mut main_lines: Vec<String> = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            if let Some(rest) = line.strip_prefix(START_PREFIX) {
                let file_name = rest.trim().to_string();
                let mut body = Vec::new();
                i += 1;
                while i < lines.len() && lines[i] != END_MARKER {
                    body.push(lines[i].to_string());
                    i += 1;
                }
                if i < lines.len() {
                    i += 1;
                }
                if !file_name.is_empty() {
                    extra.insert(file_name, format!("{}\n", body.join("\n")));
                }
                continue;
            }
            main_lines.push(line.to_string());
            i += 1;
        }
        (main_lines.join("\n"), extra)
    }

    fn has_windify_audio_clip_files(extra: &BTreeMap<String, String>) -> bool {
        extra
            .keys()
            .any(|n| n.starts_with("windify_audio_clip_") && n.ends_with(".cpp"))
    }

    /// Port of `_sanitizeSketchSource` (the 6+ digit numeric prefix strip + the
    /// Adafruit_AHTX0 missing-include strip).
    fn sanitize_sketch_source(&self, code: &str, sendstd: &mut SendStd) -> String {
        if code.is_empty() {
            return code.to_string();
        }
        let mut out = String::with_capacity(code.len());
        let directives = [
            "include", "define", "if", "ifdef", "ifndef", "elif", "else", "endif", "pragma",
        ];
        for line in code.split_inclusive('\n') {
            let raw = line;
            let trimmed = raw.trim_start();
            // detect: <6+ digits> optional ws then #directive
            let bytes = trimmed.as_bytes();
            let mut digit_count = 0;
            while digit_count < bytes.len() && bytes[digit_count].is_ascii_digit() {
                digit_count += 1;
            }
            if digit_count >= 6 {
                let after = trimmed[digit_count..].trim_start();
                if after.starts_with('#')
                    && directives
                        .iter()
                        .any(|d| after[1..].trim_start().starts_with(d))
                {
                    let leading_ws = &raw[..raw.len() - trimmed.len()];
                    sendstd(
                        &format!(
                            "{}[build] sanitized corrupted preprocessor line: {}\n",
                            ansi::YELLOW_DARK,
                            raw.trim()
                        ),
                        None,
                    );
                    out.push_str(leading_ws);
                    out.push_str(after);
                    continue;
                }
            }
            out.push_str(raw);
        }

        if out.contains("#include <Adafruit_AHTX0.h>")
            && !self.has_header_in_known_libraries("Adafruit_AHTX0.h")
        {
            let mut filtered = String::with_capacity(out.len());
            for line in out.split_inclusive('\n') {
                let t = line.trim_start();
                if t.starts_with("#include <Adafruit_AHTX0.h>") {
                    continue;
                }
                filtered.push_str(line);
            }
            out = filtered;
            sendstd(
                &format!(
                    "{}[build] strip missing include: <Adafruit_AHTX0.h> (library not found)\n",
                    ansi::YELLOW_DARK
                ),
                None,
            );
        }
        out
    }

    fn library_has_header(lib_dir: &Path, header: &str) -> bool {
        lib_dir.join(header).exists()
            || lib_dir.join("src").join(header).exists()
            || lib_dir.join("include").join(header).exists()
    }

    fn has_header_in_known_libraries(&self, header: &str) -> bool {
        let libs_root = self.arduino_path.join("libraries");
        if let Ok(entries) = fs::read_dir(&libs_root) {
            for e in entries.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() && Self::library_has_header(&p, header) {
                    return true;
                }
            }
        }
        false
    }

    /// Port of `_discoverManualLibraryPaths` + `_isArduinoLibraryDir`.
    fn discover_manual_library_paths(&self) -> Vec<PathBuf> {
        let libs_root = self.arduino_path.join("libraries");
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(&libs_root) {
            for e in entries.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() && Self::is_arduino_library_dir(&p) {
                    out.push(p);
                }
            }
        }
        out.sort();
        out
    }

    fn dir_has_header_or_source(dir: &Path) -> bool {
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.filter_map(|e| e.ok()) {
                if let Some(name) = e.file_name().to_str() {
                    if Self::is_source_header(name) {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn is_source_header(name: &str) -> bool {
        let lower = name.to_lowercase();
        [".h", ".hpp", ".hh", ".c", ".cc", ".cpp", ".cxx"]
            .iter()
            .any(|ext| lower.ends_with(ext))
    }

    fn is_arduino_library_dir(dir: &Path) -> bool {
        if dir.join("library.properties").exists() {
            return true;
        }
        if Self::dir_has_header_or_source(&dir.join("src"))
            || Self::dir_has_header_or_source(&dir.join("include"))
        {
            return true;
        }
        Self::dir_has_header_or_source(dir)
    }

    /// Port of `_ensureManualLibraryCompatHeaders`.
    fn ensure_manual_library_compat_headers(&self, lib_dirs: &[PathBuf], sendstd: &mut SendStd) {
        for dir in lib_dirs {
            let lib_name = match dir.file_name().and_then(|n| n.to_str()) {
                Some(n) if !n.is_empty() => n.to_string(),
                _ => continue,
            };
            let expected = format!("{}.h", lib_name);
            let src_header = dir.join("src").join(&expected);
            let include_header = dir.join("include").join(&expected);
            let root_header = dir.join(&expected);
            if src_header.exists() || include_header.exists() || root_header.exists() {
                continue;
            }
            let fallback = dir.join("include").join("wk_i2c.h");
            if !fallback.exists() {
                continue;
            }
            let src_dir = dir.join("src");
            if !src_dir.exists() && fs::create_dir_all(&src_dir).is_err() {
                continue;
            }
            let guard = format!(
                "__{}_H__",
                lib_name
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                    .collect::<String>()
            );
            let shim = format!(
                "/* Auto-generated compatibility header for Arduino resolver. */\n#ifndef {g}\n#define {g}\n#include \"../include/wk_i2c.h\"\n#endif\n",
                g = guard
            );
            if fs::write(&src_header, shim).is_ok() {
                sendstd(
                    &format!("{}[build] Generated compat header: {}\n", ansi::YELLOW_DARK, src_header.display()),
                    None,
                );
            }
        }
    }

    /// Port of `_buildCompileLibraryPaths` (ordered, deduped, existing only).
    fn build_compile_library_paths(&self) -> Vec<PathBuf> {
        let mut ordered = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let add = |p: &Path, ordered: &mut Vec<PathBuf>, seen: &mut std::collections::HashSet<PathBuf>| {
            if !p.exists() {
                return;
            }
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| p.to_path_buf())
            };
            if seen.insert(abs.clone()) {
                ordered.push(abs);
            }
        };
        for p in self.discover_manual_library_paths() {
            add(&p, &mut ordered, &mut seen);
        }
        if let Some(arr) = self.config.get("libraryOrder").and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    add(Path::new(s), &mut ordered, &mut seen);
                }
            }
        }
        if let Some(arr) = self.config.get("library").and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    add(Path::new(s), &mut ordered, &mut seen);
                }
            }
        }
        ordered
    }

    // ── fqbn option helpers (port of _withFqbnOption / _build16MCustomFqbn) ──

    fn with_fqbn_option(fqbn: &str, key: &str, value: &str) -> String {
        if fqbn.is_empty() {
            return fqbn.to_string();
        }
        let option = format!("{}={}", key, value);
        // Replace existing key=... (case-insensitive, stop at , or :)
        let lower = fqbn.to_lowercase();
        let key_lower = format!("{}=", key.to_lowercase());
        if let Some(pos) = lower.find(&key_lower) {
            let val_start = pos + key_lower.len();
            let mut val_end = val_start;
            let bytes = fqbn.as_bytes();
            while val_end < bytes.len() && bytes[val_end] != b',' && bytes[val_end] != b':' {
                val_end += 1;
            }
            let mut s = String::new();
            s.push_str(&fqbn[..pos]);
            s.push_str(&option);
            s.push_str(&fqbn[val_end..]);
            return s;
        }
        if fqbn.contains(':') && fqbn.split(':').count() >= 4 {
            format!("{},{}", fqbn, option)
        } else {
            format!("{}:{}", fqbn, option)
        }
    }

    fn build_16m_custom_fqbn(&self) -> String {
        let mut f = self.fqbn.clone();
        f = Self::with_fqbn_option(&f, "FlashSize", "16M");
        f = Self::with_fqbn_option(&f, "PartitionScheme", "custom");
        f
    }

    /// Port of `_buildCompileFqbn`.
    fn build_compile_fqbn(&self, has_windify_audio: bool) -> String {
        if !self.is_esp32_target() || (!has_windify_audio && !self.fqbn_has_16m_flash()) {
            return self.fqbn.clone();
        }
        if has_windify_audio {
            return self.build_16m_custom_fqbn();
        }
        Self::with_fqbn_option(&self.fqbn, "PartitionScheme", "custom")
    }

    /// Port of `_writeEsp32PartitionTable`.
    fn write_esp32_partition_table(&self, has_windify_audio: bool) -> Result<(), String> {
        let partition_path = self.code_folder_path.join("partitions.csv");
        if !self.is_esp32_target() || (!has_windify_audio && !self.fqbn_has_16m_flash()) {
            if partition_path.exists() {
                let _ = fs::remove_file(&partition_path);
            }
            return Ok(());
        }
        if has_windify_audio {
            fs::write(&partition_path, WINDIFY_ESP32_16MB_PARTITIONS_CSV).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if partition_path.exists() {
            let _ = fs::remove_file(&partition_path);
        }
        Ok(())
    }

    /// Build flash build-properties for ESP32 16M (returns the args to insert
    /// before the sketch path). Port of `_appendEsp32FlashBuildProperties`.
    fn esp32_flash_build_properties(
        &self,
        has_windify_audio: bool,
        sendstd: &mut SendStd,
    ) -> Vec<String> {
        if !self.is_esp32_target() || (!has_windify_audio && !self.fqbn_has_16m_flash()) {
            return Vec::new();
        }
        if has_windify_audio {
            return vec![
                "--build-property".into(),
                format!("upload.maximum_size={}", WINDIFY_ESP32_16MB_APP_BYTES),
            ];
        }
        sendstd(
            &format!("{}[build] Using 16 MB flash partition table (6.25 MB APP).\n", ansi::YELLOW_DARK),
            None,
        );
        vec![
            "--build-property".into(),
            "build.partitions=default_16MB".into(),
            "--build-property".into(),
            format!("upload.maximum_size={}", ESP32_DEFAULT_16MB_APP_BYTES),
        ]
    }

    fn cleanup_windify_audio_sketch_files(&self) {
        let dirs = [self.code_folder_path.clone(), self.build_path.join("sketch")];
        for dir in dirs {
            if let Ok(entries) = fs::read_dir(&dir) {
                for e in entries.filter_map(|e| e.ok()) {
                    if let Some(name) = e.file_name().to_str() {
                        if Self::is_windify_audio_clip_sketch_file(name) {
                            let _ = fs::remove_file(e.path());
                        }
                    }
                }
            }
        }
    }

    fn is_windify_audio_clip_sketch_file(name: &str) -> bool {
        name.starts_with("windify_audio_clip_")
            && (name.ends_with(".cpp")
                || name.ends_with(".c")
                || name.ends_with(".h")
                || name.ends_with(".cpp.d")
                || name.ends_with(".c.d"))
    }

    fn get_bundled_at32_ws2812b_library_path(&self) -> Option<PathBuf> {
        let p = self.arduino_path.join("libraries").join("WS2812B");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }

    fn flash_progress_from_text(text: &str) -> Option<f64> {
        // last NN% token
        let mut last: Option<i64> = None;
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                // walk back over optional whitespace then digits
                let mut j = i;
                while j > 0 && (bytes[j - 1] == b' ') {
                    j -= 1;
                }
                let mut k = j;
                while k > 0 && bytes[k - 1].is_ascii_digit() {
                    k -= 1;
                }
                if k < j {
                    if let Ok(n) = text[k..j].parse::<i64>() {
                        last = Some(n);
                    }
                }
            }
            i += 1;
        }
        last.map(|n| (n as f64 / 100.0).clamp(0.0, 1.0))
    }

    fn sketch_storage_error(log_text: &str) -> Option<String> {
        // Sketch uses (\d+) bytes (..%) of program storage space. Maximum is (\d+) bytes
        let marker = "Sketch uses ";
        let idx = log_text.find(marker)?;
        let after = &log_text[idx + marker.len()..];
        let used_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        let used: u64 = used_str.parse().ok()?;
        let max_marker = "Maximum is ";
        let midx = after.find(max_marker)?;
        let mafter = &after[midx + max_marker.len()..];
        let max_str: String = mafter.chars().take_while(|c| c.is_ascii_digit()).collect();
        let max: u64 = max_str.parse().ok()?;
        if used <= max {
            return None;
        }
        let used_mb = used as f64 / (1024.0 * 1024.0);
        let max_mb = max as f64 / (1024.0 * 1024.0);
        let flash_mb = MAX_FLASH_PROGRAM_BYTES / (1024 * 1024);
        Some(format!(
            "Sketch uses {:.2} MB of program storage; partition allows {:.2} MB ({} MB flash). Use a shorter or smaller audio file.",
            used_mb, max_mb, flash_mb
        ))
    }

    // ── build ────────────────────────────────────────────────────────────

    /// Port of `build(code)`. Resolves Success / Aborted, or Err(message).
    pub fn build(&self, code: &str, sendstd: &mut SendStd) -> Result<UploadResult, String> {
        if !self.code_folder_path.exists() {
            fs::create_dir_all(&self.code_folder_path).map_err(|e| e.to_string())?;
        }

        let discovered = self.discover_manual_library_paths();
        self.ensure_manual_library_compat_headers(&discovered, sendstd);

        let (sketch_main, payload_files) = Self::parse_upload_sketch_payload(code);
        let transformed = self.sanitize_sketch_source(&self.apply_source_transforms(&sketch_main), sendstd);
        let (main, marker_files) = Self::extract_windify_extra_sketch_files(&transformed);

        let mut extra_files = marker_files;
        for (k, v) in payload_files {
            extra_files.insert(k, v);
        }
        if main.contains("// WINDIFY_EXTRA_SKETCH_FILE:") {
            return Err(
                "Windify audio files were not extracted from the sketch. Restart WindyLink (npm run start in scratch-devices-link-lib) or update WindyLink.exe.".to_string(),
            );
        }
        let has_windify_audio = Self::has_windify_audio_clip_files(&extra_files);
        let has_at32_markers = main.contains("AT32_")
            || main.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|t| t.starts_with("at32"));

        self.cleanup_windify_audio_sketch_files();
        self.write_esp32_partition_table(has_windify_audio)?;
        for (file_name, body) in &extra_files {
            // safeName = basename(fileName); skip when it differs (path traversal guard).
            let safe = Path::new(file_name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if safe.is_empty() || safe != file_name {
                continue;
            }
            fs::write(self.code_folder_path.join(safe), body).map_err(|e| e.to_string())?;
            sendstd(&format!("Windify sketch file: {}\n", safe), None);
        }
        fs::write(&self.code_file_path, &main).map_err(|e| e.to_string())?;

        let compile_fqbn = self.build_compile_fqbn(has_windify_audio);
        let mut args: Vec<String> = vec![
            "compile".into(),
            "--fqbn".into(),
            compile_fqbn,
            "--warnings=none".into(),
            "--verbose".into(),
            "--build-path".into(),
            self.build_path.to_string_lossy().to_string(),
            "--build-cache-path".into(),
            self.build_cache_path.to_string_lossy().to_string(),
            "--config-file".into(),
            self.config_file_path.to_string_lossy().to_string(),
            self.code_folder_path.to_string_lossy().to_string(),
        ];

        // Inject libraries (matches JS splice(3, ...) order, reversed loop).
        let mut extra_libs: Vec<PathBuf> = self.build_compile_library_paths();
        if has_at32_markers {
            if let Some(ws) = self.get_bundled_at32_ws2812b_library_path() {
                if !extra_libs.contains(&ws) {
                    extra_libs.insert(0, ws.clone());
                    sendstd(&format!("Inject AT32 WS2812B library: {}\n", ws.display()), None);
                }
            }
        }
        for lib in extra_libs.iter().rev() {
            args.splice(3..3, ["--libraries".to_string(), lib.to_string_lossy().to_string()]);
            sendstd(&format!("Inject library: {}\n", lib.display()), None);
        }

        // sketchIdx = index of code folder path (recompute after splices).
        let sketch_path = self.code_folder_path.to_string_lossy().to_string();
        let sketch_idx = args.iter().position(|a| *a == sketch_path).unwrap_or(args.len());
        let flash_props = self.esp32_flash_build_properties(has_windify_audio, sendstd);
        if !flash_props.is_empty() {
            args.splice(sketch_idx..sketch_idx, flash_props);
        }

        if let Some(defines) = self.config.get("compilerDefines").and_then(|v| v.as_array()) {
            let flags: Vec<String> = defines
                .iter()
                .filter_map(|d| d.as_str())
                .map(|d| d.trim())
                .filter(|d| !d.is_empty())
                .map(|d| if d.starts_with("-D") { d.to_string() } else { format!("-D{}", d) })
                .collect();
            if !flags.is_empty() {
                let sketch_idx = args.iter().position(|a| *a == sketch_path).unwrap_or(args.len());
                args.splice(
                    sketch_idx..sketch_idx,
                    [
                        "--build-property".to_string(),
                        format!("compiler.cpp.extra_flags={}", flags.join(" ")),
                    ],
                );
            }
        }

        if !self.arduino_cli_path.exists() {
            return Err(format!("arduino-cli not found: {}", self.arduino_cli_path.display()));
        }

        sendstd("Start building...\n", None);
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let (code, build_log) = self.spawn_stream(&arg_refs, sendstd, true)?;

        sendstd(&format!("{}\r\n", ansi::CLEAR), None);
        match code {
            None => Ok(UploadResult::Aborted),
            Some(0) => Ok(UploadResult::Success),
            Some(1) => {
                if let Some(storage) = Self::sketch_storage_error(&build_log) {
                    Err(storage)
                } else {
                    Err("Build failed".to_string())
                }
            }
            Some(2) => Err("Sketch not found".to_string()),
            Some(3) => Err("Invalid (argument for) commandline optiond".to_string()),
            Some(4) => Err("Preference passed to --get-pref does not exist".to_string()),
            _ => Err("Unknown error".to_string()),
        }
    }

    /// Spawn arduino-cli, stream stdout/stderr through sendstd with progress and
    /// abort handling. Returns (exit_code, captured_log_tail).
    fn spawn_stream(
        &self,
        args: &[&str],
        sendstd: &mut SendStd,
        color_build: bool,
    ) -> Result<(Option<i32>, String), String> {
        let mut cmd = std::process::Command::new(&self.arduino_cli_path);
        cmd.args(args);
        if let Some(parent) = self.arduino_cli_path.parent() {
            cmd.current_dir(parent);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        configure_killable(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start {}: {}", self.arduino_cli_path.display(), e))?;

        let abort = self.abort.clone();
        let pid = child.id();
        let done = Arc::new(AtomicBool::new(false));
        let done2 = done.clone();
        let watcher = std::thread::spawn(move || loop {
            if done2.load(Ordering::Relaxed) {
                break;
            }
            if abort.load(Ordering::Relaxed) {
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/f", "/t"])
                        .status();
                }
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        });

        let mut build_log = String::new();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let data = format!("{}\n", line);
                Self::append_log(&mut build_log, &data);
                let prog = Self::flash_progress_from_text(&data);
                let painted = if color_build {
                    if data.contains("Sketch uses") || data.contains("Global variables") {
                        format!("{}{}", ansi::GREEN_DARK, data)
                    } else {
                        format!("{}{}", ansi::CLEAR, data)
                    }
                } else {
                    data.clone()
                };
                sendstd(&painted, prog);
            }
        }
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let data = format!("{}\n", line);
                Self::append_log(&mut build_log, &data);
                let prog = Self::flash_progress_from_text(&data);
                sendstd(&format!("{}{}", ansi::RED, data), prog);
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        done.store(true, Ordering::Relaxed);
        let _ = watcher.join();

        // killed process → exit code None (Aborted)
        let code = if self.abort.load(Ordering::Relaxed) {
            None
        } else {
            status.code()
        };
        Ok((code, build_log))
    }

    fn append_log(buf: &mut String, chunk: &str) {
        buf.push_str(chunk);
        if buf.len() > 256 * 1024 {
            let start = buf.len() - 256 * 1024;
            *buf = buf[start..].to_string();
        }
    }

    // ── flash ──────────────────────────────────────────────────────────────

    fn should_clear_firmware_before_upload(&self) -> bool {
        if !self.is_esp32_target() {
            return false;
        }
        if let Some(b) = self.config.get("clearFirmwareBeforeUpload").and_then(|v| v.as_bool()) {
            return b;
        }
        true
    }

    fn resolve_esp32_esptool_path(&self) -> PathBuf {
        let exe_name = if cfg!(windows) { "esptool.exe" } else { "esptool" };
        if let Some(explicit) = self.config.get("esptoolPath").and_then(|v| v.as_str()) {
            let p = PathBuf::from(explicit);
            if p.exists() {
                return p;
            }
        }
        let base_dir = self
            .arduino_path
            .join("packages")
            .join("esp32")
            .join("tools")
            .join("esptool_py");
        if let Ok(entries) = fs::read_dir(&base_dir) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            versions.reverse();
            for ver in versions {
                let candidate = ver.join(exe_name);
                if candidate.exists() {
                    return candidate;
                }
            }
        }
        PathBuf::from(exe_name)
    }

    fn is_serial_port_open_error(text: &str) -> bool {
        let lower = text.to_lowercase();
        ["could not open", "can't open", "cannot find the file specified", "no such file"]
            .iter()
            .any(|n| lower.contains(n))
            || (lower.contains("serial port ") && lower.contains(" not found"))
    }

    fn allowed_esp_vids(&self) -> Vec<String> {
        if let Some(arr) = self.config.get("espVendorIds").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(serial::normalize_usb_id)
                .collect()
        } else {
            vec!["303A".into(), "10C4".into(), "1A86".into()]
        }
    }

    /// Port of `_resolveEsp32PortAfterErase`.
    fn resolve_esp32_port_after_erase(&self, preferred: &str) -> Option<String> {
        let delay_ms = self
            .config
            .get("espPostErasePortDelayMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(if cfg!(target_os = "windows") { 1600 } else { 900 });
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        let ports = serial::list_devices().ok()?;
        if ports.is_empty() {
            return None;
        }
        let allowed = self.allowed_esp_vids();
        let pref_upper = preferred.to_uppercase();
        let pref_com = serial::com_num(preferred);
        let allow_low = self.config.get("allowLowComFallback").and_then(|v| v.as_bool()) == Some(true);

        let mut matching: Vec<(String, String)> = ports
            .iter()
            .filter(|p| !p.path.is_empty())
            .map(|p| (p.path.clone(), serial::normalize_usb_id(p.vendor_id.as_deref().unwrap_or(""))))
            .filter(|(_, vid)| !vid.is_empty() && allowed.contains(vid))
            .collect();
        if matching.is_empty() {
            return None;
        }
        if let Some((path, _)) = matching.iter().find(|(p, _)| p.to_uppercase() == pref_upper) {
            return Some(path.clone());
        }
        if cfg!(target_os = "windows") && !allow_low && pref_com > 3 {
            matching.retain(|(p, _)| serial::com_num(p) > 3);
        }
        if matching.is_empty() {
            return None;
        }
        Self::rank_ports(&mut matching, &allowed, pref_com);
        Some(matching[0].0.clone())
    }

    /// Port of `_resolveFallbackSerialPath`.
    fn resolve_fallback_serial_path(&self, current: &str) -> Option<String> {
        let delay_ms = self
            .config
            .get("espFallbackScanDelayMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(400);
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        let ports = serial::list_devices().ok()?;
        if ports.is_empty() {
            return None;
        }
        let normalized_current = current.to_uppercase();
        let allowed = self.allowed_esp_vids();
        let current_com = serial::com_num(current);
        let allow_low = self.config.get("allowLowComFallback").and_then(|v| v.as_bool()) == Some(true);

        let mut candidates: Vec<(String, String)> = ports
            .iter()
            .filter(|p| !p.path.is_empty())
            .filter(|p| p.path.to_uppercase() != normalized_current)
            .map(|p| (p.path.clone(), serial::normalize_usb_id(p.vendor_id.as_deref().unwrap_or(""))))
            .filter(|(path, _)| {
                if !cfg!(target_os = "windows") {
                    return true;
                }
                if allow_low {
                    return true;
                }
                let n = serial::com_num(path);
                if n <= 0 {
                    return true;
                }
                if current_com > 3 {
                    return n > 3;
                }
                true
            })
            .filter(|(_, vid)| !vid.is_empty() && allowed.contains(vid))
            .collect();
        if candidates.is_empty() {
            return None;
        }
        Self::rank_ports(&mut candidates, &allowed, current_com);
        Some(candidates[0].0.clone())
    }

    fn rank_ports(ports: &mut [(String, String)], allowed: &[String], pref_com: i64) {
        let vid_rank = |vid: &str| -> i64 {
            if vid == "303A" {
                4
            } else if vid == "10C4" || vid == "1A86" {
                3
            } else if allowed.iter().any(|a| a == vid) {
                2
            } else {
                0
            }
        };
        ports.sort_by(|a, b| {
            let r = vid_rank(&b.1).cmp(&vid_rank(&a.1));
            if r != std::cmp::Ordering::Equal {
                return r;
            }
            if pref_com > 0 {
                let da = (serial::com_num(&a.0) - pref_com).abs();
                let db = (serial::com_num(&b.0) - pref_com).abs();
                if da != db {
                    return da.cmp(&db);
                }
            }
            serial::com_num(&b.0).cmp(&serial::com_num(&a.0))
        });
    }

    /// Port of `_clearEsp32FirmwareBeforeUpload` (with low-baud retry).
    fn clear_esp32_firmware_before_upload(&self, sendstd: &mut SendStd) -> Result<(), String> {
        let esptool = self.resolve_esp32_esptool_path();
        let chip = self.cfg_str("espChip", "esp32s3");
        let before = self.cfg_str("espBefore", "default_reset");
        let after = self.cfg_str("espAfter", "hard_reset");
        let low_baud: u64 = 115200;
        let first_baud = self.config.get("espEraseBaudrate").and_then(|v| v.as_u64()).unwrap_or(460800);

        let run = |baud: u64, is_retry: bool, sendstd: &mut SendStd| -> Result<bool, String> {
            let args = vec![
                "--chip".to_string(),
                chip.clone(),
                "--port".to_string(),
                self.peripheral_path.clone(),
                "--baud".to_string(),
                baud.to_string(),
                "--before".to_string(),
                before.clone(),
                "--after".to_string(),
                after.clone(),
                "erase_flash".to_string(),
            ];
            if is_retry {
                sendstd(&format!("{}[upload] Retrying firmware erase at {} baud...\n", ansi::YELLOW_DARK, baud), None);
            } else {
                sendstd(&format!("{}[upload] Clear old firmware before upload...\n", ansi::YELLOW_DARK), None);
            }
            let mut cmd = std::process::Command::new(&esptool);
            cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
            configure_killable(&mut cmd);
            let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn esptool: {}", e))?;
            if let Some(out) = child.stdout.take() {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    sendstd(&format!("{}\n", line), None);
                }
            }
            if let Some(e) = child.stderr.take() {
                for line in BufReader::new(e).lines().map_while(Result::ok) {
                    sendstd(&format!("{}\n", line), None);
                }
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            Ok(status.code() == Some(0))
        };

        if run(first_baud, false, sendstd)? {
            sendstd(&format!("{}[upload] Firmware erase done.\n", ansi::GREEN_DARK), None);
            return Ok(());
        }
        if first_baud > low_baud {
            if run(low_baud, true, sendstd)? {
                sendstd(&format!("{}[upload] Firmware erase done.\n", ansi::GREEN_DARK), None);
                return Ok(());
            }
        }
        Err("Failed to clear old firmware".to_string())
    }

    fn cfg_str<'a>(&'a self, key: &str, default: &'a str) -> String {
        self.config.get(key).and_then(|v| v.as_str()).unwrap_or(default).to_string()
    }

    /// Port of `flash(firmwarePath)`. `firmware_path` None => sketch upload.
    pub fn flash(
        &mut self,
        firmware_path: Option<&Path>,
        sendstd: &mut SendStd,
    ) -> Result<UploadResult, String> {
        if firmware_path.is_none() && self.should_clear_firmware_before_upload() {
            match self.clear_esp32_firmware_before_upload(sendstd) {
                Ok(()) => {
                    let pref = self.peripheral_path.clone();
                    if let Some(after) = self.resolve_esp32_port_after_erase(&pref) {
                        if after != self.peripheral_path {
                            sendstd(
                                &format!(
                                    "{}[upload] Port after chip erase: {}(was {})\n",
                                    ansi::YELLOW_DARK, after, self.peripheral_path
                                ),
                                None,
                            );
                            self.peripheral_path = after;
                        }
                    } else {
                        sendstd(
                            &format!(
                                "{}[upload] No USB serial port found after erase yet; upload may fail until the device re-enumerates.\n",
                                ansi::YELLOW_DARK
                            ),
                            None,
                        );
                    }
                }
                Err(e) => {
                    sendstd(
                        &format!("{}[upload] Pre-erase failed, continue upload: {}\n", ansi::YELLOW_DARK, e),
                        None,
                    );
                }
            }
        }

        let port = self.peripheral_path.clone();
        self.run_flash(&port, true, firmware_path, sendstd)
    }

    fn run_flash(
        &mut self,
        upload_port: &str,
        allow_fallback_retry: bool,
        firmware_path: Option<&Path>,
        sendstd: &mut SendStd,
    ) -> Result<UploadResult, String> {
        let mut args: Vec<String> = vec![
            "upload".into(),
            "--fqbn".into(),
            self.fqbn.clone(),
            "--verbose".into(),
            "--verify".into(),
            "--config-file".into(),
            self.config_file_path.to_string_lossy().to_string(),
            format!("-p{}", upload_port),
        ];
        if self.fqbn.starts_with("Maixduino:k210:") {
            args.push("-Pkflash".into());
        }
        if let Some(fw) = firmware_path {
            args.push("--input-file".into());
            args.push(fw.to_string_lossy().to_string());
            args.push(fw.to_string_lossy().to_string());
        } else {
            args.push("--input-dir".into());
            args.push(self.build_path.to_string_lossy().to_string());
            args.push(self.code_folder_path.to_string_lossy().to_string());
        }

        if !self.arduino_cli_path.exists() {
            return Err(format!("arduino-cli not found: {}", self.arduino_cli_path.display()));
        }

        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let (code, raw_output) = self.spawn_stream(&arg_refs, sendstd, false)?;

        if code == Some(0) {
            let post_delay = self
                .config
                .get("postUploadDelay")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| {
                    if self.is_esp32_target() {
                        if cfg!(target_os = "windows") {
                            2000
                        } else {
                            1000
                        }
                    } else {
                        0
                    }
                });
            if post_delay > 0 {
                std::thread::sleep(Duration::from_millis(post_delay));
            }
            return Ok(UploadResult::Success);
        }
        if self.abort.load(Ordering::Relaxed) || code.is_none() {
            std::thread::sleep(Duration::from_millis(100));
            return Ok(UploadResult::Aborted);
        }

        let esptool_like_failure = code == Some(1) || code == Some(2);
        if allow_fallback_retry
            && self.is_esp32_target()
            && esptool_like_failure
            && Self::is_serial_port_open_error(&raw_output)
        {
            match self.resolve_fallback_serial_path(upload_port) {
                Some(fallback) => {
                    sendstd(
                        &format!("{}[upload] Port {} unavailable, retry on {}\n", ansi::YELLOW_DARK, upload_port, fallback),
                        None,
                    );
                    self.peripheral_path = fallback.clone();
                    return self.run_flash(&fallback, false, firmware_path, sendstd);
                }
                None => {
                    return Err(
                        "Serial port missing or busy: no ESP/USB-UART device found. Reconnect USB, refresh the port list, pick the correct COM (Espressif/CP210x/CH343), and close Serial Monitor or other apps using the port.".to_string(),
                    );
                }
            }
        }
        Err("avrdude failed to flash".to_string())
    }

    /// Port of `flashRealtimeFirmware`.
    pub fn flash_realtime_firmware(&mut self, sendstd: &mut SendStd) -> Result<UploadResult, String> {
        let firmware = self.cfg_str("firmware", "");
        let path = self.firmware_dir.join(firmware);
        self.flash(Some(&path), sendstd)
    }
}
