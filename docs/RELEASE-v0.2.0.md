# Future Academy v0.2.0 — Windows Installer

**Release date:** 2026-05-27

Future Academy is the local hardware link server for the [Windify Block editor](https://stem.windify.edu.vn/). It connects your browser to Arduino/ESP boards over USB for upload, flash, and serial communication.

## Download

**File:** `FutureAcademy-0.2.0-x64-setup.exe`  
**Platform:** Windows 10/11 (64-bit)  
**Size:** ~239 MB

## System requirements

- Windows 10 or later (64-bit)
- Administrator rights for installation
- Internet connection to use https://stem.windify.edu.vn/

If Node.js is not already on your PC, the installer will install it automatically.

## Install

1. Download `FutureAcademy-0.2.0-x64-setup.exe`
2. Double-click the file and follow the setup wizard
3. Wait until installation finishes (tool extraction may take a few minutes on first install)
4. Open **Future Academy** from the Start Menu

When the app starts, your browser opens https://stem.windify.edu.vn/ and the link server runs in the background on port **11337**.

## What gets installed

| Location | Contents |
|----------|----------|
| `C:\Program Files\Future Academy\` | Future Academy app and firmware files |
| `C:\ProgramData\Windify\Future Academy\tools\` | Arduino build and upload tools |
| `%LOCALAPPDATA%\WindyLink\` | Build cache and user data (created when you use the app) |

## What's new in v0.2.0

- New Windows setup installer (`.exe`) — easier to install than the previous MSI package
- Build tools are included in the installer; no separate download needed
- Node.js is installed automatically when required
- Improved device connection stability

## Uninstall

1. Open **Settings → Apps → Installed apps**
2. Find **Future Academy** and choose **Uninstall**

To also remove build cache, delete the folder:

```
%LOCALAPPDATA%\WindyLink
```

## Troubleshooting

**Installation asks for administrator permission**  
This is normal. The app installs to Program Files and extracts build tools to ProgramData.

**Upload or flash fails after install**  
Close Future Academy, run the installer again, or reinstall from the setup EXE.

**Browser does not open automatically**  
Open https://stem.windify.edu.vn/ manually after starting Future Academy from the Start Menu.

**Port already in use**  
Another copy of Future Academy may already be running. Close it from the system tray or Task Manager, then start again.

## Support

- Editor: https://stem.windify.edu.vn/
