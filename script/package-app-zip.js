/**
 * Zip the Electron GUI (win-unpacked) for portable distribution / update server upload.
 * Output: dist/FutureAcademy-<version>-x64-app.zip
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const {path7za} = require('7zip-bin');
const {getGuiUnpackedDir, GUI_EXE} = require('./lib/electron-output');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const zipName = `FutureAcademy-${pkg.version}-x64-app.zip`;
const zipPath = path.join(repoRoot, 'dist', zipName);
const stagingRoot = path.join(repoRoot, 'dist', 'staging-app', 'Future Academy');

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

const createZip = () => {
    const stagingParent = path.dirname(stagingRoot);
    const folderName = path.basename(stagingRoot);

    if (fs.existsSync(zipPath)) {
        fs.rmSync(zipPath, {force: true});
    }
    fs.mkdirSync(path.dirname(zipPath), {recursive: true});

    console.log(`Creating ${zipName}…`);
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
        throw new Error(`7za exited with code ${result.status}`);
    }
};

const main = () => {
    const guiUnpacked = getGuiUnpackedDir(repoRoot);
    const guiExe = path.join(guiUnpacked, GUI_EXE);

    if (!fs.existsSync(guiExe)) {
        console.error(`Missing GUI build: ${guiExe}`);
        console.error('Run npm run build:gui:win first (or npm run release:setup).');
        process.exit(1);
    }

    if (fs.existsSync(stagingRoot)) {
        fs.rmSync(stagingRoot, {recursive: true, force: true});
    }
    fs.mkdirSync(stagingRoot, {recursive: true});

    console.log(`Staging GUI from ${guiUnpacked}…`);
    copyDir(guiUnpacked, stagingRoot);
    fs.writeFileSync(
        path.join(stagingRoot, 'version.txt'),
        `${pkg.version}\n`,
        'utf8'
    );

    createZip();

    if (fs.existsSync(stagingRoot)) {
        fs.rmSync(stagingRoot, {recursive: true, force: true});
    }

    const size = fs.statSync(zipPath).size;
    console.log(`\nApp zip ready: dist/${zipName} (${formatBytes(size)})`);
    console.log('Upload to scratch-link-server: npm run seed:releases (from server repo)');
};

main();
