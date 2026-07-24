//! Atomic runtime installation of the platform tool package.
//!
//! The archive is downloaded and extracted beside the destination using only
//! Rust APIs. The staged package is permission-repaired and fully validated
//! before it replaces an existing install, which keeps retries safe and avoids
//! shell quoting/code-page problems on Windows.

use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(target_os = "macos")]
pub const TOOLS_7Z: &str = "tools-mac.7z";
#[cfg(not(target_os = "macos"))]
pub const TOOLS_7Z: &str = "tools.7z";

pub const ASSET_BASE: &str =
    "https://github.com/Kannoki/scratch-devices-link-lib/releases/download/Tools/";

const DOWNLOAD_ATTEMPTS: usize = 3;

pub type ProgressFn = Arc<dyn Fn(u8) + Send + Sync + 'static>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolsStatus {
    Present,
    Downloaded,
    Failed(String),
}

/// Validate an existing install or atomically replace it with a fresh package.
pub fn ensure_tools(tools_path: &Path, progress: ProgressFn) -> ToolsStatus {
    match crate::toolchain::repair_executable_permissions(tools_path) {
        Ok(repaired) if repaired > 0 => {
            tracing::info!("[tools] restored execute permission on {repaired} files");
        }
        Ok(_) => {}
        Err(error) => tracing::warn!("[tools] permission repair failed: {error}"),
    }

    let current = crate::toolchain::validate_toolchain(tools_path);
    if current.is_ready() {
        progress(100);
        return ToolsStatus::Present;
    }
    if tools_path.exists() {
        tracing::warn!(
            "[tools] existing package is incomplete: {}",
            current.missing.join("; ")
        );
    }

    tracing::info!(
        "[tools] installing {} into {}",
        TOOLS_7Z,
        tools_path.display()
    );
    match download_extract_and_install(tools_path, progress) {
        Ok(()) => ToolsStatus::Downloaded,
        Err(error) => ToolsStatus::Failed(format!("tool package installation failed: {error}")),
    }
}

fn download_extract_and_install(tools_path: &Path, progress: ProgressFn) -> Result<(), String> {
    let parent = tools_path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|error| format!("create tools parent {}: {error}", parent.display()))?;

    let id = Uuid::new_v4().simple().to_string();
    let archive = parent.join(format!(".windy-tools-{id}.7z.partial"));
    let stage = parent.join(format!(".windy-tools-{id}.stage"));
    let url = format!("{ASSET_BASE}{TOOLS_7Z}");

    let result = (|| {
        download_with_retries(&url, &archive, progress.clone())?;
        fs::create_dir(&stage)
            .map_err(|error| format!("create extraction stage {}: {error}", stage.display()))?;
        // sevenz-rust2 has historically panicked inside Windows path APIs for
        // some Unicode/junction paths. Convert that panic into a normal setup
        // failure so the previous atomic install remains usable.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sevenz_rust2::decompress_file(&archive, &stage)
        }))
        .map_err(|panic| {
            let message = panic
                .downcast_ref::<&str>()
                .map(|message| (*message).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown sevenz-rust2 panic".to_string());
            format!("extract {TOOLS_7Z} panicked: {message}")
        })?
        .map_err(|error| format!("extract {TOOLS_7Z}: {error}"))?;

        let prepared = extracted_package_root(&stage)?;
        let repaired = crate::toolchain::repair_executable_permissions(&prepared)?;
        if repaired > 0 {
            tracing::info!("[tools] restored execute permission on {repaired} staged files");
        }
        let validation = crate::toolchain::validate_toolchain(&prepared);
        if !validation.is_ready() {
            return Err(format!(
                "downloaded archive is incomplete: {}",
                validation.missing.join("; ")
            ));
        }

        replace_atomically(&prepared, tools_path)?;
        progress(100);
        Ok(())
    })();

    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir_all(&stage);
    result
}

fn download_with_retries(
    url: &str,
    destination: &Path,
    progress: ProgressFn,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        progress(0);
        match download_once(url, destination, progress.clone()) {
            Ok(()) => return Ok(()),
            Err(error) => {
                errors.push(format!("attempt {attempt}: {error}"));
                let _ = fs::remove_file(destination);
            }
        }
    }
    Err(format!(
        "download failed after {DOWNLOAD_ATTEMPTS} attempts ({})",
        errors.join(" | ")
    ))
}

