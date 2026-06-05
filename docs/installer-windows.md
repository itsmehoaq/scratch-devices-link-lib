# Windows 11 installer — SmartScreen and extraction

`FutureAcademy-*-x64-setup.exe` is built with **Inno Setup** and is currently **unsigned** unless you sign at build time. On Windows 11 this commonly looks like “won’t run” or “won’t extract” even when the file is fine.

## Why it happens

| Cause | What users see |
|--------|----------------|
| **SmartScreen** (unsigned exe) | Blue banner: “Windows protected your PC” |
| **Mark of the Web** (downloaded from browser / HTTP) | Blocked or restricted until **Unblock** |
| **Defender** during install | Silent failure extracting `tools.7z` via `7za.exe` in `%TEMP%` |
| **No admin** | Install to `Program Files` fails |

The installer copies the app, then extracts `tools.7z` into:

`C:\Program Files\Future Academy\tools\`

(same folder as `WindyLink.exe`)

If 7-Zip is blocked, the wizard now shows an explicit error (see `installer/WindyLink.iss`).

## End users — quick fixes

### 1. Unblock the downloaded file

Right-click `FutureAcademy-*-x64-setup.exe` → **Properties** → check **Unblock** → OK → run again.

Or PowerShell (run as the same user):

```powershell
Unblock-File -LiteralPath "$env:USERPROFILE\Downloads\FutureAcademy-2.0.3-x64-setup.exe"
```

### 2. SmartScreen “Run anyway”

1. Run the installer once (SmartScreen appears).
2. Click **More info**.
3. Click **Run anyway**.
4. Accept the **UAC** prompt (installer requires administrator).

### 3. Antivirus / Defender

- Add an exclusion for the installer while installing, or for:
  - `%TEMP%\is-*` (Inno temp)
  - `C:\Program Files\Future Academy\`
- Re-run the installer after a failed extract.

### 4. Portable zip (includes tools)

`FutureAcademy-*-x64-app.zip` contains `WindyLink.exe`, `tools/`, and `firmwares/` in one folder. Unzip anywhere and run `WindyLink.exe` — no separate extract step.

## IT / schools — recommended distribution

1. **HTTPS** download URL (builds reputation; raw IP HTTP triggers stricter SmartScreen).
2. **Code signing** (see below) — only reliable way to remove SmartScreen for unknown publishers.
3. Ship **SHA-256** checksum alongside the exe for integrity checks.
4. Pre-install by copying the full `Future Academy` folder (app + `tools/`) if installers are blocked.

## Maintainers — sign the installer

Requires an **Authenticode** certificate (`.pfx`), ideally EV for immediate SmartScreen trust.

```powershell
$env:WIN_SIGN_PFX_PATH = "D:\certs\windify.pfx"
$env:WIN_SIGN_PFX_PASSWORD = "secret"
npm run release
```

`build:setup` runs `script/sign-windows-artifacts.js` after Inno compiles the exe.

Optional timestamp server:

```powershell
$env:WIN_SIGN_TIMESTAMP_URL = "http://timestamp.digicert.com"
```

Sign manually:

```bash
node script/sign-windows-artifacts.js dist/FutureAcademy-2.0.3-x64-setup.exe
```

Electron GUI EXE signing (optional, before payload):

```powershell
$env:CSC_LINK = "D:\certs\windify.pfx"
$env:CSC_KEY_PASSWORD = "secret"
# In package.json set build.win.sign / signAndEditExecutable to true when winCodeSign symlinks work
```

## Verify signature

```powershell
Get-AuthenticodeSignature .\dist\FutureAcademy-2.0.3-x64-setup.exe | Format-List Status, SignerCertificate
```

`Status : Valid` → SmartScreen should improve after reputation builds.

## Rebuild after script changes

```bash
npm run build:gui:win
npm run prepare:installer-payload:gui
npm run build:setup
```
