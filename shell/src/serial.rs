//! Serial port operations + helpers. Port of `src/lib/serial-device-list.js`
//! plus the serial-specific helpers from `src/session/serialport.js`
//! (`_comNum`, `_normalizeUsbId`, `_isEsp32S3OtgDevice`, `_isTransientSerialError`,
//! `_resolveReconnectPort` ranking) and `src/upload/*` port re-resolution.
//!
//! The `serialport` crate's blocking API is wrapped in a dedicated OS thread per
//! open connection; bytes are forwarded to an mpsc channel consumed by the
//! per-connection actor in `ws::serialport_session`.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use serde::Serialize;
use serialport::{SerialPort, SerialPortType};

use crate::usb_id;

// ── Platform-tuned timing constants (win32 vs other). Load-bearing — do not
//    round. Port of the constants at the top of serialport.js / arduino.js. ──

pub const PERIPHERAL_UNPLUG_CHECK_INTERVAL_MS: u64 = 100;
pub const PERIPHERAL_UNPLUG_CLOSED_STREAK: u32 = if cfg!(target_os = "windows") { 15 } else { 8 };
pub const POST_OPEN_UNPLUG_GRACE_MS: u64 = 2500;

pub const POST_FLASH_RECONNECT_INITIAL_DELAY_MS: u64 =
    if cfg!(target_os = "windows") { 2800 } else { 1400 };
pub const POST_FLASH_RECONNECT_ATTEMPTS: u32 = 16;
pub const POST_FLASH_RECONNECT_RETRY_DELAY_MS: u64 =
    if cfg!(target_os = "windows") { 700 } else { 500 };
pub const POST_FLASH_OPEN_UNPLUG_GRACE_MS: u64 =
    if cfg!(target_os = "windows") { 12000 } else { 8000 };
pub const TRANSIENT_RECONNECT_ATTEMPTS: u32 = 12;
pub const TRANSIENT_RECONNECT_DELAY_MS: u64 = if cfg!(target_os = "windows") { 500 } else { 400 };
pub const PORT_LIST_POLL_INTERVAL_MS: u64 = 250;
pub const PORT_LIST_RECONNECT_MAX_WAIT_MS: u64 =
    if cfg!(target_os = "windows") { 18000 } else { 12000 };

pub const ESP_RECONNECT_VENDOR_IDS: [&str; 3] = ["303A", "10C4", "1A86"];

/// Espressif native USB VID for ESP32-S3 OTG / Serial-JTAG (not UART bridge).
pub const ESP32S3_OTG_VENDOR_ID: &str = "303A";
/// Known ESP32-S3 native USB product IDs (OTG port).
pub const ESP32S3_OTG_PRODUCT_IDS: [&str; 2] = ["1001", "0002"];

pub const SCAN_DEVICES_DEFAULT_TIMEOUT_MS: u64 = 10000;
pub const SCAN_DEVICES_BUFFER_LIMIT: usize = 64 * 1024;

/// A serial port entry as returned by enumeration (mirrors node-serialport's
/// `SerialPort.list()` shape, fields we consume).
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeviceInfo {
    pub path: String,
    #[serde(rename = "vendorId")]
    pub vendor_id: Option<String>,
    #[serde(rename = "productId")]
    pub product_id: Option<String>,
    pub manufacturer: Option<String>,
    #[serde(rename = "serialNumber")]
    pub serial_number: Option<String>,
    #[serde(rename = "friendlyName")]
    pub friendly_name: Option<String>,
}

/// Status-panel device entry. Port of `serial-device-list.js` output shape.
#[derive(Debug, Clone, Serialize)]
pub struct StatusDevice {
    pub name: String,
    pub path: String,
    #[serde(rename = "vendorId")]
    pub vendor_id: String,
    #[serde(rename = "productId")]
    pub product_id: String,
}

/// Enumerate serial ports. Cross-platform via the `serialport` crate.
pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for p in ports {
        let mut info = DeviceInfo {
            path: p.port_name.clone(),
            ..Default::default()
        };
        if let SerialPortType::UsbPort(usb) = p.port_type {
            info.vendor_id = Some(format!("{:04X}", usb.vid));
            info.product_id = Some(format!("{:04X}", usb.pid));
            info.manufacturer = usb.manufacturer;
            info.serial_number = usb.serial_number;
            // serialport crate exposes `product` rather than friendlyName.
            info.friendly_name = usb.product;
        }
        out.push(info);
    }
    Ok(out)
}