fn download_once(url: &str, destination: &Path, progress: ProgressFn) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(90))
        .timeout_write(Duration::from_secs(90))
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|error| format!("GET {url}: {error}"))?;
    if !(200..300).contains(&response.status()) {
        return Err(format!("GET {url}: HTTP {}", response.status()));
    }

    let expected_size = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    let file = fs::File::create(destination)
        .map_err(|error| format!("create {}: {error}", destination.display()))?;
    let mut writer = BufWriter::new(file);
    let mut reader = response.into_reader();
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    let mut buffer = [0_u8; 256 * 1024];

    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("read response: {error}"))?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|error| format!("write {}: {error}", destination.display()))?;
        hasher.update(&buffer[..count]);
        received += count as u64;
        if let Some(total) = expected_size.filter(|total| *total > 0) {
            let percent = ((received.saturating_mul(100)) / total).min(99) as u8;
            progress(percent);
        }
    }
    writer
        .flush()
        .map_err(|error| format!("flush {}: {error}", destination.display()))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| format!("sync {}: {error}", destination.display()))?;

    if let Some(expected) = expected_size {
        if received != expected {
            return Err(format!(
                "truncated response: received {received} of {expected} bytes"
            ));
        }
    }
    if received == 0 {
        return Err("server returned an empty archive".to_string());
    }

    tracing::info!(
        "[tools] downloaded {received} bytes; sha256={}",
        hex::encode(hasher.finalize())
    );
    Ok(())
}

/// Accept either an archive with a single `tools/` wrapper or a flat archive.
fn extracted_package_root(stage: &Path) -> Result<PathBuf, String> {
    let entries: Vec<PathBuf> = fs::read_dir(stage)
        .map_err(|error| format!("read extraction stage {}: {error}", stage.display()))?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| format!("read extracted entry: {error}"))
        })
        .collect::<Result<_, _>>()?;

    if entries.len() == 1 && entries[0].is_dir() {
        Ok(entries[0].clone())
    } else if entries.is_empty() {
        Err("archive extracted no files".to_string())
    } else {
        Ok(stage.to_path_buf())
    }
}

/// Replace `destination` only after `prepared` has passed validation.
///
/// Both paths are siblings on the same filesystem, so rename is atomic. If
/// activation fails, the previous package is restored.
fn replace_atomically(prepared: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let backup = parent.join(format!(".windy-tools-backup-{}", Uuid::new_v4().simple()));
    let had_previous = destination.exists();

    if had_previous {
        fs::rename(destination, &backup).map_err(|error| {
            format!(
                "move previous tools package {} aside: {error}",
                destination.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(prepared, destination) {
        if had_previous {
            let _ = fs::rename(&backup, destination);
        }
        return Err(format!(
            "activate tools package at {}: {error}",
            destination.display()
        ));
    }

    if had_previous {
        if let Err(error) = fs::remove_dir_all(&backup) {
            tracing::warn!(
                "[tools] could not remove previous package {}: {error}",
                backup.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn detects_wrapped_and_flat_archives() {
        let wrapped = test_root("tools-wrapped");
        fs::create_dir_all(wrapped.join("tools/Arduino")).unwrap();
        assert_eq!(
            extracted_package_root(&wrapped).unwrap(),
            wrapped.join("tools")
        );

        let flat = test_root("tools-flat");
        fs::create_dir_all(flat.join("Arduino")).unwrap();
        fs::write(flat.join("manifest.json"), b"{}").unwrap();
        assert_eq!(extracted_package_root(&flat).unwrap(), flat);

        fs::remove_dir_all(wrapped).unwrap();
        fs::remove_dir_all(flat).unwrap();
    }

    #[test]
    fn atomically_replaces_existing_package_under_unicode_path() {
        let root = test_root("Công cụ");
        let destination = root.join("Thiết bị");
        let prepared = root.join("prepared");
        fs::create_dir_all(&destination).unwrap();
        fs::create_dir_all(&prepared).unwrap();
        fs::write(destination.join("version"), b"old").unwrap();
        fs::write(prepared.join("version"), b"new").unwrap();

        replace_atomically(&prepared, &destination).unwrap();
        assert_eq!(fs::read(destination.join("version")).unwrap(), b"new");
        assert!(!prepared.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
