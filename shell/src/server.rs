//! Axum HTTP + WebSocket server. Port of `src/index.js` (`OpenBlockLink`).
//!
//! Routes: GET `/`, HEAD `/`, OPTIONS `*`, GET `/status`, 404 fallback.
//! Every response carries the PNA CORS headers. Port hard-forced to 11337.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::{any, get};
use axum::Router;
use serde_json::json;

use crate::serial;
use crate::ws;

/// Server name returned at GET / for health checks.
pub const SERVER_NAME: &str = "windy-link-server";
/// Legacy server id still accepted by isSameServer.
pub const SERVER_NAME_LEGACY: &str = "winblock-link-server";
/// Port is hard-forced — any other listen argument is ignored.
pub const DEFAULT_PORT: u16 = 11337;

fn default_host() -> String {
    let from_env = std::env::var("WINDY_LINK_LISTEN_HOST")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if from_env.is_empty() || from_env == "localhost" || from_env == "0.0.0.1" {
        "127.0.0.1".to_string()
    } else {
        from_env
    }
}

/// Shared server state. `Arc<AppState>` is cloned into every handler + session.
pub struct AppState {
    pub host: String,
    pub port: u16,
    pub user_data_path: PathBuf,
    pub tools_path: PathBuf,
    setup_phase: Mutex<Option<String>>,
    setup_progress: AtomicU8,
    connections: AtomicI64,
}

impl AppState {
    pub fn new(user_data_path: PathBuf, tools_path: PathBuf) -> Self {
        // index.js appends 'link' to the user-data path for sessions.
        let session_user_data = user_data_path.join("link");
        Self {
            host: default_host(),
            port: DEFAULT_PORT,
            user_data_path: session_user_data,
            tools_path,
            setup_phase: Mutex::new(None),
            setup_progress: AtomicU8::new(0),
            connections: AtomicI64::new(0),
        }
    }

    pub fn set_setup_phase(&self, phase: Option<String>) {
        *self.setup_phase.lock().unwrap() = phase;
    }

    pub fn setup_phase(&self) -> Option<String> {
        self.setup_phase.lock().unwrap().clone()
    }

    pub fn set_setup_progress(&self, p: u8) {
        self.setup_progress.store(p, Ordering::Relaxed);
    }

    pub fn setup_progress(&self) -> u8 {
        self.setup_progress.load(Ordering::Relaxed)
    }

    pub fn inc_connection(&self) {
        self.connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dec_connection(&self) {
        let prev = self.connections.fetch_sub(1, Ordering::Relaxed);
        if prev <= 0 {
            // clamp to 0 (Math.max(0, ...))
            self.connections.store(0, Ordering::Relaxed);
        }
    }

    pub fn connections(&self) -> i64 {
        self.connections.load(Ordering::Relaxed).max(0)
    }

    fn ready(&self) -> bool {
        self.setup_phase().is_none()
    }
}

/// Apply PNA headers to any header map.
fn pna_headers(headers: &mut HeaderMap) {
    headers.insert(
        "Access-Control-Allow-Private-Network",
        HeaderValue::from_static("true"),
    );
    headers.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
}

/// Catch-all handler for non-WS HTTP methods (GET/HEAD/OPTIONS/404).
async fn http_handler(
    State(app): State<Arc<AppState>>,
    method: Method,
    req_headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    let path = uri.path();

    if method == Method::OPTIONS {
        let mut resp = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .unwrap();
        pna_headers(resp.headers_mut());
        resp.headers_mut().insert(
            "Access-Control-Allow-Methods",
            HeaderValue::from_static("GET, HEAD, OPTIONS"),
        );
        let echo = req_headers
            .get("access-control-request-headers")
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("*"));
        resp.headers_mut().insert("Access-Control-Allow-Headers", echo);
        return resp;
    }

    if method == Method::HEAD && path == "/" {
        let mut resp = Response::builder().status(StatusCode::OK).body(Body::empty()).unwrap();
        pna_headers(resp.headers_mut());
        return resp;
    }

