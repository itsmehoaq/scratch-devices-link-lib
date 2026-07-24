//! Runtime toolchain setup and validation.
//!
//! The desktop app installs one platform-specific tools archive. Keeping this
//! module focused on that package avoids drifting between an archive installer
//! and a second per-component installer with different versions and layouts.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::download;

#[cfg(windows)]
pub const CLI_FILE: &str = "arduino-cli.exe";
#[cfg(not(windows))]
pub const CLI_FILE: &str = "arduino-cli";

pub const ESP32_INDEX_URL: &str =
    "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json";

/// Setup-phase + progress payload.
#[derive(Debug, Clone)]
pub struct SetupProgress {
    pub phase: String,
    pub progress: u8,
}

/// Shared progress sink. Cloneable so it can be captured by background tasks.
pub type ProgressFn = Arc<dyn Fn(SetupProgress) + Send + Sync + 'static>;

/// Full-package validation result. A CLI by itself is not a usable toolchain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolchainValidation {
    pub missing: Vec<String>,
}

impl ToolchainValidation {
    pub fn is_ready(&self) -> bool {
        self.missing.is_empty()
    }
}

fn expected_binary(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_file_named(root: &Path, file_name: &str) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }

    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if entry.file_name() == file_name {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Validate every package component required for ESP32-S3 compilation/upload.
///
/// The paths below intentionally allow arbitrary version directory names.
/// Tool releases can therefore update versions without changing the app.
pub fn validate_toolchain(tools_path: &Path) -> ToolchainValidation {
    let arduino = tools_path.join("Arduino");
    let cli = arduino.join(CLI_FILE);
    let esp32_hardware = arduino
        .join("packages")
        .join("esp32")
        .join("hardware")
        .join("esp32");
    let esp32_tools = arduino.join("packages").join("esp32").join("tools");
    let libraries = arduino.join("libraries");

    let mut missing = Vec::new();
    if !is_executable(&cli) {
        missing.push(format!("executable Arduino CLI ({})", cli.display()));
    }
    if find_file_named(&esp32_hardware, "platform.txt").is_none() {
        missing.push(format!(
            "ESP32 platform (platform.txt under {})",
            esp32_hardware.display()
        ));
    }

    let esptool_name = expected_binary("esptool");
    if find_file_named(&esp32_tools.join("esptool_py"), &esptool_name)
        .filter(|path| is_executable(path))
        .is_none()
    {
        missing.push(format!("ESP32 uploader ({esptool_name})"));
    }

    let compiler_name = expected_binary("xtensa-esp32s3-elf-g++");
    if find_file_named(&esp32_tools, &compiler_name)
        .filter(|path| is_executable(path))
        .is_none()
    {
        missing.push(format!("ESP32-S3 compiler ({compiler_name})"));
    }
    let frontend_name = expected_binary("cc1plus");
    if find_file_named(&esp32_tools.join("esp-x32"), &frontend_name)
        .filter(|path| is_executable(path))
        .is_none()
    {
        missing.push(format!("ESP32-S3 C++ frontend ({frontend_name})"));
    }

    if !libraries.is_dir() {
        missing.push(format!("Arduino libraries ({})", libraries.display()));
    }
    if !libraries.join("Windify").is_dir() {
        missing.push(format!(
            "Windify library ({})",
            libraries.join("Windify").display()
        ));
    }

    ToolchainValidation { missing }
}

/// Compatibility wrapper used by startup.
pub fn check_toolchain(tools_path: &Path) -> (bool, PathBuf) {
    let cli = tools_path.join("Arduino").join(CLI_FILE);
    if let Err(error) = repair_executable_permissions(tools_path) {
        tracing::warn!("[tools] startup permission repair failed: {error}");
    }
    (validate_toolchain(tools_path).is_ready(), cli)
}

/// Restore execute bits that the 7z decoder does not preserve on Unix.
///
/// ESP32 packages contain executables both in `bin/` directories and as
/// top-level launchers such as `esptool`. Repairing only `arduino-cli` leaves a
/// package that starts successfully but fails later with exit status 126.
#[cfg(unix)]
pub fn repair_executable_permissions(tools_path: &Path) -> Result<usize, String> {
    use std::os::unix::fs::PermissionsExt;

    let arduino = tools_path.join("Arduino");
    if !arduino.exists() {
        return Ok(0);
    }

    let known_launchers = [
        "arduino-cli",
        "esptool",
        "esptool.py",
        "espota.py",
        "gen_esp32part.py",
        "mklittlefs",
        "mkspiffs",
    ];
    let mut repaired = 0;
    let mut pending = vec![arduino];
    while let Some(dir) = pending.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("read tool directory {}: {error}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("read tool entry: {error}"))?;
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }

            let in_executable_tree = path.components().any(|component| {
                let name = component.as_os_str();
                name == "bin" || name == "libexec"
            });
            let known_launcher = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| known_launchers.contains(&name));
            if !in_executable_tree && !known_launcher {
                continue;
            }

            let metadata = fs::metadata(&path)
                .map_err(|error| format!("read permissions for {}: {error}", path.display()))?;
            let old_mode = metadata.permissions().mode();
            let new_mode = old_mode | 0o111;
            if new_mode != old_mode {
                let mut permissions = metadata.permissions();
                permissions.set_mode(new_mode);
                fs::set_permissions(&path, permissions).map_err(|error| {
                    format!("set executable permission on {}: {error}", path.display())
                })?;
                repaired += 1;
            }
        }
    }
    Ok(repaired)
}

#[cfg(not(unix))]
pub fn repair_executable_permissions(_tools_path: &Path) -> Result<usize, String> {
    Ok(0)
}

#[derive(Serialize)]
struct ArduinoConfig<'a> {
    board_manager: BoardManager<'a>,
    directories: ArduinoDirectories<'a>,
}

