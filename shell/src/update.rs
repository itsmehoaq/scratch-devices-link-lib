//! OTA self-update module.
//!
//! Checks the configured R2 OTA manifest for a newer version of the tray
//! binary, with GitHub Releases as a fallback. Downloads the matching platform
//! archive, verifies its SHA256, extracts the binary, swaps it with the current
//! executable, and restarts.
//!
//! Release asset naming on GitHub:
//! - `FutureAcademy-win.zip`    → Windows
//! - `FutureAcademy-arm64.zip`  → macOS Apple Silicon
//! - `FutureAcademy-intel.zip`  → macOS Intel

#[cfg(target_os = "windows")]
use std::io::BufWriter;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};

// ── GitHub API response types ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GithubRelease {
    #[serde(rename = "tag_name")]
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    /// SHA256 hex digest provided by the release action.
    digest: Option<String>,
    /// Content-Length (bytes).
    size: Option<u64>,
    #[serde(rename = "browser_download_url")]
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct OtaManifest {
    schema_version: u32,
    version: String,
    assets: Vec<OtaAsset>,
}

#[derive(Debug, Deserialize)]
struct OtaAsset {
    name: String,
    url: String,
    sha256: String,
    size: Option<u64>,
}

// ── Public types ────────────────────────────────────────────────────────────

/// Result of checking for an update.
#[derive(Debug, Clone)]
pub enum UpdateCheck {
    /// Local version is up-to-date (or newer).
    UpToDate,
    /// A newer version is available.
    Available(UpdateInfo),
    /// The check failed (network, parse, etc.).
    Error(String),
}

/// Describes an available update.
#[derive(Debug, Clone)]
pub struct UpdateInfo {
    /// Remote version, e.g. `"2.0.8"` (any `v` prefix is stripped).
    pub version: String,
    /// Human-readable label, e.g. `"v2.0.6"`.
    pub version_label: String,
    /// Download URL for the platform-matching asset.
    pub download_url: String,
    /// Expected SHA256 hex digest.
    pub sha256: Option<String>,
    /// File size in bytes (from the API).
    pub size: Option<u64>,
}

/// Outcome of a download attempt.
#[derive(Debug)]
pub enum DownloadOutcome {
    /// Payload bytes (the zip archive).
    Downloaded(Vec<u8>),
    /// Something went wrong.
    Failed(String),
}

/// Result of applying an update.
#[derive(Debug)]
pub enum ApplyOutcome {
    /// The new binary was staged; the caller should exit so the launcher
    /// (or the OS) picks up the replacement.
    RestartRequired,
    /// Something went wrong.
    Failed(String),
}

// ── Platform helpers ────────────────────────────────────────────────────────

/// Returns the release asset name for the current platform, e.g.
/// `"FutureAcademy-win.zip"`.
fn platform_asset_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "FutureAcademy-win.zip"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "FutureAcademy-arm64.zip"
    }
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    {
        "FutureAcademy-intel.zip"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "FutureAcademy-intel.zip"
    }
}

/// Returns the current running binary's path.
fn current_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("FutureAcademyTray"))
}

/// Parse a version string like `"v2.0.5"` or `"2.0.5"` into a comparable
/// `(major, minor, patch)` tuple. Returns `None` on malformed input.
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.strip_prefix('v').unwrap_or(s);
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

/// Returns `true` if `remote` is strictly newer than `local` (semver comparison).
fn is_newer(local: &str, remote: &str) -> bool {
    match (parse_version(local), parse_version(remote)) {
        (Some(l), Some(r)) => r > l,
        _ => false,
    }
}

fn ota_manifest_url() -> Option<&'static str> {
    option_env!("OTA_MANIFEST_URL")
        .map(str::trim)
        .filter(|url| !url.is_empty())
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Check the configured OTA source for a newer version.
///
/// Called from the async runtime thread (or a blocking context via
/// `tokio::task::spawn_blocking`). Returns an `UpdateCheck` variant.
pub async fn check_for_update(client: &Client) -> UpdateCheck {
    if let Some(url) = ota_manifest_url() {
        match check_ota_manifest(client, url).await {
            UpdateCheck::Error(error) => {
                tracing::warn!(
                    "[update] R2 manifest check failed, falling back to GitHub: {}",
                    error
                );
            }
            result => return result,
        }
    }

    check_github_release(client).await
}

