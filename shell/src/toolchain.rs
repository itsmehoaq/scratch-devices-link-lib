//! Toolchain auto-setup. Downloads the pre-packaged arduino-cli + ESP32 + AVR
//! toolchain from the GitHub Tools release as a `.7z` archive and extracts it
//! with sevenz-rust2. No per-tool or per-core download is needed after this.
//!
//! If pre-shipped tools are already present on disk, the download is skipped.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bzip2::read::BzDecoder;
use futures_util::StreamExt;
use serde::Deserialize;

pub const ESP32_INDEX_URL: &str =
    "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json";
pub const ARDUINO_INDEX_URL: &str =
    "https://downloads.arduino.cc/packages/package_index.json";
pub const ARDUINO_CLI_VERSION: &str = "1.4.1";

/// A reqwest client with explicit settings.
/// reqwest is built with `default-features = false` (no auto gzip/brotli/deflate),
/// so we only need to configure redirects here.
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .expect("reqwest client")
}

/// Detected archive format, based on magic bytes at the start of the file.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ArchiveFormat {
    /// Standard gzip-compressed tar (.tar.gz / .tgz).
    TarGz,
    /// bzip2-compressed tar (.tar.bz2).
    TarBz2,
    /// Zip archive (.zip).
    Zip,
}

impl std::fmt::Display for ArchiveFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArchiveFormat::TarGz => write!(f, ".tar.gz"),
            ArchiveFormat::TarBz2 => write!(f, ".tar.bz2"),
            ArchiveFormat::Zip => write!(f, ".zip"),
        }
    }
}

/// Read the first 2 bytes of the file and identify the compression format.
/// - `1f 8b` → gzip  (TarGz)
/// - `42 5a` → bzip2 (TarBz2)
/// - `50 4b` → zip   (Zip)
/// Returns `None` if the file is too short or unreadable.
fn detect_format(path: &Path) -> Result<ArchiveFormat, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 2];
    f.read_exact(&mut header).map_err(|e| e.to_string())?;
    match header {
        [0x1f, 0x8b] => Ok(ArchiveFormat::TarGz),
        [0x42, 0x5a] => Ok(ArchiveFormat::TarBz2),
        [0x50, 0x4b] => Ok(ArchiveFormat::Zip),
        _ => Err(format!(
            "unsupported or corrupt archive (magic {:02x}{:02x}): {}",
            header[0], header[1],
            path.display()
        )),
    }
}

/// Only these ESP32 tools are downloaded. Everything else in toolsDependencies
/// is skipped (compilers, debuggers, RISC-V tools). We flash pre-compiled .bin
/// files via esptool so no compiler is needed.
/// xtensa-esp32s3-elf-* must be kept so arduino-cli can link ESP32-S3 projects.
const ESP32_KEEP_TOOLS: &[&str] = &[
    "esptool_py",
    "esptool",
    "mklittlefs",
    "mkspiffs",
    "esp32-arduino-libs",
    "esp32s3-libs",
    "xtensa-esp32s3-elf-gcc",
    "xtensa-esp32s3-elf-g++",
];

/// Arduino AVR tools we keep (everything else in the AVR core is skipped).
const ARDUINO_KEEP_TOOLS: &[&str] = &["avr-gcc", "avrdude"];

#[cfg(windows)]
pub const CLI_FILE: &str = "arduino-cli.exe";
#[cfg(not(windows))]
pub const CLI_FILE: &str = "arduino-cli";

/// Setup-phase + progress payload.
#[derive(Debug, Clone)]
pub struct SetupProgress {
    pub phase: String,
    pub progress: u8,
}

/// Shared progress sink. Cloneable so it can be captured by async closures.
pub type ProgressFn = Arc<dyn Fn(SetupProgress) + Send + Sync + 'static>;

/// Simple progress callback used during extraction, separate from the main
/// `SetupProgress` channel so extraction does not need to own or clone `ProgressFn`.
type ExtractProgress = dyn Fn(u8) + Send + Sync + 'static;

