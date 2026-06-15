//! Per-connection serialport session actor. Port of `src/session/serialport.js`.
//!
//! Concurrency model (per the analyst's recommendation): one tokio task owns all
//! mutable state (peripheral, params, flags, scan context). The serial port runs
//! in a dedicated OS thread whose reads are forwarded over an mpsc channel; WS
//! frames arrive over a second channel. The actor loop `select!`s over both plus
//! a periodic unplug-check tick, so there are no shared locks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::ansi;
use crate::paths;
use crate::serial::{self, DeviceInfo, OpenConfig, OpenPort};
use crate::upload::arduino::Arduino;
use crate::upload::esp32::Esp32;
use crate::upload::UploadResult;
use crate::usb_id;
use crate::ws::session::{is_truthy, Session};
use crate::AppState;

/// Events from the serial read thread to the actor.
enum SerialEvent {
    Data(Vec<u8>),
    Closed(String),
}

/// Handle to a running serial read thread.
struct SerialHandle {
    port: Arc<std::sync::Mutex<Option<OpenPort>>>,
    stop: Arc<AtomicBool>,
    path: String,
}

/// In-flight `scanDevices` accumulator.
struct ScanContext {
    buffer: String,
    deadline: Instant,
    timeout_ms: u64,
    responder: ResponderId,
}

/// Identifies a pending client request awaiting a reply (id echoed back).
type ResponderId = Value;

/// The per-connection session.
pub struct SerialportSession {
    session: Session,
    user_data_path: std::path::PathBuf,
    tools_path: std::path::PathBuf,
    app: Arc<AppState>,

    // serial state
    serial: Option<SerialHandle>,
    serial_rx: Option<UnboundedReceiver<SerialEvent>>,
    serial_tx_template: UnboundedSender<SerialEvent>,

    peripheral_params: Option<Value>,
    reported_peripherals: HashMap<String, DeviceInfo>,
    reported_signatures: HashMap<String, String>,

    is_read: bool,
    is_in_disconnect: bool,
    intentional_disconnect: bool,
    recovering_transient: bool,
    post_flash_reconnecting: bool,

    unplug_grace_until: Instant,
    unplug_closed_streak: u32,

    // upload tool abort flag (set while a tool is active)
    tool_abort: Option<Arc<AtomicBool>>,
    tool_active: bool,

    scan: Option<ScanContext>,

    // discovery
    discover_filters: Option<Value>,
}

impl SerialportSession {
    pub fn new(
        out: UnboundedSender<String>,
        user_data_path: std::path::PathBuf,
        tools_path: std::path::PathBuf,
        app: Arc<AppState>,
    ) -> Self {
        let (serial_tx, serial_rx) = unbounded_channel();
        Self {
            session: Session::new(out),
            user_data_path,
            tools_path,
            app,
            serial: None,
            serial_rx: Some(serial_rx),
            serial_tx_template: serial_tx,
            peripheral_params: None,
            reported_peripherals: HashMap::new(),
            reported_signatures: HashMap::new(),
            is_read: false,
            is_in_disconnect: false,
            intentional_disconnect: false,
            recovering_transient: false,
            post_flash_reconnecting: false,
            unplug_grace_until: Instant::now(),
            unplug_closed_streak: 0,
            tool_abort: None,
            tool_active: false,
            scan: None,
            discover_filters: None,
        }
    }

    /// Main actor loop. Owns all state; `ws_rx` carries inbound WS frames.
    pub async fn run(mut self, mut ws_rx: UnboundedReceiver<String>) {
        let mut serial_rx = self.serial_rx.take().expect("serial_rx present");
        let mut tick = tokio::time::interval(Duration::from_millis(
            serial::PERIPHERAL_UNPLUG_CHECK_INTERVAL_MS,
        ));
        let mut discover_tick = tokio::time::interval(Duration::from_millis(100));

        loop {
            tokio::select! {
                msg = ws_rx.recv() => {
                    match msg {
                        Some(text) => self.on_ws_message(&text).await,
                        None => break, // socket closed → dispose
                    }
                }
                Some(ev) = serial_rx.recv() => {
                    match ev {
                        SerialEvent::Data(bytes) => self.on_serial_data(&bytes),
                        SerialEvent::Closed(reason) => {
                            // Mirror the JS `error`/`close` handlers: transient errors
                            // (or a dropped port) trigger recovery; other noise is logged.
                            if self.is_in_disconnect || self.recovering_transient {
                                // ignore — teardown in progress
                            } else if serial::is_transient_serial_error(&reason) {
                                self.schedule_transient_recovery(&format!("close event: {}", reason)).await;
                            } else {
                                // port still effectively gone (read loop ended) → recover
                                self.schedule_transient_recovery(&format!("close event: {}", reason)).await;
                            }
                        }
                    }
                }
                _ = tick.tick() => {
                    self.on_unplug_tick().await;
                    self.check_scan_timeout();
                }
                _ = discover_tick.tick() => {
                    if self.discover_filters.is_some() {
                        self.run_discover_scan();
                    }
                }
            }
        }
        self.dispose();
    }

    // ── dispatch ─────────────────────────────────────────────────────────

    async fn on_ws_message(&mut self, text: &str) {
        match Session::parse_inbound(text) {
            Ok(crate::ws::session::Inbound::Request { method, params, id }) => {
                self.did_receive_call(&method, params, id).await;
            }
            Ok(crate::ws::session::Inbound::Response { id, result, error }) => {
                self.session.handle_response(&id, result, error);
            }
            Err(msg) => {
                // reply with error using null id (parse failures have no id)
                self.session.send_response(&Value::Null, Value::Null, json!(msg));
            }
        }
    }

