//! Runtime path resolution. Port of `src/lib/runtime-paths.js`.

use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const INSTALL_REGISTRY_KEY: &str = r"Software\Windify\Future Academy";

fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(up) = std::env::var("USERPROFILE") {
            return PathBuf::from(up);
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        return PathBuf::from(h);
    }
    PathBuf::from(".")
}

/// Resolve runtime root beside the exe when packaged, repo root in dev.
///
/// Rust equivalent of `resolveRuntimeBaseDir`: the directory of the current
/// executable. There is no `process.pkg`/Electron concept; we always use the
/// exe's parent, falling back to CWD when the exe path cannot be resolved.
pub fn resolve_runtime_base_dir() -> PathBuf {
    // `std::env::current_exe()` internally calls Windows `GetFinalPathNameByHandleW`
    // via the windows-rs crate, which can PANIC (via an assertion) when the exe path
    // involves symlinks, junctions, or certain special filesystem paths
    // (error code 3 = ERROR_PATH_NOT_FOUND). We run it in a join-handle thread so a
    // panic stays contained and we fall back to CWD safely.
    let handle = std::thread::Builder::new()
        .spawn(std::env::current_exe)
        .ok();
    if let Some(handle) = handle {
        if let Ok(Ok(exe)) = handle.join() {
            if let Some(parent) = exe.parent() {
                return parent.to_path_buf();
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Resolve a tool binary with Windows `.exe` handling. Always returns absolute.
/// Port of `resolveToolBinary`.
pub fn resolve_tool_binary(tools_path: &Path, relative_path: &str) -> PathBuf {
    let base_path = tools_path.join(relative_path);
    #[cfg(windows)]
    {
        let exe_path = if base_path.extension().and_then(|e| e.to_str()) == Some("exe") {
            base_path.clone()
        } else {
            let mut p = base_path.clone();
            p.set_extension("exe");
            p
        };
        if exe_path.exists() {
            return absolutize(&exe_path);
        }
    }
    if base_path.exists() {
        return absolutize(&base_path);
    }
    #[cfg(windows)]
    {
        if base_path.extension().and_then(|e| e.to_str()) != Some("exe") {
            let mut p = base_path.clone();
            p.set_extension("exe");
            return absolutize(&p);
        }
    }
    absolutize(&base_path)
}

fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else if let Ok(cwd) = std::env::current_dir() {
        cwd.join(p)
    } else {
        p.to_path_buf()
    }
}

/// True when running inside a macOS .app bundle (any location, not just /Applications/).
/// This is the reliable check — .app/Contents/MacOS is always the exe dir inside a bundle.
#[cfg(target_os = "macos")]
fn is_in_app_bundle(base_dir: &Path) -> bool {
    let s = base_dir.to_string_lossy();
    s.contains(".app/Contents/MacOS")
}

/// True when the runtime root is inside an OS protected or app-bundle directory.
/// On macOS this also covers any .app bundle so tools never write inside the bundle.
pub fn is_installed_in_protected_dir(base_dir: &Path) -> bool {
    let normalized = absolutize(base_dir).to_string_lossy().to_lowercase();
    #[cfg(windows)]
    {
        let win = normalized.replace('/', "\\");
        return win.contains("\\program files\\") || win.contains("\\program files (x86)\\");
    }
    #[cfg(target_os = "macos")]
    {
        // Any .app bundle — installed in /Applications or run from anywhere.
        return normalized.starts_with("/applications/") || is_in_app_bundle(base_dir);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return normalized.starts_with("/usr/") || normalized.starts_with("/opt/");
    }
    #[allow(unreachable_code)]
    false
}

/// Resolve writable user data directory. Port of `resolveUserDataPath`.
pub fn resolve_user_data_path(base_dir: &Path) -> PathBuf {
    if let Ok(custom) = std::env::var("WINDY_USER_DATA") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    if is_installed_in_protected_dir(base_dir) {
        #[cfg(target_os = "macos")]
        {
            return home_dir()
                .join("Library")
                .join("Application Support")
                .join("WindyLink");
        }
        #[cfg(windows)]
        {
            let local_app_data = std::env::var("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir().join("AppData").join("Local"));
            return local_app_data.join("WindyLink");
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let xdg = std::env::var("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home_dir().join(".local").join("share"));
            return xdg.join("WindyLink");
        }
    }
    base_dir.join(".winblockData")
}

/// Read installer registry values (Windows only). Port of `readInstallRegistry`.
#[cfg(windows)]
pub fn read_install_registry() -> Option<(Option<String>, Option<String>)> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm.open_subkey(INSTALL_REGISTRY_KEY).ok()?;
    let install_path: Option<String> = key.get_value("InstallPath").ok();
    let tools_path: Option<String> = key.get_value("ToolsPath").ok();
    if install_path.is_none() && tools_path.is_none() {
        return None;
    }
    Some((install_path, tools_path))
}

#[cfg(not(windows))]
pub fn read_install_registry() -> Option<(Option<String>, Option<String>)> {
    None
}

/// Resolve build/upload tools directory. Port of `resolveToolsPath`.
/// When running inside a .app bundle, tools go to the user-data dir, never inside the bundle.
pub fn resolve_tools_path(base_dir: &Path) -> PathBuf {
    if let Ok(custom) = std::env::var("WINDY_TOOLS_PATH") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }

    // Inside an .app (or protected dir): use user-data/tools so writes never land in the bundle.
    if is_installed_in_protected_dir(base_dir) {
        return resolve_user_data_path(base_dir).join("tools");
    }

    let local_tools = base_dir.join("tools");
    let local_cli = resolve_tool_binary(&local_tools, "Arduino/arduino-cli");
    if local_cli.exists() {
        return local_tools;
    }

    if let Some((_install, tools)) = read_install_registry() {
        if let Some(tp) = tools {
            let p = PathBuf::from(&tp);
            if p.exists() {
                return p;
            }
        }
    }

    local_tools
}

/// Result of `validate_tools_layout`.
pub struct ToolsLayout {
    pub ok: bool,
    /// Resolved arduino-cli path (part of the validated layout report; mirrors
    /// the JS `{ok, arduinoCliPath, missing}` shape).
    #[allow(dead_code)]
    pub arduino_cli_path: PathBuf,
    pub missing: Vec<String>,
}

/// Port of `validateToolsLayout`.
pub fn validate_tools_layout(tools_path: &Path) -> ToolsLayout {
    let arduino_cli_path = resolve_tool_binary(tools_path, "Arduino/arduino-cli");
    let mut missing = Vec::new();
    if !arduino_cli_path.exists() {
        missing.push(arduino_cli_path.to_string_lossy().to_string());
    }
    let arduino_root = tools_path.join("Arduino");
    if !arduino_root.exists() {
        missing.push(arduino_root.to_string_lossy().to_string());
    }
    ToolsLayout {
        ok: missing.is_empty(),
        arduino_cli_path,
        missing,
    }
}

/// Returns true if the ESP32-S3 xtensa cross-compiler toolchain is present.
/// This goes beyond `check_toolchain` — the CLI binary existing is not enough;
/// the actual compiler must also be on disk, or arduino-cli will silently use
/// its bundled (Linux/macOS) path as a fallback and produce the `/bin/…` path
/// seen in Windows build errors.
///
/// The tool archive extracts to:
///   packages/esp32/tools/xtensa-esp32s3-elf-gcc/<version>/xtensa-esp32s3-elf/bin/
pub fn is_esp32_toolchain_ready(tools_path: &Path) -> bool {
    let tools_root = tools_path
        .join("Arduino")
        .join("packages")
        .join("esp32")
        .join("tools");
    let Ok(entries) = fs::read_dir(tools_root) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("xtensa-esp32s3-elf-gcc") {
            let bin = entry
                .path()
                .join("xtensa-esp32s3-elf")
                .join("bin")
                .join("xtensa-esp32s3-elf-gcc.exe");
            if bin.exists() {
                return true;
            }
        }
    }
    false
}
