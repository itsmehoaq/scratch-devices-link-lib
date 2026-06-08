const {spawnSync} = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const {path7za} = require('7zip-bin');
const {
    stopRunningWindyLink,
    cleanLockedDir
} = require('./lib/clean-locked-dir');
const {getGuiUnpackedDir, GUI_EXE} = require('./lib/electron-output');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const useGui = process.argv.includes('--gui');
const payloadRoot = path.join(repoRoot, 'dist', 'installer-payload');
const cliExePath = path.join(repoRoot, 'dist', 'WindyLink.exe');
const trayExePath = path.join(
    repoRoot,
    'shell',
    'target',
    'x86_64-pc-windows-msvc',
    'release',
    'FutureAcademyTray.exe'
);

/** Resolve GUI paths at runtime (pointer may be stale between steps). */
const resolveGuiPaths = () => {
    const guiUnpackedDir = getGuiUnpackedDir(repoRoot);
    const guiExePath = path.join(guiUnpackedDir, GUI_EXE);
    return {guiUnpackedDir, guiExePath};
};
const toolsRoot = path.join(repoRoot, 'tools');
const firmwaresRoot = path.join(repoRoot, 'firmwares');
const assetsRoot = path.join(repoRoot, 'installer', 'assets');
const appIconPath = path.join(repoRoot, 'assets', 'FutureAcademy.ico');
const nodeVersion = '18.20.8';
const nodeMsiName = `node-v${nodeVersion}-x64.msi`;
const nodeMsiUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeMsiName}`;

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
    fs.cpSync(source, target, {recursive: true, force: true});
};

/** Remove known payload children when the root folder cannot be deleted. */
const partialPayloadClean = () => {
    if (!fs.existsSync(payloadRoot)) {
        return;
    }
    for (const name of fs.readdirSync(payloadRoot)) {
        cleanLockedDir(path.join(payloadRoot, name), 'prepare-installer-payload');
    }
};

/**
 * Clear prior installer payload; rename aside when Windows locks files (EPERM/EBUSY).
 */
const preparePayloadRoot = () => {
    stopRunningWindyLink();

    if (!fs.existsSync(payloadRoot)) {
        fs.mkdirSync(payloadRoot, {recursive: true});
        return;
    }

    if (cleanLockedDir(payloadRoot, 'prepare-installer-payload')) {
        fs.mkdirSync(payloadRoot, {recursive: true});
        return;
    }

    console.warn('[prepare-installer-payload] clearing payload contents only…');
    partialPayloadClean();
    fs.mkdirSync(payloadRoot, {recursive: true});
};

/**
 * Download Node.js LTS MSI into installer/assets when missing.
 * @param {string} targetPath destination file path.
 */
const downloadNodeMsi = targetPath => new Promise((resolve, reject) => {
    if (fs.existsSync(targetPath)) {
        resolve();
        return;
    }

    fs.mkdirSync(path.dirname(targetPath), {recursive: true});
    const file = fs.createWriteStream(targetPath);

    const request = url => {
        https.get(url, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                request(response.headers.location);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download Node.js MSI (${response.statusCode})`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', reject);
    };

    request(nodeMsiUrl);
});

/**
 * Create tools.7z from the tools directory for embedding in the setup exe.
 * @param {string} archivePath output archive path.
 */
