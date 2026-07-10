//! Upload/flash subsystem. Ports `src/upload/arduino.js` and `src/upload/esp32.js`.

pub mod arduino;
pub mod esp32;
pub mod limits;

use std::process::Child;

/// Outcome of a build/flash step. Mirrors the JS string returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadResult {
    Success,
    Aborted,
}

/// Streaming callback: `(text, progress?)` → forwarded as `uploadStdout`.
pub type SendStd<'a> = dyn FnMut(&str, Option<f64>) + Send + 'a;

/// Kill a child process tree. Replicates `taskkill /pid <pid> /f /t` on Windows
/// and a process-group SIGTERM on Unix (port group set via pre_exec).
pub fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/f", "/t"]);
        configure_killable(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            // Negative pid → signal the whole process group (set in spawn).
            libc::kill(-pid, libc::SIGTERM);
        }
        // Fallback to direct kill if group signaling did nothing.
        let _ = child.kill();
    }
}

/// Configure a Command so the child becomes a process-group leader (Unix) or is
/// spawned without a console window (Windows), enabling reliable tree-kill.
pub fn configure_killable(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // New process group so kill(-pid) hits grandchildren too.
                libc::setpgid(0, 0);
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}
