# Future Academy — Release Notes

## Version 2.0.1 (2026-05-29)

Windows local hardware link server for [Windify Block](https://stem.windify.edu.vn/).

### Download

- Installer: `FutureAcademy-2.0.1-x64-setup.exe`
- Platform: Windows 10/11 (64-bit)
- Size: ~400-500 MB

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
- **Browser not opened:** open [https://stem.windify.edu.vn/](https://stem.windify.edu.vn/) manually.
- **Port in use:** close other Future Academy instances (tray/Task Manager).

### Uninstall

Windows Settings -> Apps -> Future Academy -> Uninstall.  
Optional cleanup: delete `%LOCALAPPDATA%\WindyLink`.
