//! Direct esptool `write_flash` of three pre-built bins. Port of `src/upload/esp32.js`.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::Value;

use crate::ansi;
use crate::upload::{configure_killable, kill_tree, SendStd, UploadResult};

/// Default flash addresses (bootloader 0x0, partitions 0x8000, firmware 0x10000).
pub const DEFAULT_BOOTLOADER_ADDR: u64 = 0x0;
pub const DEFAULT_PARTITIONS_ADDR: u64 = 0x8000;
pub const DEFAULT_FIRMWARE_ADDR: u64 = 0x10000;
pub const DEFAULT_BAUDRATE: u64 = 921600;

pub struct Esp32 {
    peripheral_path: String,
    config: Value,
    user_data_path: PathBuf,
    tools_path: PathBuf,
    abort: Arc<AtomicBool>,
    temp_dir: Option<PathBuf>,
    esptool_path: PathBuf,
}

impl Esp32 {
    pub fn new(
        peripheral_path: &str,
        config: Value,
        user_data_path: &Path,
        tools_path: &Path,
    ) -> Self {
        let mut me = Self {
            peripheral_path: peripheral_path.to_string(),
            config,
            user_data_path: user_data_path.to_path_buf(),
            tools_path: tools_path.to_path_buf(),
            abort: Arc::new(AtomicBool::new(false)),
            temp_dir: None,
            esptool_path: PathBuf::new(),
        };
        me.esptool_path = me.resolve_esptool_binary();
        me
    }

    pub fn abort_flag(&self) -> Arc<AtomicBool> {
        self.abort.clone()
    }

    /// Port of `_resolveEsptoolBinary`.
    fn resolve_esptool_binary(&self) -> PathBuf {
        let exe_name = if cfg!(windows) {
            "esptool.exe"
        } else {
            "esptool"
        };
        if let Some(explicit) = self.config.get("esptoolPath").and_then(|v| v.as_str()) {
            let p = PathBuf::from(explicit);
            if p.exists() {
                return p;
            }
        }
        let base_dir = self
            .tools_path
            .join("Arduino")
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

    /// Port of `_writeBinsToTemp`. Accepts base64 string / {encoding,data} /
    /// {path} entries.
    fn write_bins_to_temp(&mut self, bins: &Value) -> Result<[PathBuf; 3], String> {
        if !bins.is_object() {
            return Err("uploadEsp32Bin requires bins payload".to_string());
        }
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let pid = std::process::id();
        let rand: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        let id = format!("esp32_flash_{}_{}_{}", ts, pid, rand);
        let temp_root = self.user_data_path.join("esp32").join(&id);
        fs::create_dir_all(&temp_root).map_err(|e| e.to_string())?;
        self.temp_dir = Some(temp_root.clone());

        let keys = ["bootloader", "partitions", "firmware"];
        let mut out: Vec<PathBuf> = Vec::with_capacity(3);
        for key in keys {
            let entry = bins
                .get(key)
                .ok_or_else(|| format!("uploadEsp32Bin missing {} bin", key))?;
            let target = temp_root.join(format!("{}.bin", key));
            if let Some(s) = entry.as_str() {
                let data = base64::engine::general_purpose::STANDARD
                    .decode(s)
                    .map_err(|e| e.to_string())?;
                fs::write(&target, data).map_err(|e| e.to_string())?;
            } else if let Some(path) = entry.get("path").and_then(|v| v.as_str()) {
                if !Path::new(path).exists() {
                    return Err(format!("uploadEsp32Bin {} path not found: {}", key, path));
                }
                fs::copy(path, &target).map_err(|e| e.to_string())?;
            } else if let Some(data) = entry.get("data").and_then(|v| v.as_str()) {
                let encoding = entry
                    .get("encoding")
                    .and_then(|v| v.as_str())
                    .unwrap_or("base64");
                let bytes = if encoding == "hex" {
                    hex::decode(data).map_err(|e| e.to_string())?
                } else {
                    base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .map_err(|e| e.to_string())?
                };
                fs::write(&target, bytes).map_err(|e| e.to_string())?;
            } else {
                return Err(format!("uploadEsp32Bin invalid {} bin payload", key));
            }
            out.push(target);
        }
        Ok([out[0].clone(), out[1].clone(), out[2].clone()])
    }

    fn cfg_str<'a>(&'a self, key: &str, default: &'a str) -> String {
        self.config
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or(default)
            .to_string()
    }

    fn cfg_u64(&self, key: &str, default: u64) -> u64 {
        self.config
            .get(key)
            .and_then(|v| v.as_u64())
            .unwrap_or(default)
    }

    fn addr(&self, key: &str, default: u64) -> u64 {
        self.config
            .get("addresses")
            .and_then(|a| a.get(key))
            .and_then(|v| v.as_u64())
            .unwrap_or(default)
    }

