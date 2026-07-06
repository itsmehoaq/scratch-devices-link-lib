//! Toolchain auto-setup. Downloads the pre-packaged arduino-cli + ESP32 + AVR
//! toolchain from the GitHub Tools release as a `.7z` archive and extracts it
//! with 7zr. No per-tool or per-core download is needed after this.
//!
//! If pre-shipped tools are already present on disk, the download is skipped.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::download;

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
/// core + AVR core) from the GitHub Tools release using 7zr. Reports progress
/// via the `report` callback. Calls `report` with phases: downloading-tools | done
pub async fn setup_toolchain(
    tools_path: &Path,
    report: ProgressFn,
) -> Result<(), String> {
    let cli_path = tools_path.join("Arduino").join(CLI_FILE);

    let phase = |phase: &str, progress: u8| {
        report(SetupProgress {
            phase: phase.to_string(),
            progress,
        });
    };

    phase("downloading-tools", 0);
    match download::ensure_tools(tools_path) {
        download::ToolsStatus::Present | download::ToolsStatus::Downloaded => {}
        download::ToolsStatus::Failed => {
            return Err("tools download/fetch failed".to_string());
        }
    }
    phase("downloading-tools", 100);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if cli_path.exists() {
            let mut perms = fs::metadata(cli_path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(cli_path, perms).map_err(|e| e.to_string())?;
        }
    }

    phase("done", 100);
    Ok(())
}
