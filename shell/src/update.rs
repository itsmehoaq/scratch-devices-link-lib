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

use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};
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
    /// Version tag from GitHub, e.g. `"2.0.6"` (the `v` prefix is stripped).
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

    let remote_tag = release.tag_name.strip_prefix('v').unwrap_or(&release.tag_name);

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
        Ok(r) => {
            return DownloadOutcome::Failed(format!(
                "Download returned HTTP {}",
                r.status()
            ))
        }
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

/// Extract the new binary from the downloaded zip and stage it beside the
/// current executable (as `FutureAcademyTray.new` / `.new.exe`).
///
/// This does NOT replace the running binary — the caller should signal a
/// restart so a short-lived launcher (or a restart wrapper) can perform the
/// final swap.
pub fn apply_update(archive_bytes: &[u8]) -> ApplyOutcome {
    let exe = current_exe();
    let parent = exe.parent().unwrap_or(Path::new("."));

    // The zip has the binary name for this platform.
    #[cfg(target_os = "windows")]
    const BIN_NAME: &str = "FutureAcademyTray.exe";
    #[cfg(not(target_os = "windows"))]
    const BIN_NAME: &str = "FutureAcademyTray";

    // Read the zip from memory.
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
            return ApplyOutcome::Failed(format!(
                "Binary '{}' not found in update zip",
                BIN_NAME
            ));
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
                return ApplyOutcome::Failed(format!(
                    "Failed to create staging file: {e}"
                ));
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

    // Make it executable on Unix.
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&staging_path, std::fs::Permissions::from_mode(0o755)) {
            let _ = std::fs::remove_file(&staging_path);
            return ApplyOutcome::Failed(format!("Failed to set executable bit: {e}"));
        }
    }

    tracing::info!(
        "[update] staged new binary at {}",
        staging_path.display()
    );

    ApplyOutcome::RestartRequired
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
}
