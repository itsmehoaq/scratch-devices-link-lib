# Future Academy — Release notes

## Current version: 2.0.1

**Release date:** 2026-05-29

Local hardware link server for the [Windify Block editor](https://stem.windify.edu.vn/).

---

## Download

| | |
|---|---|
| **Installer** | `FutureAcademy-2.0.1-x64-setup.exe` |
| **Platform** | Windows 10 / 11 (64-bit) |
| **Size** | ~400–500 MB |

## Requirements

- Windows 10 or later (64-bit)
- Administrator rights to install
- Internet connection for the editor at https://stem.windify.edu.vn/
- No separate Node.js install needed for this release

## Install

1. Run `FutureAcademy-2.0.1-x64-setup.exe`
2. Follow the setup wizard
3. Wait on **“Extracting build tools…”** (about 1–3 minutes)
4. Start **Future Academy** from the Start Menu

The app opens a desktop window and system tray icon, starts the link server on port **11337**, and opens https://stem.windify.edu.vn/ in your browser.

## Installed locations

| Location | Purpose |
|----------|---------|
| `C:\Program Files\Future Academy\` | Application |
| `C:\ProgramData\Windify\Future Academy\tools\` | Arduino / ESP build tools |
| `%LOCALAPPDATA%\WindyLink\` | User data and build cache |

## What’s new in 2.0.1

- Desktop app with device list, tray icon, and in-app console
- Windows setup installer with bundled build tools
- Improved USB device listing (real devices only)
- Future Academy branding and icons

## Uninstall

**Settings → Apps → Installed apps → Future Academy → Uninstall**

To remove local cache as well, delete:

`%LOCALAPPDATA%\WindyLink`

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| Setup fails while extracting tools | Uninstall any partial install, run setup again; check antivirus is not blocking the installer |
| Administrator prompt | Expected for install to Program Files and ProgramData |
| Upload / flash fails | Quit Future Academy from the tray, confirm `arduino-cli.exe` exists under ProgramData tools (see table above), then reinstall if needed |
| Browser does not open | Open https://stem.windify.edu.vn/ manually |
| “Port already in use” | Close other Future Academy instances (tray or Task Manager) |

## Support

https://stem.windify.edu.vn/
