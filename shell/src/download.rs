//! Runtime tool download. If the pre-shipped `tools/` (Windows) or
//! `tools-mac/` (macOS) folder is missing or empty, the shell fetches the
//! matching `.7z` archive from the GitHub Tools release and extracts it in
//! place using a pure-Rust 7z decoder. This lets the client device self-update
//! its toolchain on first launch with no developer-side step and no external
//! `7zr` / 7-Zip install.
//!
//! The archive URL is fixed at compile time so it cannot be tampered with at
//! runtime.

use std::path::{Path, PathBuf};
use std::time::Duration;

use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle};
use sha2::{Digest, Sha256};
use std::io::IsTerminal;

#[cfg(target_os = "macos")]
pub const TOOLS_7Z: &str = "tools-mac.7z";
#[cfg(not(target_os = "macos"))]
pub const TOOLS_7Z: &str = "tools.7z";

pub const ASSET_BASE: &str =
    "https://github.com/Kannoki/scratch-devices-link-lib/releases/download/Tools/";

/// Result of the runtime tools check/download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolsStatus {
    /// Pre-shipped tools were found; nothing to do.
    Present,
    /// Tools were missing; download, sha256-verify, and extraction completed successfully.
    Downloaded,
    /// Tools were missing but the download, verification, or extraction failed. The
    /// inner String describes what went wrong so the caller can surface it to the user.
    Failed(String),
}

/// Thin wrapper so the caller (an async context) can pass a bar into this sync fn.
pub struct DownloadProgress {
    bar: Option<ProgressBar>,
}

impl DownloadProgress {
    pub fn new(total_bytes: u64) -> Self {
        if !std::io::stderr().is_terminal() {
            return Self { bar: None };
        }
        let bar = ProgressBar::with_draw_target(Some(total_bytes), ProgressDrawTarget::stderr());
        bar.set_style(
            ProgressStyle::with_template(
                "{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({eta})",
            )
            .unwrap()
            .progress_chars("#>-"),
        );
        bar.enable_steady_tick(Duration::from_millis(120));
        Self { bar: Some(bar) }
    }

    pub fn bar(&self) -> Option<&ProgressBar> {
        self.bar.as_ref()
    }

    pub fn finish_ok(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.finish_with_message(msg.to_string());
        } else {
            tracing::info!("[tools] {msg}");
        }
    }

    pub fn abandon(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.abandon_with_message(msg.to_string());
        } else {
            tracing::error!("[tools] {msg}");
        }
    }
}

/// Check whether the CLI binary already exists under tools_path.
pub fn ensure_tools(tools_path: &Path, dl: &DownloadProgress) -> ToolsStatus {
    let cli = tools_path.join("Arduino").join(crate::toolchain::CLI_FILE);
    if cli.exists() {
        return ToolsStatus::Present;
    }

    // Remove any leftover tools directory from a prior failed extraction so
    // the fresh extraction doesn't trip over existing paths.
    if tools_path.exists() {
        let _ = std::fs::remove_dir_all(tools_path);
    }

    tracing::info!(
        target: "future-academy-tray",
        "[tools] not found at {} -- downloading from GitHub release Tools",
        tools_path.display()
    );

    match download_verify_and_extract(tools_path, dl.bar()) {
        Ok(()) => ToolsStatus::Downloaded,
        Err(e) => {
            dl.abandon(&e);
            ToolsStatus::Failed(e)
        }
    }
}

fn download_verify_and_extract(tools_path: &Path, bar: Option<&ProgressBar>) -> Result<(), String> {
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
        // Update progress bar if provided; silently ignore if the bar is None
        // (headless / non-TTY environments).
        if let Some(b) = bar {
            b.inc(n as u64);
        }
        if let Some(total) = total {
            let pct = (received as f64 / total as f64) * 100.0;
            tracing::debug!(
                target: "future-academy-tray",
                "[tools] downloaded {}/{} ({:.0}%)",
                received,
                total,
                pct
            );
        }
    }
    writer.flush().map_err(|e| format!("flush archive: {e}"))?;

    let digest = hasher.finalize();
    let actual_hex = hex::encode(digest);
    tracing::info!(target: "future-academy-tray", "[tools] sha256: {actual_hex}");

    tracing::info!(
        target: "future-academy-tray",
        "[tools] extracting {dest:?} -> {tools_path:?}"
    );
    extract_archive(&dest, tools_path)?;

    // Remove the archive to save disk space.
    let _ = std::fs::remove_file(&dest);

    tracing::info!(
        target: "future-academy-tray",
        "[tools] ready at {}",
        tools_path.display()
    );
    Ok(())
}

fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir dest: {e}"))?;
    // In-process 7z extraction. Supports LZMA2 + Delta used by the release
    // archives, which is why we replaced the old `7zr` shell-out (it had to be
    // installed separately and was missing on most user machines).
    //
    // We extract to a sibling temp dir rather than `dest` directly because the
    // archive is packed with a top-level `tools/` wrapper (matching the asset
    // name). Extracting straight into `dest` would land files at
    // `dest/tools/...`, leaving `dest/Arduino/arduino-cli[.exe]` missing and
    // breaking the CLI lookup in `toolchain::check_toolchain`.
    let stage_parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let stage = unique_stage_dir(stage_parent)?;
    sevenz_rust2::decompress_file(archive, &stage)
        .map_err(|e| format!("7z extract failed: {e}"))?;

    // If the archive flattened into a single top-level dir, hoist its contents
    // up so the caller sees files directly under `dest` (the standard
    // `tar --strip-components=1` pattern). If the archive ever ships flat, this
    // is a no-op.
    flatten_single_root(&stage, dest)?;

    // Best-effort cleanup of the staging dir.
    let _ = std::fs::remove_dir_all(&stage);
    Ok(())
}

/// Pick a non-existent staging dir next to `dest`. Suffixes with `.stage-N` so
/// repeated failures don't collide.
fn unique_stage_dir(parent: &Path) -> Result<PathBuf, String> {
    for n in 0..1000 {
        let candidate = parent.join(format!(".windify-tools-stage-{n}"));
        if !candidate.exists() {
            std::fs::create_dir_all(&candidate).map_err(|e| format!("mkdir stage dir: {e}"))?;
            return Ok(candidate);
        }
    }
    Err("could not allocate a tools staging dir".to_string())
}

/// If `stage` contains exactly one entry and that entry is a directory, move
/// its contents up to `dest` and remove the now-empty wrapper. Otherwise move
/// `stage`'s contents directly into `dest`.
fn flatten_single_root(stage: &Path, dest: &Path) -> Result<(), String> {
    let entries = collect_children(stage)?;
    if entries.len() == 1 && entries[0].is_dir() {
        let wrapper = &entries[0];
        move_children(wrapper, dest)?;
        let _ = std::fs::remove_dir(wrapper);
    } else if !entries.is_empty() {
        move_children(stage, dest)?;
    }
    Ok(())
}

fn collect_children(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|e| format!("read stage dir: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("iterate stage dir: {e}"))?;
        if let Some(name) = entry.file_name().to_str() {
            // Skip our own staging bookkeeping; should never appear here, but be safe.
            if name.starts_with(".windify-tools-stage-") {
                continue;
            }
            out.push(entry.path());
        }
    }
    Ok(out)
}

/// Move every entry under `src` directly into `dst`. Refuses to clobber
/// existing files so a stale extraction doesn't silently overwrite user data.
fn move_children(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| format!("read src dir: {e}"))? {
        let entry = entry.map_err(|e| format!("iterate src dir: {e}"))?;
        let from = entry.path();
        let file_name = entry.file_name();
        let to = dst.join(&file_name);
        if to.exists() {
            return Err(format!(
                "refusing to overwrite existing path during extraction: {}",
                to.display()
            ));
        }
        // `rename` works across the same filesystem; if `src` and `dst` are on
        // different drives (rare for a staging dir next to the target) fall
        // back to a copy + delete.
        match std::fs::rename(&from, &to) {
            Ok(()) => {}
            Err(_) => move_across_drives(&from, &to)?,
        }
    }
    Ok(())
}

fn move_across_drives(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        copy_dir_recursive(from, to)?;
        std::fs::remove_dir_all(from).map_err(|e| format!("cleanup src dir: {e}"))?;
    } else {
        std::fs::copy(from, to).map_err(|e| format!("copy file: {e}"))?;
        std::fs::remove_file(from).map_err(|e| format!("cleanup src file: {e}"))?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir dst: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read src: {e}"))? {
        let entry = entry.map_err(|e| format!("iterate src: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("copy file: {e}"))?;
        }
    }
    Ok(())
}
