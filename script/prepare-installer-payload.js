const {spawnSync} = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const {path7za} = require('7zip-bin');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const payloadRoot = path.join(repoRoot, 'dist', 'installer-payload');
const exePath = path.join(repoRoot, 'dist', 'WindyLink.exe');
const toolsRoot = path.join(repoRoot, 'tools');
const firmwaresRoot = path.join(repoRoot, 'firmwares');
const assetsRoot = path.join(repoRoot, 'installer', 'assets');
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

    if (!fs.existsSync(exePath)) {
        console.error(`Missing exe: ${exePath}`);
        console.error('Run npm run build:exe:win first.');
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

    if (fs.existsSync(payloadRoot)) {
        fs.rmSync(payloadRoot, {recursive: true, force: true});
    }
    fs.mkdirSync(payloadRoot, {recursive: true});

    const toolsArchivePath = path.join(payloadRoot, 'tools.7z');
    createToolsArchive(toolsArchivePath);

    const cachedNodeMsi = path.join(assetsRoot, nodeMsiName);
    const payloadNodeMsi = path.join(payloadRoot, nodeMsiName);
    console.log(`Ensuring Node.js MSI (${nodeVersion})...`);
    await downloadNodeMsi(cachedNodeMsi);
    fs.copyFileSync(cachedNodeMsi, payloadNodeMsi);

    fs.copyFileSync(exePath, path.join(payloadRoot, 'WindyLink.exe'));
    fs.copyFileSync(path7za, path.join(payloadRoot, '7za.exe'));
    copyDir(firmwaresRoot, path.join(payloadRoot, 'firmwares'));

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
