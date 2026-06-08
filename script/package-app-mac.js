/**
 * Package FutureAcademy.app (macOS) — Rust-only, no Node runtime.
 * Usage: node script/package-app-mac.js [--arch arm64|x64]
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const args = process.argv.slice(2);
const arch = (() => {
    const i = args.indexOf('--arch');
    return i !== -1 && args[i + 1] ? args[i + 1] : 'arm64';
})();

const rustTarget = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const trayBin = path.join(repoRoot, 'shell', 'target', rustTarget, 'release', 'FutureAcademyTray');

if (!fs.existsSync(trayBin)) {
    console.error(`Missing shell binary: ${trayBin}`);
    console.error(`Run npm run build:shell:mac:${arch} first.`);
    process.exit(1);
}

const appName = 'FutureAcademy.app';
const appPath = path.join(repoRoot, 'dist', arch === 'x64' ? `FutureAcademy-intel.app` : appName);
const macOsDir = path.join(appPath, 'Contents', 'MacOS');
const resourcesDir = path.join(appPath, 'Contents', 'Resources');

if (fs.existsSync(appPath)) {
    fs.rmSync(appPath, {recursive: true, force: true});
}
fs.mkdirSync(macOsDir, {recursive: true});
fs.mkdirSync(resourcesDir, {recursive: true});

// Info.plist — LSUIElement hides the Dock icon.
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>edu.windify.future-academy.link</string>
  <key>CFBundleName</key>
  <string>Future Academy Link</string>
  <key>CFBundleDisplayName</key>
  <string>Future Academy Link</string>
  <key>CFBundleExecutable</key>
  <string>FutureAcademyTray</string>
  <key>CFBundleIconFile</key>
  <string>FutureAcademy</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${pkg.version}</string>
  <key>CFBundleVersion</key>
  <string>${pkg.version}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), infoPlist, 'utf8');

fs.copyFileSync(trayBin, path.join(macOsDir, 'FutureAcademyTray'));
fs.chmodSync(path.join(macOsDir, 'FutureAcademyTray'), 0o755);

const icnsSource = path.join(repoRoot, 'assets', 'FutureAcademy.icns');
if (fs.existsSync(icnsSource)) {
    fs.copyFileSync(icnsSource, path.join(resourcesDir, 'FutureAcademy.icns'));
}

// Ad-hoc codesign.
const sign = spawnSync('codesign', ['--sign', '-', '--force', '--deep', appPath], {
    stdio: 'inherit'
});
if (sign.status !== 0) {
    console.error('codesign failed');
    process.exit(1);
}

const archLabel = arch === 'arm64' ? 'Apple Silicon (ARM64)' : 'Intel (x86_64)';
console.log(`\nBuilt: ${appPath}`);
console.log(`Arch:  ${archLabel}`);
console.log(`Size:  ${(fs.statSync(path.join(macOsDir, 'FutureAcademyTray')).size / 1024 / 1024).toFixed(1)} MB`);
console.log('\nTools (arduino-cli + esp32 core) are downloaded on first run.');