// ── Package-index JSON model ─────────────────────────────────────────────────
// Only the fields we consume are declared; extra fields (checksum/size/…) are
// ignored.

#[derive(Deserialize)]
struct PackageIndex {
    packages: Vec<PackageEntry>,
}
#[derive(Deserialize)]
struct PackageEntry {
    name: String,
    #[serde(default)]
    platforms: Vec<Platform>,
    #[serde(default)]
    tools: Vec<Tool>,
}
#[derive(Deserialize, Clone)]
struct Platform {
    architecture: String,
    version: String,
    url: String,
    #[serde(rename = "archiveFileName")]
    archive_file_name: String,
    #[serde(default, rename = "toolsDependencies")]
    tools_dependencies: Vec<ToolDep>,
}
#[derive(Deserialize, Clone)]
struct ToolDep {
    name: String,
    version: String,
}
#[derive(Deserialize, Clone)]
struct Tool {
    name: String,
    version: String,
    #[serde(default)]
    systems: Vec<ToolSystem>,
}
#[derive(Deserialize, Clone)]
struct ToolSystem {
    host: String,
    url: String,
    #[serde(rename = "archiveFileName")]
    archive_file_name: String,
}

/// Return the arduino-cli release archive filename for the current platform.
pub fn get_cli_asset() -> String {
    let v = ARDUINO_CLI_VERSION;
    if cfg!(target_os = "windows") {
        return format!("arduino-cli_{}_Windows_64bit.zip", v);
    }
    if cfg!(target_os = "macos") {
        return if cfg!(target_arch = "aarch64") {
            format!("arduino-cli_{}_macOS_ARM64.tar.gz", v)
        } else {
            format!("arduino-cli_{}_macOS_64bit.tar.gz", v)
        };
    }
    if cfg!(target_arch = "aarch64") {
        format!("arduino-cli_{}_Linux_ARM64.tar.gz", v)
    } else {
        format!("arduino-cli_{}_Linux_64bit.tar.gz", v)
    }
}

/// Port of `getCliDownloadUrl`.
pub fn get_cli_download_url() -> String {
    format!(
        "https://github.com/arduino/arduino-cli/releases/download/v{}/{}",
        ARDUINO_CLI_VERSION,
        get_cli_asset()
    )
}

/// Port of `checkToolchain`: ok if `<toolsPath>/Arduino/arduino-cli[.exe]` exists.
pub fn check_toolchain(tools_path: &Path) -> (bool, PathBuf) {
    let cli_path = tools_path.join("Arduino").join(CLI_FILE);
    (cli_path.exists(), cli_path)
}

/// Stream-download a URL to a file, reporting integer 0-100 progress.
async fn download_file<F: FnMut(u8)>(
    url: &str,
    dest: &Path,
    mut on_progress: F,
) -> Result<(), String> {
    let resp = http_client().get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut received: u64 = 0;
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if total > 0 {
            let pct = ((received as f64 / total as f64) * 100.0).round() as u8;
            on_progress(pct.min(100));
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract a .tar.gz or .tar.bz2 archive into dest_dir, reporting per-entry progress.
fn extract_tar_compressed(
    archive_path: &Path,
    dest_dir: &Path,
    on_progress: Option<&Arc<ExtractProgress>>,
) -> Result<(), String> {
    let format = detect_format(archive_path)?;

    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let decompressor: Box<dyn Read> = match format {
        ArchiveFormat::TarGz => Box::new(flate2::read::GzDecoder::new(file)),
        ArchiveFormat::TarBz2 => Box::new(BzDecoder::new(file)),
        ArchiveFormat::Zip => unreachable!(),
    };
    let mut archive = tar::Archive::new(decompressor);

    // Count entries first so we can report per-entry progress.
    let entries: Vec<_> = archive
        .entries()
        .map_err(|e| e.to_string())?
        .collect();
    let total = entries.len();
    for (i, entry_result) in entries.into_iter().enumerate() {
        let mut entry = entry_result.map_err(|e| e.to_string())?;
        entry.unpack(dest_dir).map_err(|e| e.to_string())?;
        if let Some(cb) = on_progress {
            let pct = (((i + 1) as f64 / total as f64) * 100.0).round() as u8;
            cb(pct.min(100));
        }
    }
    Ok(())
}

/// Extract a .zip archive into dest_dir, reporting per-entry progress.
fn extract_zip(
    archive_path: &Path,
    dest_dir: &Path,
    on_progress: Option<&Arc<ExtractProgress>>,
) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = zip.len();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let out_path = match entry.enclosed_name() {
            Some(p) => dest_dir.join(p),
            None => continue,
        };
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        if let Some(cb) = on_progress {
            let pct = (((i + 1) as f64 / total as f64) * 100.0).round() as u8;
            cb(pct.min(100));
        }
    }
    Ok(())
}

