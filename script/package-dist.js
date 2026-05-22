const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const exeName = 'WindyLink.exe';
const exePath = path.join(repoRoot, 'dist', exeName);
const stagingRoot = path.join(repoRoot, 'dist', 'staging', 'Windy Link');
const arduinoCliPath = path.join(stagingRoot, 'tools', 'Arduino', 'arduino-cli.exe');

const copyDir = (source, target) => {
    if (!fs.existsSync(source)) {
        throw new Error(`Missing source directory: ${source}`);
    }
    fs.cpSync(source, target, {recursive: true});
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

if (!fs.existsSync(exePath)) {
    console.error(`Missing exe: ${exePath}`);
    console.error('Run npm run build:exe:win first.');
    process.exit(1);
}

if (fs.existsSync(stagingRoot)) {
    fs.rmSync(stagingRoot, {recursive: true, force: true});
}

fs.mkdirSync(stagingRoot, {recursive: true});
fs.copyFileSync(exePath, path.join(stagingRoot, exeName));
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
