# Future Academy Link

Local hardware link server for [Future Academy](https://stem.windify.edu.vn/).

Single Rust binary — no Node.js or Electron at runtime. Downloads arduino-cli and ESP32 toolchain on first launch when no local toolchain is present.

---

## Install

Download the latest release for your platform from the [Releases](../../releases) page:

| File | Platform |
|------|----------|
| `Future Academy Link.app` | macOS Apple Silicon |
| `Future Academy Link — Intel.app` | macOS Intel |
| `Future Academy Link.exe` | Windows x64 |

**macOS:** unzip, right-click → Open (first time only — app is ad-hoc signed, not notarized). Or remove quarantine:
```bash
xattr -cr "Future Academy Link.app"
```

**Windows:** unzip, run `Future Academy Link.exe`.

On first run, arduino-cli and the ESP32/AVR toolchain are downloaded to:
- macOS: `~/Library/Application Support/Future Academy Link/tools/`
- Windows: `%LOCALAPPDATA%\Future Academy Link\tools\`

---

## Build locally

Prerequisites: Rust (via rustup), Node.js (for packaging scripts only).

```bash
# macOS Apple Silicon
npm run build:app:mac:arm64     # → dist/Future Academy Link.app

# macOS Intel
npm run build:app:mac:x64       # → dist/Future Academy Link — Intel.app

# Windows
npm run build:win:installer     # → dist/Future Academy Link-<version>-x64-setup.exe
npm run build:win:portable      # → dist/FutureAcademy-win/
```

Cross-compile targets require rustup:
```bash
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin
rustup target add x86_64-pc-windows-gnu
```

---

## How it works

- `FutureAcademyTray` starts a tray icon and an embedded HTTP/WebSocket server on `http://127.0.0.1:11337`
- Serial devices appear in the tray menu in real time
- Tray shows setup progress while tools download on first run
- Log file: `~/Library/Logs/Future Academy Link/link.log` (macOS) / `%LOCALAPPDATA%\Future Academy Link\link.log` (Windows)
- Click **Show Console Log** in the tray to open the log

---

## JSON-RPC API (WebSocket)

Connect to `ws://127.0.0.1:11337/`. All messages are JSON-RPC 2.0.

### `connect`
```jsonc
{ "jsonrpc": "2.0", "id": 1, "method": "connect", "params": { "port": "/dev/cu.usbmodem123", "baudRate": 115200 } }
```

### `upload` (Arduino AVR)
```jsonc
{ "jsonrpc": "2.0", "id": 2, "method": "upload", "params": { "port": "/dev/cu.usbmodem123", "board": "uno", "hex": "<base64>" } }
```

### `uploadEsp32Bin`
```jsonc
{
  "jsonrpc": "2.0", "id": 3, "method": "uploadEsp32Bin",
  "params": {
    "chip": "esp32s3", "baudrate": 921600,
    "addresses": { "bootloader": 0, "partitions": 32768, "firmware": 65536 },
    "bins": {
      "bootloader": { "encoding": "base64", "data": "<...>" },
      "partitions":  { "encoding": "base64", "data": "<...>" },
      "firmware":    { "encoding": "base64", "data": "<...>" }
    }
  }
}
```

Progress streams via `uploadStdout` notifications. Ends with `uploadSuccess`.

### `scanDevices`
```jsonc
{ "jsonrpc": "2.0", "id": 4, "method": "scanDevices", "params": { "command": "scan", "terminator": "\n", "timeoutMs": 10000 } }
```

Returns `{ devices: [...], raw: "..." }`.

---

## CI / Releases

Pushing to `main` or `macos-optimize` triggers a build for all 3 platforms and auto-publishes a GitHub release tagged `v{version}` (from `package.json`). Zips are created on the native runner (`ditto` for macOS, `Compress-Archive` for Windows) to preserve permissions.