/// Detect archive format and extract into dest_dir using the appropriate decompressor.
fn extract_archive(
    archive_path: &Path,
    dest_dir: &Path,
    on_progress: Option<&Arc<ExtractProgress>>,
) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let format = detect_format(archive_path)?;
    match format {
        ArchiveFormat::TarGz | ArchiveFormat::TarBz2 => {
            extract_tar_compressed(archive_path, dest_dir, on_progress)
        }
        ArchiveFormat::Zip => extract_zip(archive_path, dest_dir, on_progress),
    }
}

/// Extract a .zip or .tar.gz archive into dest_dir, stripping a common leading
/// directory component shared by ALL entries. Platform / tool archives wrap
/// their contents in a single top-level dir (e.g. `arduino-esp32-3.1.0/…`) that
/// must be removed so arduino-cli finds `platform.txt`/`boards.txt` at the
/// hardware root.
fn extract_archive_stripped(
    archive_path: &Path,
    dest_dir: &Path,
    on_progress: Option<&Arc<ExtractProgress>>,
) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let format = detect_format(archive_path)?;
    match format {
        ArchiveFormat::TarGz | ArchiveFormat::TarBz2 => {
            extract_tar_compressed_stripped(archive_path, dest_dir, on_progress)
        }
        ArchiveFormat::Zip => extract_zip_stripped(archive_path, dest_dir, on_progress),
    }
}

/// Given the first path component of every entry, return the single shared one
/// if (and only if) ALL entries share it, else None (strip nothing).
fn common_first_component(firsts: &[String]) -> Option<String> {
    let mut iter = firsts.iter().filter(|s| !s.is_empty());
    let first = iter.next()?.clone();
    if firsts.iter().all(|c| !c.is_empty() && *c == first) {
        Some(first)
    } else {
        None
    }
}

/// First path component of a relative path as a String, or empty if none.
fn first_component(p: &Path) -> String {
    p.components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default()
}

fn extract_zip_stripped(
    archive_path: &Path,
    dest_dir: &Path,
    on_progress: Option<&Arc<ExtractProgress>>,
) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // Pass 1: collect first components to detect a common prefix.
    let mut firsts: Vec<String> = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if let Some(p) = entry.enclosed_name() {
            firsts.push(first_component(&p));
        }
    }
    let prefix = common_first_component(&firsts);

    // Pass 2: extract, stripping the common prefix when present.
    let total = zip.len() as u64;
    let mut extracted: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let rel = match entry.enclosed_name() {
            Some(p) => p,
            None => continue,
        };
        let stripped: &Path = match &prefix {
            Some(pfx) => rel.strip_prefix(pfx).unwrap_or(&rel),
            None => &rel,
        };
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest_dir.join(stripped);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        extracted += 1;
        if let Some(cb) = on_progress {
            let pct = ((extracted as f64 / total as f64) * 100.0).round() as u8;
            cb(pct.min(100));
        }
    }
    Ok(())
}

