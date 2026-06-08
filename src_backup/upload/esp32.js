const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawn, spawnSync} = require('child_process');
const ansi = require('ansi-string');

/**
 * Default flash addresses for ESP32 family bins.
 * Matches the ESPLoader / hardware-console.jsx triple at 0x0/0x8000/0x10000.
 * @readonly
 */
const DEFAULT_ADDRESSES = {
    bootloader: 0x0,
    partitions: 0x8000,
    firmware: 0x10000
};

const DEFAULT_BAUDRATE = 921600;
const ABORT_STATE_CHECK_INTERVAL = 100;

const ESPTOOL_PROGRESS_LINE = /Writing at 0x[0-9a-fA-F]+\s*\(\s*(\d{1,3})\s*%\s*\)/;
const ESPTOOL_ERROR_HINT = new RegExp(
    [
        'A fatal error occurred',
        'Failed to connect',
        'No serial data received',
        'Wrong boot mode',
        'Invalid head of packet'
    ].join('|'),
    'i'
);
const ESPTOOL_OK_LINE = /Hash of data verified|Hard resetting via RTS pin|Leaving\.\.\./i;

/**
 * Wrap the prebuilt esptool binary that ships with the esp32 Arduino core
 * (`tools/Arduino/packages/esp32/tools/esptool_py/<ver>/esptool[.exe]`).
 *
 * Mirrors the WebSerial + esptool-js flow used by Windify GUI's
 * hardware-console.jsx (lines 430-754), but runs on the Node side over
 * node-serialport so any client of the link server can flash an ESP32
 * without depending on Web Serial.
 */
