//! Runtime tool download. If the pre-shipped `tools/` (Windows) or
//! `tools-mac/` (macOS) folder is missing or empty, the shell fetches the
//! matching `.7z` archive from the GitHub Tools release and extracts it in
//! place. This allows the client device to self-update its toolchain on
//! first launch without any developer-side step.
//!
//! The archive name and the release tag are fixed at compile time so they
//! cannot be tampered with at runtime.

use std::path::{Path, PathBuf};
use std::process::Command;

const TOOLS_7Z: &str = if cfg!(target_os = "macos") {
    "tools-mac.7z"
} else {
    "tools.7z"
};
const ASSET_BASE: &str =
    "https://github.com/Kannoki/scratch-devices-link-lib/releases/download/Tools/";

/// Result of the runtime tools check/download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolsStatus {
    /// Pre-shipped tools were found; nothing to do.
    Present,
    /// Tools were missing; download and extraction completed successfully.
    Downloaded,
    /// Tools were missing but the download or extraction failed. The caller
    /// should surface the returned error to the user.
    Failed,
}

/// Check whether `tools_path` already has arduino-cli, and if not, download
/// the appropriate `.7z` from the GitHub Tools release and extract it.
///
/// The function is intentionally synchronous so it can be called before the
/// event loop starts. On a fast connection the download is a few seconds;
/// the tray UI is already visible by then.
pub fn ensure_tools(tools_path: &Path) -> ToolsStatus {
    let cli = tools_path.join("Arduino").join(crate::toolchain::CLI_FILE);
    if cli.exists() {
        return ToolsStatus::Present;
    }

    tracing::info!(
        target: "future-academy-tray",
        "[tools] not found at {} — downloading from GitHub release Tools",
        tools_path.display()
    );

    match download_and_extract(tools_path) {
        Ok(()) => ToolsStatus::Downloaded,
        Err(e) => {
            tracing::error!(target: "future-academy-tray", "[tools] download failed: {e}");
            ToolsStatus::Failed
        }
    }
}

fn download_and_extract(tools_path: &Path) -> Result<(), String> {
    let asset_name = TOOLS_7Z;
    let download_url = format!("{ASSET_BASE}{asset_name}");

    // Resolve a 7-Zip extractor. We use `7zr` because the version bundled
    // with `7zip-bin` (21.07) rejects the modern LZMA2 + Delta method used
    // by the release archives. We try a few well-known locations before
    // falling back to the PATH.
    let sevenz = resolve_sevenz()?;

    // Download to a temp file beside the target so we can resume if needed.
    let tmp_dir = tools_path.parent().map(Path::new).unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(tmp_dir).map_err(|e| format!("mkdir tools parent: {e}"))?;
    let dest = tmp_dir.join(asset_name);

    tracing::info!(target: "future-academy-tray", "[tools] downloading {download_url}");
    let response = ureq::get(&download_url)
        .call()
        .map_err(|e| format!("download failed: {e}"))?;

    if !(200..300).contains(&response.status()) {
        return Err(format!("GitHub returned HTTP {}", response.status()));
    }

    let total = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok());

    let mut file = std::fs::File::create(&dest).map_err(|e| format!("create archive: {e}"))?;
    use std::io::{BufWriter, Write};
    let mut writer = BufWriter::new(&mut file);
    let mut received: u64 = 0;
    let mut reader = response.into_reader();

    let mut buf = [0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("read response: {e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("write archive: {e}"))?;
        received += n as u64;
        if let Some(total) = total {
            let pct = (received as f64 / total as f64) * 100.0;
            tracing::debug!(
                target: "future-academy-tray",
                "[tools] downloaded {}/{} ({:.0}%)",
                received, total, pct
            );
        }
    }
    writer.flush().map_err(|e| format!("flush archive: {e}"))?;

    tracing::info!(target: "future-academy-tray", "[tools] extracting {dest:?} -> {tools_path:?}");
    extract_archive(&sevenz, &dest, tools_path)?;

    // Remove the archive to save disk space.
    let _ = std::fs::remove_file(&dest);

    tracing::info!(target: "future-academy-tray", "[tools] ready at {}", tools_path.display());
    Ok(())
}

fn extract_archive(sevenz: &Path, archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir dest: {e}"))?;
    let output = Command::new(sevenz)
        .args(["x", archive.to_string_lossy().as_ref(), "-o"])
        .arg(dest.to_string_lossy().as_ref())
        .args(["-y", "-bso0", "-bsp0"])
        .output()
        .map_err(|e| format!("spawn 7zr: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("7zr exited {}: {}", output.status, stderr.trim()));
    }
    Ok(())
}

fn resolve_sevenz() -> Result<PathBuf, String> {
    // 1. Check beside the running binary first (packager copies it there).
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(parent) = exe_dir.parent() {
            let candidate = if cfg!(windows) {
                parent.join("7zr.exe")
            } else {
                parent.join("7zr")
            };
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // 2. Check a few well-known install locations.
    let candidates: &[&str] = if cfg!(windows) {
        &[
            r"C:\Program Files\7-Zip\7zr.exe",
            r"C:\Program Files (x86)\7-Zip\7zr.exe",
        ]
    } else {
        &["/usr/local/bin/7zr", "/opt/homebrew/bin/7zr", "/usr/bin/7zr"]
    };
    for c in candidates {
        let p = Path::new(c);
        if p.exists() {
            return Ok(p.to_path_buf());
        }
    }

    // 3. Fall back to whatever the OS resolves as `7zr` on PATH.
    let _name = if cfg!(windows) { "7zr.exe" } else { "7zr" };
    Err(format!(
        "7zr (modern 7-Zip standalone) not found. Install it or place it beside \
         the binary. Download from https://www.7-zip.org/download.html"
    ))
}
