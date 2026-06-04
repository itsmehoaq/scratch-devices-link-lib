const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawnSync} = require('child_process');
const axios = require('axios');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '..');
const toolsRoot = path.join(repoRoot, 'tools');
const arduinoRoot = path.join(toolsRoot, 'Arduino');
const tmpRoot = path.join(repoRoot, 'tmp', 'arduino-cli');
const configPath = path.join(arduinoRoot, 'arduino-cli.yaml');
const esp32PackageUrl = process.env.ARDUINO_ESP32_PACKAGE_URL ||
    'https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json';
const cliVersion = process.env.ARDUINO_CLI_VERSION || '1.4.1';
const requiredCores = ['arduino:avr', 'esp32:esp32'];

const log = message => console.log(`[setup:arduino] ${message}`);

const cliFileName = () => ({
    win32: 'arduino-cli.exe'
}[os.platform()] || 'arduino-cli');

const cliPath = () => path.join(arduinoRoot, cliFileName());

const legacyCliPath = () => {
    const name = os.platform() === 'win32' ? 'arduino-cli' : 'arduino-cli.exe';
    return path.join(arduinoRoot, name);
};

const ensureDir = dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }
};

const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: options.stdio || 'inherit',
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        const suffix = result.stderr ? `\n${result.stderr.trim()}` : '';
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${suffix}`);
    }
    return result;
};

const pickReleaseAsset = assets => {
    const platform = os.platform();
    const arch = os.arch();
    const suffix = platform === 'win32' ? '.zip' : '.tar.gz';
    const labelsByPlatform = {
        darwin: {
            arm64: ['macOS_ARM64', 'macOS_64bit'],
            x64: ['macOS_64bit']
        },
        linux: {
            arm64: ['Linux_ARM64', 'Linux_64bit'],
            arm: ['Linux_ARMv7', 'Linux_ARMv6'],
            x64: ['Linux_64bit']
        },
        win32: {
            arm64: ['Windows_ARM64', 'Windows_64bit'],
            x64: ['Windows_64bit'],
            ia32: ['Windows_32bit']
        }
    };
    const labels = labelsByPlatform[platform] && labelsByPlatform[platform][arch];
    if (!labels) {
        throw new Error(`unsupported platform for Arduino CLI install: ${platform}/${arch}`);
    }
    const asset = labels
        .map(label => assets.find(item => item.name.includes(label) && item.name.endsWith(suffix)))
        .find(Boolean);
    if (!asset) {
        const names = assets.map(item => item.name).join(', ');
        throw new Error(`no Arduino CLI release asset matched ${platform}/${arch}; assets: ${names}`);
    }
    return asset;
};

const downloadFile = async (url, targetPath) => {
    ensureDir(path.dirname(targetPath));
    const response = await axios.get(url, {
        responseType: 'stream',
        headers: {'User-Agent': 'scratch-devices-link-lib setup'}
    });
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(targetPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.on('error', reject);
    });
};

const findExtractedCli = dir => {
    const wanted = cliFileName();
    const entries = fs.readdirSync(dir, {withFileTypes: true});
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === wanted) {
            return fullPath;
        }
        if (entry.isDirectory()) {
            const nested = findExtractedCli(fullPath);
            if (nested) return nested;
        }
    }
    return null;
};

const extractArchive = (archivePath, extractDir) => {
    ensureDir(extractDir);
    if (os.platform() === 'win32' && archivePath.endsWith('.zip')) {
        const psCommand = [
            'Expand-Archive',
            '-LiteralPath',
            JSON.stringify(archivePath),
            '-DestinationPath',
            JSON.stringify(extractDir),
            '-Force'
        ].join(' ');
        run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand]);
        return;
    }
    run('tar', ['-xzf', archivePath, '-C', extractDir]);
};

const isUsableCli = targetPath => {
    const result = spawnSync(targetPath, ['version'], {
        cwd: repoRoot,
        stdio: 'ignore',
        windowsHide: true
    });
    return !result.error && result.status === 0;
};

const installArduinoCli = async () => {
    if (fs.existsSync(cliPath()) && isUsableCli(cliPath())) {
        return;
    }

    ensureDir(arduinoRoot);
    if (fs.existsSync(cliPath())) {
        log(`replacing unusable ${path.relative(repoRoot, cliPath())}`);
        fs.rmSync(cliPath(), {force: true});
    }
    fs.rmSync(tmpRoot, {recursive: true, force: true});
    ensureDir(tmpRoot);

    const apiUrl = cliVersion === 'latest' ?
        'https://api.github.com/repos/arduino/arduino-cli/releases/latest' :
        `https://api.github.com/repos/arduino/arduino-cli/releases/tags/v${cliVersion.replace(/^v/, '')}`;
    log(`downloading Arduino CLI (${cliVersion})`);
    const release = await axios.get(apiUrl, {
        headers: {'User-Agent': 'scratch-devices-link-lib setup'}
    });
    const asset = pickReleaseAsset(release.data.assets || []);
    const archivePath = path.join(tmpRoot, asset.name);
    await downloadFile(asset.browser_download_url, archivePath);

    const extractDir = path.join(tmpRoot, 'extract');
    extractArchive(archivePath, extractDir);
    const extractedCli = findExtractedCli(extractDir);
    if (!extractedCli) {
        throw new Error(`Arduino CLI binary was not found in ${asset.name}`);
    }

    fs.copyFileSync(extractedCli, cliPath());
    if (os.platform() !== 'win32') {
        fs.chmodSync(cliPath(), 0o755);
    }

    log(`installed ${path.relative(repoRoot, cliPath())}`);
};