class Esp32 {
    /**
     * @param {string} peripheralPath - serial port path (e.g. COM5 or /dev/ttyUSB0).
     * @param {object} config - flash options (chip, baudrate, addresses, flashMode...).
     * @param {string} userDataPath - link-lib user data root, used for temp bin files.
     * @param {string} toolsPath - link-lib tools root (where esptool_py lives).
     * @param {Function} sendstd - (text, normalizedProgress?) => void streaming callback.
     */
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd) {
        this._peripheralPath = peripheralPath;
        this._config = config || {};
        this._userDataPath = userDataPath;
        this._toolsPath = toolsPath;
        this._sendstd = typeof sendstd === 'function' ? sendstd : (() => {});

        this._abort = false;
        this._proc = null;
        this._tempDir = null;

        this._esptoolPath = this._resolveEsptoolBinary();
    }

    /**
     * Locate the prebuilt esptool inside `tools/Arduino/packages/esp32/tools/esptool_py/<ver>/`.
     * Falls back to `esptool` on PATH when the bundled copy is missing
     * (e.g. fresh checkout that has not run `npm run fetch` yet).
     * @returns {string} resolved esptool path - absolute when bundled, otherwise the bare binary name for PATH lookup.
     */
    _resolveEsptoolBinary () {
        const isWin = os.platform() === 'win32';
        const exeName = isWin ? 'esptool.exe' : 'esptool';
        const explicit = this._config.esptoolPath;
        if (explicit && fs.existsSync(explicit)) {
            return explicit;
        }

        const baseDir = path.join(
            this._toolsPath,
            'Arduino', 'packages', 'esp32', 'tools', 'esptool_py'
        );
        try {
            if (fs.existsSync(baseDir)) {
                const versions = fs.readdirSync(baseDir)
                    .filter(name => fs.statSync(path.join(baseDir, name)).isDirectory())
                    .sort()
                    .reverse();
                for (const ver of versions) {
                    const candidate = path.join(baseDir, ver, exeName);
                    if (fs.existsSync(candidate)) {
                        return path.resolve(candidate);
                    }
                }
            }
        } catch (err) {
            this._sendstd(
                `${ansi.yellow_dark}[esp32] esptool resolver warning: ${err.message}\n`
            );
        }
        return exeName;
    }

    abortUpload () {
        this._abort = true;
        if (this._proc && !this._proc.killed) {
            try {
                if (os.platform() === 'win32') {
                    spawnSync('taskkill', ['/pid', String(this._proc.pid), '/f', '/t']);
                } else {
                    this._proc.kill('SIGTERM');
                }
            } catch (err) {
                this._sendstd(`${ansi.red}[esp32] abort kill failed: ${err.message}\n`);
            }
        }
    }

    /**
     * Decode/copy the three bin payloads into a fresh temp directory.
     * Each entry can be { encoding:'base64', data } | { encoding:'hex', data }
     * | { path: '<absolute>' } | Buffer | string (treated as base64).
     * @param {object} bins - {bootloader, partitions, firmware}
     * @returns {object} resolved on-disk paths {bootloader, partitions, firmware}.
     */
    _writeBinsToTemp (bins) {
        if (!bins || typeof bins !== 'object') {
            throw new Error('uploadEsp32Bin requires bins payload');
        }
        const random = Math.random().toString(36);
        const rand = random.slice(2, 8);
        const id = `esp32_flash_${Date.now()}_${process.pid}_${rand}`;
        const tempRoot = path.join(this._userDataPath, 'esp32', id);
        fs.mkdirSync(tempRoot, {recursive: true});
        this._tempDir = tempRoot;

        const out = {};
        for (const key of ['bootloader', 'partitions', 'firmware']) {
            const entry = bins[key];
            if (!entry) {
                throw new Error(`uploadEsp32Bin missing ${key} bin`);
            }
            const target = path.join(tempRoot, `${key}.bin`);
            if (typeof entry === 'string') {
                fs.writeFileSync(target, Buffer.from(entry, 'base64'));
            } else if (Buffer.isBuffer(entry)) {
                fs.writeFileSync(target, entry);
            } else if (entry.path) {
                if (!fs.existsSync(entry.path)) {
                    throw new Error(`uploadEsp32Bin ${key} path not found: ${entry.path}`);
                }
                fs.copyFileSync(entry.path, target);
            } else if (entry.data) {
                const encoding = entry.encoding || 'base64';
                fs.writeFileSync(target, Buffer.from(entry.data, encoding));
            } else {
                throw new Error(`uploadEsp32Bin invalid ${key} bin payload`);
            }
            out[key] = target;
        }
        return out;
    }

    /**
     * Try to extract a 0..1 progress fraction from an esptool log fragment.
     * @param {string} text - chunk from stdout/stderr.
     * @returns {number|void} normalised progress 0..1, or void if the chunk has no usable progress marker.
     */
    _flashProgressFromText (text) {
        const m = text.match(ESPTOOL_PROGRESS_LINE);
        if (!m) {
            return;
        }
        const n = parseInt(m[1], 10);
        if (Number.isNaN(n)) {
            return;
        }
        return Math.min(1, Math.max(0, n / 100));
    }

    /**
     * Build the esptool argv (separate so tests can assert on it).
     * @param {object} files - resolved bin paths {bootloader, partitions, firmware}.
     * @returns {string[]} argv passed to esptool.
     */
    _buildArgs (files) {
        const cfg = this._config;
        const addr = Object.assign({}, DEFAULT_ADDRESSES, cfg.addresses || {});
        const args = [
            '--chip', cfg.chip || 'esp32s3',
            '--port', this._peripheralPath,
            '--baud', String(cfg.baudrate || DEFAULT_BAUDRATE),
            '--before', cfg.before || 'default_reset',
            '--after', cfg.after || 'hard_reset',
            'write_flash'
        ];
        if (cfg.eraseAll) args.push('--erase-all');
        args.push(
            '--flash_mode', cfg.flashMode || 'dio',
            '--flash_freq', cfg.flashFreq || '80m',
            '--flash_size', cfg.flashSize || 'keep'
        );
        args.push(`0x${Number(addr.bootloader).toString(16)}`, files.bootloader);
        args.push(`0x${Number(addr.partitions).toString(16)}`, files.partitions);
        args.push(`0x${Number(addr.firmware).toString(16)}`, files.firmware);
        return args;
    }

    /**
     * Pretty-print a chunk through sendstd with light ansi colouring.
     * @param {string} text - raw text from esptool.
     */
    _emit (text) {
        if (!text) return;
        let painted = text;
        if (ESPTOOL_ERROR_HINT.test(text)) {
            painted = ansi.red + text;
        } else if (ESPTOOL_OK_LINE.test(text)) {
            painted = ansi.green_dark + text;
        }
        const prog = this._flashProgressFromText(text);
        this._sendstd(painted, prog);
    }

    /**
     * Spawn esptool with the prepared bins and resolve when it finishes.
     * Resolves to 'Success' on exit code 0, 'Aborted' when the user
     * cancelled, otherwise rejects.
     * @param {object} bins - {bootloader, partitions, firmware}
     * @returns {Promise<string>} resolves to 'Success' or 'Aborted'; rejects with an Error on failure.
     */
    flashBins (bins) {
        return new Promise((resolve, reject) => {
            let files;
            try {
                files = this._writeBinsToTemp(bins);
            } catch (err) {
                return reject(err);
            }

            const args = this._buildArgs(files);
            this._sendstd(
                `${ansi.clear}[esp32] esptool ${path.basename(this._esptoolPath)} ${args.join(' ')}\n`
            );

            let proc;
            try {
                proc = spawn(this._esptoolPath, args, {windowsHide: true});
            } catch (err) {
                return reject(new Error(`Failed to spawn esptool: ${err.message}`));
            }
            this._proc = proc;

            proc.stdout.on('data', buf => this._emit(buf.toString()));
            proc.stderr.on('data', buf => this._emit(buf.toString()));

            const abortTimer = setInterval(() => {
                if (this._abort && proc && !proc.killed) {
                    try {
                        if (os.platform() === 'win32') {
                            spawnSync('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
                        } else {
                            proc.kill('SIGTERM');
                        }
                    } catch (err) {
                        this._sendstd(`${ansi.red}[esp32] abort kill failed: ${err.message}\n`);
                    }
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            proc.on('error', err => {
                clearInterval(abortTimer);
                this._proc = null;
                reject(new Error(`esptool spawn error: ${err.message}`));
            });

            proc.on('exit', (code, signal) => {
                clearInterval(abortTimer);
                this._proc = null;
                this._sendstd(`${ansi.clear}\r\n`);
                if (this._abort) {
                    return resolve('Aborted');
                }
                if (code === 0) {
                    return resolve('Success');
                }
                const reason = signal ?
                    `signal ${signal}` :
                    `exit code ${code === null ? 'null' : code}`;
                return reject(new Error(`esptool failed (${reason})`));
            });
        });
    }

    /**
     * Remove the temp directory created by {@link Esp32._writeBinsToTemp}.
     * Safe to call multiple times.
     */
    cleanup () {
        if (this._tempDir && fs.existsSync(this._tempDir)) {
            try {
                fs.rmSync(this._tempDir, {recursive: true, force: true});
            } catch (err) {
                this._sendstd(
                    `${ansi.yellow_dark}[esp32] cleanup warning: ${err.message}\n`
                );
            }
            this._tempDir = null;
        }
    }
}

module.exports = Esp32;
module.exports.DEFAULT_ADDRESSES = DEFAULT_ADDRESSES;
module.exports.DEFAULT_BAUDRATE = DEFAULT_BAUDRATE;
