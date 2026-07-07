//! Runtime tool download. If the pre-shipped `tools/` (Windows) or
//! `tools-mac/` (macOS) folder is missing or empty, the shell fetches the
//! matching `.7z` archive from the GitHub Tools release, verifies its SHA256,
//! and extracts it in place using a pure-Rust 7z decoder. This lets the client
//! device self-update its toolchain on first launch with no developer-side
//! step and no external `7zr` / 7-Zip install.
//!
//! The archive URL and its expected SHA256 are fixed at compile time so they
//! cannot be tampered with at runtime.

use std::path::Path;

use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
const TOOLS_7Z: &str = "tools-mac.7z";
#[cfg(not(target_os = "macos"))]
const TOOLS_7Z: &str = "tools.7z";

const ASSET_BASE: &str =
    "https://github.com/Kannoki/scratch-devices-link-lib/releases/download/Tools/";

/// Expected SHA256 of the matching archive, pinned at compile time. Used to
/// detect corrupted / truncated downloads and to reject any archive that
/// doesn't match the release we built against.
#[cfg(target_os = "macos")]
const TOOLS_SHA256_HEX: &str = "bb5e6be8018e670322635c27452e6eb48ae9a1e63da9cb1007009ce408a74409";
#[cfg(not(target_os = "macos"))]
const TOOLS_SHA256_HEX: &str = "fdbc2b63a10e230433cde5bf99059201bec4faebdf546cbc61b1cfa19781804b";

/// Result of the runtime tools check/download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolsStatus {
    /// Pre-shipped tools were found; nothing to do.
    Present,
    /// Tools were missing; download, sha256-verify, and extraction completed successfully.
    Downloaded,
    /// Tools were missing but the download, verification, or extraction failed. The caller
    /// should surface the returned error to the user.
    Failed,
}

/// Check whether `tools_path` already has arduino-cli, and if not, download
/// the appropriate `.7z` from the GitHub Tools release, verify its SHA256,
/// and extract it via the in-process 7z decoder.
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

    match download_verify_and_extract(tools_path) {
        Ok(()) => ToolsStatus::Downloaded,
        Err(e) => {
            tracing::error!(target: "future-academy-tray", "[tools] download failed: {e}");
            ToolsStatus::Failed
        }
    }
}

fn download_verify_and_extract(tools_path: &Path) -> Result<(), String> {
    let asset_name = TOOLS_7Z;
    let download_url = format!("{ASSET_BASE}{asset_name}");

    // Download to a temp file beside the target so we can stream SHA256 + write
    // to disk in a single pass, then drop the archive after extraction.
    let tmp_dir = tools_path
        .parent()
        .map(Path::new)
        .unwrap_or_else(|| Path::new("."));
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
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut reader = response.into_reader();

    let mut buf = [0u8; 256 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read response: {e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("write archive: {e}"))?;
        hasher.update(&buf[..n]);
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

    // Verify the archive against the compile-time pinned SHA256. A mismatch
    // usually means a truncated download or a release that changed since this
    // binary was built — fail loudly rather than extract garbage.
    let digest = hasher.finalize();
    let actual_hex = hex::encode(digest);
    let expected_hex = TOOLS_SHA256_HEX;
    if !actual_hex.eq_ignore_ascii_case(expected_hex) {
        let _ = std::fs::remove_file(&dest);
        return Err(format!(
            "sha256 mismatch for {asset_name}: expected {expected_hex}, got {actual_hex}"
        ));
    }
    tracing::info!(
        target: "future-academy-tray",
        "[tools] sha256 ok ({actual_hex})"
    );

    tracing::info!(target: "future-academy-tray", "[tools] extracting {dest:?} -> {tools_path:?}");
    extract_archive(&dest, tools_path)?;

    // Remove the archive to save disk space.
    let _ = std::fs::remove_file(&dest);

    tracing::info!(target: "future-academy-tray", "[tools] ready at {}", tools_path.display());
    Ok(())
}

fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir dest: {e}"))?;
    // In-process 7z extraction. Supports LZMA2 + Delta used by the release
    // archives, which is why we replaced the old `7zr` shell-out (it had to be
    // installed separately and was missing on most user machines).
    sevenz_rust2::decompress_file(archive, dest).map_err(|e| format!("7z extract failed: {e}"))
}