const writeConfig = () => {
    ensureDir(arduinoRoot);
    const config = {
        board_manager: {
            additional_urls: [esp32PackageUrl]
        },
        directories: {
            data: arduinoRoot,
            downloads: path.join(arduinoRoot, 'staging'),
            user: arduinoRoot
        }
    };

    let current = null;
    if (fs.existsSync(configPath)) {
        try {
            current = yaml.load(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            current = null;
        }
    }

    const currentUrl = current &&
        current.board_manager &&
        Array.isArray(current.board_manager.additional_urls) &&
        current.board_manager.additional_urls[0];
    const currentDirs = current && current.directories;
    if (
        currentUrl === esp32PackageUrl &&
        currentDirs &&
        currentDirs.data === arduinoRoot &&
        currentDirs.downloads === path.join(arduinoRoot, 'staging') &&
        currentDirs.user === arduinoRoot
    ) {
        return;
    }

    fs.writeFileSync(configPath, yaml.dump(config), 'utf8');
    log(`wrote ${path.relative(repoRoot, configPath)}`);
};

const installedCores = () => {
    const result = spawnSync(cliPath(), [
        'core',
        'list',
        '--format',
        'json',
        '--config-file',
        configPath
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) {
        return new Set();
    }

    try {
        const data = JSON.parse(result.stdout);
        return new Set((data.platforms || [])
            .filter(platform => platform.installed_version)
            .map(platform => platform.id));
    } catch (e) {
        return new Set();
    }
};

const ensureCores = () => {
    const installed = installedCores();
    const missing = requiredCores.filter(core => !installed.has(core));
    if (missing.length === 0) {
        log(`cores already installed: ${requiredCores.join(', ')}`);
        return;
    }

    log(`installing missing cores: ${missing.join(', ')}`);
    run(cliPath(), ['core', 'update-index', '--config-file', configPath]);
    missing.forEach(core => {
        run(cliPath(), ['core', 'install', core, '--config-file', configPath]);
    });
};

const smokeCheckBoards = () => {
    const boards = ['arduino:avr:uno', 'esp32:esp32:esp32s3'];
    boards.forEach(board => {
        run(cliPath(), [
            'board',
            'details',
            '--fqbn',
            board,
            '--config-file',
            configPath
        ], {stdio: 'ignore'});
    });
    log(`verified boards: ${boards.join(', ')}`);
};

(async () => {
    try {
        if (os.platform() === 'win32' && fs.existsSync(legacyCliPath()) && !fs.existsSync(cliPath())) {
            fs.copyFileSync(legacyCliPath(), cliPath());
        }
        await installArduinoCli();
        writeConfig();
        ensureCores();
        smokeCheckBoards();
    } catch (err) {
        console.error(`[setup:arduino] ${err.message}`);
        console.error(
            '[setup:arduino] Check your internet connection, or run npm run setup:arduino after reconnecting.'
        );
        process.exit(1);
    }
})();
