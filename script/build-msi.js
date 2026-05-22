const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const productVersion = `${pkg.version}.0`;
const stagingDir = path.join(repoRoot, 'dist', 'staging', 'Future Academy');
const workDir = path.join(repoRoot, 'dist', 'installer-work');
const filesWxs = path.join(repoRoot, 'installer', 'Files.wxs');
const productWxs = path.join(repoRoot, 'installer', 'WindyLink.wxs');
const iconSource = path.join(repoRoot, 'assets', 'FutureAcademy.ico');
const msiOut = path.join(repoRoot, 'dist', `FutureAcademy-${pkg.version}-x64.msi`);

const WIX3_BIN_DIRS = [
    'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin',
    'C:\\Program Files (x86)\\WiX Toolset v3.11\\bin',
    'C:\\Program Files\\WiX Toolset v3.14\\bin',
    'C:\\Program Files\\WiX Toolset v3.11\\bin'
];

/**
 * Locate a WiX v3 tool executable on PATH or in common install dirs.
 * @param {string} toolName heat, candle, or light.
 * @returns {string|null}
 */
const resolveWix3Tool = toolName => {
    const where = spawnSync('where', [toolName], {encoding: 'utf8'});
    if (where.status === 0 && where.stdout.trim()) {
        return where.stdout.trim().split(/\r?\n/)[0].trim();
    }
    for (const dir of WIX3_BIN_DIRS) {
        const full = path.join(dir, `${toolName}.exe`);
        if (fs.existsSync(full)) {
            return full;
        }
    }
    return null;
};

/**
 * @param {string} cmd executable path.
 * @param {string[]} args command arguments.
 */
const run = (cmd, args) => {
    const result = spawnSync(cmd, args, {stdio: 'inherit', shell: false});
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${path.basename(cmd)} exited with code ${result.status}`);
    }
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

if (!fs.existsSync(stagingDir)) {
    console.error(`Missing staging folder: ${stagingDir}`);
    console.error('Run npm run package:dist first.');
    process.exit(1);
}

if (!fs.existsSync(iconSource)) {
    console.error(`Missing icon: ${iconSource}`);
    console.error('Run npm run generate:icon first.');
    process.exit(1);
}

const heat = resolveWix3Tool('heat');
const candle = resolveWix3Tool('candle');
const light = resolveWix3Tool('light');

if (!heat || !candle || !light) {
    console.error('WiX Toolset v3 (heat, candle, light) was not found.');
    console.error('Install with: winget install WiXToolset.WiXToolset');
    process.exit(1);
}

if (fs.existsSync(filesWxs)) {
    fs.rmSync(filesWxs, {force: true});
}
if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, {recursive: true, force: true});
}
fs.mkdirSync(workDir, {recursive: true});

console.log(`Harvesting staged files from: ${stagingDir}`);
run(heat, [
    'dir',
    stagingDir,
    '-cg',
    'AppFiles',
    '-gg',
    '-sfrag',
    '-srd',
    '-dr',
    'INSTALLFOLDER',
    '-var',
    'var.StagingSource',
    '-out',
    filesWxs
]);

console.log('Compiling WiX source...');
run(candle, [
    `-dStagingSource=${stagingDir}`,
    `-dProductVersion=${productVersion}`,
    `-dIconSource=${iconSource}`,
    '-arch',
    'x64',
    '-out',
    `${workDir}${path.sep}`,
    productWxs,
    filesWxs
]);

const wixObjs = fs.readdirSync(workDir)
    .filter(name => name.endsWith('.wixobj'))
    .map(name => path.join(workDir, name));

console.log('Linking MSI...');
run(light, [
    '-out',
    msiOut,
    ...wixObjs
]);

const msiSize = fs.statSync(msiOut).size;
console.log(`MSI created: ${msiOut} (${formatBytes(msiSize)})`);