async fn check_ota_manifest(client: &Client, url: &str) -> UpdateCheck {
    let local_ver = env!("CARGO_PKG_VERSION");

    let resp = match client
        .get(url)
        .header("User-Agent", "FutureAcademyLink/2.0")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            return UpdateCheck::Error(format!("R2 OTA manifest returned HTTP {}", r.status()))
        }
        Err(e) => return UpdateCheck::Error(format!("R2 OTA manifest request failed: {e}")),
    };

    let manifest: OtaManifest = match resp.json().await {
        Ok(manifest) => manifest,
        Err(e) => return UpdateCheck::Error(format!("Failed to parse R2 OTA manifest: {e}")),
    };

    if manifest.schema_version != 1 {
        return UpdateCheck::Error(format!(
            "Unsupported R2 OTA manifest schema: {}",
            manifest.schema_version
        ));
    }

    if !is_newer(local_ver, &manifest.version) {
        return UpdateCheck::UpToDate;
    }

    let target_name = platform_asset_name();
    let asset = match manifest
        .assets
        .iter()
        .find(|asset| asset.name == target_name)
    {
        Some(asset) => asset,
        None => {
            return UpdateCheck::Error(format!(
                "No R2 OTA asset found for platform ({}) in release v{}",
                target_name, manifest.version
            ));
        }
    };

    if !asset.url.starts_with("https://") {
        return UpdateCheck::Error(format!("R2 OTA asset URL must use HTTPS: {}", asset.url));
    }

    if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return UpdateCheck::Error(format!(
            "R2 OTA asset has an invalid SHA256 digest: {}",
            asset.name
        ));
    }

    UpdateCheck::Available(UpdateInfo {
        version: manifest.version.clone(),
        version_label: format!("v{}", manifest.version),
        download_url: asset.url.clone(),
        sha256: Some(asset.sha256.clone()),
        size: asset.size,
    })
}

async fn check_github_release(client: &Client) -> UpdateCheck {
    let url = "https://api.github.com/repos/itsmehoaq/scratch-devices-link-lib/releases/latest";
    let local_ver = env!("CARGO_PKG_VERSION");

    let resp = match client
        .get(url)
        .header("User-Agent", "FutureAcademyLink/2.0")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return UpdateCheck::Error(format!("GitHub API returned HTTP {}", r.status())),
        Err(e) => {
            return UpdateCheck::Error(format!("GitHub API request failed: {e}"));
        }
    };

    let release: GithubRelease = match resp.json().await {
        Ok(r) => r,
        Err(e) => return UpdateCheck::Error(format!("Failed to parse release JSON: {e}")),
    };

    let remote_tag = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);

    if !is_newer(local_ver, remote_tag) {
        return UpdateCheck::UpToDate;
    }

    // Find the asset matching this platform.
    let target_name = platform_asset_name();
    let asset = match release.assets.iter().find(|a| a.name == target_name) {
        Some(a) => a,
        None => {
            return UpdateCheck::Error(format!(
                "No asset found for platform ({}) in release {}",
                target_name, release.tag_name
            ));
        }
    };

    UpdateCheck::Available(UpdateInfo {
        version: remote_tag.to_string(),
        version_label: release.tag_name.clone(),
        download_url: asset.browser_download_url.clone(),
        sha256: asset.digest.clone(),
        size: asset.size,
    })
}

/// Download the update zip into memory.
///
/// Returns the raw bytes on success. The caller can verify SHA256 before
/// extracting, and write to disk when ready to apply.
pub async fn download_update(
    client: &Client,
    info: &UpdateInfo,
    on_progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
) -> DownloadOutcome {
    let resp = match client
        .get(&info.download_url)
        .header("User-Agent", "FutureAcademyLink/2.0")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return DownloadOutcome::Failed(format!("Download returned HTTP {}", r.status())),
        Err(e) => return DownloadOutcome::Failed(format!("Download failed: {e}")),
    };

    let total = info.size.unwrap_or(0);
    let mut received: u64 = 0;
    let mut body = Vec::new();

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return DownloadOutcome::Failed(format!("Stream error: {e}")),
        };
        received += chunk.len() as u64;
        body.extend_from_slice(&chunk);
        if let Some(ref cb) = on_progress {
            cb(received, total);
        }
    }

    // Verify SHA256 if the release provides a digest.
    if let Some(ref expected_digest) = info.sha256 {
        let expected_hex = expected_digest
            .strip_prefix("sha256:")
            .unwrap_or(expected_digest);
        let mut hasher = Sha256::new();
        hasher.update(&body);
        let actual_hex = hex::encode(hasher.finalize());
        if !actual_hex.eq_ignore_ascii_case(expected_hex) {
            return DownloadOutcome::Failed(format!(
                "SHA256 mismatch: expected {}, got {}",
                expected_hex, actual_hex
            ));
        }
        tracing::info!("[update] sha256 ok ({})", actual_hex);
    }

    DownloadOutcome::Downloaded(body)
}

