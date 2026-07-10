#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

// Future Academy Link — single-binary tray shell + local hardware link server.
//
// The tray event loop owns the main thread (tao requirement). A tokio runtime
// runs on a separate thread and hosts: the axum link server, the background
// toolchain-setup task, and the per-connection serial sessions. The tray polls
// /status every 2s (synchronously, via ureq, on the poll thread) to drive the
// menu. There is NO Node runtime — the Rust binary IS the server.

mod ansi;
mod download;
mod paths;
mod progress;
mod serial;
mod server;
mod toolchain;
mod update;
mod upload;
mod usb_id;
mod ws;

use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::{fs::OpenOptions, io::Write};

use indicatif::{ProgressBar, ProgressStyle};
use std::time::Duration;

use muda::accelerator::{Accelerator, Code, Modifiers};
use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use serde::Deserialize;
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use time::format_description;
use tracing_subscriber::fmt::time::OffsetTime;
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
        let status_label = if let Some(phase) = resp.setup_phase.as_deref().filter(|p| *p != "done")
        {
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
            let host = if resp.host.is_empty() {
                "127.0.0.1"
            } else {
                &resp.host
            };
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
    UpdateCheck(update::UpdateCheck),
    UpdateProgress {
        received: u64,
        total: u64,
    },
    UpdatePrepared {
        version_label: String,
        result: Result<update::PreparedUpdate, String>,
    },
}

#[derive(Clone)]
struct SharedLogWriter(Arc<Mutex<std::fs::File>>);

impl Write for SharedLogWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("log file lock poisoned"))?
            .write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("log file lock poisoned"))?
            .flush()
    }
}

/// Return current local time as "HH:MM:SS" suitable for log prefixes.
pub fn log_timestamp() -> String {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    now.format(&format_description::parse_borrowed::<2>("[hour]:[minute]:[second]").unwrap())
        .unwrap_or_else(|_| String::new())
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
            let _ = std::process::Command::new("osascript")
                .args(["-e", &script])
                .spawn();
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
            if ok && paths::is_esp32_toolchain_ready(&tools_path) {
                let layout = paths::validate_tools_layout(&tools_path);
                if !layout.ok {
                    for m in &layout.missing {
                        tracing::error!("[link] some tools are missing: {}", m);
                    }
                }
            } else {
                tracing::info!("[link] downloading toolchain in background…");

                // indicatif progress bar + a background print thread so the bar
                // updates on a stable terminal line even when tokio yields.
                let pb = ProgressBar::new(100);
                pb.set_style(
                    ProgressStyle::with_template(
                        "{spinner:.cyan} [{bar:40}] {msg:.dim} {percent:>3}%",
                    )
                    .unwrap()
                    .progress_chars("█▉▊▋▌▍▎▏  "),
                );
                pb.set_message("downloading-cli");
                let pb = Arc::new(Mutex::new(Some(pb)));
                let (tx, rx) = channel::<(String, u8)>();
                let pb_for_print = pb.clone();
                let _print_thread = thread::spawn(move || {
                    // Drain the channel and update the bar from a single OS thread,
                    // keeping the cursor in one place so the bar redraws cleanly.
                    while let Ok((phase, pct)) = rx.recv() {
                        let label = match phase.as_str() {
                            "downloading-cli" => "Downloading CLI",
                            "extracting" => "Extracting",
                            "configuring" => "Configuring",
                            "updating-index" => "Updating index",
                            "downloading-platform" => "Downloading ESP32 core",
                            "downloading-tools" => "Downloading toolchain",
                            "pruning" => "Cleaning up",
                            "done" => "Done",
                            "error" => "Error",
                            _ => "Setup",
                        };
                        if let Some(pb) = pb_for_print.lock().unwrap().as_ref() {
                            pb.set_message(label);
                            pb.set_position(pct as u64);
                            if pct >= 100 {
                                pb.finish();
                            }
                        }
                    }
                });

                app.set_setup_phase(Some("downloading-cli".to_string()));
                app.set_setup_progress(0);
                let app_setup = app.clone();
                let tools_setup = tools_path.clone();
                let tx_for_setup = tx.clone();
                tokio::spawn(async move {
                    let app_for_cb = app_setup.clone();
                    let tx_clone = tx_for_setup.clone();
                    let report_fn: toolchain::ProgressFn =
                        Arc::new(move |p: toolchain::SetupProgress| {
                            app_for_cb.set_setup_phase(if p.phase == "done" {
                                None
                            } else {
                                Some(p.phase.clone())
                            });
                            app_for_cb.set_setup_progress(p.progress);
                            let _ = tx_clone.send((p.phase.clone(), p.progress));
                        });
                    let res = toolchain::setup_toolchain(&tools_setup, report_fn).await;
                    // Signal the print thread to drain then exit.
                    let _ = tx_for_setup.send(("done".to_string(), 100));
                    drop(tx_for_setup);
                    if let Err(e) = res {
                        let _ = tx.send(("error".to_string(), 0));
                        tracing::error!("[link] toolchain setup failed: {}", e);
                        app_setup.set_setup_phase(Some("error".to_string()));
                    } else {
                        // CLI environment init after successful toolchain setup.
                        upload::arduino::init_cli_environment(
                            &tools_setup,
                            &app_setup.user_data_path,
                        );
                    }
                });
            }

            // Initialize CLI environment at startup when tools already exist.
            if ok {
                upload::arduino::init_cli_environment(&tools_path, &app.user_data_path);
            }

            // Serve forever (with EADDRINUSE same-server retry).
            if let Err(e) = server::start(app).await {
                tracing::error!("[link] server error: {}", e);
            }
        });
    });
}