    if method == Method::GET && path == "/" {
        let mut resp = Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "text/html")
            .body(Body::from(SERVER_NAME))
            .unwrap();
        pna_headers(resp.headers_mut());
        return resp;
    }

    if method == Method::GET && path == "/status" {
        return status_response(&app);
    }

    let mut resp = Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .unwrap();
    pna_headers(resp.headers_mut());
    resp
}

/// Build the `/status` JSON. Always HTTP 200, even on device-list error.
fn status_response(app: &Arc<AppState>) -> Response {
    let phase = app.setup_phase();
    let base = json!({
        "server": SERVER_NAME,
        "ready": app.ready(),
        "setupPhase": phase,
        "setupProgress": app.setup_progress(),
        "version": env!("CARGO_PKG_VERSION"),
        "host": app.host,
        "port": app.port,
        "connections": app.connections(),
    });

    let body = match serial::list_status_devices() {
        Ok(devices) => {
            let mut v = base;
            v["devices"] = serde_json::to_value(devices).unwrap_or(json!([]));
            v
        }
        Err(e) => {
            let mut v = base;
            v["devices"] = json!([]);
            v["error"] = json!(e);
            v
        }
    };

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    pna_headers(resp.headers_mut());
    resp
}

/// Build the axum router. WS routes are registered explicitly; everything else
/// (including 404) falls through to `http_handler`.
fn build_router(app: Arc<AppState>) -> Router {
    let mut router = Router::new();
    for route in ws::SERIALPORT_ROUTES {
        router = router.route(route, get(ws::ws_handler));
    }
    router
        .fallback(any(http_handler))
        .with_state(app)
}

/// Health check used for EADDRINUSE same-server detection. Port of `isSameServer`.
async fn is_same_server(host: &str, port: u16) -> bool {
    let url = format!("http://{}:{}/", host, port);
    match reqwest::get(&url).await {
        Ok(resp) => match resp.text().await {
            Ok(text) => text == SERVER_NAME || text == SERVER_NAME_LEGACY,
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// Find and kill any process listening on `port`, skipping our own PID.
fn kill_port_owner(port: u16) {
    let own_pid = std::process::id();

    #[cfg(unix)]
    {
        let out = std::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port)])
            .output();
        if let Ok(o) = out {
            for pid_str in String::from_utf8_lossy(&o.stdout).split_whitespace() {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    if pid == own_pid {
                        continue;
                    }
                    tracing::warn!("[link] killing stale server on port {} (pid {})", port, pid);
                    unsafe {
                        libc::kill(pid as libc::pid_t, libc::SIGKILL);
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        let out = std::process::Command::new("netstat").args(["-ano"]).output();
        if let Ok(o) = out {
            let needle = format!(":{} ", port);
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if line.contains(&needle) && line.to_uppercase().contains("LISTENING") {
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            if pid == own_pid {
                                continue;
                            }
                            tracing::warn!(
                                "[link] killing stale server on port {} (pid {})",
                                port,
                                pid
                            );
                            let _ = std::process::Command::new("taskkill")
                                .args(["/F", "/PID", pid_str])
                                .output();
                        }
                    }
                }
            }
        }
    }
}

/// Start the link server. On EADDRINUSE by our own server, kills the stale
/// process and retries once. Errors on any other conflict.
pub async fn start(app: Arc<AppState>) -> Result<(), String> {
    let addr = format!("{}:{}", app.host, app.port);
    let mut kill_attempted = false;
    loop {
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => {
                tracing::info!(
                    "WinLink link server start successfully, socket listen on: http://{}",
                    addr
                );
                let router = build_router(app.clone());
                axum::serve(listener, router)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err(e) => {
                if is_same_server(&app.host, app.port).await {
                    if kill_attempted {
                        return Err(format!(
                            "port {} still in use after kill attempt",
                            app.port
                        ));
                    }
                    tracing::warn!(
                        "[link] stale WinLink server on port {} — force closing",
                        app.port
                    );
                    kill_port_owner(app.port);
                    kill_attempted = true;
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }
                return Err(format!("error while trying to listen port {}: {}", app.port, e));
            }
        }
    }
}