/// Stage the downloaded update and start a detached platform helper that waits
/// for this process to exit, swaps the staged application into place, and
/// relaunches it.
pub fn apply_update(archive_bytes: &[u8]) -> ApplyOutcome {
    apply_update_for_platform(archive_bytes)
}

#[cfg(target_os = "macos")]
fn apply_update_for_platform(archive_bytes: &[u8]) -> ApplyOutcome {
    let exe = current_exe();
    let app_bundle = match exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("app"))
    {
        Some(path) => path.to_path_buf(),
        None => {
            return ApplyOutcome::Failed(format!(
                "Running executable is not inside a macOS app bundle: {}",
                exe.display()
            ));
        }
    };

    let install_parent = match app_bundle.parent() {
        Some(path) => path,
        None => return ApplyOutcome::Failed("App bundle has no parent directory".to_string()),
    };
    let staging_container =
        install_parent.join(format!(".future-academy-update-{}", std::process::id()));
    if staging_container.exists() {
        if let Err(error) = std::fs::remove_dir_all(&staging_container) {
            return ApplyOutcome::Failed(format!("Failed to clear update staging: {error}"));
        }
    }
    if let Err(error) = std::fs::create_dir_all(&staging_container) {
        return ApplyOutcome::Failed(format!("Failed to create update staging: {error}"));
    }

    if let Err(error) = extract_zip_archive(archive_bytes, &staging_container) {
        let _ = std::fs::remove_dir_all(&staging_container);
        return ApplyOutcome::Failed(error);
    }

    let staged_bundle = match find_staged_app_bundle(&staging_container) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging_container);
            return ApplyOutcome::Failed(error);
        }
    };

    let staged_executable = staged_bundle
        .join("Contents")
        .join("MacOS")
        .join("FutureAcademyTray");
    if !staged_executable.is_file() {
        let _ = std::fs::remove_dir_all(&staging_container);
        return ApplyOutcome::Failed(format!(
            "Staged macOS app is missing {}",
            staged_executable.display()
        ));
    }

    let signature_valid = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&staged_bundle)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !signature_valid {
        let _ = std::fs::remove_dir_all(&staging_container);
        return ApplyOutcome::Failed(
            "Staged macOS app failed code-signature verification".to_string(),
        );
    }

    let backup_bundle = install_parent.join(format!(
        "{}.previous",
        app_bundle
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Future Academy Link.app")
    ));
    let helper_script = r#"
pid="$1"
current="$2"
staged="$3"
backup="$4"
container="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$backup"
if mv "$current" "$backup" && mv "$staged" "$current"; then
    rm -rf "$backup" "$container"
    open "$current"
else
    if [ -e "$backup" ] && [ ! -e "$current" ]; then mv "$backup" "$current"; fi
    exit 1
fi
"#;

    let spawn_result = Command::new("/bin/sh")
        .arg("-c")
        .arg(helper_script)
        .arg("future-academy-updater")
        .arg(std::process::id().to_string())
        .arg(&app_bundle)
        .arg(&staged_bundle)
        .arg(&backup_bundle)
        .arg(&staging_container)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match spawn_result {
        Ok(_) => {
            tracing::info!(
                "[update] staged macOS app at {} and scheduled restart",
                staged_bundle.display()
            );
            ApplyOutcome::RestartRequired
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging_container);
            ApplyOutcome::Failed(format!("Failed to start macOS update helper: {error}"))
        }
    }
}

