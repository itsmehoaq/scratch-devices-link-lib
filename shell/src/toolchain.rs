//! Toolchain auto-setup. Port of `src/lib/toolchain-setup.js`.
//!
//! Downloads arduino-cli, extracts it, writes `arduino-cli.yaml`, runs
//! `core update-index`, then performs a *selective* install by parsing the
//! ESP32 and Arduino package-index JSON files and downloading only the platform
//! archive plus the specific tools we need (skipping the RISC-V toolchain and
//! other chip variants). Replaces node-7z/7zip-bin with the `zip` (Windows) and
//! `flate2`+`tar` (macOS/Linux) crates.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Deserialize;

pub const ESP32_INDEX_URL: &str =
    "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json";
pub const ARDUINO_INDEX_URL: &str =
    "https://downloads.arduino.cc/packages/package_index.json";
pub const ARDUINO_CLI_VERSION: &str = "1.4.1";

/// ESP32 tools that are never needed for the boards we support; skipped during
/// the selective install so they are never downloaded.
const SKIP_TOOLS: &[&str] = &[
    "esp-rv32",
    "riscv32-esp-elf-gcc",
    "riscv32-esp-elf-gdb",
    "xtensa-esp32-elf-gcc",
    "xtensa-esp32s2-elf-gcc",
    "xtensa-esp32s3-elf-gcc",
    "openocd-esp32",
    "xtensa-esp-elf-gdb",
];

/// Arduino AVR tools we keep (everything else in the AVR core is skipped).
const ARDUINO_KEEP_TOOLS: &[&str] = &["avr-gcc", "avrdude"];

#[cfg(windows)]
pub const CLI_FILE: &str = "arduino-cli.exe";
#[cfg(not(windows))]
pub const CLI_FILE: &str = "arduino-cli";

/// Setup-phase + progress payload, mirrors `onProgress({phase, progress})`.
#[derive(Debug, Clone)]
pub struct SetupProgress {
    pub phase: String,
    pub progress: u8,
}

/// Shared progress sink. Cloneable so it can be captured by download closures.
pub type ProgressFn = Arc<dyn Fn(SetupProgress) + Send + Sync + 'static>;

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
/// Port of `getCliAsset`.
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
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
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

/// Extract a .zip or .tar.gz archive into dest_dir.
fn extract_archive(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    if name.ends_with(".zip") {
        extract_zip(archive_path, dest_dir)
    } else {
        extract_tar_gz(archive_path, dest_dir)
    }
}

fn extract_zip(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
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
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    archive.unpack(dest_dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract a .zip or .tar.gz archive into dest_dir, stripping a common leading
/// directory component shared by ALL entries. Platform / tool archives wrap
/// their contents in a single top-level dir (e.g. `arduino-esp32-3.1.0/…`) that
/// must be removed so arduino-cli finds `platform.txt`/`boards.txt` at the
/// hardware root.
fn extract_archive_stripped(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let name = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    if name.ends_with(".zip") {
        extract_zip_stripped(archive_path, dest_dir)
    } else {
        extract_tar_gz_stripped(archive_path, dest_dir)
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

fn extract_zip_stripped(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
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
    }
    Ok(())
}

fn extract_tar_gz_stripped(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    // tar over GzDecoder is single-pass + not seekable, so open the file twice.
    // Pass 1: collect first components.
    let firsts: Vec<String> = {
        let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        let mut v = Vec::new();
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?;
            v.push(first_component(&path));
        }
        v
    };
    let prefix = common_first_component(&firsts);

    // Pass 2: re-open and extract stripping the prefix.
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
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
    let bytes = reqwest::get(url)
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
/// `phase`.
async fn download_and_extract(
    url: &str,
    archive_file_name: &str,
    tmp_dir: &Path,
    dest_dir: &Path,
    report: ProgressFn,
    phase: &str,
) -> Result<(), String> {
    let archive_path = tmp_dir.join(archive_file_name);
    let report_dl = report.clone();
    let phase_owned = phase.to_string();
    download_file(url, &archive_path, move |pct| {
        report_dl(SetupProgress {
            phase: phase_owned.clone(),
            progress: pct,
        });
    })
    .await?;
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    extract_archive_stripped(&archive_path, dest_dir)?;
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
    )
    .await?;

    // Tools (filtered by SKIP_TOOLS).
    let deps: Vec<&ToolDep> = platform
        .tools_dependencies
        .iter()
        .filter(|d| !SKIP_TOOLS.contains(&d.name.as_str()))
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

    let archive_name = get_cli_asset();
    let archive_path = tmp_dir.join(&archive_name);

    phase("downloading-cli", 0);
    {
        let report_dl = report.clone();
        download_file(&get_cli_download_url(), &archive_path, move |pct| {
            report_dl(SetupProgress {
                phase: "downloading-cli".to_string(),
                progress: pct,
            });
        })
        .await?;
        phase("downloading-cli", 100);
    }

    phase("extracting", 0);
    extract_archive(&archive_path, arduino_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if cli_path.exists() {
            let mut perms = fs::metadata(cli_path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(cli_path, perms).map_err(|e| e.to_string())?;
        }
    }

    phase("configuring", 0);
    write_arduino_config(config_path, arduino_dir)?;

    phase("updating-index", 0);
    let cli = cli_path.to_path_buf();
    let cfg = config_path.to_path_buf();
    tokio::task::spawn_blocking(move || run_cli(&cli, &["core", "update-index"], &cfg))
        .await
        .map_err(|e| e.to_string())??;

    // ── Selective ESP32 install ──────────────────────────────────────────────
    phase("downloading-platform", 0);
    install_esp32(arduino_dir, tmp_dir, report).await?;

    // ── Selective Arduino AVR (Uno) install ──────────────────────────────────
    install_arduino_avr(arduino_dir, tmp_dir, report).await?;

    // Safety-net prune: keep only the esp32s3 per-chip subdir inside
    // esp32-arduino-libs (the skipped tools are never downloaded now).
    phase("pruning", 0);
    let packages = arduino_dir.join("packages").join("esp32").join("tools");
    let libs_root = packages.join("esp32-arduino-libs");
    if libs_root.exists() {
        let remove_chips = ["esp32", "esp32c3", "esp32c6", "esp32h2", "esp32p4", "esp32s2"];
        if let Ok(versions) = fs::read_dir(&libs_root) {
            for ver in versions.flatten() {
                let ver_path = ver.path();
                if ver_path.is_dir() {
                    for chip in &remove_chips {
                        let cp = ver_path.join(chip);
                        if cp.exists() {
                            let _ = fs::remove_dir_all(&cp);
                        }
                    }
                }
            }
        }
    }

    phase("done", 100);
    Ok(())
}
