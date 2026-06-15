const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawnSync} = require('child_process');
const axios = require('axios');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin').path7za;
const cliProgress = require('cli-progress');

const ESP32_INDEX_URL =
    'https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json';
const ARDUINO_CLI_VERSION = '1.4.1';
const CLI_FILE = os.platform() === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';

/**
 * Return the arduino-cli release archive filename for the current platform.
 * @returns {string} asset filename.
 */
const getCliAsset = function () {
    const p = os.platform();
    const a = os.arch();
    if (p === 'win32') {
        return `arduino-cli_${ARDUINO_CLI_VERSION}_Windows_64bit.zip`;
    }
    if (p === 'darwin') {
        return a === 'arm64' ?
            `arduino-cli_${ARDUINO_CLI_VERSION}_macOS_ARM64.tar.gz` :
            `arduino-cli_${ARDUINO_CLI_VERSION}_macOS_64bit.tar.gz`;
    }
    return a === 'arm64' ?
        `arduino-cli_${ARDUINO_CLI_VERSION}_Linux_ARM64.tar.gz` :
        `arduino-cli_${ARDUINO_CLI_VERSION}_Linux_64bit.tar.gz`;
};

/**
 * Return the GitHub download URL for the arduino-cli binary archive.
 * @returns {string} download URL.
 */
const getCliDownloadUrl = function () {
    return `https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/${getCliAsset()}`;
};

/**
 * Download a URL to a local file, reporting progress 0-100 via onProgress.
 * @param {string} url - remote URL.
 * @param {string} destPath - local destination path.
 * @param {Function} onProgress - called with integer 0-100.
 * @returns {Promise<void>} resolves when download completes.
 */
const downloadFile = async function (url, destPath, onProgress) {
    const resp = await axios.get(url, {
        responseType: 'stream',
        maxRedirects: 5,
        decompress: true
    });
    const total = parseInt(resp.headers['content-length'] || '0', 10);
    let received = 0;
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);
        resp.data.on('data', chunk => {
            received += chunk.length;
            if (total > 0) {
                onProgress(Math.round((received / total) * 100));
            }
        });
        resp.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
};

/**
 * Extract an archive using 7z into destDir.
 * @param {string} archivePath - path to .zip or .tar.gz.
 * @param {string} destDir - extraction destination.
 * @returns {Promise<void>} resolves when extraction completes.
 */
const extract7z = function (archivePath, destDir) {
    return new Promise((resolve, reject) => {
        const stream = Seven.extractFull(archivePath, destDir, {
            $bin: sevenBin,
            overwrite: 'a',
            recursive: true
        });
        stream.on('end', resolve);
        stream.on('error', reject);
    });
};

/**
 * Write a minimal arduino-cli.yaml config pointing at arduinoDir.
 * @param {string} configPath - destination yaml path.
 * @param {string} arduinoDir - arduino data/user directory.
 */
const writeArduinoConfig = function (configPath, arduinoDir) {
    const stagingDir = path.join(arduinoDir, 'staging');
    fs.mkdirSync(stagingDir, {recursive: true});
    const lines = [
        'board_manager:',
        '  additional_urls:',
        `    - ${ESP32_INDEX_URL}`,
        'directories:',
        `  data: ${arduinoDir}`,
        `  downloads: ${stagingDir}`,
        `  user: ${arduinoDir}`
    ];
    fs.writeFileSync(configPath, `${lines.join('\n')}\n`, 'utf8');
};

/**
 * Run arduino-cli with the given args (blocking).
 * @param {string} cliPath - path to arduino-cli binary.
 * @param {Array<string>} args - CLI arguments.
 * @param {string} configPath - arduino-cli.yaml path.
 */
const runCli = function (cliPath, args, configPath) {
    const result = spawnSync(cliPath, [...args, '--config-file', configPath], {
        stdio: 'inherit',
        windowsHide: true,
        timeout: 10 * 60 * 1000
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`arduino-cli ${args[0]} failed (exit ${result.status})`);
    }
};

/**
 * Check whether arduino-cli is already present at the expected path.
 * @param {string} toolsPath - base tools directory.
 * @returns {{ok: boolean, cliPath: string}} presence check result.
 */
const checkToolchain = function (toolsPath) {
    const arduinoDir = path.join(toolsPath, 'Arduino');
    const cliPath = path.join(arduinoDir, CLI_FILE);
    const ok = fs.existsSync(cliPath);
    return {ok, cliPath};
};

/**
 * Download arduino-cli and install esp32:esp32 on first run.
 * Reports progress via onProgress({ phase, progress }).
 * Phases: downloading-cli | extracting | configuring | updating-index | installing-core | done
 * @param {string} toolsPath - base tools directory.
 * @param {Function} onProgress - called with {phase: string, progress: number}.
 * @returns {Promise<void>} resolves when toolchain is ready.
 */
const setupToolchain = async function (toolsPath, onProgress) {
    const report = function (phase, progress) {
        onProgress({phase, progress: progress || 0});
    };

    const arduinoDir = path.join(toolsPath, 'Arduino');
    const cliPath = path.join(arduinoDir, CLI_FILE);
    const configPath = path.join(arduinoDir, 'arduino-cli.yaml');
    const tmpDir = path.join(toolsPath, '.setup-tmp');

    fs.mkdirSync(arduinoDir, {recursive: true});
    fs.mkdirSync(tmpDir, {recursive: true});

    try {
        const archiveName = getCliAsset();
        const archivePath = path.join(tmpDir, archiveName);

        report('downloading-cli', 0);
        const dlBar = new cliProgress.SingleBar({
            format: '  {spin} Downloading arduino-cli  [{bar}] {percent}%',
            autopause: false,
            notTTYSchedule: 200,
        }, cliProgress.Presets.shades_classic);
        dlBar.start(100, 0);
        await downloadFile(getCliDownloadUrl(), archivePath, pct => dlBar.update(pct));
        dlBar.update(100);
        dlBar.stop();

        report('extracting', 0);
        await extract7z(archivePath, arduinoDir);

        if (os.platform() !== 'win32') {
            fs.chmodSync(cliPath, 0o755);
        }

        report('configuring', 0);
        writeArduinoConfig(configPath, arduinoDir);

        report('updating-index', 0);
        runCli(cliPath, ['core', 'update-index'], configPath);

        report('installing-core', 0);
        runCli(cliPath, ['core', 'install', 'esp32:esp32'], configPath);

        report('done', 100);
    } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
    }
};

module.exports = {checkToolchain, setupToolchain};