#[cfg(target_os = "macos")]
fn extract_zip_archive(archive_bytes: &[u8], destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let cursor = Cursor::new(archive_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("Failed to open update zip: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read update zip entry: {error}"))?;
        let relative_path = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe path in update zip: {}", entry.name()))?;
        let output_path = destination.join(relative_path);

        if entry.is_dir() {
            std::fs::create_dir_all(&output_path)
                .map_err(|error| format!("Failed to create update directory: {error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create update directory: {error}"))?;
        }
        let mut output = std::fs::File::create(&output_path)
            .map_err(|error| format!("Failed to create staged update file: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract staged update file: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("Failed to flush staged update file: {error}"))?;

        if let Some(mode) = entry.unix_mode() {
            std::fs::set_permissions(&output_path, std::fs::Permissions::from_mode(mode))
                .map_err(|error| format!("Failed to set staged file permissions: {error}"))?;
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn find_staged_app_bundle(staging_container: &Path) -> Result<PathBuf, String> {
    let entries = std::fs::read_dir(staging_container)
        .map_err(|error| format!("Failed to inspect staged update: {error}"))?;
    let app_bundles: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir() && path.extension().and_then(|ext| ext.to_str()) == Some("app")
        })
        .collect();

    if app_bundles.len() != 1 {
        return Err(format!(
            "Expected one app bundle in update zip, found {}",
            app_bundles.len()
        ));
    }
    Ok(app_bundles[0].clone())
}

#[cfg(target_os = "windows")]
fn apply_update_for_platform(archive_bytes: &[u8]) -> ApplyOutcome {
    const BIN_NAME: &str = "FutureAcademyTray.exe";

    let exe = current_exe();
    let parent = exe.parent().unwrap_or(Path::new("."));

    let cursor = Cursor::new(archive_bytes);
    let mut archive = match zip::ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(e) => return ApplyOutcome::Failed(format!("Failed to open update zip: {e}")),
    };

    // Find the binary inside the zip. It may be at the root or inside
    // a directory — search all entries.
    let bin_index = (0..archive.len()).find(|i| {
        archive
            .name_for_index(*i)
            .map(|n| {
                let name = n.replace('\\', "/");
                name.ends_with(BIN_NAME)
            })
            .unwrap_or(false)
    });

    let idx = match bin_index {
        Some(i) => i,
        None => {
            return ApplyOutcome::Failed(format!("Binary '{}' not found in update zip", BIN_NAME));
        }
    };

    let mut entry = match archive.by_index(idx) {
        Ok(e) => e,
        Err(e) => return ApplyOutcome::Failed(format!("Failed to read zip entry: {e}")),
    };

    // Stage next to the current exe as `.new`.
    let staging_name = format!("{}.new", BIN_NAME);
    let staging_path = parent.join(&staging_name);

    // Write the extracted binary.
    {
        let file = match std::fs::File::create(&staging_path) {
            Ok(f) => f,
            Err(e) => {
                return ApplyOutcome::Failed(format!("Failed to create staging file: {e}"));
            }
        };
        let mut writer = BufWriter::new(file);
        if let Err(e) = std::io::copy(&mut entry, &mut writer) {
            let _ = std::fs::remove_file(&staging_path);
            return ApplyOutcome::Failed(format!("Failed to extract binary: {e}"));
        }
        if let Err(e) = writer.flush() {
            let _ = std::fs::remove_file(&staging_path);
            return ApplyOutcome::Failed(format!("Failed to flush binary: {e}"));
        }
    }

    let helper_path =
        std::env::temp_dir().join(format!("future-academy-updater-{}.ps1", std::process::id()));
    let helper_script = r#"param(
    [int]$ProcessToWait,
    [string]$CurrentExecutable,
    [string]$StagedExecutable
)
$ErrorActionPreference = 'Stop'
Wait-Process -Id $ProcessToWait -ErrorAction SilentlyContinue
$BackupExecutable = "$CurrentExecutable.previous"
$MovedCurrent = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
        if (Test-Path $BackupExecutable) { Remove-Item -Force $BackupExecutable }
        Move-Item -Force $CurrentExecutable $BackupExecutable
        $MovedCurrent = $true
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (!$MovedCurrent) { exit 1 }
try {
    Move-Item -Force $StagedExecutable $CurrentExecutable
    Start-Process $CurrentExecutable
    Remove-Item -Force $BackupExecutable
    Remove-Item -Force $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue
    exit 0
} catch {
    if (Test-Path $CurrentExecutable) { Remove-Item -Force $CurrentExecutable }
    if (Test-Path $BackupExecutable) {
        Move-Item -Force $BackupExecutable $CurrentExecutable
        Start-Process $CurrentExecutable -ErrorAction SilentlyContinue
    }
    exit 1
}
"#;

    if let Err(error) = std::fs::write(&helper_path, helper_script) {
        let _ = std::fs::remove_file(&staging_path);
        return ApplyOutcome::Failed(format!("Failed to create Windows update helper: {error}"));
    }

    let spawn_result = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(&helper_path)
        .arg("-ProcessToWait")
        .arg(std::process::id().to_string())
        .arg("-CurrentExecutable")
        .arg(&exe)
        .arg("-StagedExecutable")
        .arg(&staging_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    if let Err(error) = spawn_result {
        let _ = std::fs::remove_file(&helper_path);
        let _ = std::fs::remove_file(&staging_path);
        return ApplyOutcome::Failed(format!("Failed to start Windows update helper: {error}"));
    }

    tracing::info!(
        "[update] staged Windows executable at {} and scheduled restart",
        staging_path.display()
    );
    ApplyOutcome::RestartRequired
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply_update_for_platform(_archive_bytes: &[u8]) -> ApplyOutcome {
    ApplyOutcome::Failed("Automatic updates are unsupported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_newer, parse_version, OtaManifest};

    #[test]
    fn parses_stable_versions_with_optional_v_prefix() {
        assert_eq!(parse_version("2.0.7"), Some((2, 0, 7)));
        assert_eq!(parse_version("v2.0.7"), Some((2, 0, 7)));
        assert_eq!(parse_version("2.0"), None);
    }

    #[test]
    fn only_accepts_strictly_newer_versions() {
        assert!(is_newer("2.0.6", "2.0.7"));
        assert!(is_newer("2.0.6", "3.0.0"));
        assert!(!is_newer("2.0.6", "2.0.6"));
        assert!(!is_newer("2.0.6", "1.9.9"));
    }

    #[test]
    fn parses_generated_ota_manifest_contract() {
        let manifest: OtaManifest = serde_json::from_str(
            r#"{
                "schema_version": 1,
                "version": "2.0.7",
                "published_at": "2026-07-10T00:00:00.000Z",
                "assets": [{
                    "name": "FutureAcademy-win.zip",
                    "url": "https://updates.example.com/ota/releases/v2.0.7/FutureAcademy-win.zip",
                    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "size": 123
                }]
            }"#,
        )
        .expect("generated manifest should deserialize");

        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.version, "2.0.7");
        assert_eq!(manifest.assets[0].name, "FutureAcademy-win.zip");
        assert_eq!(manifest.assets[0].size, Some(123));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn extracts_complete_macos_app_bundle() {
        use super::{extract_zip_archive, find_staged_app_bundle};
        use std::io::{Cursor, Write};
        use std::os::unix::fs::PermissionsExt;
        use zip::write::SimpleFileOptions;

        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let directory_options = SimpleFileOptions::default().unix_permissions(0o755);
        let executable_options = SimpleFileOptions::default().unix_permissions(0o755);
        writer
            .add_directory("Future Academy Link.app/Contents/MacOS/", directory_options)
            .expect("add app directory");
        writer
            .start_file(
                "Future Academy Link.app/Contents/MacOS/FutureAcademyTray",
                executable_options,
            )
            .expect("add app executable");
        writer
            .write_all(b"test executable")
            .expect("write app executable");
        let archive_bytes = writer.finish().expect("finish test zip").into_inner();

        let destination = std::env::temp_dir().join(format!(
            "future-academy-extract-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::create_dir_all(&destination).expect("create test destination");

        extract_zip_archive(&archive_bytes, &destination).expect("extract app bundle");
        let app_bundle = find_staged_app_bundle(&destination).expect("find app bundle");
        let executable = app_bundle
            .join("Contents")
            .join("MacOS")
            .join("FutureAcademyTray");
        assert_eq!(std::fs::read(&executable).unwrap(), b"test executable");
        assert_ne!(
            std::fs::metadata(&executable).unwrap().permissions().mode() & 0o111,
            0
        );

        std::fs::remove_dir_all(&destination).expect("remove test destination");
    }
}
