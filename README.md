# Future Academy — Windify Block Link Server

Local hardware link server for [Future Academy / Windblock 3.0 GUI](https://steam.windify.edu.vn/).

### Instructions
```bash
# Run from the repo root
npm install
npm run fetch
npm start
```

Listen host: default `0.0.0.0` (all interfaces). Loopback-only: `set WINDY_LINK_LISTEN_HOST=127.0.0.1` then `npm start`. The address `0.0.0.1` is not valid for TCP bind.

When launched as `WindyLink.exe`, the app opens **https://steam.windify.edu.vn/** in the default browser after the link server is ready.

Optional env vars:

- `WINDY_STARTUP_URL` — override startup browser URL
- `WINDY_OPEN_STARTUP_URL=0` — disable opening the browser on start

### Build Windows terminal exe

```powershell
npm install
npm run fetch
npm run release:win
```

Output staging folder (portable run):

```
dist/staging/Future Academy/
├── WindyLink.exe
├── tools/
└── firmwares/
```

Run from that folder so build/upload tools resolve correctly:

```powershell
cd "dist\staging\Future Academy"
.\WindyLink.exe
```

If tools are missing beside the exe, upload will fail instead of crashing the server.

After MSI install, user data (build cache) is stored in `%LOCALAPPDATA%\WindyLink`.

### Build Windows MSI installer

Prerequisite on the build machine:

```powershell
winget install WiXToolset.WiXToolset
```

Build the MSI (icon appears on Start Menu shortcut and Add/Remove Programs):

```powershell
npm install
npm run release:msi
```

Note: do not run `script/apply-exe-icon.js` on pkg-built `WindyLink.exe` — it corrupts the binary. The Future Academy icon is applied via the MSI installer.

Output:

```
dist/FutureAcademy-0.2.0-x64.msi
```

Install flow:

1. Double-click the MSI
2. Files install to `C:\Program Files\Future Academy\`
3. Start **Future Academy** from the Start Menu (Future Academy logo icon)
4. Browser opens https://steam.windify.edu.vn/
5. Uninstall via Windows Settings → Apps (optional cleanup: delete `%LOCALAPPDATA%\WindyLink`)

### ESP32 binary flashing & device scan

The link server can flash a triple of pre-compiled ESP32 bins
(`bootloader.bin`, `partitions.bin`, `firmware.bin`) over an existing
serial session by wrapping the `esptool` binary that `npm run fetch`
extracts under `tools/Arduino/packages/esp32/tools/esptool_py/<ver>/`.
After flashing, the same session can issue a `scan` command and stream
the firmware's JSON device list back to the client.

See [`docs/esp32-bin-flash.md`](docs/esp32-bin-flash.md) for the full
design notes and the GUI flow it mirrors.

#### `uploadEsp32Bin` (JSON-RPC)

Pre-condition: the session is already `connect`ed to the target serial
port (same flow as the existing AVR `upload`).

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "uploadEsp32Bin",
  "params": {
    "chip": "esp32s3",
    "baudrate": 921600,
    "eraseAll": false,
    "flashMode": "dio",
    "flashFreq": "80m",
    "flashSize": "keep",
    "addresses": { "bootloader": 0, "partitions": 32768, "firmware": 65536 },
    "bins": {
      "bootloader": { "encoding": "base64", "data": "<...>" },
      "partitions": { "encoding": "base64", "data": "<...>" },
      "firmware":   { "path": "C:/abs/path/firmware.bin" }
    }
  }
}
```

Each `bins.*` entry accepts either an inline `{encoding, data}` payload
or a local `{path}` already on disk. Progress is streamed back via the
existing `uploadStdout` notifications (with optional `progress` 0..1
values). The flow ends with an `uploadSuccess` notification.

#### `scanDevices` (JSON-RPC)

```jsonc
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "scanDevices",
  "params": { "command": "scan", "terminator": "\n", "timeoutMs": 10000 }
}
```

Returns `{ devices: [...], raw: <full JSON> }` once the firmware emits
a balanced JSON object containing a `devices` array. Rejects with
`scan timeout` after `timeoutMs`.
