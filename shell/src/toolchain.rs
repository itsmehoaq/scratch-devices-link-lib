//! Toolchain auto-setup. Downloads the pre-packaged arduino-cli + ESP32 + AVR
//! toolchain from the GitHub Tools release as a `.7z` archive and extracts it
//! with sevenz-rust2. No per-tool or per-core download is needed after this.
//!
//! If pre-shipped tools are already present on disk, the download is skipped.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::download;
#[cfg(unix)]
use crate::progress::Spinner;

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

/// Check whether `tools_path/Arduino/arduino-cli[.exe]` exists.
pub fn check_toolchain(tools_path: &Path) -> (bool, PathBuf) {
    let cli_path = tools_path.join("Arduino").join(CLI_FILE);
    (cli_path.exists(), cli_path)
}

/// Download and extract the pre-packaged tools archive (arduino-cli + ESP32
/// core + AVR core) from the GitHub Tools release. Reports progress via the
/// `report` callback. Calls `report` with phases: downloading-tools | done
pub async fn setup_toolchain(tools_path: &Path, report: ProgressFn) -> Result<(), String> {
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

    phase("downloading-tools", 100);

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
