const fs = require('fs');
const {spawn, spawnSync} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const yaml = require('js-yaml');
const os = require('os');
const {SerialPort} = require('serialport');

const ARDUINO_CLI_STDOUT_GREEN_START = /Reading \||Writing \|/g;
const ARDUINO_CLI_STDOUT_GREEN_END = /%/g;
const ARDUINO_CLI_STDOUT_WHITE = /avrdude done/g;
const ARDUINO_CLI_STDOUT_RED_START = /can't open device|programmer is not responding/g;
const ARDUINO_CLI_STDERR_RED_IGNORE = /Executable segment sizes/g;

const ABORT_STATE_CHECK_INTERVAL = 100;

class Arduino {
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd) {
        this._peripheralPath = peripheralPath;
        this._config = config;
        this._userDataPath = userDataPath;
        this._arduinoPath = path.join(toolsPath, 'Arduino');
        this._sendstd = sendstd;
        this._firmwareDir = path.join(toolsPath, '../firmwares/arduino');

        this._abort = false;

        // If the fqbn is an object means the value of this parameter is
        // different under different systems.
        if (typeof this._config.fqbn === 'object') {
            this._config.fqbn = this._config.fqbn[os.platform()];
        }

        const projectPathName = `${this._config.fqbn.replace(/:/g, '_')}_project`.split(/_/).splice(0, 3)
            .join('_');
        this._configFilePath = path.join(this._userDataPath, 'arduino/arduino-cli.yaml');
        this._projectFilePath = path.join(this._userDataPath, 'arduino', projectPathName);

        this._arduinoCliPath = path.join(this._arduinoPath, 'arduino-cli');

        this._codeFolderPath = path.join(this._projectFilePath, 'code');
        this._codeFilePath = path.join(this._codeFolderPath, 'code.ino');
        this._buildPath = path.join(this._projectFilePath, 'build');
        this._buildCachePath = path.join(this._projectFilePath, 'buildCache');

        this.initArduinoCli();
    }

    /**
     * Ordered unique extension library paths for compiler search (--libraries).
     * libraryOrder entries win; then config.library; duplicates removed.
     * @returns {string[]} absolute paths that exist on disk.
     */
    _buildCompileLibraryPaths () {
        const ordered = [];
        const seen = new Set();
        const add = p => {
            if (!p || typeof p !== 'string') return;
            if (!fs.existsSync(p)) return;
            const abs = path.resolve(p);
            if (seen.has(abs)) return;
            seen.add(abs);
            ordered.push(abs);
        };
        this._discoverManualLibraryPaths().forEach(add);
        if (Array.isArray(this._config.libraryOrder)) {
            this._config.libraryOrder.forEach(add);
        }
        if (Array.isArray(this._config.library)) {
            this._config.library.forEach(add);
        }
        return ordered;
    }

    /**
     * Why: manual libraries are often copied into sketchbook/libraries without
     * updating config.library. Auto-discovering keeps upload behavior in sync
     * with local library changes.
     * @returns {string[]} absolute candidate library directories.
     */
    _discoverManualLibraryPaths () {
        const libsRoot = path.join(this._arduinoPath, 'libraries');
        if (!fs.existsSync(libsRoot)) return [];
        try {
            const dirs = fs.readdirSync(libsRoot)
                .map(name => path.join(libsRoot, name))
                .filter(full => {
                    try {
                        return fs.statSync(full).isDirectory();
                    } catch (e) {
                        return false;
                    }
                });
            return dirs.filter(dir => this._isArduinoLibraryDir(dir));
        } catch (err) {
            this._sendstd(`${ansi.yellow_dark}[build] scan libraries warning: ${err.message}\n`);
            return [];
        }
    }

    /**
     * Why: several hand-copied AT32 libraries expose only generic headers
     * (e.g. wk_i2c.h) but generated sketches include <LibraryName.h>.
     * Create a tiny compatibility header so Arduino resolver can find them.
     * @param {string[]} libDirs absolute library directories.
     */
    _ensureManualLibraryCompatHeaders (libDirs) {
        if (!Array.isArray(libDirs) || libDirs.length === 0) return;
        for (const dir of libDirs) {
            const libName = path.basename(dir);
            if (!libName) continue;
            const expectedHeader = `${libName}.h`;
            const srcHeader = path.join(dir, 'src', expectedHeader);
            const includeHeader = path.join(dir, 'include', expectedHeader);
            const rootHeader = path.join(dir, expectedHeader);
            if (fs.existsSync(srcHeader) || fs.existsSync(includeHeader) || fs.existsSync(rootHeader)) {
                continue;
            }
            const fallbackHeader = path.join(dir, 'include', 'wk_i2c.h');
            if (!fs.existsSync(fallbackHeader)) {
                continue;
            }
            const srcDir = path.join(dir, 'src');
            try {
                if (!fs.existsSync(srcDir)) {
                    fs.mkdirSync(srcDir, {recursive: true});
                }
                const guard = `__${libName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_H__`;
                const shim = [
                    '/* Auto-generated compatibility header for Arduino resolver. */',
                    `#ifndef ${guard}`,
                    `#define ${guard}`,
                    '#include "../include/wk_i2c.h"',
                    '#endif'
                ].join('\n') + '\n';
                fs.writeFileSync(srcHeader, shim, 'utf8');
                this._sendstd(`${ansi.yellow_dark}[build] Generated compat header: ${srcHeader}\n`);
            } catch (err) {
                this._sendstd(
                    `${ansi.yellow_dark}[build] compat header warning (${libName}): ${err.message}\n`
                );
            }
        }
    }

    /**
     * Why: ignore non-Arduino folders (e.g. .pio/.vscode artifacts) that cause
     * "invalid library: no header files found" noise during compile.
     * @param {string} dir absolute library directory path.
     * @returns {boolean} true when folder looks like an Arduino library.
     */
    _isArduinoLibraryDir (dir) {
        if (fs.existsSync(path.join(dir, 'library.properties'))) {
            return true;
        }
        const hasHeaderOrSource = subdir => {
            const target = path.join(dir, subdir);
            if (!fs.existsSync(target)) return false;
            try {
                return fs.readdirSync(target).some(name => /\.(h|hpp|hh|c|cc|cpp|cxx)$/i.test(name));
            } catch (e) {
                return false;
            }
        };
        if (hasHeaderOrSource('src') || hasHeaderOrSource('include')) {
            return true;
        }
        try {
            return fs.readdirSync(dir).some(name => /\.(h|hpp|hh|c|cc|cpp|cxx)$/i.test(name));
        } catch (e) {
            return false;
        }
    }

    /**
     * Prefer the bundled AT32 WS2812B lib when AT32 blocks are present.
     * @returns {string|null} absolute library directory or null.
     */
    _getBundledAt32Ws2812bLibraryPath () {
        const ws2812b = path.join(this._arduinoPath, 'libraries', 'WS2812B');
        if (fs.existsSync(ws2812b)) {
            return path.resolve(ws2812b);
        }
        return null;
    }

    /**
     * Simple JSON-serializable source tweaks before writing the .ino (optional).
     * Each rule: { type: 'replace', find: string, replace: string }.
     * @param {string} code - generated sketch source.
     * @returns {string} possibly modified source.
     */
    _applySourceTransforms (code) {
        const transforms = this._config.sourceTransforms;
        if (!Array.isArray(transforms)) return code;
        let out = code;
        transforms.forEach(t => {
            if (!t || t.type !== 'replace') return;
            if (typeof t.find !== 'string' || typeof t.replace !== 'string') return;
            out = out.split(t.find).join(t.replace);
        });
        return out;
    }

    /**
     * Why: some upstream payloads occasionally prepend numeric noise before
     * preprocessor directives (e.g. `99964968#include <Arduino.h>`), which
     * breaks compilation immediately. Strip only that specific corruption while
     * leaving normal sketch content untouched.
     * @param {string} code - generated sketch source.
     * @returns {string} sanitized source.
     */
    _sanitizeSketchSource (code) {
        if (typeof code !== 'string' || !code) return code;
        return code.replace(
            /(^|\n)\s*\d{6,}\s*(#(?:include|define|if|ifdef|ifndef|elif|else|endif|pragma)\b)/g,
            (m, prefix, directive) => {
                this._sendstd(
                    `${ansi.yellow_dark}[build] sanitized corrupted preprocessor line: ${m.trim()}\n`
                );
                return `${prefix}${directive}`;
            }
        );
    }

    /**
     * Parse avrdude-style percentage from a log chunk for GUI progress (0..1).
     * @param {string} text - stderr/stdout fragment.
     * @returns {number|undefined} normalized progress.
     */
    _flashProgressFromText (text) {
        const matches = text.match(/\d{1,3}\s*%/g);
        if (!matches || !matches.length) return;
        const last = matches[matches.length - 1];
        const n = parseInt(last, 10);
        if (Number.isNaN(n)) return;
        return Math.min(1, Math.max(0, n / 100));
    }

    initArduinoCli () {
        // try to init the arduino cli config.
        spawnSync(this._arduinoCliPath, ['config', 'init', '--dest-file', this._configFilePath]);

        // if arduino cli config haven be init, set it to link arduino path.
        const buf = spawnSync(this._arduinoCliPath, ['config', 'dump', '--config-file', this._configFilePath]);
        try {
            if (buf.error) {
                throw buf.error;
            }

            const stdout = yaml.load(buf.stdout.toString());

            if (stdout.directories.data !== this._arduinoPath) {
                this._sendstd(`${ansi.yellow_dark}arduino cli config has not been initialized yet.\n`);
                this._sendstd(`${ansi.green_dark}set the path to ${this._arduinoPath}.\n`);
                spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.data', this._arduinoPath,
                    '--config-file', this._configFilePath]);
                spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.downloads',
                    path.join(this._arduinoPath, 'staging'), '--config-file', this._configFilePath]);
                spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.user', this._arduinoPath,
                    '--config-file', this._configFilePath]);
            }
        } catch (err) {
            this._sendstd(`${ansi.red}arduino cli init error:${err.toString()}\n`);
        }

    }

    abortUpload () {
        this._abort = true;
    }

    build (code) {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(this._codeFolderPath)) {
                fs.mkdirSync(this._codeFolderPath, {recursive: true});
            }

            const transformed = this._sanitizeSketchSource(
                this._applySourceTransforms(code)
            );
            const hasAt32Markers = /AT32_|at32[_A-Za-z0-9]*/.test(transformed);
            const discoveredManualLibs = this._discoverManualLibraryPaths();
            this._ensureManualLibraryCompatHeaders(discoveredManualLibs);
            try {
                fs.writeFileSync(this._codeFilePath, transformed);
            } catch (err) {
                return reject(err);
            }

            const args = [
                'compile',
                '--fqbn', this._config.fqbn,
                '--warnings=none',
                '--verbose',
                '--build-path', this._buildPath,
                '--build-cache-path', this._buildCachePath,
                '--config-file', this._configFilePath,
                this._codeFolderPath
            ];

            const extraLibs = this._buildCompileLibraryPaths();
            if (hasAt32Markers) {
                const at32Ws2812b = this._getBundledAt32Ws2812bLibraryPath();
                if (at32Ws2812b && !extraLibs.includes(at32Ws2812b)) {
                    extraLibs.unshift(at32Ws2812b);
                    this._sendstd(`Inject AT32 WS2812B library: ${at32Ws2812b}\n`);
                }
            }
            for (let i = extraLibs.length - 1; i >= 0; i--) {
                args.splice(3, 0, '--libraries', extraLibs[i]);
                this._sendstd(`Inject library: ${extraLibs[i]}\n`);
            }

            const sketchIdx = args.indexOf(this._codeFolderPath);
            if (Array.isArray(this._config.compilerDefines) && this._config.compilerDefines.length) {
                const flags = this._config.compilerDefines
                    .map(d => String(d).trim())
                    .filter(Boolean)
                    .map(d => {
                        if (d.startsWith('-D')) return d;
                        return `-D${d}`;
                    })
                    .join(' ');
                if (flags) {
                    args.splice(sketchIdx, 0, '--build-property', `compiler.cpp.extra_flags=${flags}`);
                }
            }

            const arduinoCli = spawn(this._arduinoCliPath, args);
            this._sendstd(`Start building...\n`);

            arduinoCli.stderr.on('data', buf => {
                const data = buf.toString();

                if (data.search(ARDUINO_CLI_STDERR_RED_IGNORE) !== -1) { // eslint-disable-line no-negated-condition
                    this._sendstd(ansi.red + data);
                } else {
                    this._sendstd(ansi.red + data);
                }
            });

            arduinoCli.stdout.on('data', buf => {
                const data = buf.toString();
                let ansiColor = null;

                if (data.search(/Sketch uses|Global variables/g) === -1) {
                    ansiColor = ansi.clear;
                } else {
                    ansiColor = ansi.green_dark;
                }
                this._sendstd(ansiColor + data);
            });

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    arduinoCli.kill();
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            arduinoCli.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                this._sendstd(`${ansi.clear}\r\n`); // End ansi color setting
                switch (outCode) {
                case null:
                    // process be killed, do nothing.
                    return resolve('Aborted');
                case 0:
                    return resolve('Success');
                case 1:
                    return reject(new Error('Build failed'));
                case 2:
                    return reject(new Error('Sketch not found'));
                case 3:
                    return reject(new Error('Invalid (argument for) commandline optiond'));
                case 4:
                    return reject(new Error('Preference passed to --get-pref does not exist'));
                default:
                    return reject(new Error('Unknown error'));
                }
            });
        });
    }

    _insertStr (soure, start, newStr) {
        return soure.slice(0, start) + newStr + soure.slice(start);
    }

    /**
     * Why: pre-erase is useful for ESP32 class boards where stale app/partitions
     * can cause unstable boot after repeated flashes.
     * @returns {boolean} true when the target fqbn belongs to ESP32 core.
     */
    _isEsp32Target () {
        return typeof this._config.fqbn === 'string' &&
            this._config.fqbn.toLowerCase().startsWith('esp32:');
    }

    /**
     * Why: allow users to disable the extra erase step per board/profile while
     * keeping safer defaults for ESP32 uploads.
     * @returns {boolean} whether erase should run before upload.
     */
    _shouldClearFirmwareBeforeUpload () {
        if (!this._isEsp32Target()) return false;
        if (typeof this._config.clearFirmwareBeforeUpload === 'boolean') {
            return this._config.clearFirmwareBeforeUpload;
        }
        return true;
    }

    /**
     * Why: bundled esptool is more stable than shell PATH lookup and keeps
     * upload behavior deterministic across environments.
     * @returns {string} absolute esptool binary path or plain executable name.
     */
    _resolveEsp32EsptoolPath () {
        const isWin = os.platform() === 'win32';
        const exeName = isWin ? 'esptool.exe' : 'esptool';
        const explicit = this._config.esptoolPath;
        if (explicit && fs.existsSync(explicit)) {
            return explicit;
        }
        const baseDir = path.join(
            this._arduinoPath,
            'packages', 'esp32', 'tools', 'esptool_py'
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
                        return candidate;
                    }
                }
            }
        } catch (err) {
            this._sendstd(`${ansi.yellow_dark}[upload] esptool resolver warning: ${err.message}\n`);
        }
        return exeName;
    }

    /**
     * Why: ESP32 reset during erase/upload can re-enumerate as a new COM port.
     * Detect arduino-cli/esptool "port not available" failures reliably.
     * @param {string} text merged stderr/stdout output.
     * @returns {boolean} true when failure is caused by missing/busy serial port.
     */
    _isSerialPortOpenError (text) {
        if (typeof text !== 'string' || !text) return false;
        return /could not open|can't open|cannot find the file specified|serial port .* not found|no such file/i.test(text);
    }

    /**
     * Why: after ESP32 resets, Windows may assign a different COM number.
     * Pick a deterministic fallback serial path for one retry.
     * @param {string} currentPath currently selected serial path.
     * @returns {Promise<string|null>} fallback path or null when none is suitable.
     */
    async _resolveFallbackSerialPath (currentPath) {
        try {
            const ports = await SerialPort.list();
            if (!Array.isArray(ports) || !ports.length) return null;
            const normalizedCurrent = (currentPath || '').toUpperCase();
            const normalizedAllowedVids = Array.isArray(this._config.espVendorIds) ?
                this._config.espVendorIds.map(v => String(v).toUpperCase()) :
                ['303A', '10C4', '1A86'];
            const candidates = ports
                .filter(p => p && typeof p.path === 'string' && p.path)
                .filter(p => p.path.toUpperCase() !== normalizedCurrent)
                .filter(p => {
                    const vid = String(p.vendorId || '').toUpperCase();
                    if (!vid) return true;
                    return normalizedAllowedVids.includes(vid);
                })
                .sort((a, b) => {
                    const ma = /COM(\d+)/i.exec(a.path || '');
                    const mb = /COM(\d+)/i.exec(b.path || '');
                    if (ma && mb) return Number(mb[1]) - Number(ma[1]);
                    return String(b.path || '').localeCompare(String(a.path || ''));
                });
            if (!candidates.length) return null;
            return candidates[0].path;
        } catch (err) {
            this._sendstd(
                `${ansi.yellow_dark}[upload] fallback serial scan warning: ${err.message}\n`
            );
            return null;
        }
    }

    /**
     * Why: clearing flash before upload helps avoid stale firmware artifacts
     * after watchdog resets or layout changes on ESP32 boards.
     * @returns {Promise<void>} resolves when erase completes.
     */
    _clearEsp32FirmwareBeforeUpload () {
        return new Promise((resolve, reject) => {
            const esptoolPath = this._resolveEsp32EsptoolPath();
            const args = [
                '--chip', this._config.espChip || 'esp32s3',
                '--port', this._peripheralPath,
                '--baud', String(this._config.espEraseBaudrate || 460800),
                '--before', this._config.espBefore || 'default_reset',
                '--after', this._config.espAfter || 'hard_reset',
                'erase_flash'
            ];
            this._sendstd(
                `${ansi.yellow_dark}[upload] Clear old firmware before upload...\n`
            );
            const proc = spawn(esptoolPath, args, {windowsHide: true});
            proc.stdout.on('data', buf => this._sendstd(buf.toString()));
            proc.stderr.on('data', buf => this._sendstd(buf.toString()));
            proc.on('error', err => reject(new Error(`Failed to spawn esptool: ${err.message}`)));
            proc.on('exit', code => {
                if (code === 0) {
                    this._sendstd(`${ansi.green_dark}[upload] Firmware erase done.\n`);
                    return resolve();
                }
                return reject(new Error(`Failed to clear old firmware (exit code ${code})`));
            });
        });
    }

    async flash (firmwarePath = null) {
        if (!firmwarePath && this._shouldClearFirmwareBeforeUpload()) {
            try {
                await this._clearEsp32FirmwareBeforeUpload();
            } catch (err) {
                // Pre-erase is a best-effort safety step. On USB reset-capable ESP32 boards
                // the COM port may briefly disappear, so continue with normal upload attempt.
                this._sendstd(
                    `${ansi.yellow_dark}[upload] Pre-erase failed, continue upload: ${err.message}\n`
                );
            }
        }
        const runFlash = (uploadPort, allowFallbackRetry) => new Promise((resolve, reject) => {
            const args = [
                'upload',
                '--fqbn', this._config.fqbn,
                '--verbose',
                '--verify',
                '--config-file', this._configFilePath,
                `-p${uploadPort}`
            ];

            // for k210 we must specify the programmer used as kflash
            if (this._config.fqbn.startsWith('Maixduino:k210:')) {
                args.push('-Pkflash');
            }

            if (firmwarePath) {
                args.push('--input-file', firmwarePath, firmwarePath);
            } else {
                args.push('--input-dir', this._buildPath);
                args.push(this._codeFolderPath);
            }

            let rawOutput = '';
            const arduinoCli = spawn(this._arduinoCliPath, args);

            arduinoCli.stderr.on('data', buf => {
                let data = buf.toString();
                rawOutput += data;

                // Note: avrdude emits progress chunks intermittently.
                // There should be a better way to handle these mesaage.
                if (data.search(ARDUINO_CLI_STDOUT_GREEN_START) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_GREEN_START), ansi.green_dark);
                }
                if (data.search(ARDUINO_CLI_STDOUT_GREEN_END) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_GREEN_END) + 1, ansi.clear);
                }
                if (data.search(ARDUINO_CLI_STDOUT_WHITE) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_WHITE), ansi.clear);
                }
                if (data.search(ARDUINO_CLI_STDOUT_RED_START) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_RED_START), ansi.red);
                }
                const prog = this._flashProgressFromText(data);
                this._sendstd(data, prog);
            });

            arduinoCli.stdout.on('data', buf => {
                // It seems that avrdude didn't use stdout.
                const data = buf.toString();
                rawOutput += data;
                const prog = this._flashProgressFromText(data);
                this._sendstd(data, prog);
            });

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    if (os.platform() === 'win32') {
                        spawnSync('taskkill', ['/pid', arduinoCli.pid, '/f', '/t']);
                    } else {
                        arduinoCli.kill();
                    }
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            arduinoCli.on('exit', code => {
                clearInterval(listenAbortSignal);
                const wait = ms => new Promise(relv => setTimeout(relv, ms));
                switch (code) {
                case 0:
                    if (this._config.postUploadDelay) {
                        // Waiting for usb rerecognize.
                        wait(this._config.postUploadDelay).then(() => resolve('Success'));
                    } else {
                        return resolve('Success');
                    }
                    break;
                case 1:
                    if (this._abort) {
                        // Wait for 100ms before returning to prevent the serial port from being released.
                        wait(100).then(() => resolve('Aborted'));
                    } else if (allowFallbackRetry && this._isEsp32Target() &&
                        this._isSerialPortOpenError(rawOutput)) {
                        this._resolveFallbackSerialPath(uploadPort)
                            .then(fallbackPort => {
                                if (!fallbackPort) {
                                    return reject(new Error('avrdude failed to flash'));
                                }
                                this._sendstd(
                                    `${ansi.yellow_dark}[upload] Port ${uploadPort} unavailable, retry on ${fallbackPort}\n`
                                );
                                this._peripheralPath = fallbackPort;
                                return resolve(runFlash(fallbackPort, false));
                            })
                            .catch(() => reject(new Error('avrdude failed to flash')));
                    } else {
                        return reject(new Error('avrdude failed to flash'));
                    }
                    break;
                default:
                    return reject(new Error('avrdude failed to flash'));
                }
            });
        });

        return runFlash(this._peripheralPath, true);
    }

    flashRealtimeFirmware () {
        const firmwarePath = path.join(this._firmwareDir, this._config.firmware);
        return this.flash(firmwarePath);
    }
}

module.exports = Arduino;
