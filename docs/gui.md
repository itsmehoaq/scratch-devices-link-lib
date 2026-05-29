# Future Academy Link — Desktop GUI

Electron desktop panel for **Windy Link** (`scratch-devices-link-lib`), matching the Figma device-list layout (Future Academy branding, device cards, floating Website / Console / Refresh actions).

## Run locally

```bash
npm install
npm run start:gui
```

Or from the CLI entry with a detached Electron window:

```bash
node bin/windy-link.js --gui
```

The GUI starts the same HTTP/WebSocket link server as the headless binary (`127.0.0.1:11337`) and does **not** auto-open the browser (`WINDY_OPEN_STARTUP_URL=0`). Use **Website** in the floating bar or the tray menu to open [stem.windify.edu.vn](https://stem.windify.edu.vn/).

## Behaviour

| UI control | Action |
|------------|--------|
| Device list | Polls `SerialPort.list()` every 3s (Port / VID / PID) |
| Website | Opens `WINDY_STARTUP_URL` or default editor URL |
| Console | Opens the **app log window** (link server `console.*` output, not browser DevTools) |
| Refresh | Refreshes the device list immediately |
| Close (×) | Hides to system tray (server keeps running) |
| Tray | Show window, open browser, open console, quit |

## Layout / tokens

- Primary: `#0e69b3`
- Device list surface: `#f3f3f3` (Figma node `9:399`)
- Content panel: Figma `4:714` (white 36px card, header + device list + bottom float bar)
- Float bar: in-flow at bottom of content (`7:289`), horizontal icon+label buttons; idle `7:325`, hover `7:291`
- Device list: only ports with both **VID** and **PID** (hides COM placeholders like COM1)
- Section gradient: `#f6c149` → `#eb5779`
- Card header: Mobifone gradient image + `#0061af` drop shadow
- Neutral border: `#e5e5e5`
- Fonts: Quicksand (titles), DM Sans (metadata)
- Assets: `gui/assets/` (served beside `index.html` for Electron)
- After downloading from Figma, run `npm run gui:assets` — Figma URLs often return **SVG saved as `.png`**; the script converts them to real PNGs for `<img>` tags

## Windows installer build

`npm run release:setup` packages the **GUI** (Electron) into `FutureAcademy-<version>-x64-setup.exe`:

```bash
npm install
npm run fetch
npm run release:setup
```

Steps: `build:gui:win` → `prepare:installer-payload:gui` → Inno Setup.

Headless CLI-only installer (pkg + system Node.js MSI):

```bash
npm run release:setup:cli
```

Windows GUI builds disable Authenticode signing (`signAndEditExecutable: false`) so `electron-builder` does not need the `winCodeSign` cache (avoids symlink errors without Developer Mode).