/// Extract a tar archive (gzip or bzip2) into dest_dir, stripping the common
/// top-level directory component from all paths inside the archive.
fn extract_tar_compressed_stripped(
    archive_path: &Path,
    dest_dir: &Path,
    on_progress: Option<&Arc<ExtractProgress>>,
) -> Result<(), String> {
    let format = detect_format(archive_path)?;

    // Pass 1: read entries to count them (tar is single-pass over decompressor).
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let decompressor: Box<dyn Read> = match format {
        ArchiveFormat::TarGz => Box::new(flate2::read::GzDecoder::new(file)),
        ArchiveFormat::TarBz2 => Box::new(BzDecoder::new(file)),
        ArchiveFormat::Zip => unreachable!(),
    };
    let mut archive = tar::Archive::new(decompressor);
    let mut firsts: Vec<String> = Vec::new();
    let mut entry_count: u64 = 0;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?;
        firsts.push(first_component(&path));
        entry_count += 1;
    }
    let prefix = common_first_component(&firsts);

    // Pass 2: re-open and extract, stripping the prefix, reporting progress.
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let decompressor: Box<dyn Read> = match format {
        ArchiveFormat::TarGz => Box::new(flate2::read::GzDecoder::new(file)),
        ArchiveFormat::TarBz2 => Box::new(BzDecoder::new(file)),
        ArchiveFormat::Zip => unreachable!(),
    };
    let mut archive = tar::Archive::new(decompressor);
    let mut extracted: u64 = 0;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let rel = entry.path().map_err(|e| e.to_string())?.into_owned();
        let stripped: &Path = match &prefix {
            Some(pfx) => rel.strip_prefix(pfx).unwrap_or(&rel),
            None => &rel,
        };
        if stripped.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest_dir.join(stripped);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry.unpack(&out_path).map_err(|e| e.to_string())?;
        extracted += 1;
        if let Some(cb) = on_progress {
            let pct = ((extracted as f64 / entry_count as f64) * 100.0).round() as u8;
            cb(pct.min(100));
        }
    }
    Ok(())
}

/// Write `arduino-cli.yaml`. Port of `writeArduinoConfig`.
fn write_arduino_config(config_path: &Path, arduino_dir: &Path) -> Result<(), String> {
    let staging = arduino_dir.join("staging");
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let body = format!(
        "board_manager:\n  additional_urls:\n    - {url}\ndirectories:\n  data: {data}\n  downloads: {downloads}\n  user: {user}\n",
        url = ESP32_INDEX_URL,
        data = arduino_dir.display(),
        downloads = staging.display(),
        user = arduino_dir.display(),
    );
    fs::write(config_path, body).map_err(|e| e.to_string())?;
    Ok(())
}

/// Run arduino-cli with args + `--config-file`. Port of `runCli`. Blocking.
fn run_cli(cli_path: &Path, args: &[&str], config_path: &Path) -> Result<(), String> {
    let mut cmd = Command::new(cli_path);
    cmd.args(args);
    cmd.arg("--config-file").arg(config_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "arduino-cli {} failed (exit {:?})",
            args.first().copied().unwrap_or(""),
            status.code()
        ));
    }
    Ok(())
}

// ── Selective install helpers ────────────────────────────────────────────────