#[derive(Serialize)]
struct BoardManager<'a> {
    additional_urls: [&'a str; 1],
}

#[derive(Serialize)]
struct ArduinoDirectories<'a> {
    data: &'a str,
    downloads: &'a str,
    user: &'a str,
}

/// Write a deterministic, YAML-escaped Arduino configuration.
///
/// Serializing the paths is important on Windows: hand-written YAML can
/// misinterpret drive-letter colons, backslashes, spaces, and non-ASCII user
/// names. Process arguments continue to use native `Path`/`OsStr` values.
pub fn write_arduino_config(config_path: &Path, arduino_dir: &Path) -> Result<(), String> {
    let staging = arduino_dir.join("staging");
    fs::create_dir_all(&staging)
        .map_err(|error| format!("create Arduino staging directory: {error}"))?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create Arduino config directory: {error}"))?;
    }

    let data = arduino_dir.to_str().ok_or_else(|| {
        format!(
            "Arduino path is not valid Unicode: {}",
            arduino_dir.display()
        )
    })?;
    let downloads = staging
        .to_str()
        .ok_or_else(|| format!("staging path is not valid Unicode: {}", staging.display()))?;
    let config = ArduinoConfig {
        board_manager: BoardManager {
            additional_urls: [ESP32_INDEX_URL],
        },
        directories: ArduinoDirectories {
            data,
            downloads,
            user: data,
        },
    };
    let yaml = serde_yaml::to_string(&config)
        .map_err(|error| format!("serialize Arduino config: {error}"))?;
    fs::write(config_path, yaml)
        .map_err(|error| format!("write Arduino config {}: {error}", config_path.display()))
}

/// Install or repair the one packaged toolchain archive.
pub async fn setup_toolchain(tools_path: &Path, report: ProgressFn) -> Result<(), String> {
    report(SetupProgress {
        phase: "downloading-tools".to_string(),
        progress: 0,
    });

    let progress_report = report.clone();
    let download_progress: download::ProgressFn = Arc::new(move |progress| {
        progress_report(SetupProgress {
            phase: "downloading-tools".to_string(),
            progress,
        });
    });
    let tools = tools_path.to_path_buf();
    let status =
        tokio::task::spawn_blocking(move || download::ensure_tools(&tools, download_progress))
            .await
            .map_err(|error| format!("tool package task panicked: {error}"))?;

    match status {
        download::ToolsStatus::Present => {
            tracing::info!("[tools] validated existing tool package");
        }
        download::ToolsStatus::Downloaded => {
            tracing::info!("[tools] downloaded and validated tool package");
        }
        download::ToolsStatus::Failed(error) => return Err(error),
    }

    report(SetupProgress {
        phase: "done".to_string(),
        progress: 100,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()))
    }

    fn write_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"test").unwrap();
    }

    fn create_minimal_toolchain(root: &Path) {
        write_file(&root.join("Arduino").join(CLI_FILE));
        write_file(&root.join("Arduino/packages/esp32/hardware/esp32/3.1.3/platform.txt"));
        write_file(
            &root
                .join("Arduino/packages/esp32/tools/esptool_py/4.9")
                .join(expected_binary("esptool")),
        );
        write_file(
            &root
                .join("Arduino/packages/esp32/tools/xtensa/14.2/bin")
                .join(expected_binary("xtensa-esp32s3-elf-g++")),
        );
        write_file(
            &root
                .join("Arduino/packages/esp32/tools/esp-x32/2405/libexec/gcc/xtensa-esp-elf/13.2.0")
                .join(expected_binary("cc1plus")),
        );
        fs::create_dir_all(root.join("Arduino/libraries/Windify")).unwrap();
        repair_executable_permissions(root).unwrap();
    }

    #[test]
    fn validates_versioned_layout_under_unicode_path() {
        let root = test_root("Thiết-bị-học-sinh");
        create_minimal_toolchain(&root);
        assert!(validate_toolchain(&root).is_ready());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_missing_uploader_instead_of_accepting_cli_only() {
        let root = test_root("toolchain-incomplete");
        create_minimal_toolchain(&root);
        fs::remove_file(
            root.join("Arduino/packages/esp32/tools/esptool_py/4.9")
                .join(expected_binary("esptool")),
        )
        .unwrap();
        let result = validate_toolchain(&root);
        assert!(!result.is_ready());
        assert!(result.missing.iter().any(|item| item.contains("uploader")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serializes_unicode_paths_as_yaml_strings() {
        let root = test_root("Nguyễn Văn A");
        let arduino = root.join("Người dùng").join("Học sinh").join("Arduino");
        let config = root.join("arduino-cli.yaml");
        write_arduino_config(&config, &arduino).unwrap();
        let parsed: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(parsed["directories"]["data"].as_str(), arduino.to_str());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn repairs_nested_tool_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_root("tool-permissions");
        create_minimal_toolchain(&root);
        let esptool = root.join("Arduino/packages/esp32/tools/esptool_py/4.9/esptool");
        let cc1plus = root.join(
            "Arduino/packages/esp32/tools/esp-x32/2405/libexec/gcc/xtensa-esp-elf/13.2.0/cc1plus",
        );
        fs::set_permissions(&esptool, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&cc1plus, fs::Permissions::from_mode(0o644)).unwrap();
        let repaired = repair_executable_permissions(&root).unwrap();
        assert!(repaired >= 2);
        assert_ne!(
            fs::metadata(esptool).unwrap().permissions().mode() & 0o111,
            0
        );
        assert_ne!(
            fs::metadata(cc1plus).unwrap().permissions().mode() & 0o111,
            0
        );
        fs::remove_dir_all(root).unwrap();
    }
}