/// `hasUsbIds` filter + name format. Port of `listSerialDevices`.
pub fn list_status_devices() -> Result<Vec<StatusDevice>, String> {
    let mut devices: Vec<StatusDevice> = list_devices()?
        .into_iter()
        .filter(|d| {
            !d.path.is_empty()
                && d.vendor_id.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
                && d.product_id.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        })
        .map(|d| {
            let vid = d.vendor_id.clone().unwrap_or_default().to_uppercase();
            let pid = d.product_id.clone().unwrap_or_default().to_uppercase();
            StatusDevice {
                name: format_device_name(&d),
                path: d.path.clone(),
                vendor_id: vid,
                product_id: pid,
            }
        })
        .collect();
    // numeric-aware sort by path (approximates localeCompare numeric:true)
    devices.sort_by(|a, b| natural_cmp(&a.path, &b.path));
    Ok(devices)
}

/// Port of `formatDeviceName` in serial-device-list.js.
pub fn format_device_name(device: &DeviceInfo) -> String {
    let vid = device.vendor_id.clone().unwrap_or_default().to_uppercase();
    let pid = device.product_id.clone().unwrap_or_default().to_uppercase();
    let pnpid = if !vid.is_empty() && !pid.is_empty() {
        format!("USB\\VID_{}&PID_{}", vid, pid)
    } else {
        String::new()
    };
    let mapped = if !pnpid.is_empty() {
        usb_id::lookup(&pnpid)
    } else {
        None
    };
    let friendly = device
        .friendly_name
        .clone()
        .or_else(|| device.manufacturer.clone())
        .or_else(|| device.serial_number.clone());
    let base_name = mapped
        .map(|s| s.to_string())
        .or(friendly)
        .unwrap_or_else(|| "Unknown device".to_string());
    format!("{} ({})", base_name, device.path)
}

/// Port of `_normalizeUsbId`: strip 0x prefix, uppercase.
pub fn normalize_usb_id(raw: &str) -> String {
    let s = raw.trim();
    let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    s.to_uppercase()
}