/// Fetch a package-index JSON, save the raw bytes to `dest`, and parse it.
async fn fetch_and_save_index(url: &str, dest: &Path) -> Result<PackageIndex, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let client = http_client();
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    fs::write(dest, &bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Pick the highest-semver platform for the given architecture. Unparseable
/// versions sort lowest (treated as `None`).
fn pick_latest_platform(platforms: &[Platform], arch: &str) -> Option<Platform> {
    platforms
        .iter()
        .filter(|p| p.architecture == arch)
        .max_by(|a, b| {
            let va = semver::Version::parse(&a.version).ok();
            let vb = semver::Version::parse(&b.version).ok();
            va.cmp(&vb)
        })
        .cloned()
}

/// Pick the best `ToolSystem` for the compile-time target, by host substring
/// matching with a per-target priority list (best first).
fn pick_system(systems: &[ToolSystem]) -> Option<ToolSystem> {
    let prefs: &[&[&str]] = {
        #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
        {
            &[&["aarch64", "darwin"], &["arm64", "darwin"], &["aarch64", "apple"], &["darwin"]]
        }
        #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
        {
            &[&["x86_64", "darwin"], &["x86_64", "apple"], &["darwin"]]
        }
        #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
        {
            &[&["x86_64", "mingw"], &["mingw32"], &["windows"]]
        }
        #[cfg(not(any(
            all(target_arch = "aarch64", target_os = "macos"),
            all(target_arch = "x86_64", target_os = "macos"),
            all(target_arch = "x86_64", target_os = "windows"),
        )))]
        {
            &[]
        }
    };
    for needles in prefs {
        if let Some(s) = systems.iter().find(|s| {
            let h = s.host.to_lowercase();
            needles.iter().all(|n| h.contains(n))
        }) {
            return Some(s.clone());
        }
    }
    None
}

/// Download one archive (the index gives a complete `url`) and extract it with
/// prefix stripping into `dest_dir`. Reports live download progress under
/// `phase`, then extraction progress under `extract_phase` (typically "extracting").
async fn download_and_extract(
    url: &str,
    archive_file_name: &str,
    tmp_dir: &Path,
    dest_dir: &Path,
    report: ProgressFn,
    phase: &str,
    extract_phase: &str,
) -> Result<(), String> {
    let archive_path = tmp_dir.join(archive_file_name);
    let report_dl = report.clone();
    let phase_owned = phase.to_string();
    let phase_for_dl = phase_owned.clone();
    download_file(url, &archive_path, move |pct| {
        report_dl(SetupProgress {
            phase: phase_for_dl.clone(),
            progress: pct,
        });
    })
    .await?;

    // Signal download done before starting extraction.
    report(SetupProgress {
        phase: phase_owned,
        progress: 100,
    });

    let report_ext = report.clone();
    let extract_phase_owned = extract_phase.to_string();
    let on_extract_progress: Arc<ExtractProgress> = Arc::new(move |pct: u8| {
        report_ext(SetupProgress {
            phase: extract_phase_owned.clone(),
            progress: pct,
        });
    });

    // Extraction is synchronous; wrap in spawn_blocking to avoid blocking the async runtime.
    let archive_path_for_blocking = archive_path.clone();
    let dest_dir_for_blocking = dest_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        extract_archive_stripped(&archive_path_for_blocking, &dest_dir_for_blocking, Some(&on_extract_progress))
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = fs::remove_file(&archive_path);
    Ok(())
}

/// Selective ESP32 install: platform archive + non-skipped tool dependencies.
async fn install_esp32(
    arduino_dir: &Path,
    tmp_dir: &Path,
    report: &ProgressFn,
) -> Result<(), String> {
    let idx_path = arduino_dir
        .join("packages")
        .join("esp32")
        .join("package_esp32_index.json");
    let index = fetch_and_save_index(ESP32_INDEX_URL, &idx_path).await?;
    let pkg = index
        .packages
        .iter()
        .find(|p| p.name == "esp32")
        .ok_or("esp32 package not found in index")?;
    let platform =
        pick_latest_platform(&pkg.platforms, "esp32").ok_or("no esp32 platform found")?;

    // Platform archive → packages/esp32/hardware/esp32/<version>/
    let hw_dest = arduino_dir
        .join("packages")
        .join("esp32")
        .join("hardware")
        .join("esp32")
        .join(&platform.version);
    download_and_extract(
        &platform.url,
        &platform.archive_file_name,
        tmp_dir,
        &hw_dest,
        report.clone(),
        "downloading-platform",
        "extracting",
    )
    .await?;

    // Tools: whitelist — only download what we actually need.
    let deps: Vec<&ToolDep> = platform
        .tools_dependencies
        .iter()
        .filter(|d| ESP32_KEEP_TOOLS.contains(&d.name.as_str()))
        .collect();
    let total = deps.len().max(1);
    for (done, dep) in deps.iter().enumerate() {
        let tool = match pkg
            .tools
            .iter()
            .find(|t| t.name == dep.name && t.version == dep.version)
        {
            Some(t) => t,
            None => {
                tracing::warn!(
                    "[link] esp32 tool {} {} not found in index",
                    dep.name,
                    dep.version
                );
                continue;
            }
        };
        let sys = match pick_system(&tool.systems) {
            Some(s) => s,
            None => {
                tracing::warn!("[link] no host match for tool {} — skipping", tool.name);
                continue;
            }
        };
        let dest = arduino_dir
            .join("packages")
            .join("esp32")
            .join("tools")
            .join(&tool.name)
            .join(&tool.version);
        download_and_extract(
            &sys.url,
            &sys.archive_file_name,
            tmp_dir,
            &dest,
            report.clone(),
            "downloading-tools",
            "extracting",
        )
        .await?;
        let progress = ((done + 1) * 100 / total) as u8;
        report(SetupProgress {
            phase: "downloading-tools".to_string(),
            progress,
        });
    }
    Ok(())
}

