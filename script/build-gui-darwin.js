/**
 * Build the Future Academy desktop GUI (Electron) for macOS.
 * Output: dist/electron/mac-unpacked/WindyLink.app  (x64)
 *         dist/electron/mac-arm64-unpacked/WindyLink.app  (arm64)
 *
 * Usage:
 *   node script/build-gui-darwin.js [--arch arm64|x64|universal]
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const defaultElectronOutput = path.join(repoRoot, 'dist', 'electron');

const args = process.argv.slice(2);
const archFlag = (() => {
    const idx = args.indexOf('--arch');
    if (idx !== -1 && args[idx + 1]) {
        return args[idx + 1];
    }
    // Default to the current machine architecture
    return os.arch() === 'arm64' ? 'arm64' : 'x64';
})();

const runNpm = npmArgs => {
    const result = spawnSync('npm', npmArgs, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: true,
        env: process.env
    });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
};

const runElectronBuilder = outputDir => {
    const relOutput = path
        .relative(repoRoot, outputDir)
        .split(path.sep)
        .join('/');
    const localBin = path.join(
        repoRoot,
        'node_modules',
        '.bin',
        'electron-builder'
    );
    const cmd = fs.existsSync(localBin) ? localBin : 'npx electron-builder';
    const builderArgs = [
        '--mac',
        'dir',
        `--${archFlag}`,
        `--config.directories.output=${relOutput}`
    ];
    const result = spawnSync(cmd, builderArgs, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: true,
        env: {
            ...process.env,
            CSC_IDENTITY_AUTO_DISCOVERY: 'false'
        }
    });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
};

if (os.platform() !== 'darwin') {
    console.error('[build-gui-darwin] macOS GUI builds must run on macOS.');
    console.error('[build-gui-darwin] Cross-compilation from Windows/Linux is possible');
    console.error('[build-gui-darwin] but not recommended without code signing.');
    process.exit(1);
}

console.info('[build-gui-darwin] preparing GUI assets…');
runNpm(['run', 'gui:assets']);

const electronOutput = defaultElectronOutput;
fs.mkdirSync(electronOutput, {recursive: true});

const unpackedDir = archFlag === 'arm64'
    ? path.join(electronOutput, 'mac-arm64-unpacked')
    : path.join(electronOutput, 'mac-unpacked');
const appPath = path.join(unpackedDir, 'WindyLink.app');

console.info(`[build-gui-darwin] packaging Electron app (${archFlag})…`);
runElectronBuilder(electronOutput);

if (!fs.existsSync(appPath)) {
    // electron-builder may name the .app after productName
    const altAppPath = path.join(unpackedDir, 'Future Academy.app');
    if (!fs.existsSync(altAppPath)) {
        console.error(`[build-gui-darwin] missing ${appPath}`);
        process.exit(1);
    }
    console.info(`[build-gui-darwin] ready: ${altAppPath}`);
} else {
    console.info(`[build-gui-darwin] ready: ${appPath}`);
}