fn main() {
    let log = log_path();
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // The tray application never needs a persistent console. Write routine
    // diagnostics to the file opened by the explicit "Show Console Log" item.
    let log_file = OpenOptions::new().create(true).append(true).open(&log);
    let offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    let fmt = format_description::parse_borrowed::<2>("[hour]:[minute]:[second]")
        .expect("valid time format");
    let timer = OffsetTime::new(offset, fmt);
    if let Ok(file) = log_file {
        let writer = SharedLogWriter(Arc::new(Mutex::new(file)));
        let _ = tracing_subscriber::fmt()
            .with_timer(timer)
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .with_level(false)
            .with_target(false)
            .try_init();
    }

    // --headless: run without tray icon, just the server. Use Ctrl+C to stop.
    let headless = std::env::args().any(|a| a == "--headless");
    if headless {
        progress::set_headless(true);
        tracing::info!("[link] starting in headless mode (no tray icon)");
    }

    // Start the embedded link server on its own runtime thread (no Node spawn).
    start_runtime();

    if headless {
        tracing::info!("[link] server running — press Ctrl+C to stop");
        // Block forever; the runtime thread lives until the process is killed.
        loop {
            thread::park();
        }
    }

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

    // ── Background OTA update check (5 s after startup, then every 4 h) ────
    let proxy_upd = proxy.clone();
    {
        let proxy = proxy.clone();
        thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().expect("update check runtime");
            let client = reqwest::Client::builder()
                .user_agent("FutureAcademyLink/2.0")
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("update check client");

            thread::sleep(Duration::from_secs(5));

            loop {
                let result = rt.block_on(update::check_for_update(&client));
                let _ = proxy.send_event(UserEvent::UpdateCheck(result));
                thread::sleep(Duration::from_secs(4 * 60 * 60));
            }
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
    let update_check_item = MenuItem::new("Check for Updates\u{2026}", true, None);
    let sep_upd = PredefinedMenuItem::separator();
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
    menu.append(&update_check_item).ok();
    menu.append(&sep_upd).ok();
    menu.append(&debug_header).ok();
    menu.append(&show_log).ok();
    menu.append(&sep4).ok();
    menu.append(&quit_item).ok();

    let open_website_id = open_website.id().clone();
    let show_log_id = show_log.id().clone();
    let quit_id = quit_item.id().clone();
    let update_check_id = update_check_item.id().clone();

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
    let mut update_check_in_progress = false;
    let mut pending_update: Option<update::UpdateInfo> = None;
    let mut prepared_update: Option<update::PreparedUpdate> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Poll;

        while let Ok(ev) = menu_receiver.try_recv() {
            if ev.id == open_website_id {
                open_url(SCRATCH_URL);
            } else if ev.id == show_log_id {
                show_console_log(&log);
            } else if ev.id == quit_id {
                *control_flow = ControlFlow::Exit;
            } else if ev.id == update_check_id {
                if update_check_in_progress {
                    // Already checking — ignore.
                } else if let Some(prepared) = prepared_update.take() {
                    match update::install_prepared_update(prepared) {
                        update::ApplyOutcome::RestartRequired => {
                            update_check_item.set_text("Restarting to finish update\u{2026}");
                            update_check_item.set_enabled(false);
                            *control_flow = ControlFlow::Exit;
                        }
                        update::ApplyOutcome::Failed(error) => {
                            update_check_item.set_text(&format!("Update failed: {error}"));
                            update_check_item.set_enabled(true);
                        }
                    }
                } else if let Some(info) = pending_update.take() {
                    let version_label = info.version_label.clone();
                    update_check_item.set_text(&format!("Downloading {}\u{2026}", version_label));
                    update_check_item.set_enabled(false);
                    update_check_in_progress = true;

                    let proxy = proxy_upd.clone();
                    thread::spawn(move || {
                        let rt = tokio::runtime::Runtime::new().expect("update download runtime");
                        let client = reqwest::Client::builder()
                            .user_agent("FutureAcademyLink/2.0")
                            .connect_timeout(Duration::from_secs(10))
                            .timeout(Duration::from_secs(30 * 60))
                            .build()
                            .expect("update download client");
                        let progress_proxy = proxy.clone();
                        let progress: Arc<dyn Fn(u64, u64) + Send + Sync> =
                            Arc::new(move |received, total| {
                                let _ = progress_proxy
                                    .send_event(UserEvent::UpdateProgress { received, total });
                            });

                        let result = match rt.block_on(update::download_update(
                            &client,
                            &info,
                            Some(progress),
                        )) {
                            update::DownloadOutcome::Downloaded(bytes) => {
                                update::prepare_update(&bytes)
                            }
                            update::DownloadOutcome::Failed(error) => Err(error),
                        };
                        let _ = proxy.send_event(UserEvent::UpdatePrepared {
                            version_label,
                            result,
                        });
                    });
                } else {
                    // Manual trigger.
                    update_check_item.set_text("Checking for updates\u{2026}");
                    update_check_item.set_enabled(false);
                    update_check_in_progress = true;
                    let proxy = proxy_upd.clone();
                    thread::spawn(move || {
                        let rt = tokio::runtime::Runtime::new().expect("manual check rt");
                        let client = reqwest::Client::builder()
                            .user_agent("FutureAcademyLink/2.0")
                            .connect_timeout(Duration::from_secs(10))
                            .timeout(Duration::from_secs(30))
                            .build()
                            .expect("manual check client");
                        let result = rt.block_on(update::check_for_update(&client));
                        let _ = proxy.send_event(UserEvent::UpdateCheck(result));
                    });
                }
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
        } else if let Event::UserEvent(UserEvent::UpdateCheck(result)) = event {
            update_check_in_progress = false;
            match result {
                update::UpdateCheck::UpToDate => {
                    update_check_item.set_text("Up to date");
                    update_check_item.set_enabled(true);
                    pending_update = None;
                    prepared_update = None;
                }
                update::UpdateCheck::Available(info) => {
                    let version_label = info.version_label.clone();
                    update_check_item.set_text(&format!("Update to {} \u{2192}", version_label));
                    update_check_item.set_enabled(true);
                    pending_update = Some(info);
                    prepared_update = None;
                }
                update::UpdateCheck::Error(e) => {
                    update_check_item.set_text(&format!("Update failed: {e}"));
                    update_check_item.set_enabled(true);
                    pending_update = None;
                }
            }
        } else if let Event::UserEvent(UserEvent::UpdateProgress { received, total }) = event {
            if total > 0 {
                let percent = received.saturating_mul(100) / total;
                update_check_item.set_text(&format!("Downloading update\u{2026} {}%", percent));
            } else {
                update_check_item.set_text(&format!(
                    "Downloading update\u{2026} {} KB",
                    received / 1024
                ));
            }
        } else if let Event::UserEvent(UserEvent::UpdatePrepared {
            version_label,
            result,
        }) = event
        {
            update_check_in_progress = false;
            match result {
                Ok(prepared) => {
                    prepared_update = Some(prepared);
                    update_check_item
                        .set_text(&format!("Restart to install {} \u{2192}", version_label));
                    update_check_item.set_enabled(true);
                }
                Err(error) => {
                    update_check_item.set_text(&format!("Update failed: {error}"));
                    update_check_item.set_enabled(true);
                }
            }
        }
    });
}