/// Selective Arduino AVR (Uno) install: platform archive + avr-gcc/avrdude.
async fn install_arduino_avr(
    arduino_dir: &Path,
    tmp_dir: &Path,
    report: &ProgressFn,
) -> Result<(), String> {
    let idx_path = arduino_dir.join("package_index.json");
    let index = fetch_and_save_index(ARDUINO_INDEX_URL, &idx_path).await?;
    let pkg = index
        .packages
        .iter()
        .find(|p| p.name == "arduino")
        .ok_or("arduino package not found in index")?;
    let platform = pick_latest_platform(&pkg.platforms, "avr").ok_or("no avr platform found")?;

    let hw_dest = arduino_dir
        .join("packages")
        .join("arduino")
        .join("hardware")
        .join("avr")
        .join(&platform.version);
    download_and_extract(
        &platform.url,
        &platform.archive_file_name,
        tmp_dir,
        &hw_dest,
        report.clone(),
        "downloading-platform",
        "extracting",
    )
    .await?;

    let deps: Vec<&ToolDep> = platform
        .tools_dependencies
        .iter()
        .filter(|d| ARDUINO_KEEP_TOOLS.contains(&d.name.as_str()))
        .collect();
    let total = deps.len().max(1);
    for (done, dep) in deps.iter().enumerate() {
        let tool = match pkg
            .tools
            .iter()
            .find(|t| t.name == dep.name && t.version == dep.version)
        {
            Some(t) => t,
            None => {
                tracing::warn!("[link] arduino tool {} {} not found", dep.name, dep.version);
                continue;
            }
        };
        let sys = match pick_system(&tool.systems) {
            Some(s) => s,
            None => {
                tracing::warn!("[link] no host match for {} — skipping", tool.name);
                continue;
            }
        };
        let dest = arduino_dir
            .join("packages")
            .join("arduino")
            .join("tools")
            .join(&tool.name)
            .join(&tool.version);
        download_and_extract(
            &sys.url,
            &sys.archive_file_name,
            tmp_dir,
            &dest,
            report.clone(),
            "downloading-tools",
            "extracting",
        )
        .await?;
        let progress = ((done + 1) * 100 / total) as u8;
        report(SetupProgress {
            phase: "downloading-tools".to_string(),
            progress,
        });
    }
    Ok(())
}

