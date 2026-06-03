const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const {path7za} = require('7zip-bin');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const exeName = 'WindyLink';
const exePath = path.join(repoRoot, 'dist', exeName);
const toolsRoot = path.join(repoRoot, 'tools-mac');
const firmwaresRoot = path.join(repoRoot, 'firmwares');
const stagingRoot = path.join(repoRoot, 'dist', 'staging-mac', 'Future Academy');
const arduinoCliPath = path.join(toolsRoot, 'Arduino', 'arduino-cli');
const zipPath = path.join(
    repoRoot,
    'dist',
    `FutureAcademy-${pkg.version}-macos-arm64-portable.zip`
);

const formatBytes = bytes => {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${bytes} B`;
};

const copyDir = (source, target) => {
    if (!fs.existsSync(source)) {
        throw new Error(`Missing source directory: ${source}`);
    }
    fs.cpSync(source, target, {recursive: true, force: true});
};

const getDirSize = targetPath => {
    if (!fs.existsSync(targetPath)) {
        return 0;
    }
    let total = 0;
    const walk = current => {
        const stat = fs.statSync(current);
        if (!stat.isDirectory()) {
            total += stat.size;
            return;
        }
        for (const entry of fs.readdirSync(current)) {
            walk(path.join(current, entry));
        }
    };
    walk(targetPath);
    return total;
};

const prepareStagingRoot = () => {
    if (fs.existsSync(stagingRoot)) {
        fs.rmSync(stagingRoot, {recursive: true, force: true});
    }
    fs.mkdirSync(stagingRoot, {recursive: true});
};

const createZip = () => {
    const stagingParent = path.dirname(stagingRoot);
    const folderName = path.basename(stagingRoot);

    if (fs.existsSync(zipPath)) {
        fs.rmSync(zipPath, {force: true});
    }
    fs.mkdirSync(path.dirname(zipPath), {recursive: true});

    console.log(`Creating ${path.relative(repoRoot, zipPath)}…`);
    const result = spawnSync(path7za, [
        'a',
        '-tzip',
        '-mx=5',
        zipPath,
        folderName
    ], {
        cwd: stagingParent,
        stdio: 'inherit',
        windowsHide: true
    });

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`7-Zip failed with exit code ${result.status}`);
    }
};

if (!fs.existsSync(exePath)) {
    console.error(`Missing binary: ${exePath}`);
    console.error('Run npm run build:exe:mac:arm64:from-win first.');
    process.exit(1);
}

if (!fs.existsSync(firmwaresRoot)) {
    console.error(`Missing firmwares directory: ${firmwaresRoot}`);
    console.error('Run npm run fetch (or npm run fetch:mac:from-win) first.');
    process.exit(1);
}

if (!fs.existsSync(arduinoCliPath)) {
    console.error(`Missing arduino-cli: ${arduinoCliPath}`);
    console.error('Run npm run fetch:tools:mac first.');
    process.exit(1);
}

prepareStagingRoot();
fs.copyFileSync(exePath, path.join(stagingRoot, exeName));
fs.chmodSync(path.join(stagingRoot, exeName), 0o755);
copyDir(toolsRoot, path.join(stagingRoot, 'tools'));
copyDir(firmwaresRoot, path.join(stagingRoot, 'firmwares'));
fs.writeFileSync(
    path.join(stagingRoot, 'version.txt'),
    `${pkg.version}\n`,
    'utf8'
);
fs.writeFileSync(
    path.join(stagingRoot, 'README-mac-portable.txt'),
    [
        'Future Academy — macOS ARM64 portable bundle',
        '',
        '1. Unzip this folder anywhere (e.g. ~/Applications/Future Academy).',
        '2. On the Mac, sign the binary (required on Apple Silicon):',
        '   codesign --sign - ./WindyLink',
        '3. Run from Terminal:',
        '   cd "/path/to/Future Academy"',
        '   ./WindyLink',
        '',
        'User data: ~/Library/Application Support/WindyLink',
        'Editor: https://stem.windify.edu.vn/',
        ''
    ].join('\n'),
    'utf8'
);

const stagedSize = getDirSize(stagingRoot);
console.log(`Staged portable bundle: ${stagingRoot}`);
console.log(`Contents: ${exeName} + tools/ + firmwares/ (${formatBytes(stagedSize)})`);

createZip();
const zipSize = fs.statSync(zipPath).size;
console.log(`Release zip: ${zipPath} (${formatBytes(zipSize)})`);
console.log('');
console.log('Before distributing to users, ad-hoc sign on a Mac:');
console.log(`  codesign --sign - "${path.join(stagingRoot, exeName)}"`);
console.log('Then re-zip or distribute the signed binary from staging-mac.');
