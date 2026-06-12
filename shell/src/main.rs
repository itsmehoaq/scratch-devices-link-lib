// Future Academy Link — single-binary tray shell + local hardware link server.
//
// The tray event loop owns the main thread (tao requirement). A tokio runtime
// runs on a separate thread and hosts: the axum link server, the background
// toolchain-setup task, and the per-connection serial sessions. The tray polls
// /status every 2s (synchronously, via ureq, on the poll thread) to drive the
// menu. There is NO Node runtime — the Rust binary IS the server.

mod ansi;
mod paths;
mod serial;
mod server;
mod toolchain;
mod upload;
mod usb_id;
mod ws;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use muda::accelerator::{Accelerator, Code, Modifiers};
use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use serde::Deserialize;
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{TrayIconBuilder, TrayIconEvent};

pub use server::AppState;

const ICON_PNG: &[u8] = include_bytes!("../../assets/logo.png");
const STATUS_URL: &str = "http://127.0.0.1:11337/status";
const SCRATCH_URL: &str = "https://stem.windify.edu.vn/";
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize)]
struct Device {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct StatusResponse {
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    devices: Vec<Device>,
    #[serde(rename = "setupPhase", default)]
    setup_phase: Option<String>,
    #[serde(rename = "setupProgress", default)]
    setup_progress: u8,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: u16,
}

#[derive(Debug, Clone)]
struct TrayState {
    status_label: String,
    devices: Vec<String>,
}

impl TrayState {
    fn from_response(resp: &StatusResponse) -> Self {
        let status_label = if let Some(phase) = resp.setup_phase.as_deref().filter(|p| *p != "done") {
            let label = match phase {
                "downloading-cli" => "Downloading arduino-cli",
                "extracting" => "Extracting tools",
                "configuring" => "Configuring",
                "updating-index" => "Updating package index",
                "installing-core" => "Installing ESP32 core",
                "downloading-platform" => "Downloading ESP32 core",
                "downloading-tools" => "Downloading toolchain",
                "pruning" => "Cleaning up unused tools",
                "error" => "Setup failed \u{2014} restart app",
                _ => "Setting up tools",
            };
            format!("{} ({}%)", label, resp.setup_progress)
        } else if resp.ready {
            let host = if resp.host.is_empty() { "127.0.0.1" } else { &resp.host };
            let port = if resp.port == 0 { 11337 } else { resp.port };
            format!("Running on http://{}:{}", host, port)
        } else {
            "Starting\u{2026}".to_string()
        };
        Self {
            status_label,
            devices: resp.devices.iter().map(|d| d.name.clone()).collect(),
        }
    }

    fn starting() -> Self {
        Self {
            status_label: "Starting\u{2026}".to_string(),
            devices: Vec::new(),
        }
    }
}

#[derive(Debug)]
enum UserEvent {
    Status(TrayState),
}

fn log_path() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    {
        let base = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        std::path::PathBuf::from(base).join("Library/Logs/FutureAcademy/link.log")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| "C:\\Temp".to_string());
        std::path::PathBuf::from(base).join("FutureAcademy\\link.log")
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        std::path::PathBuf::from("/tmp/future-academy-link.log")
    }
}

fn open_url(url: &str) {
    let _ = open::that_detached(url);
}

fn show_console_log(log: &std::path::Path) {
    let s = log.to_string_lossy();
    #[cfg(target_os = "macos")]
    {
        let ok = std::process::Command::new("open")
            .args(["-a", "Console", s.as_ref()])
            .status()
            .map(|st| st.success())
            .unwrap_or(false);
        if !ok {
            let script = format!(
                "tell application \"Terminal\" to do script \"tail -f '{}'\"",
                s
            );
            let _ = std::process::Command::new("osascript").args(["-e", &script]).spawn();
        }
    }
    #[cfg(target_os = "windows")]
    {
        let cmd = format!("powershell -NoExit -Command Get-Content '{}' -Wait", s);
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &cmd])
            .spawn();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = std::process::Command::new("xterm")
            .args(["-e", &format!("tail -f {}", s)])
            .spawn();
    }
}

/// Spawn the tokio runtime on a background thread and start the link server +
/// toolchain setup. Returns immediately; the runtime thread runs forever.
fn start_runtime() {
    thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new().expect("failed to build tokio runtime");
        rt.block_on(async {
            // Path resolution (port of start-link-server.js).
            let base_dir = paths::resolve_runtime_base_dir();
            let user_data_path = paths::resolve_user_data_path(&base_dir);
            let tools_path = paths::resolve_tools_path(&base_dir);

            tracing::info!("[link] runtime base: {}", base_dir.display());
            tracing::info!("[link] tools path: {}", tools_path.display());
            tracing::info!("[link] user data: {}", user_data_path.display());

            let app = Arc::new(AppState::new(user_data_path, tools_path.clone()));

            // Background toolchain check/setup → updates /status.
            let (ok, _cli) = toolchain::check_toolchain(&tools_path);
            if ok {
                let layout = paths::validate_tools_layout(&tools_path);
                if !layout.ok {
                    for m in &layout.missing {
                        tracing::error!("[link] some tools are missing: {}", m);
                    }
                }
            } else {
                tracing::info!("[link] arduino-cli not found — downloading toolchain in background…");
                app.set_setup_phase(Some("downloading-cli".to_string()));
                app.set_setup_progress(0);
                let app_setup = app.clone();
                let tools_setup = tools_path.clone();
                tokio::spawn(async move {
                    let app_for_cb = app_setup.clone();
                    let report_fn: toolchain::ProgressFn =
                        Arc::new(move |p: toolchain::SetupProgress| {
                            let phase = if p.phase == "done" { None } else { Some(p.phase.clone()) };
                            app_for_cb.set_setup_phase(phase);
                            app_for_cb.set_setup_progress(p.progress);
                        });
                    let res = toolchain::setup_toolchain(&tools_setup, report_fn).await;
                    if let Err(e) = res {
                        tracing::error!("[link] toolchain setup failed: {}", e);
                        app_setup.set_setup_phase(Some("error".to_string()));
                    }
                });
            }

            // Serve forever (with EADDRINUSE same-server retry).
            if let Err(e) = server::start(app).await {
                tracing::error!("[link] server error: {}", e);
            }
        });
    });
}

