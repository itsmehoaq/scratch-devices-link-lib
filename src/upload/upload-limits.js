/** Max program storage on ESP32 boards with 16 MB flash (APP partition budget). */
const MAX_FLASH_PROGRAM_BYTES = 16 * 1024 * 1024;

/** ~14 MiB APP slot for Windify PCM-in-PROGMEM (partitions.csv on 16 MB flash). */
const WINDIFY_ESP32_16MB_APP_BYTES = 14 * 1024 * 1024;

/** default_16MB OTA slot size from the ESP32 Arduino core. */
const ESP32_DEFAULT_16MB_APP_BYTES = 6553600;

const WINDIFY_ESP32_16MB_PARTITIONS_CSV = `# Name,   Type, SubType, Offset,  Size, Flags
nvs,      data, nvs,     0x9000,  0x5000,
otadata,  data, ota,     0xe000,  0x2000,
app0,     app,  ota_0,   0x10000, 0xE00000,
coredump, data, coredump,0xFF0000,0x10000,
`;

module.exports = {
    MAX_FLASH_PROGRAM_BYTES,
    WINDIFY_ESP32_16MB_APP_BYTES,
    ESP32_DEFAULT_16MB_APP_BYTES,
    WINDIFY_ESP32_16MB_PARTITIONS_CSV
};