    /// Port of the `didReceiveCall` switch.
    async fn did_receive_call(&mut self, method: &str, params: Value, id: Value) {
        match method {
            "discover" => {
                match self.discover(&params) {
                    Ok(()) => self.session.send_response(&id, Value::Null, Value::Null),
                    Err(e) => self.session.send_response(&id, Value::Null, json!(e)),
                }
            }
            "stopDiscover" => {
                self.stop_discover();
                self.session.send_response(&id, Value::Null, Value::Null);
            }
            "connect" => {
                match self.connect(&params, false, false).await {
                    Ok(()) => self.session.send_response(&id, Value::Null, Value::Null),
                    Err(e) => self.session.send_response(&id, Value::Null, json!(e)),
                }
            }
            "disconnect" => {
                let _ = self.disconnect(true).await;
                self.session.send_response(&id, Value::Null, Value::Null);
            }
            "updateBaudrate" => {
                match self.update_baudrate(&params) {
                    Ok(()) => self.session.send_response(&id, Value::Null, Value::Null),
                    Err(message) => {
                        // do NOT reject — warn via connectError, reply null,null
                        self.session
                            .send_notification("connectError", Some(json!({ "message": message })));
                        self.session.send_response(&id, Value::Null, Value::Null);
                    }
                }
            }
            "write" => {
                let r = self.write(&params);
                match r {
                    Ok(n) => self.session.send_response(&id, json!(n), Value::Null),
                    Err(e) => self.session.send_response(&id, Value::Null, json!(e)),
                }
            }
            "read" => {
                self.is_read = true;
                self.session.send_response(&id, Value::Null, Value::Null);
            }
            "upload" => {
                self.upload(&params).await;
                self.session.send_response(&id, Value::Null, Value::Null);
            }
            "uploadFirmware" => {
                self.upload_firmware(&params).await;
                self.session.send_response(&id, Value::Null, Value::Null);
            }
            "uploadEsp32Bin" => {
                self.upload_esp32_bin(&params).await;
                self.session.send_response(&id, Value::Null, Value::Null);
            }
            "scanDevices" => {
                // resolves later via the accumulator; store responder id.
                match self.scan_devices(&params, id.clone()) {
                    Ok(()) => { /* response sent on completion/timeout */ }
                    Err(e) => self.session.send_response(&id, Value::Null, json!(e)),
                }
            }
            "abortUpload" => {
                self.abort_upload();
                self.session.send_response(&id, Value::Null, Value::Null);
            }
            "getServices" => {
                // services always null in practice → []
                self.session.send_response(&id, json!([]), Value::Null);
            }
            "pingMe" => {
                self.session.send_response(&id, json!("willPing"), Value::Null);
                // server→client request ping (fire-and-forget completion logged)
                let (tx, rx) = tokio::sync::oneshot::channel();
                self.session.send_remote_request("ping", None, Some(tx));
                tokio::spawn(async move {
                    if let Ok((result, _err)) = rx.await {
                        tracing::info!("Got result from ping: {}", result);
                    }
                });
            }
            _ => {
                self.session.send_response(&id, Value::Null, json!("Method not found"));
            }
        }
    }

    // ── discover ─────────────────────────────────────────────────────────

    /// Port of `discover`.
    fn discover(&mut self, params: &Value) -> Result<(), String> {
        if self.serial.is_some() {
            return Err("cannot discover when connected".to_string());
        }
        let pnpid = params
            .get("filters")
            .and_then(|f| f.get("pnpid"))
            .and_then(|v| v.as_array());
        match pnpid {
            Some(arr) if !arr.is_empty() => {}
            _ => return Err("discovery request must include filters".to_string()),
        }
        self.reported_peripherals.clear();
        self.reported_signatures.clear();
        self.discover_filters = params.get("filters").cloned();
        Ok(())
    }

    fn stop_discover(&mut self) {
        self.discover_filters = None;
    }