fn main() {
    // Logging to stderr (the tray's parent process / log file captures it).
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .try_init();

    let log = log_path();
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Start the embedded link server on its own runtime thread (no Node spawn).
    start_runtime();

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    TrayIconEvent::set_event_handler(Some(|_| {}));
    let menu_receiver = MenuEvent::receiver();

    {
        let proxy = proxy.clone();
        thread::spawn(move || loop {
            let state = match ureq::get(STATUS_URL).call() {
                Ok(resp) => match resp.into_json::<StatusResponse>() {
                    Ok(s) => TrayState::from_response(&s),
                    Err(_) => TrayState::starting(),
                },
                Err(_) => TrayState::starting(),
            };
            let _ = proxy.send_event(UserEvent::Status(state));
            thread::sleep(POLL_INTERVAL);
        });
    }

    // ── Static menu items (never removed) ───────────────────────────────────
    let menu = Menu::new();
    let title_item = MenuItem::new("Future Academy Link", false, None);
    let status_item = MenuItem::new("Starting\u{2026}", false, None);
    let sep1 = PredefinedMenuItem::separator();
    let devices_header = MenuItem::new("Devices", false, None);
    let sep2 = PredefinedMenuItem::separator();
    let open_website = MenuItem::new("Open Website", true, None);
    let sep3 = PredefinedMenuItem::separator();
    let debug_header = MenuItem::new("Debug", false, None);
    let show_log = MenuItem::new("Show Console Log", true, None);
    let sep4 = PredefinedMenuItem::separator();
    let quit_accel = if cfg!(target_os = "macos") {
        Accelerator::new(Some(Modifiers::META), Code::KeyQ)
    } else {
        Accelerator::new(Some(Modifiers::ALT), Code::F4)
    };
    let quit_item = MenuItem::new("Quit", true, Some(quit_accel));

    menu.append(&title_item).ok();
    menu.append(&status_item).ok();
    menu.append(&sep1).ok();
    menu.append(&devices_header).ok();
    menu.append(&sep2).ok();
    menu.append(&open_website).ok();
    menu.append(&sep3).ok();
    menu.append(&debug_header).ok();
    menu.append(&show_log).ok();
    menu.append(&sep4).ok();
    menu.append(&quit_item).ok();

    let open_website_id = open_website.id().clone();
    let show_log_id = show_log.id().clone();
    let quit_id = quit_item.id().clone();

    let icon = {
        // Load logo.png and resize to 44×44 px (22 pt @2× Retina).
        const SIZE: u32 = 44;
        let img = image::load_from_memory(ICON_PNG).expect("invalid icon PNG");
        let img = img.resize_exact(SIZE, SIZE, image::imageops::FilterType::Lanczos3);
        let rgba = img.into_rgba8().into_raw();
        tray_icon::Icon::from_rgba(rgba, SIZE, SIZE).expect("invalid icon")
    };

    let _tray = TrayIconBuilder::new()
        .with_tooltip("Future Academy Link")
        .with_icon(icon)
        .with_menu(Box::new(menu.clone()))
        .build()
        .expect("failed to build tray icon");

    // Devices section starts right after devices_header (index 4 in the menu).
    let mut current_device_items: Vec<MenuItem> = Vec::new();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Poll;

        while let Ok(ev) = menu_receiver.try_recv() {
            if ev.id == open_website_id {
                open_url(SCRATCH_URL);
            } else if ev.id == show_log_id {
                show_console_log(&log);
            } else if ev.id == quit_id {
                *control_flow = ControlFlow::Exit;
            }
        }

        if let Event::UserEvent(UserEvent::Status(state)) = event {
            status_item.set_text(&state.status_label);

            let current_names: Vec<String> =
                current_device_items.iter().map(|i| i.text()).collect();
            let new_names: Vec<&str> = state.devices.iter().map(|s| s.as_str()).collect();
            let current_refs: Vec<&str> = current_names.iter().map(|s| s.as_str()).collect();

            if current_refs != new_names {
                for item in &current_device_items {
                    menu.remove(item).ok();
                }
                current_device_items.clear();

                if state.devices.is_empty() {
                    let item = MenuItem::new("No devices", false, None);
                    menu.insert(&item, 4).ok();
                    current_device_items.push(item);
                } else {
                    for (i, name) in state.devices.iter().enumerate() {
                        let item = MenuItem::new(name.as_str(), false, None);
                        menu.insert(&item, 4 + i).ok();
                        current_device_items.push(item);
                    }
                }
            }
        }
    });
}
