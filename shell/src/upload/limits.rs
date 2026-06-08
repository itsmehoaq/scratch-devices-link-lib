//! ESP32 flash partition constants. Port of `src/upload/upload-limits.js`.

/// Max program storage on ESP32 boards with 16 MB flash (APP partition budget).
pub const MAX_FLASH_PROGRAM_BYTES: u64 = 16 * 1024 * 1024;

/// ~14 MiB APP slot for Windify PCM-in-PROGMEM (partitions.csv on 16 MB flash).
pub const WINDIFY_ESP32_16MB_APP_BYTES: u64 = 14 * 1024 * 1024;

/// default_16MB OTA slot size from the ESP32 Arduino core.
pub const ESP32_DEFAULT_16MB_APP_BYTES: u64 = 6553600;

/// Custom 16 MB partition table (app0 0x10000 size 0xE00000). Verbatim port.
pub const WINDIFY_ESP32_16MB_PARTITIONS_CSV: &str = "# Name,   Type, SubType, Offset,  Size, Flags
nvs,      data, nvs,     0x9000,  0x5000,
otadata,  data, ota,     0xe000,  0x2000,
app0,     app,  ota_0,   0x10000, 0xE00000,
coredump, data, coredump,0xFF0000,0x10000,
";