const createToolsArchive = archivePath => {
    if (!fs.existsSync(toolsRoot)) {
        throw new Error(`Missing tools directory: ${toolsRoot}`);
    }

    if (fs.existsSync(archivePath)) {
        fs.rmSync(archivePath, {force: true});
    }

    console.log(`Creating ${archivePath}...`);
    const result = spawnSync(path7za, [
        'a',
        '-t7z',
        '-mx=9',
        archivePath,
        'tools'
    ], {
        cwd: repoRoot,
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

const main = async () => {
    if (os.platform() !== 'win32') {
        console.error('Installer payload can only be prepared on Windows.');
        process.exit(1);
    }

    const exePath = useGui
        ? resolveGuiPaths().guiExePath
        : cliExePath;

    if (!fs.existsSync(exePath)) {
        console.error(`Missing exe: ${exePath}`);
        if (useGui) {
            console.error('Run npm run build:gui:win first.');
        } else {
            console.error('Run npm run build:exe:win first.');
        }
        process.exit(1);
    }

    if (!fs.existsSync(firmwaresRoot)) {
        console.error(`Missing firmwares directory: ${firmwaresRoot}`);
        console.error('Run npm run fetch before packaging.');
        process.exit(1);
    }

    const arduinoCliPath = path.join(toolsRoot, 'Arduino', 'arduino-cli.exe');
    if (!fs.existsSync(arduinoCliPath)) {
        console.error(`Missing arduino-cli: ${arduinoCliPath}`);
        console.error('Run npm run fetch before packaging.');
        process.exit(1);
    }

    preparePayloadRoot();

    const toolsArchivePath = path.join(payloadRoot, 'tools.7z');
    createToolsArchive(toolsArchivePath);
    fs.copyFileSync(path7za, path.join(payloadRoot, '7za.exe'));

    const appDir = path.join(payloadRoot, 'app');

    if (useGui) {
        const {guiUnpackedDir} = resolveGuiPaths();
        if (!fs.existsSync(guiUnpackedDir)) {
            console.error(`Missing GUI folder: ${guiUnpackedDir}`);
            console.error('Run npm run build:gui:win first.');
            process.exit(1);
        }
        console.log(`Copying Electron GUI from ${guiUnpackedDir}…`);
        copyDir(guiUnpackedDir, appDir);
        fs.copyFileSync(path7za, path.join(appDir, '7za.exe'));
        copyDir(firmwaresRoot, path.join(appDir, 'firmwares'));
        if (!fs.existsSync(appIconPath)) {
            throw new Error(`Missing app icon: ${appIconPath}`);
        }
        fs.copyFileSync(appIconPath, path.join(appDir, 'FutureAcademy.ico'));
        fs.writeFileSync(
            path.join(payloadRoot, 'build-type.txt'),
            'gui\n',
            'utf8'
        );
    } else {
        const cachedNodeMsi = path.join(assetsRoot, nodeMsiName);
        const payloadNodeMsi = path.join(payloadRoot, nodeMsiName);
        console.log(`Ensuring Node.js MSI (${nodeVersion})...`);
        await downloadNodeMsi(cachedNodeMsi);
        fs.copyFileSync(cachedNodeMsi, payloadNodeMsi);

        fs.copyFileSync(exePath, path.join(payloadRoot, 'WindyLink.exe'));
        if (!fs.existsSync(trayExePath)) {
            console.error(`Missing tray exe: ${trayExePath}`);
            console.error('Run npm run build:shell:win first.');
            process.exit(1);
        }
        fs.copyFileSync(trayExePath, path.join(payloadRoot, 'FutureAcademyTray.exe'));
        copyDir(firmwaresRoot, path.join(payloadRoot, 'firmwares'));
        fs.writeFileSync(
            path.join(payloadRoot, 'build-type.txt'),
            'cli\n',
            'utf8'
        );
    }

    const versionFile = path.join(payloadRoot, 'version.txt');
    fs.writeFileSync(versionFile, `${pkg.version}\n`, 'utf8');

    const payloadSize = fs.readdirSync(payloadRoot)
        .reduce((total, name) => {
            const entryPath = path.join(payloadRoot, name);
            const stat = fs.statSync(entryPath);
            if (stat.isDirectory()) {
                const walk = current => {
                    for (const child of fs.readdirSync(current)) {
                        const childPath = path.join(current, child);
                        const childStat = fs.statSync(childPath);
                        if (childStat.isDirectory()) {
                            walk(childPath);
                        } else {
                            total += childStat.size;
                        }
                    }
                };
                walk(entryPath);
                return total;
            }
            return total + stat.size;
        }, 0);

    console.log(`Installer payload ready: ${payloadRoot}`);
    console.log(`Version: ${pkg.version}`);
    console.log(`Total payload size: ${formatBytes(payloadSize)}`);
};

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