/// Download arduino-cli, then selectively install the ESP32 + Arduino AVR cores
/// and only the tools we need. Port of `setupToolchain`.
/// Calls `report` with each `{phase, progress}` transition. Phases:
/// downloading-cli | extracting | configuring | updating-index |
/// downloading-platform | downloading-tools | pruning | done
pub async fn setup_toolchain(
    tools_path: &Path,
    report: ProgressFn,
) -> Result<(), String> {
    let arduino_dir = tools_path.join("Arduino");
    let cli_path = arduino_dir.join(CLI_FILE);
    let config_path = arduino_dir.join("arduino-cli.yaml");
    let tmp_dir = tools_path.join(".setup-tmp");

    fs::create_dir_all(&arduino_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let result = setup_inner(
        &arduino_dir,
        &cli_path,
        &config_path,
        &tmp_dir,
        &report,
    )
    .await;

    // Finally: remove .setup-tmp (mirrors the JS `finally`).
    let _ = fs::remove_dir_all(&tmp_dir);
    result
}

async fn setup_inner(
    arduino_dir: &Path,
    cli_path: &Path,
    config_path: &Path,
    tmp_dir: &Path,
    report: &ProgressFn,
) -> Result<(), String> {
    let phase = |phase: &str, progress: u8| {
        report(SetupProgress {
            phase: phase.to_string(),
            progress,
        });
    };

    let asset_name = download::TOOLS_7Z;
    let download_url = format!("{}{}", download::ASSET_BASE, asset_name);

    // Probe Content-Length with a quick HEAD request so we can size the progress bar.
    let total_bytes = reqwest::Client::new()
        .head(&download_url)
        .send()
        .await
        .map_err(|e| format!("HEAD {download_url}: {e}"))?
        .content_length()
        .ok_or_else(|| "Content-Length header missing -- cannot show progress bar".to_string())?
        as u64;

    phase("downloading-tools", 0);

    // Create the download progress bar. It renders in the current async context
    // while the blocking sync download runs in spawn_blocking.
    let dl = download::DownloadProgress::new(total_bytes);

    // Clone to an owned PathBuf so it can be moved into spawn_blocking.
    let tools_path_owned = tools_path.to_path_buf();
    let dl = Arc::new(dl);
    let dl_for_task = dl.clone();
    let result = tokio::task::spawn_blocking(move || {
        download::ensure_tools(&tools_path_owned, &dl_for_task)
    })
    .await
    .map_err(|e| format!("download task panicked: {e}"))?;

    match result {
        download::ToolsStatus::Present => {
            // Tools were already on disk; nothing to download or extract.
            dl.finish_ok("Toolchain ready");
        }
        download::ToolsStatus::Downloaded => {
            // ensure_tools already called extract_archive (and deleted the .7z).
            // Just finish the bar cleanly.
            dl.finish_ok("Downloaded");
        }
        download::ToolsStatus::Failed => {
            return Err("tools download/fetch failed".to_string());
        }
    }

    // Extraction is synchronous; wrap in spawn_blocking so it doesn't block the async runtime.
    let report_ext = report.clone();
    let on_extract_progress: Arc<ExtractProgress> = Arc::new(move |pct: u8| {
        report_ext(SetupProgress {
            phase: "extracting-cli".to_string(),
            progress: pct,
        });
    });
    let archive_path_for_blocking = archive_path.clone();
    let arduino_dir_for_blocking = arduino_dir.to_path_buf();
    phase("extracting-cli", 0);
    tokio::task::spawn_blocking(move || {
        extract_archive(&archive_path_for_blocking, &arduino_dir_for_blocking, Some(&on_extract_progress))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Brief spinner while the cli chmod runs (unix only).
    #[cfg(unix)]
    {
        let spin = Spinner::new("Setting permissions...");
        chmod_cli(tools_path);
        spin.finish_ok("Permissions set");
    }
    #[cfg(not(unix))]
    let _ = ();
    drop(dl); // drop bar reference before spinner finish

    phase("done", 100);
    Ok(())
}

#[cfg(unix)]
fn chmod_cli(tools_path: &Path) {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    let cli_path = tools_path.join("Arduino").join(CLI_FILE);
    if !cli_path.exists() {
        return;
    }
    if let Ok(meta) = fs::metadata(&cli_path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        let _ = fs::set_permissions(&cli_path, perms);
    }
}