/// Port of `_comNum`: extract a comparable numeric id from a serial path.
pub fn com_num(serial_path: &str) -> i64 {
    if serial_path.is_empty() {
        return -1;
    }
    // Windows: COMn
    if let Some(idx) = serial_path.to_uppercase().find("COM") {
        let rest: String = serial_path[idx + 3..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !rest.is_empty() {
            if let Ok(n) = rest.parse::<i64>() {
                return n;
            }
        }
    }
    // Unix: trailing digits
    let trailing: String = serial_path
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if !trailing.is_empty() {
        if let Ok(n) = trailing.parse::<i64>() {
            return n;
        }
    }
    -1
}

/// Port of `_isEsp32S3OtgDevice`.
pub fn is_esp32s3_otg_device(device: &DeviceInfo) -> bool {
    let vid = normalize_usb_id(device.vendor_id.as_deref().unwrap_or(""));
    let pid = normalize_usb_id(device.product_id.as_deref().unwrap_or(""));
    if vid != ESP32S3_OTG_VENDOR_ID {
        return false;
    }
    ESP32S3_OTG_PRODUCT_IDS.contains(&pid.as_str())
}

/// Port of `_isTransientSerialError` regex (case-insensitive substring set).
pub fn is_transient_serial_error(msg: &str) -> bool {
    const NEEDLES: [&str; 16] = [
        "disconnected",
        "not open",
        "file_not_found",
        "operation aborted",
        "ebadf",
        "enoent",
        "access denied",
        "unknown error code 31",
        "resource temporarily unavailable",
        "eagain",
        "framing",
        "break",
        "overrun",
        "parity",
        // extra spellings kept for direct mapping with the original alternation
        "no such file",
        "could not open",
    ];
    let lower = msg.to_lowercase();
    NEEDLES.iter().take(14).any(|n| lower.contains(n))
        || NEEDLES[14..].iter().any(|n| lower.contains(n))
}

/// Open configuration for a serial port.
#[derive(Debug, Clone)]
pub struct OpenConfig {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub rts: bool,
    pub dtr: bool,
}

/// An opened serial port handle wrapping the blocking `serialport` object.
pub struct OpenPort {
    inner: Box<dyn SerialPort>,
    /// The path this port was opened on (tracked for re-resolution diagnostics).
    #[allow(dead_code)]
    pub path: String,
}

impl OpenPort {
    /// Open + configure (rts/dtr) a serial port. Port of the `connect()` open path.
    pub fn open(path: &str, cfg: &OpenConfig) -> Result<OpenPort, String> {
        let data_bits = match cfg.data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        };
        let stop_bits = match cfg.stop_bits {
            2 => serialport::StopBits::Two,
            _ => serialport::StopBits::One,
        };
        let mut port = serialport::new(path, cfg.baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| e.to_string())?;
        port.write_request_to_send(cfg.rts).map_err(|e| e.to_string())?;
        port.write_data_terminal_ready(cfg.dtr).map_err(|e| e.to_string())?;
        Ok(OpenPort {
            inner: port,
            path: path.to_string(),
        })
    }

    /// Non-blocking-ish read of available bytes; returns Ok(empty) on timeout.
    pub fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, String> {
        match self.inner.read(buf) {
            Ok(n) => Ok(n),
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(0),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn write_all(&mut self, data: &[u8]) -> Result<usize, String> {
        self.inner.write_all(data).map_err(|e| e.to_string())?;
        self.inner.flush().map_err(|e| e.to_string())?;
        Ok(data.len())
    }

    /// Live baud-rate change + re-apply rts/dtr. Port of `updateBaudrate`.
    pub fn update_baud(&mut self, baud: u32, rts: bool, dtr: bool) -> Result<(), String> {
        self.inner.set_baud_rate(baud).map_err(|e| e.to_string())?;
        self.inner.write_request_to_send(rts).map_err(|e| e.to_string())?;
        self.inner.write_data_terminal_ready(dtr).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Resolve the best reconnect port. Port of `_resolveReconnectPort` ranking
/// (exact path → same VID(/PID) → any ESP VID, ranked by VID priority +
/// COM-number proximity). Polls until the deadline.
pub fn resolve_reconnect_port(
    preferred_path: &str,
    cached: Option<&DeviceInfo>,
) -> Result<DeviceInfo, String> {
    if preferred_path.is_empty() {
        return Err("Missing serial path for reconnect".to_string());
    }
    let preferred_vid = cached
        .and_then(|c| c.vendor_id.as_deref())
        .map(normalize_usb_id)
        .unwrap_or_default();
    let preferred_pid = cached
        .and_then(|c| c.product_id.as_deref())
        .map(normalize_usb_id)
        .unwrap_or_default();
    let deadline = Instant::now() + Duration::from_millis(PORT_LIST_RECONNECT_MAX_WAIT_MS);

    loop {
        let list = list_devices().unwrap_or_default();

        if let Some(exact) = list.iter().find(|d| d.path == preferred_path) {
            return Ok(exact.clone());
        }

        if !preferred_vid.is_empty() {
            let mut vid_matches: Vec<DeviceInfo> = list
                .iter()
                .filter(|d| {
                    let vid = normalize_usb_id(d.vendor_id.as_deref().unwrap_or(""));
                    let pid = normalize_usb_id(d.product_id.as_deref().unwrap_or(""));
                    if vid != preferred_vid || d.path.is_empty() {
                        return false;
                    }
                    preferred_pid.is_empty() || pid == preferred_pid
                })
                .cloned()
                .collect();
            if !vid_matches.is_empty() {
                let pref_com = com_num(preferred_path);
                vid_matches.sort_by(|a, b| {
                    if pref_com > 0 {
                        let da = (com_num(&a.path) - pref_com).abs();
                        let db = (com_num(&b.path) - pref_com).abs();
                        if da != db {
                            return da.cmp(&db);
                        }
                    }
                    com_num(&b.path).cmp(&com_num(&a.path))
                });
                return Ok(vid_matches.remove(0));
            }
        }

        let esp_matches: Vec<DeviceInfo> = list
            .iter()
            .filter(|d| {
                let vid = normalize_usb_id(d.vendor_id.as_deref().unwrap_or(""));
                ESP_RECONNECT_VENDOR_IDS.contains(&vid.as_str()) && !d.path.is_empty()
            })
            .cloned()
            .collect();
        if !esp_matches.is_empty() {
            if let Some(d) = pick_best_esp_reconnect_device(&esp_matches, preferred_path) {
                return Ok(d);
            }
        }

        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(PORT_LIST_POLL_INTERVAL_MS));
    }

    Err(format!("Serial port not listed yet: {}", preferred_path))
}

/// Port of `_pickBestEspReconnectDevice`.
pub fn pick_best_esp_reconnect_device(
    devices: &[DeviceInfo],
    preferred_path: &str,
) -> Option<DeviceInfo> {
    if devices.is_empty() {
        return None;
    }
    let pref_com = com_num(preferred_path);
    let rank = |device: &DeviceInfo| -> i64 {
        let mut score = 0i64;
        if is_esp32s3_otg_device(device) {
            score += 100;
        }
        let vid = normalize_usb_id(device.vendor_id.as_deref().unwrap_or(""));
        if vid == ESP32S3_OTG_VENDOR_ID {
            score += 50;
        }
        if pref_com > 0 {
            score -= (com_num(&device.path) - pref_com).abs();
        }
        score
    };
    let mut sorted = devices.to_vec();
    sorted.sort_by(|a, b| rank(b).cmp(&rank(a)));
    sorted.into_iter().next()
}

/// Natural (numeric-aware) string comparison for path sorting.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let na = com_num(a);
    let nb = com_num(b);
    if na >= 0 && nb >= 0 && na != nb {
        return na.cmp(&nb);
    }
    a.cmp(b)
}
