# Future Academy — Release Notes

## Version 2.0.2

Windows local hardware link server for [Windify Block](https://stem.windify.edu.vn/).

### Build (maintainers)

```bash
npm run release
```

Produces in `dist/`:

- `FutureAcademy-2.0.2-x64-setup.exe` — Inno Setup installer (GUI + tools.7z)
- `FutureAcademy-2.0.2-x64-app.zip` — portable Electron app (after `release:app-zip`)

Zip only (GUI already built): `npm run release:app-zip`

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
- Tools: `C:\ProgramData\Windify\Future Academy\tools\`
- User data: `%LOCALAPPDATA%\WindyLink\`

### Troubleshooting

- **Extracting tools failed:** rerun installer and whitelist `dist`/installer in antivirus.
- **Upload/flash failed:** verify `arduino-cli.exe` exists under ProgramData tools, then reinstall.
- **Missing VL53L0X / Windify:** from repo run `npm run verify:libs`; copy `tools/Arduino/libraries` to ProgramData or rebuild `tools.7z`.
- **Browser not opened:** open [https://stem.windify.edu.vn/](https://stem.windify.edu.vn/) manually.
- **Port in use:** close other Future Academy instances (tray/Task Manager).

### Uninstall

Windows Settings -> Apps -> Future Academy -> Uninstall.  
Optional cleanup: delete `%LOCALAPPDATA%\WindyLink`.
