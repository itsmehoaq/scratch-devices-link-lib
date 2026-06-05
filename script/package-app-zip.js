/**
 * Zip portable Future Academy (Electron GUI + tools + firmwares).
 * Output: dist/FutureAcademy-<version>-x64-app.zip
 *
 * Layout after unzip:
 *   Future Academy/
 *     WindyLink.exe
 *     tools/          — arduino-cli, cores, libraries
 *     firmwares/      — prebuilt AVR firmwares
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
const toolsRoot = path.join(repoRoot, 'tools');
const firmwaresRoot = path.join(repoRoot, 'firmwares');
const appIconPath = path.join(repoRoot, 'assets', 'FutureAcademy.ico');
const arduinoCliPath = path.join(toolsRoot, 'Arduino', 'arduino-cli.exe');

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

    if (!fs.existsSync(arduinoCliPath)) {
        console.error(`Missing tools: ${arduinoCliPath}`);
        console.error('Run npm run ensure:tools or npm run fetch:local first.');
        process.exit(1);
    }

    if (!fs.existsSync(firmwaresRoot)) {
        console.error(`Missing firmwares directory: ${firmwaresRoot}`);
        console.error('Run npm run ensure:tools first.');
        process.exit(1);
    }

    if (fs.existsSync(stagingRoot)) {
        fs.rmSync(stagingRoot, {recursive: true, force: true});
    }
    fs.mkdirSync(stagingRoot, {recursive: true});

    console.log(`Staging GUI from ${guiUnpacked}…`);
    copyDir(guiUnpacked, stagingRoot);

    console.log(`Staging tools from ${toolsRoot}…`);
    copyDir(toolsRoot, path.join(stagingRoot, 'tools'));

    console.log(`Staging firmwares from ${firmwaresRoot}…`);
    copyDir(firmwaresRoot, path.join(stagingRoot, 'firmwares'));

    if (fs.existsSync(appIconPath) && !fs.existsSync(path.join(stagingRoot, 'FutureAcademy.ico'))) {
        fs.copyFileSync(appIconPath, path.join(stagingRoot, 'FutureAcademy.ico'));
    }

    fs.writeFileSync(
        path.join(stagingRoot, 'version.txt'),
        `${pkg.version}\n`,
        'utf8'
    );

    fs.writeFileSync(
        path.join(stagingRoot, 'README-win-portable.txt'),
        [
            'Future Academy — Windows portable bundle',
            '',
            '1. Unzip this folder anywhere (e.g. D:\\Future Academy).',
            '2. Run WindyLink.exe (no installer required).',
            '3. tools/ and firmwares/ must stay beside WindyLink.exe.',
            '',
            'User data: %LOCALAPPDATA%\\WindyLink',
            'Editor: https://stem.windify.edu.vn/',
            '',
            'Optional: set WINDY_TOOLS_PATH if you move tools elsewhere.',
            ''
        ].join('\n'),
        'utf8'
    );

    createZip();

    if (fs.existsSync(stagingRoot)) {
        fs.rmSync(stagingRoot, {recursive: true, force: true});
    }

    const size = fs.statSync(zipPath).size;
    console.log(`\nApp zip ready: dist/${zipName} (${formatBytes(size)})`);
    console.log('Contains: GUI + tools/ + firmwares/ — unzip and run WindyLink.exe');
    console.log('Upload to scratch-link-server: npm run seed:releases (from server repo)');
};

main();
