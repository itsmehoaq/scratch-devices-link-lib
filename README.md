# Future Academy — Windify Block Link Server

Local hardware link server for [Future Academy / Windblock 3.0 GUI](https://stem.windify.edu.vn/).

### Instructions
```bash
# Run from the repo root
npm install
npm run fetch
npm start
```

### Desktop GUI (Figma device panel)

```bash
npm install
npm run start:gui
```

Shows a Future Academy tray window with USB serial device list, **Website**, **Console**, and **Refresh**. See [docs/gui.md](docs/gui.md).

Listen host: default `0.0.0.0` (all interfaces). Loopback-only: `set WINDY_LINK_LISTEN_HOST=127.0.0.1` then `npm start`. The address `0.0.0.1` is not valid for TCP bind.

When launched as `WindyLink.exe`, the app opens **https://stem.windify.edu.vn/** in the default browser after the link server is ready.

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

After setup install, build tools are stored in `%ProgramData%\Windify\Future Academy\tools` and user data (build cache) is stored in `%LOCALAPPDATA%\WindyLink`.

### Build Windows Setup EXE installer

Prerequisite on the build machine:

```powershell
winget install JRSoftware.InnoSetup
```

Build the **desktop GUI** setup installer (Electron tray app + device panel):

```powershell
npm install
npm run fetch
npm run release:setup
```

This runs `build:gui:win` (Electron), then Inno Setup. The installed app is `WindyLink.exe` with the Future Academy window and system tray — no separate Node.js install required.

Headless CLI installer (single `pkg` exe + optional Node.js MSI):

```powershell
npm run release:setup:cli
```

Note: do not run `script/apply-exe-icon.js` on pkg-built `WindyLink.exe` — it corrupts the binary. Icons come from `assets/FutureAcademy.ico` via `npm run gui:logo` and Inno Setup.

Output:

```
dist/FutureAcademy-<version>-x64-setup.exe
```

(`<version>` matches `package.json`, e.g. `2.0.1`.)

Install flow:

1. Double-click the setup EXE
2. App files install to `C:\Program Files\Future Academy\`
3. Setup extracts build tools from `tools.7z` to `C:\ProgramData\Windify\Future Academy\tools\` (wait for the progress step; may take a few minutes)
4. (CLI installer only) Node.js LTS is installed silently if it is missing or older than v18
5. Start **Future Academy** from the Start Menu — GUI window + system tray
6. Browser opens https://stem.windify.edu.vn/
7. Uninstall via Windows Settings → Apps (optional cleanup: delete `%LOCALAPPDATA%\WindyLink`)

Release notes: [release.md](release.md)

If `release:setup` fails because `dist\` is locked:

```powershell
npm run clean:dist
npm run release:setup
```

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