    /// Port of `_buildArgs`.
    fn build_args(&self, files: &[PathBuf; 3]) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "--chip".into(),
            self.cfg_str("chip", "esp32s3"),
            "--port".into(),
            self.peripheral_path.clone(),
            "--baud".into(),
            self.cfg_u64("baudrate", DEFAULT_BAUDRATE).to_string(),
            "--before".into(),
            self.cfg_str("before", "default_reset"),
            "--after".into(),
            self.cfg_str("after", "hard_reset"),
            "write_flash".into(),
        ];
        if self
            .config
            .get("eraseAll")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            args.push("--erase-all".into());
        }
        args.push("--flash_mode".into());
        args.push(self.cfg_str("flashMode", "dio"));
        args.push("--flash_freq".into());
        args.push(self.cfg_str("flashFreq", "80m"));
        args.push("--flash_size".into());
        args.push(self.cfg_str("flashSize", "keep"));

        let boot = self.addr("bootloader", DEFAULT_BOOTLOADER_ADDR);
        let part = self.addr("partitions", DEFAULT_PARTITIONS_ADDR);
        let fw = self.addr("firmware", DEFAULT_FIRMWARE_ADDR);
        args.push(format!("0x{:x}", boot));
        args.push(files[0].to_string_lossy().to_string());
        args.push(format!("0x{:x}", part));
        args.push(files[1].to_string_lossy().to_string());
        args.push(format!("0x{:x}", fw));
        args.push(files[2].to_string_lossy().to_string());
        args
    }

    fn flash_progress_from_text(text: &str) -> Option<f64> {
        // Match: Writing at 0x.. ( NN %)
        let lower = text;
        let idx = lower.find("Writing at 0x")?;
        let after = &lower[idx..];
        let paren = after.find('(')?;
        let close = after[paren..].find('%')?;
        let frag = &after[paren + 1..paren + close];
        let n: i64 = frag.trim().parse().ok()?;
        Some((n as f64 / 100.0).clamp(0.0, 1.0))
    }

    fn paint(text: &str) -> String {
        const ERR_HINTS: [&str; 5] = [
            "A fatal error occurred",
            "Failed to connect",
            "No serial data received",
            "Wrong boot mode",
            "Invalid head of packet",
        ];
        const OK_LINES: [&str; 3] = [
            "Hash of data verified",
            "Hard resetting via RTS pin",
            "Leaving...",
        ];
        if ERR_HINTS.iter().any(|h| text.contains(h)) {
            format!("{}{}", ansi::RED, text)
        } else if OK_LINES.iter().any(|h| text.contains(h)) {
            format!("{}{}", ansi::GREEN_DARK, text)
        } else {
            text.to_string()
        }
    }

    /// Port of `flashBins` — spawn esptool, stream, abort, resolve Success/Aborted.
    pub fn flash_bins(
        &mut self,
        bins: &Value,
        sendstd: &mut SendStd,
    ) -> Result<UploadResult, String> {
        let files = self.write_bins_to_temp(bins)?;
        let args = self.build_args(&files);
        let exe_label = self
            .esptool_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("esptool");
        sendstd(
            &format!(
                "{}[esp32] esptool {} {}\n",
                ansi::CLEAR,
                exe_label,
                args.join(" ")
            ),
            None,
        );

        let mut cmd = std::process::Command::new(&self.esptool_path);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_killable(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn esptool: {}", e))?;

        // Abort watcher thread (mirrors the 100ms abort timer).
        let abort = self.abort.clone();
        let pid = child.id();
        let killed = Arc::new(AtomicBool::new(false));
        let killed2 = killed.clone();
        let watcher = std::thread::spawn(move || loop {
            if abort.load(Ordering::Relaxed) {
                #[cfg(windows)]
                {
                    let mut cmd = std::process::Command::new("taskkill");
                    cmd.args(["/pid", &pid.to_string(), "/f", "/t"]);
                    configure_killable(&mut cmd);
                    let _ = cmd.status();
                }
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
                killed2.store(true, Ordering::Relaxed);
                break;
            }
            if killed2.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        });

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let prog = Self::flash_progress_from_text(&line);
                sendstd(&format!("{}\n", Self::paint(&line)), prog);
            }
        }
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let prog = Self::flash_progress_from_text(&line);
                sendstd(&format!("{}\n", Self::paint(&line)), prog);
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        killed.store(true, Ordering::Relaxed);
        let _ = watcher.join();

        sendstd(&format!("{}\r\n", ansi::CLEAR), None);
        if self.abort.load(Ordering::Relaxed) {
            return Ok(UploadResult::Aborted);
        }
        match status.code() {
            Some(0) => Ok(UploadResult::Success),
            other => Err(format!("esptool failed (exit code {:?})", other)),
        }
    }

    /// Port of `cleanup`.
    pub fn cleanup(&mut self, sendstd: &mut SendStd) {
        if let Some(dir) = self.temp_dir.take() {
            if dir.exists() {
                if let Err(e) = fs::remove_dir_all(&dir) {
                    sendstd(
                        &format!("{}[esp32] cleanup warning: {}\n", ansi::YELLOW_DARK, e),
                        None,
                    );
                }
            }
        }
    }
}

/// Force the kill-tree path to be referenced so `upload::kill_tree` stays linked
/// even if all aborts go through the watcher thread.
#[allow(dead_code)]
pub fn _force_link(child: &mut std::process::Child) {
    kill_tree(child);
}
