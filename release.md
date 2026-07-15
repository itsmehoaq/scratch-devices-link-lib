# Future Academy — Release Notes

## Version 2.0.13

Windows local hardware link server for [Windify Block](https://stem.windify.edu.vn/).

### Bug Fixes

- Prevent `GetFinalPathNameByHandleW` panic on Windows when executable path involves symlinks, junctions, or special filesystem paths.

## Version 2.0.2

Windows local hardware link server for [Windify Block](https://stem.windify.edu.vn/).

### Build (maintainers)

```bash
npm install
npm run release
```

`release` runs `ensure:tools` first (downloads `tools/` + `firmwares/` via `fetch:small` when missing), then builds the setup EXE and app zip.

Force re-download tools:

```bash
npm run clean
npm run release
```

If GitHub `winblockcc/winblock-tools` returns **404**, `ensure:tools` falls back to `fetch:local`:

- Copies from `C:\Program Files\Future Academy\tools` if installed, or legacy ProgramData path, or
- Set `WINDY_TOOLS_SOURCE` / `TOOLS_7Z_PATH` before `npm run release`

Produces in `dist/`:

- `Future Academy Link-2.0.2-x64-setup.exe` — Inno Setup installer (GUI + tools.7z)
- `FutureAcademy-2.0.2-x64-app.zip` — portable bundle: GUI + `tools/` + `firmwares/` (unzip and run `Future Academy Link.exe`)

Zip only (requires `tools/` + GUI build): `npm run ensure:tools && npm run build:gui:win && npm run release:app-zip`

Publish to update server (from `scratch-link-server` repo): `npm run seed:releases`

### Download (update server)

Set `PUBLIC_BASE_URL` on the server (e.g. `http://14.225.209.18:8080`).

| Artifact | URL pattern |
|----------|-------------|
| Installer (.exe) | `{PUBLIC_BASE_URL}/downloads/FutureAcademy-2.0.2-x64-setup.exe` |
| Portable (.zip) | `{PUBLIC_BASE_URL}/downloads/FutureAcademy-2.0.2-x64-app.zip` |
| Short links | `{PUBLIC_BASE_URL}/download` (exe), `{PUBLIC_BASE_URL}/download/zip` |

### Download (offline / direct file)

- Installer: `FutureAcademy-2.0.2-x64-setup.exe`
- Portable zip: `FutureAcademy-2.0.2-x64-app.zip`
- Platform: Windows 10/11 (64-bit)
- Size: ~400-500 MB (installer)

### Install

1. Run the installer as administrator.
2. Wait for **Extracting build tools...** (usually 1-3 minutes).
3. Launch **Future Academy** from Start Menu.

The app starts the link server (port `11337`) and opens the editor URL.

### Paths

- App: `C:\Program Files\Future Academy\`
- Tools: `C:\Program Files\Future Academy\tools\` (beside `Future Academy Link.exe`)
- User data: `%LOCALAPPDATA%\Future Academy Link\`

### Troubleshooting

- **Windows 11 blocks installer / tools not extracted:** unsigned build + SmartScreen / Defender. See [docs/installer-windows.md](docs/installer-windows.md) — **Unblock** the exe, **More info → Run anyway**, allow in antivirus, rerun as admin.
- **Downloaded from update server over HTTP:** right-click installer → Properties → **Unblock**, then install.
- **Extracting tools failed:** installer now shows a 7-Zip error dialog; whitelist Inno `%TEMP%` and the install folder, then reinstall.
- **Upload/flash failed:** verify `arduino-cli.exe` exists under `{app}\tools`, then reinstall.
- **Missing VL53L0X / Windify:** from repo run `npm run verify:libs`; copy `tools/Arduino/libraries` into the app `tools` folder or rebuild `tools.7z`.
- **Browser not opened:** open [https://stem.windify.edu.vn/](https://stem.windify.edu.vn/) manually.
- **Port in use:** close other Future Academy instances (tray/Task Manager).

### Uninstall

Windows Settings -> Apps -> Future Academy -> Uninstall.
Optional cleanup: delete `%LOCALAPPDATA%\Future Academy Link`.
