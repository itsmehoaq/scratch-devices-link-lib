const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const payloadRoot = path.join(repoRoot, 'dist', 'installer-payload');
const issPath = path.join(repoRoot, 'installer', 'FutureAcademyLink.iss');
const setupOut = path.join(repoRoot, 'dist', `FutureAcademy-${pkg.version}-x64-setup.exe`);

const INNO_SETUP_DIRS = [
    path.join(process.env.LOCALAPPDATA || '', 'Inno Setup 6'),
    'C:\\Program Files (x86)\\Inno Setup 6',
    'C:\\Program Files\\Inno Setup 6'
];

/**
 * Locate ISCC.exe on PATH or in common install dirs.
 * @returns {string|null}
 */
const resolveIscc = () => {
    const where = spawnSync('where', ['ISCC.exe'], {encoding: 'utf8'});
    if (where.status === 0 && where.stdout.trim()) {
        return where.stdout.trim().split(/\r?\n/)[0].trim();
    }

    for (const dir of INNO_SETUP_DIRS) {
        const full = path.join(dir, 'ISCC.exe');
        if (fs.existsSync(full)) {
            return full;
        }
    }

    return null;
};

const formatBytes = bytes => {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }
    return `${bytes} B`;
};

if (!fs.existsSync(payloadRoot)) {
    console.error(`Missing installer payload: ${payloadRoot}`);
    console.error('Run node script/prepare-installer-payload.js first.');
    process.exit(1);
}

if (!fs.existsSync(issPath)) {
    console.error(`Missing Inno Setup script: ${issPath}`);
    process.exit(1);
}

const iscc = resolveIscc();
if (!iscc) {
    console.error('Inno Setup 6 (ISCC.exe) was not found.');
    console.error('Install with: winget install JRSoftware.InnoSetup');
    process.exit(1);
}

const buildTypePath = path.join(payloadRoot, 'build-type.txt');
const isGuiInstaller = fs.existsSync(buildTypePath) &&
    fs.readFileSync(buildTypePath, 'utf8').trim() === 'gui';

const isccArgs = [
    issPath,
    `/DAppVersion=${pkg.version}`,
    `/DOutputBaseFilename=FutureAcademy-${pkg.version}-x64-setup`
];
if (isGuiInstaller) {
    isccArgs.push('/DGuiBuild=1');
    console.info('Building GUI installer (Electron, bundled Node runtime).');
}

const result = spawnSync(iscc, isccArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false
});

if (result.error) {
    throw result.error;
}
if (result.status !== 0) {
    process.exit(result.status || 1);
}

if (!fs.existsSync(setupOut)) {
    console.error(`Expected setup output was not created: ${setupOut}`);
    process.exit(1);
}

const setupSize = fs.statSync(setupOut).size;
console.log(`Setup created: ${setupOut} (${formatBytes(setupSize)})`);

if (process.env.WIN_SIGN_PFX_PATH) {
    const sign = spawnSync('node', [path.join(__dirname, 'sign-windows-artifacts.js'), setupOut], {
        cwd: repoRoot,
        stdio: 'inherit'
    });
    if (sign.status !== 0) {
        process.exit(sign.status || 1);
    }
} else {
    console.warn(
        '[build:setup] Installer is unsigned — Windows 11 SmartScreen may block it.\n' +
        '  Set WIN_SIGN_PFX_PATH (+ WIN_SIGN_PFX_PASSWORD) to sign, or see docs/installer-windows.md'
    );
}
