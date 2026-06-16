# Future Academy Link — Windows build and release guide

## Installer

`Future Academy Link-*-x64-setup.exe` is built with **Inno Setup** from `installer/FutureAcademyLink.iss`.

Recommended commands:

```bash
npm run build:win:installer
```

Output: `dist/Future Academy Link-<version>-x64-setup.exe`

The installer extracts bundled build tools to the install folder and writes installer metadata under:

```text
HKLM\Software\Windify\Future Academy
```

## Portable zip

`FutureAcademy-*-x64-app.zip` is a portable Windows bundle containing the app, tools, and firmwares.

Recommended commands:

```bash
npm run build:win:portable
```

Output: `dist/FutureAcademy-<version>-x64-app.zip`

Unzip anywhere and run the packaged executable. Keep the `tools/` and `firmwares/` folders beside the app executable.

## Post-build notes

- Windows Defender or SmartScreen may block unsigned executables or installers.
- If the installer is blocked, right-click the file and choose **Properties → Unblock** before running it.
- For release builds, sign Windows artifacts with `WIN_SIGN_PFX_PATH` if Authenticode signing is configured.

## Related scripts

- `script/prepare-installer-payload.js`
- `script/build-setup.js`
- `script/package-app-zip.js`
