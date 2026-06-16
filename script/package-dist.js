const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const exeName = 'Future Academy Link.exe';
const exePath = path.join(repoRoot, 'dist', exeName);
const stagingRoot = path.join(repoRoot, 'dist', 'staging', 'Future Academy');
const arduinoCliPath = path.join(stagingRoot, 'tools', 'Arduino', 'arduino-cli.exe');

const sleep = ms => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        // busy wait — keeps script synchronous for npm callers
    }
};

const copyDir = (source, target) => {
    if (!fs.existsSync(source)) {
        throw new Error(`Missing source directory: ${source}`);
    }
    fs.cpSync(source, target, {recursive: true, force: true});
};

const copyFileSafe = (source, target, label) => {
    try {
        fs.copyFileSync(source, target);
    } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EBUSY') {
            console.error(`Cannot write ${label}: ${target}`);
            console.error('Close Future Academy Link.exe if it is running from the staging folder, then retry.');
            process.exit(1);
        }
        throw err;
    }
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

/**
 * Remove staging folder when possible; fall back to in-place refresh when locked.
 * @returns {boolean} true when folder was fully removed.
 */
const prepareStagingRoot = () => {
    if (!fs.existsSync(stagingRoot)) {
        return true;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            fs.rmSync(stagingRoot, {recursive: true, force: true});
            return true;
        } catch (err) {
            if (err.code !== 'EPERM' && err.code !== 'EBUSY') {
                throw err;
            }
            if (attempt < 3) {
                sleep(500);
                continue;
            }
            console.warn(
                `[package-dist] Could not remove staging folder (attempt ${attempt}/3). ` +
                'Updating in place — close Future Academy Link.exe if packaging keeps failing.'
            );
            return false;
        }
    }
    return false;
};

if (!fs.existsSync(exePath)) {
    console.error(`Missing exe: ${exePath}`);
    console.error('Run npm run build:exe:win first.');
    process.exit(1);
}

prepareStagingRoot();
fs.mkdirSync(stagingRoot, {recursive: true});
copyFileSafe(exePath, path.join(stagingRoot, exeName), exeName);
copyDir(path.join(repoRoot, 'tools'), path.join(stagingRoot, 'tools'));
copyDir(path.join(repoRoot, 'firmwares'), path.join(stagingRoot, 'firmwares'));

if (!fs.existsSync(arduinoCliPath)) {
    console.error(`Missing arduino-cli: ${arduinoCliPath}`);
    console.error('Run npm run fetch or npm run fetch:small before packaging.');
    process.exit(1);
}

const stagedSize = getDirSize(stagingRoot);
console.log(`Staged installer payload: ${stagingRoot}`);
console.log(`Contents: ${exeName} + tools/ + firmwares/ (${formatBytes(stagedSize)})`);
