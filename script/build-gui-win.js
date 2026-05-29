/**
 * Build the Future Academy desktop GUI (Electron) for Windows x64.
 * Output: dist/electron/win-unpacked/WindyLink.exe
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    stopRunningWindyLink,
    cleanLockedDir
} = require('./lib/clean-locked-dir');
const {setElectronOutputPointer} = require('./lib/electron-output');

const repoRoot = path.resolve(__dirname, '..');
const defaultElectronOutput = path.join(repoRoot, 'dist', 'electron');

const runNpm = args => {
    const result = spawnSync('npm', args, {
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
        process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
    );
    const cmd = fs.existsSync(localBin) ? localBin : 'npx electron-builder';
    const result = spawnSync(cmd, [
        '--win',
        'dir',
        '--x64',
        `--config.directories.output=${relOutput}`
    ], {
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

if (os.platform() !== 'win32') {
    console.error('[build-gui-win] Windows x64 GUI builds must run on Windows.');
    process.exit(1);
}

console.info('[build-gui-win] preparing GUI assets…');
runNpm(['run', 'gui:assets']);
runNpm(['run', 'gui:logo']);

console.info('[build-gui-win] stopping Windy Link and clearing prior build…');
stopRunningWindyLink();

let electronOutput = defaultElectronOutput;
const defaultUnpacked = path.join(electronOutput, 'win-unpacked');
if (fs.existsSync(defaultUnpacked) &&
    !cleanLockedDir(defaultUnpacked, 'build-gui-win')) {
    electronOutput = path.join(repoRoot, 'dist', `electron-${Date.now()}`);
    console.warn(
        `[build-gui-win] dist/electron locked; using ${path.relative(repoRoot, electronOutput)}`
    );
}
fs.mkdirSync(electronOutput, {recursive: true});

const guiUnpacked = path.join(electronOutput, 'win-unpacked');
const exePath = path.join(guiUnpacked, 'WindyLink.exe');

console.info('[build-gui-win] packaging Electron app…');
runElectronBuilder(electronOutput);

console.info('[build-gui-win] embedding app icon…');
runNpm(['run', 'apply:gui-exe-icon']);

if (!fs.existsSync(exePath)) {
    console.error(`[build-gui-win] missing ${exePath}`);
    process.exit(1);
}

setElectronOutputPointer(repoRoot, electronOutput);

const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(2);
console.info(`[build-gui-win] ready: ${exePath} (${sizeMb} MB)`);
