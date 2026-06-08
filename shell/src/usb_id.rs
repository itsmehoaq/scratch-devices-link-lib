//! Static VID/PID → friendly-name map. Port of `src/lib/usb-id.js`.

/// Look up a friendly name for a `USB\VID_xxxx&PID_yyyy` key (keys uppercased).
pub fn lookup(pnpid: &str) -> Option<&'static str> {
    match pnpid {
        // CH340
        "USB\\VID_1A86&PID_7523" => Some("USB-SERIAL CH340"),
        // CH343
        "USB\\VID_1A86&PID_55D3" => Some("USB-SERIAL CH343"),
        // CH9102
        "USB\\VID_1A86&PID_55D4" => Some("USB-SERIAL CH9102"),
        // PL2303
        "USB\\VID_067B&PID_2303" => Some("USB-SERIAL PL2303"),
        // FTDI
        "USB\\VID_0403&PID_6001" => Some("USB-SERIAL FTDI"),
        "USB\\VID_0403&PID_6010" => Some("USB-SERIAL FTDI"),
        // CP2102
        "USB\\VID_10C4&PID_EA60" => Some("USB-SERIAL CP2102"),
        // Arduino Uno
        "USB\\VID_2341&PID_0043" => Some("Arduino UNO"),
        "USB\\VID_2341&PID_0001" => Some("Arduino UNO"),
        "USB\\VID_2A03&PID_0043" => Some("Arduino UNO"),
        "USB\\VID_2341&PID_0243" => Some("Arduino UNO"),
        _ => None,
    }
}