    /// One discovery scan tick. Port of `onAdvertisementReceived` (hard-gated to
    /// ESP32-S3 OTG devices, as in the original).
    fn run_discover_scan(&mut self) {
        let filters = match &self.discover_filters {
            Some(f) => f.clone(),
            None => return,
        };
        let allow_any = filters
            .get("pnpid")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().any(|e| e.as_str() == Some("*")))
            .unwrap_or(false);
        let allowed: Vec<String> = filters
            .get("pnpid")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|e| e.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        let devices = serial::list_devices().unwrap_or_default();
        let mut current_paths = std::collections::HashSet::new();
        for device in &devices {
            let vid = device.vendor_id.clone().unwrap_or_default().to_uppercase();
            let pid = device.product_id.clone().unwrap_or_default().to_uppercase();
            let pnpid = format!("USB\\VID_{}&PID_{}", vid, pid);
            if allow_any || allowed.iter().any(|p| p == &pnpid) {
                if !serial::is_esp32s3_otg_device(device) {
                    continue;
                }
                current_paths.insert(device.path.clone());
                let name = Self::format_discovered_name(device, &pnpid);
                let payload = Self::build_discovery_payload(device, &pnpid, &name);
                self.reported_peripherals.insert(device.path.clone(), device.clone());
                let signature = payload.to_string();
                if self.reported_signatures.get(&device.path) == Some(&signature) {
                    continue;
                }
                self.reported_signatures.insert(device.path.clone(), signature);
                self.session.send_notification("didDiscoverPeripheral", Some(payload));
            }
        }
        // prune stale signatures
        let stale: Vec<String> = self
            .reported_signatures
            .keys()
            .filter(|p| !current_paths.contains(*p))
            .cloned()
            .collect();
        for p in stale {
            self.reported_signatures.remove(&p);
        }
    }

    /// Port of `_formatDiscoveredName`.
    fn format_discovered_name(device: &DeviceInfo, pnpid: &str) -> String {
        let mapped = usb_id::lookup(pnpid);
        let friendly = device
            .friendly_name
            .clone()
            .or_else(|| device.manufacturer.clone())
            .or_else(|| device.serial_number.clone());
        let base = mapped.map(|s| s.to_string()).or(friendly).unwrap_or_else(|| "Unknown device".to_string());
        format!("{} ({})", base, device.path)
    }

    /// Port of `_buildDiscoveryPayload`.
    fn build_discovery_payload(device: &DeviceInfo, pnpid: &str, name: &str) -> Value {
        let vendor_id = device
            .vendor_id
            .clone()
            .map(|s| s.to_uppercase())
            .filter(|s| !s.is_empty());
        let product_id = device
            .product_id
            .clone()
            .map(|s| s.to_uppercase())
            .filter(|s| !s.is_empty());
        let mut suffix: Vec<String> = Vec::new();
        if let Some(m) = &device.manufacturer {
            suffix.push(m.clone());
        }
        if let Some(s) = &device.serial_number {
            suffix.push(format!("#{}", s));
        }
        if let (Some(v), Some(p)) = (&vendor_id, &product_id) {
            suffix.push(format!("VID:{}/PID:{}", v, p));
        }
        let display_name = if suffix.is_empty() {
            name.to_string()
        } else {
            format!("{} - {}", name, suffix.join(" | "))
        };
        json!({
            "peripheralId": device.path,
            "name": display_name,
            "path": if device.path.is_empty() { Value::Null } else { json!(device.path) },
            "pnpId": if pnpid.is_empty() { Value::Null } else { json!(pnpid) },
            "vendorId": vendor_id,
            "productId": product_id,
            "manufacturer": device.manufacturer,
            "serialNumber": device.serial_number,
            "friendlyName": device.friendly_name,
        })
    }

    // ── connect / disconnect ─────────────────────────────────────────────

    /// Port of `connect`. Opens the port + spawns the read thread.
    async fn connect(
        &mut self,
        params: &Value,
        is_after_upload: bool,
        silent: bool,
    ) -> Result<(), String> {
        if self.serial.is_some() {
            return Err("already connected to peripheral".to_string());
        }
        let peripheral_id = params
            .get("peripheralId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let device = match self.reported_peripherals.get(&peripheral_id) {
            Some(d) => d.clone(),
            None => return Err(format!("invalid peripheral ID: {}", peripheral_id)),
        };
        self.discover_filters = None;

        let cfg = params.get("peripheralConfig").and_then(|c| c.get("config"));
        let open_cfg = OpenConfig {
            baud_rate: cfg.and_then(|c| c.get("baudRate")).and_then(|v| v.as_u64()).unwrap_or(115200) as u32,
            data_bits: cfg.and_then(|c| c.get("dataBits")).and_then(|v| v.as_u64()).unwrap_or(8) as u8,
            stop_bits: cfg.and_then(|c| c.get("stopBits")).and_then(|v| v.as_u64()).unwrap_or(1) as u8,
            rts: cfg.and_then(|c| c.get("rts")).and_then(|v| v.as_bool()).unwrap_or(true),
            dtr: cfg.and_then(|c| c.get("dtr")).and_then(|v| v.as_bool()).unwrap_or(true),
        };

        let opened = match OpenPort::open(&device.path, &open_cfg) {
            Ok(p) => p,
            Err(e) => {
                if is_after_upload && !silent {
                    self.session.send_notification(
                        "uploadError",
                        Some(json!({ "message": format!("{}{}", ansi::RED, e) })),
                    );
                    self.session.send_notification("peripheralUnplug", None);
                }
                if !silent {
                    self.notify_connect_open_failure(&e);
                }
                return Err(e);
            }
        };

        self.peripheral_params = Some(params.clone());
        self.intentional_disconnect = false;
        self.unplug_closed_streak = 0;
        let grace = if is_after_upload {
            serial::POST_FLASH_OPEN_UNPLUG_GRACE_MS
        } else {
            serial::POST_OPEN_UNPLUG_GRACE_MS
        };
        self.unplug_grace_until = Instant::now() + Duration::from_millis(grace);

        // Spawn the read thread. The port lives behind a mutex so write/baud can
        // reach it from the actor while the reader holds it for reads.
        let port = Arc::new(std::sync::Mutex::new(Some(opened)));
        let stop = Arc::new(AtomicBool::new(false));
        let tx = self.serial_tx_template.clone();
        {
            let port = port.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let read = {
                        let mut guard = port.lock().unwrap();
                        match guard.as_mut() {
                            Some(p) => p.read_chunk(&mut buf),
                            None => break,
                        }
                    };
                    match read {
                        Ok(0) => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Ok(n) => {
                            if tx.send(SerialEvent::Data(buf[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(SerialEvent::Closed(e));
                            break;
                        }
                    }
                }
            });
        }

        self.serial = Some(SerialHandle {
            port,
            stop,
            path: device.path.clone(),
        });
        Ok(())
    }

    /// Port of `disconnect`.
    async fn disconnect(&mut self, intentional: bool) -> Result<(), String> {
        self.is_in_disconnect = true;
        if intentional {
            self.intentional_disconnect = true;
        }
        if let Some(handle) = self.serial.take() {
            handle.stop.store(true, Ordering::Relaxed);
            // drop the port (closes it)
            if let Ok(mut guard) = handle.port.lock() {
                *guard = None;
            }
        }
        if intentional {
            self.peripheral_params = None;
        }
        self.is_in_disconnect = false;
        Ok(())
    }

    fn notify_connect_open_failure(&mut self, msg: &str) {
        if msg.contains("Access denied") {
            self.session.send_notification("connectError", Some(json!({ "message": "Access denied" })));
        }
        if msg.contains("Permission denied") {
            self.session.send_notification("connectError", Some(json!({ "message": "Permission denied" })));
        }
        if msg.contains("Unknown error code 31") {
            self.session.send_notification("connectError", Some(json!({ "message": "Unknown error code 31" })));
        }
        if msg.contains("Resource temporarily unavailable") || msg.contains("EAGAIN") {
            self.session.send_notification(
                "connectError",
                Some(json!({ "message": "Resource temporarily unavailable" })),
            );
        }
    }

    // ── serial data ──────────────────────────────────────────────────────

    /// Port of `onMessageCallback`.
    fn on_serial_data(&mut self, bytes: &[u8]) {
        self.unplug_closed_streak = 0;
        if self.is_read {
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            self.session
                .send_notification("onMessage", Some(json!({ "encoding": "base64", "message": b64 })));
        }
        if self.scan.is_some() {
            self.feed_scan_context(bytes);
        }
        if let Ok(text) = std::str::from_utf8(bytes) {
            for line in text.split(['\n', '\r']) {
                let trimmed = line.trim();
                if trimmed.contains("WINDIFY_MOBILE_") {
                    self.session
                        .send_notification("mobileUiSerialLine", Some(json!({ "line": trimmed })));
                }
            }
        }
    }

    /// Port of `_feedScanContext`.
    fn feed_scan_context(&mut self, bytes: &[u8]) {
        let text = match std::str::from_utf8(bytes) {
            Ok(t) => t,
            Err(_) => return,
        };
        let resolved = {
            let ctx = match self.scan.as_mut() {
                Some(c) => c,
                None => return,
            };
            ctx.buffer.push_str(text);
            if ctx.buffer.len() > serial::SCAN_DEVICES_BUFFER_LIMIT {
                let start = ctx.buffer.len() - serial::SCAN_DEVICES_BUFFER_LIMIT;
                ctx.buffer = ctx.buffer[start..].to_string();
            }
            let start_idx = ctx.buffer.find('{');
            let end_idx = ctx.buffer.rfind('}');
            match (start_idx, end_idx) {
                (Some(s), Some(e)) if s < e => {
                    let candidate = &ctx.buffer[s..=e];
                    match serde_json::from_str::<Value>(candidate) {
                        Ok(parsed) if parsed.get("devices").map(|d| d.is_array()).unwrap_or(false) => {
                            Some(parsed)
                        }
                        _ => None,
                    }
                }
                _ => None,
            }
        };
        if let Some(parsed) = resolved {
            let responder = self.scan.take().unwrap().responder;
            let devices = parsed.get("devices").cloned().unwrap_or(json!([]));
            self.session.send_response(
                &responder,
                json!({ "devices": devices, "raw": parsed }),
                Value::Null,
            );
        }
    }

    fn check_scan_timeout(&mut self) {
        let timed_out = self.scan.as_ref().map(|c| Instant::now() >= c.deadline).unwrap_or(false);
        if timed_out {
            let ctx = self.scan.take().unwrap();
            self.session.send_response(
                &ctx.responder,
                Value::Null,
                json!(format!("scan timeout after {}ms", ctx.timeout_ms)),
            );
        }
    }

    // ── write / baud ─────────────────────────────────────────────────────

    /// Port of `write`. Returns bytes written.
    fn write(&mut self, params: &Value) -> Result<usize, String> {
        if self.is_in_disconnect {
            return Ok(0);
        }
        let message = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let encoding = params.get("encoding").and_then(|v| v.as_str()).unwrap_or("utf8");
        let buffer = decode_buffer(message, encoding)?;
        let handle = self.serial.as_ref().ok_or_else(|| "not open".to_string())?;
        let mut guard = handle.port.lock().map_err(|_| "port lock poisoned".to_string())?;
        let port = guard.as_mut().ok_or_else(|| "not open".to_string())?;
        port.write_all(&buffer)
            .map_err(|e| format!("Error while attempting to write: {}", e))
    }

    /// Port of `updateBaudrate` (no-op resolves return Ok; failures return Err
    /// so the caller emits connectError, never rejecting the RPC).
    fn update_baudrate(&mut self, params: &Value) -> Result<(), String> {
        if self.is_in_disconnect {
            return Ok(());
        }
        let handle = match self.serial.as_ref() {
            Some(h) => h,
            None => return Err("Baud rate update skipped: serial port is not open".to_string()),
        };
        let config = self
            .peripheral_params
            .as_ref()
            .and_then(|p| p.get("peripheralConfig"))
            .and_then(|c| c.get("config"))
            .cloned();
        let config = match config {
            Some(c) => c,
            None => return Err("Baud rate update skipped: device connection is not ready".to_string()),
        };
        let baud = match params.get("baudRate").and_then(|v| v.as_u64()) {
            Some(b) => b as u32,
            None => return Err("Baud rate update skipped: missing baud rate".to_string()),
        };
        let rts = config.get("rts").and_then(|v| v.as_bool()).unwrap_or(true);
        let dtr = config.get("dtr").and_then(|v| v.as_bool()).unwrap_or(true);
        let mut guard = handle.port.lock().map_err(|_| "port lock poisoned".to_string())?;
        let port = guard.as_mut().ok_or_else(|| "Baud rate update skipped: serial port is not open".to_string())?;
        // persist new baud into params
        if let Some(c) = self
            .peripheral_params
            .as_mut()
            .and_then(|p| p.get_mut("peripheralConfig"))
            .and_then(|c| c.get_mut("config"))
            .and_then(|c| c.as_object_mut())
        {
            c.insert("baudRate".to_string(), json!(baud));
        }
        port.update_baud(baud, rts, dtr)
            .map_err(|e| format!("Baud rate update failed: {}", e))
    }

    // ── reconnect state machine ──────────────────────────────────────────

    async fn on_unplug_tick(&mut self) {
        if Instant::now() < self.unplug_grace_until {
            return;
        }
        if self.serial.is_none() {
            return;
        }
        // We cannot read isOpen directly; the read thread reports Closed on error.
        // The closed-streak is driven by Closed events; this tick prunes nothing
        // further but is kept to mirror the JS 100ms cadence + grace handling.
    }

    /// Port of `_scheduleTransientRecovery` + `_recoverFromTransientClose`.
    async fn schedule_transient_recovery(&mut self, reason: &str) {
        if self.is_in_disconnect || self.recovering_transient || self.intentional_disconnect {
            return;
        }
        if self.peripheral_params.is_none() || self.tool_active || self.post_flash_reconnecting {
            return;
        }
        if Instant::now() < self.unplug_grace_until {
            return;
        }
        self.unplug_closed_streak += 1;
        if self.unplug_closed_streak < serial::PERIPHERAL_UNPLUG_CLOSED_STREAK {
            return;
        }
        self.unplug_closed_streak = 0;
        tracing::warn!("[serialport] scheduling transient reconnect: {}", reason);
        self.recover_from_transient_close().await;
    }

    async fn recover_from_transient_close(&mut self) {
        if self.recovering_transient || self.is_in_disconnect {
            return;
        }
        self.recovering_transient = true;
        let params = self.peripheral_params.clone();
        let result = self.do_transient_recover(params).await;
        if let Err(e) = result {
            self.sendstd(&format!("{}[serialport] Connection recovery failed: {}\n", ansi::RED, e), None);
            self.session.send_notification("peripheralUnplug", None);
        }
        self.recovering_transient = false;
    }

    async fn do_transient_recover(&mut self, params: Option<Value>) -> Result<(), String> {
        let params = params.ok_or_else(|| "Missing reconnect params".to_string())?;
        let path = params.get("peripheralId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let _ = self.disconnect(false).await;
        let mut last_err = "Failed to reconnect after transient close".to_string();
        for attempt in 0..serial::TRANSIENT_RECONNECT_ATTEMPTS {
            if !path.is_empty() {
                self.refresh_reported_peripheral_by_path(&path).await;
            }
            match self.connect(&params, true, true).await {
                Ok(()) => {
                    self.sendstd(
                        &format!("{}[serialport] Recovered connection after transient reset.\n", ansi::YELLOW_DARK),
                        None,
                    );
                    return Ok(());
                }
                Err(e) => {
                    last_err = e;
                    if attempt < serial::TRANSIENT_RECONNECT_ATTEMPTS - 1 {
                        tokio::time::sleep(Duration::from_millis(serial::TRANSIENT_RECONNECT_DELAY_MS)).await;
                    }
                }
            }
        }
        Err(last_err)
    }

    /// Port of `_refreshReportedPeripheralByPath`.
    async fn refresh_reported_peripheral_by_path(&mut self, path: &str) {
        let cached = self.reported_peripherals.get(path).cloned();
        let path_owned = path.to_string();
        let resolved = tokio::task::spawn_blocking(move || {
            serial::resolve_reconnect_port(&path_owned, cached.as_ref())
        })
        .await;
        if let Ok(Ok(device)) = resolved {
            let resolved_path = device.path.clone();
            self.reported_peripherals.insert(resolved_path.clone(), device);
            if resolved_path != path {
                if let Some(p) = self.peripheral_params.as_mut() {
                    p["peripheralId"] = json!(resolved_path.clone());
                }
                self.sendstd(
                    &format!(
                        "{}[serialport] Port re-enumerated as {} (was {}).\n",
                        ansi::YELLOW_DARK, resolved_path, path
                    ),
                    None,
                );
            }
        }
    }

    /// Port of `_connectAfterFlashWithRetries`.
    async fn connect_after_flash_with_retries(&mut self) -> Result<(), String> {
        self.post_flash_reconnecting = true;
        let result = self.connect_after_flash_inner().await;
        self.post_flash_reconnecting = false;
        result
    }

    async fn connect_after_flash_inner(&mut self) -> Result<(), String> {
        tokio::time::sleep(Duration::from_millis(serial::POST_FLASH_RECONNECT_INITIAL_DELAY_MS)).await;
        let params = self.peripheral_params.clone();
        let params = match params {
            Some(p) => p,
            None => return Err("Missing reconnect params".to_string()),
        };
        let path = params.get("peripheralId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut last_err = "reconnect after flash failed".to_string();
        for attempt in 0..serial::POST_FLASH_RECONNECT_ATTEMPTS {
            if !path.is_empty() {
                self.refresh_reported_peripheral_by_path(&path).await;
            }
            match self.connect(&params, true, true).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = e;
                    if attempt < serial::POST_FLASH_RECONNECT_ATTEMPTS - 1 {
                        tokio::time::sleep(Duration::from_millis(serial::POST_FLASH_RECONNECT_RETRY_DELAY_MS)).await;
                    }
                }
            }
        }
        Err(last_err)
    }

    fn resume_read_after_flash_reconnect(&mut self) {
        self.is_read = true;
        self.sendstd(&format!("{}Serial log stream resumed after flash reconnect.\n", ansi::CLEAR), None);
    }

    // ── upload paths ─────────────────────────────────────────────────────

    fn current_peripheral_path(&self) -> Option<String> {
        if let Some(h) = &self.serial {
            return Some(h.path.clone());
        }
        self.peripheral_params
            .as_ref()
            .and_then(|p| p.get("peripheralId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// Port of `upload`.
    async fn upload(&mut self, params: &Value) {
        if !self.app.ready() {
            self.session.send_notification("uploadError", Some(json!({
                "message": format!("{}Toolchain is not ready yet — still downloading. Check /status for progress.", ansi::RED)
            })));
            return;
        }
        let message = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let encoding = params.get("encoding").and_then(|v| v.as_str()).unwrap_or("utf8");
        let config = params.get("config").cloned().unwrap_or(json!({}));
        let code = match decode_buffer(message, encoding) {
            Ok(b) => String::from_utf8_lossy(&b).to_string(),
            Err(e) => {
                self.session.send_notification("uploadError", Some(json!({ "message": format!("{}{}", ansi::RED, e) })));
                return;
            }
        };
        let path = match self.current_peripheral_path() {
            Some(p) => p,
            None => {
                self.session.send_notification("uploadError", Some(json!({ "message": format!("{}no peripheral", ansi::RED) })));
                return;
            }
        };

        self.emit_set_upload_abort_enabled(true);
        self.tool_active = true;

        let out = self.session.out().clone();
        let user_data = self.user_data_path.clone();
        let tools = self.tools_path.clone();
        let abort = Arc::new(AtomicBool::new(false));
        self.tool_abort = Some(abort.clone());

        // Run the blocking compile in a worker thread; stream via the out sink.
        let build_res = run_arduino_build(out.clone(), &path, config.clone(), &user_data, &tools, &code, abort.clone()).await;

        match build_res {
            Ok((UploadResult::Success, _tool_path)) => {
                self.sendstd(&format!("{}Disconnect serial port\n", ansi::CLEAR), None);
                let _ = self.disconnect(false).await;
                self.sendstd(&format!("{}Disconnected successfully, flash program starting...\n", ansi::CLEAR), None);
                let flash_res = run_arduino_flash(out.clone(), &path, config.clone(), &user_data, &tools, None, abort.clone()).await;
                match flash_res {
                    Ok((flash_code, resolved_path)) => {
                        self.sync_upload_port(&resolved_path).await;
                        match self.connect_after_flash_with_retries().await {
                            Ok(()) => self.resume_read_after_flash_reconnect(),
                            Err(e) => {
                                self.sendstd(&format!("{}[serialport] Flash OK but serial reopen failed: {}. Reconnect manually.\n", ansi::YELLOW_DARK, e), None);
                                self.session.send_notification("connectError", Some(json!({ "message": e })));
                            }
                        }
                        self.session.send_notification("uploadSuccess", Some(json!({ "aborted": flash_code == UploadResult::Aborted })));
                    }
                    Err(e) => {
                        self.session.send_notification("uploadError", Some(json!({ "message": format!("{}{}", ansi::RED, e) })));
                        self.session.send_notification("peripheralUnplug", None);
                    }
                }
            }
            Ok((UploadResult::Aborted, _)) => {
                self.session.send_notification("uploadSuccess", Some(json!({ "aborted": true })));
            }
            Err(e) => {
                self.session.send_notification("uploadError", Some(json!({ "message": format!("{}{}", ansi::RED, e) })));
            }
        }

        self.emit_set_upload_abort_enabled(false);
        self.tool_active = false;
        self.tool_abort = None;
    }

    /// Port of `uploadFirmware`.
    async fn upload_firmware(&mut self, params: &Value) {
        let config = params.clone();
        let path = match self.current_peripheral_path() {
            Some(p) => p,
            None => {
                self.session.send_notification("uploadError", Some(json!({ "message": format!("{}no peripheral", ansi::RED) })));
                return;
            }
        };
        self.emit_set_upload_abort_enabled(true);
        self.tool_active = true;
        let abort = Arc::new(AtomicBool::new(false));
        self.tool_abort = Some(abort.clone());
        let out = self.session.out().clone();
        let user_data = self.user_data_path.clone();
        let tools = self.tools_path.clone();

        self.sendstd(&format!("{}Disconnect serial port\n", ansi::CLEAR), None);
        let _ = self.disconnect(false).await;
        self.sendstd(&format!("{}Disconnected successfully, flash program starting...\n", ansi::CLEAR), None);

        let firmware = config.get("firmware").and_then(|v| v.as_str()).map(|s| s.to_string());
        let flash_res = run_arduino_flash_firmware(out.clone(), &path, config.clone(), &user_data, &tools, firmware, abort.clone()).await;
        match flash_res {
            Ok((flash_code, resolved_path)) => {
                self.sync_upload_port(&resolved_path).await;
                match self.connect_after_flash_with_retries().await {
                    Ok(()) => self.resume_read_after_flash_reconnect(),
                    Err(e) => {
                        self.session.send_notification("connectError", Some(json!({ "message": e })));
                    }
                }
                self.session.send_notification("uploadSuccess", Some(json!({ "aborted": flash_code == UploadResult::Aborted })));
            }
            Err(e) => {
                self.session.send_notification("uploadError", Some(json!({ "message": format!("{}{}", ansi::RED, e) })));
            }
        }
        self.emit_set_upload_abort_enabled(false);
        self.tool_active = false;
        self.tool_abort = None;
    }

    /// Port of `uploadEsp32Bin`.
    async fn upload_esp32_bin(&mut self, params: &Value) {
        let path = match self.current_peripheral_path() {
            Some(p) => p,
            None => {
                self.session.send_notification(
                    "uploadError",
                    Some(json!({ "message": format!("{}uploadEsp32Bin requires a connected serial peripheral", ansi::RED) })),
                );
                return;
            }
        };
        // drop pending scan
        if let Some(ctx) = self.scan.take() {
            self.session.send_response(&ctx.responder, Value::Null, json!("Scan aborted: ESP32 flash starting"));
        }

        self.emit_set_upload_abort_enabled(true);
        self.tool_active = true;
        let abort = Arc::new(AtomicBool::new(false));
        self.tool_abort = Some(abort.clone());
        let out = self.session.out().clone();
        let user_data = self.user_data_path.clone();
        let tools = self.tools_path.clone();

        self.sendstd(&format!("{}Disconnect serial port\n", ansi::CLEAR), None);
        let _ = self.disconnect(false).await;
        self.sendstd(&format!("{}Disconnected successfully, ESP32 flash starting...\n", ansi::CLEAR), None);

        // bins = params.bins || params
        let bins = params.get("bins").cloned().unwrap_or_else(|| params.clone());
        let cfg = params.clone();
        let flash_res = run_esp32_flash(out.clone(), &path, cfg, &user_data, &tools, bins, abort.clone()).await;
        match flash_res {
            Ok(flash_code) => {
                match self.connect_after_flash_with_retries().await {
                    Ok(()) => self.resume_read_after_flash_reconnect(),
                    Err(e) => {
                        self.sendstd(&format!("{}[esp32] reconnect after flash failed: {}\n", ansi::YELLOW_DARK, e), None);
                        self.session.send_notification("peripheralUnplug", None);
                    }
                }
                self.session.send_notification(
                    "uploadSuccess",
                    Some(json!({ "aborted": flash_code == UploadResult::Aborted, "kind": "esp32" })),
                );
            }
            Err(e) => {
                self.session.send_notification("uploadError", Some(json!({ "message": format!("{}{}", ansi::RED, e) })));
                self.session.send_notification("peripheralUnplug", None);
            }
        }
        self.emit_set_upload_abort_enabled(false);
        self.tool_active = false;
        self.tool_abort = None;
    }

    /// Port of `_syncUploadPortFromTool` (the tool reports the resolved path).
    async fn sync_upload_port(&mut self, resolved_path: &str) {
        if resolved_path.is_empty() || self.peripheral_params.is_none() {
            return;
        }
        self.refresh_reported_peripheral_by_path(resolved_path).await;
    }

    fn abort_upload(&mut self) {
        if let Some(a) = &self.tool_abort {
            a.store(true, Ordering::Relaxed);
        }
    }

    /// Port of `scanDevices`. Registers an accumulator that resolves later.
    fn scan_devices(&mut self, params: &Value, responder: ResponderId) -> Result<(), String> {
        if self.serial.is_none() {
            return Err("scanDevices requires an open serial peripheral".to_string());
        }
        if self.scan.is_some() {
            return Err("scanDevices already in progress".to_string());
        }
        let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("scan");
        let terminator = params.get("terminator").and_then(|v| v.as_str()).unwrap_or("\n");
        let timeout_ms = params
            .get("timeoutMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(serial::SCAN_DEVICES_DEFAULT_TIMEOUT_MS);

        self.scan = Some(ScanContext {
            buffer: String::new(),
            deadline: Instant::now() + Duration::from_millis(timeout_ms),
            timeout_ms,
            responder: responder.clone(),
        });

        let payload = format!("{}{}", command, terminator);
        if let Err(e) = self.write(&json!({ "encoding": "utf8", "message": payload })) {
            if let Some(ctx) = self.scan.take() {
                self.session
                    .send_response(&ctx.responder, Value::Null, json!(format!("scan write failed: {}", e)));
            }
        }
        Ok(())
    }

    fn emit_set_upload_abort_enabled(&mut self, enabled: bool) {
        self.session
            .send_notification("setUploadAbortEnabled", Some(json!({ "enabled": enabled })));
    }

    /// Port of `sendstd` → `uploadStdout`.
    fn sendstd(&mut self, message: &str, progress: Option<f64>) {
        let mut payload = json!({ "message": message });
        if let Some(p) = progress {
            payload["progress"] = json!(p);
        }
        self.session.send_notification("uploadStdout", Some(payload));
    }

    /// Port of `dispose`. Serial cleanup happens here, never inline.
    fn dispose(&mut self) {
        if let Some(ctx) = self.scan.take() {
            self.session.send_response(&ctx.responder, Value::Null, json!("Session disposed"));
        }
        if let Some(handle) = self.serial.take() {
            handle.stop.store(true, Ordering::Relaxed);
            if let Ok(mut guard) = handle.port.lock() {
                *guard = None;
            }
        }
        self.peripheral_params = None;
        self.reported_peripherals.clear();
        self.reported_signatures.clear();
        self.discover_filters = None;
        // decrement active connection count
        self.app.dec_connection();
    }
}

/// Decode a `Buffer.from(message, encoding)` equivalent.
fn decode_buffer(message: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(message)
            .map_err(|e| e.to_string()),
        "hex" => hex::decode(message).map_err(|e| e.to_string()),
        // utf8, ascii, latin1, binary → bytes of the string
        _ => Ok(message.as_bytes().to_vec()),
    }
}

// ── blocking tool runners (spawned on worker threads, stream via out sink) ──

async fn run_arduino_build(
    out: UnboundedSender<String>,
    path: &str,
    config: Value,
    user_data: &std::path::Path,
    tools: &std::path::Path,
    code: &str,
    abort: Arc<AtomicBool>,
) -> Result<(UploadResult, String), String> {
    let path = path.to_string();
    let user_data = user_data.to_path_buf();
    let tools = tools.to_path_buf();
    let code = code.to_string();
    tokio::task::spawn_blocking(move || {
        let mut send = make_sendstd(out);
        let tool = Arduino::new(&path, config, &user_data, &tools, &mut send);
        // wire external abort flag into the tool
        let tool_abort = tool.abort_flag();
        spawn_abort_bridge(abort, tool_abort);
        let res = tool.build(&code, &mut send)?;
        Ok((res, tool.peripheral_path().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn run_arduino_flash(
    out: UnboundedSender<String>,
    path: &str,
    config: Value,
    user_data: &std::path::Path,
    tools: &std::path::Path,
    firmware: Option<String>,
    abort: Arc<AtomicBool>,
) -> Result<(UploadResult, String), String> {
    let path = path.to_string();
    let user_data = user_data.to_path_buf();
    let tools = tools.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut send = make_sendstd(out);
        let mut tool = Arduino::new(&path, config, &user_data, &tools, &mut send);
        let tool_abort = tool.abort_flag();
        spawn_abort_bridge(abort, tool_abort);
        let fw = firmware.as_ref().map(std::path::PathBuf::from);
        let res = tool.flash(fw.as_deref(), &mut send)?;
        Ok((res, tool.peripheral_path().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn run_arduino_flash_firmware(
    out: UnboundedSender<String>,
    path: &str,
    config: Value,
    user_data: &std::path::Path,
    tools: &std::path::Path,
    _firmware: Option<String>,
    abort: Arc<AtomicBool>,
) -> Result<(UploadResult, String), String> {
    let path = path.to_string();
    let user_data = user_data.to_path_buf();
    let tools = tools.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut send = make_sendstd(out);
        let mut tool = Arduino::new(&path, config, &user_data, &tools, &mut send);
        let tool_abort = tool.abort_flag();
        spawn_abort_bridge(abort, tool_abort);
        let res = tool.flash_realtime_firmware(&mut send)?;
        Ok((res, tool.peripheral_path().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn run_esp32_flash(
    out: UnboundedSender<String>,
    path: &str,
    config: Value,
    user_data: &std::path::Path,
    tools: &std::path::Path,
    bins: Value,
    abort: Arc<AtomicBool>,
) -> Result<UploadResult, String> {
    let path = path.to_string();
    let user_data = user_data.to_path_buf();
    let tools = tools.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut send = make_sendstd(out);
        let mut tool = Esp32::new(&path, config, &user_data, &tools);
        let tool_abort = tool.abort_flag();
        spawn_abort_bridge(abort, tool_abort);
        let res = tool.flash_bins(&bins, &mut send);
        tool.cleanup(&mut send);
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bridge the session abort flag → the tool's own abort flag.
fn spawn_abort_bridge(external: Arc<AtomicBool>, tool: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        if external.load(Ordering::Relaxed) {
            tool.store(true, Ordering::Relaxed);
            break;
        }
        if tool.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    });
}

/// Build a `sendstd`-shaped closure that emits `uploadStdout` notifications.
fn make_sendstd(out: UnboundedSender<String>) -> impl FnMut(&str, Option<f64>) + Send {
    move |message: &str, progress: Option<f64>| {
        let mut payload = json!({ "message": message });
        if let Some(p) = progress {
            payload["progress"] = json!(p);
        }
        let req = json!({ "jsonrpc": "2.0", "method": "uploadStdout", "params": payload });
        let _ = out.send(req.to_string());
    }
}

/// Silence unused-import warnings for paths/is_truthy referenced in cfg paths.
#[allow(dead_code)]
fn _link_unused() {
    let _ = paths::resolve_runtime_base_dir;
    let _ = is_truthy;
}
