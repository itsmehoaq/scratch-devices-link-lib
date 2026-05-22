const fs = require('fs');
const {spawn, spawnSync} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const yaml = require('js-yaml');
const os = require('os');
const {SerialPort} = require('serialport');
const {resolveToolBinary} = require('../lib/runtime-paths');

const ARDUINO_CLI_STDOUT_GREEN_START = /Reading \||Writing \|/g;
const ARDUINO_CLI_STDOUT_GREEN_END = /%/g;
const ARDUINO_CLI_STDOUT_WHITE = /avrdude done/g;
const ARDUINO_CLI_STDOUT_RED_START = /can't open device|programmer is not responding/g;
const ARDUINO_CLI_STDERR_RED_IGNORE = /Executable segment sizes/g;

const ABORT_STATE_CHECK_INTERVAL = 100;

/** Matches arduino-cli / esptool serial port open failures (upload retry). */
const ESP_SERIAL_OPEN_ERROR_RE =
    /could not open|can't open|cannot find the file specified|serial port .* not found|no such file/i;

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

        this._arduinoCliPath = resolveToolBinary(
            toolsPath,
            path.join('Arduino', 'arduino-cli')
        );

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
                const shim = `${
                    [
                        '/* Auto-generated compatibility header for Arduino resolver. */',
                        `#ifndef ${guard}`,
                        `#define ${guard}`,
                        '#include "../include/wk_i2c.h"',
                        '#endif'
                    ].join('\n')
                }\n`;
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

    _libraryHasHeader (libDir, headerName) {
        if (!libDir || !headerName) return false;
        const candidates = [
            path.join(libDir, headerName),
            path.join(libDir, 'src', headerName),
            path.join(libDir, 'include', headerName)
        ];
        return candidates.some(p => fs.existsSync(p));
    }

    _hasHeaderInKnownLibraries (headerName, extraLibDirs) {
        if (!headerName) return false;
        const libsRoot = path.join(this._arduinoPath, 'libraries');
        if (fs.existsSync(libsRoot)) {
            try {
                const names = fs.readdirSync(libsRoot);
                for (const name of names) {
                    const full = path.join(libsRoot, name);
                    try {
                        if (!fs.statSync(full).isDirectory()) continue;
                    } catch (e) {
                        continue;
                    }
                    if (this._libraryHasHeader(full, headerName)) return true;
                }
            } catch (e) {
                // ignore scan errors; extraLibDirs check below may still succeed.
            }
        }
        if (!Array.isArray(extraLibDirs)) return false;
        return extraLibDirs.some(dir => this._libraryHasHeader(dir, headerName));
    }

    /**
     * Why: some upstream payloads occasionally prepend numeric noise before
     * preprocessor directives (e.g. `99964968#include <Arduino.h>`), which
     * breaks compilation immediately. Strip only that specific corruption while
     * leaving normal sketch content untouched.
     * @param {string} code - generated sketch source.
     * @param {string[]|undefined} extraLibDirs - extra library roots for header lookup.
     * @returns {string} sanitized source.
     */
    _sanitizeSketchSource (code, extraLibDirs) {
        if (typeof code !== 'string' || !code) return code;
        let out = code.replace(
            /(^|\n)\s*\d{6,}\s*(#(?:include|define|if|ifdef|ifndef|elif|else|endif|pragma)\b)/g,
            (m, prefix, directive) => {
                this._sendstd(
                    `${ansi.yellow_dark}[build] sanitized corrupted preprocessor line: ${m.trim()}\n`
                );
                return `${prefix}${directive}`;
            }
        );
        if (
            out.includes('#include <Adafruit_AHTX0.h>') &&
            !this._hasHeaderInKnownLibraries('Adafruit_AHTX0.h', extraLibDirs)
        ) {
            out = out.replace(
                /^\s*#include\s*<Adafruit_AHTX0\.h>\s*[\r]?\n?/gm,
                ''
            );
            this._sendstd(
                `${ansi.yellow_dark}[build] strip missing include: <Adafruit_AHTX0.h> (library not found)\n`
            );
        }
        return out;
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

    _attachSpawnError (proc, reject, label) {
        proc.on('error', err => {
            reject(new Error(`${label} failed to start ${this._arduinoCliPath}: ${err.message}`));
        });
    }

    initArduinoCli () {
        if (!fs.existsSync(this._arduinoCliPath)) {
            this._sendstd(
                `${ansi.red}arduino-cli not found: ${this._arduinoCliPath}\n`
            );
            return;
        }

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

            const discoveredManualLibs = this._discoverManualLibraryPaths();
            this._ensureManualLibraryCompatHeaders(discoveredManualLibs);
            const compileLibsForSanitize = this._buildCompileLibraryPaths();

            const transformed = this._sanitizeSketchSource(
                this._applySourceTransforms(code),
                compileLibsForSanitize
            );
            const hasAt32Markers = /AT32_|at32[_A-Za-z0-9]*/.test(transformed);
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

            if (!fs.existsSync(this._arduinoCliPath)) {
                return reject(new Error(`arduino-cli not found: ${this._arduinoCliPath}`));
            }

            const arduinoCli = spawn(this._arduinoCliPath, args, {
                cwd: path.dirname(this._arduinoCliPath),
                windowsHide: true
            });
            this._sendstd(`Start building...\n`);
            this._attachSpawnError(arduinoCli, reject, 'Build');

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
     * After esptool erase_flash + hard_reset the ESP32-S3 may disappear from the
     * original COM for hundreds of ms. Wait, then return the best serial path:
     * same COM if it came back, else another Espressif/UART bridge port.
     * @param {string} preferredPath port user selected (e.g. COM9)
     * @returns {Promise<string|null>} resolved serial path, or null if none found.
     */
    async _resolveEsp32PortAfterErase (preferredPath) {
        const delayMs = typeof this._config.espPostErasePortDelayMs === 'number' ?
            this._config.espPostErasePortDelayMs :
            (os.platform() === 'win32' ? 1600 : 900);
        if (delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
        }
        try {
            const ports = await SerialPort.list();
            if (!Array.isArray(ports) || !ports.length) return null;
            const normalizedAllowedVids = Array.isArray(this._config.espVendorIds) ?
                this._config.espVendorIds.map(v => {
                    const s = String(v).replace(/^0x/i, '');
                    return s.toUpperCase();
                }) :
                ['303A', '10C4', '1A86'];
            const normalizeVid = p => {
                const raw = String(p.vendorId || '').replace(/^0x/i, '');
                return raw.toUpperCase();
            };
            const comNum = serialPath => {
                const m = /COM(\d+)/i.exec(serialPath || '');
                return m ? Number(m[1]) : -1;
            };
            const prefUpper = (preferredPath || '').toUpperCase();
            const prefCom = comNum(preferredPath);
            const vidRank = vid => {
                if (vid === '303A') return 4;
                if (vid === '10C4' || vid === '1A86') return 3;
                return normalizedAllowedVids.includes(vid) ? 2 : 0;
            };
            const matching = ports
                .filter(p => p && typeof p.path === 'string' && p.path)
                .map(p => ({path: p.path, vid: normalizeVid(p)}))
                .filter(p => p.vid && normalizedAllowedVids.includes(p.vid));
            if (!matching.length) return null;
            const stillThere = matching.find(p => p.path.toUpperCase() === prefUpper);
            if (stillThere) {
                return stillThere.path;
            }
            let candidates = matching;
            if (os.platform() === 'win32' && this._config.allowLowComFallback !== true &&
                prefCom > 3) {
                candidates = matching.filter(p => comNum(p.path) > 3);
            }
            if (!candidates.length) return null;
            candidates.sort((a, b) => {
                const r = vidRank(b.vid) - vidRank(a.vid);
                if (r !== 0) return r;
                if (prefCom > 0) {
                    const da = Math.abs(comNum(a.path) - prefCom);
                    const db = Math.abs(comNum(b.path) - prefCom);
                    if (da !== db) return da - db;
                }
                return comNum(b.path) - comNum(a.path);
            });
            return candidates[0].path;
        } catch (err) {
            this._sendstd(
                `${ansi.yellow_dark}[upload] post-erase port scan warning: ${err.message}\n`
            );
            return null;
        }
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
        return ESP_SERIAL_OPEN_ERROR_RE.test(text);
    }

    /**
     * Why: after ESP32 resets, Windows may assign a different COM number.
     * Pick one fallback serial path for a single retry. Ignore ports with no USB
     * VID (avoids COM1/modem ghosts). Prefer Espressif (303A), then CP210x/CH340.
     * Waits briefly first so USB can re-enumerate after a failed open.
     * @param {string} currentPath currently selected serial path.
     * @returns {Promise<string|null>} fallback path or null when none is suitable.
     */
    async _resolveFallbackSerialPath (currentPath) {
        const delayMs = typeof this._config.espFallbackScanDelayMs === 'number' ?
            this._config.espFallbackScanDelayMs : 400;
        if (delayMs > 0) {
            await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
        }
        try {
            const ports = await SerialPort.list();
            if (!Array.isArray(ports) || !ports.length) return null;
            const normalizedCurrent = (currentPath || '').toUpperCase();
            const normalizedAllowedVids = Array.isArray(this._config.espVendorIds) ?
                this._config.espVendorIds.map(v => {
                    const s = String(v).replace(/^0x/i, '');
                    return s.toUpperCase();
                }) :
                ['303A', '10C4', '1A86'];
            const normalizeVid = p => {
                const raw = String(p.vendorId || '').replace(/^0x/i, '');
                return raw.toUpperCase();
            };
            const comNum = serialPath => {
                const m = /COM(\d+)/i.exec(serialPath || '');
                return m ? Number(m[1]) : -1;
            };
            const currentComNum = comNum(currentPath);
            const vidRank = vid => {
                if (vid === '303A') return 4;
                if (vid === '10C4' || vid === '1A86') return 3;
                return normalizedAllowedVids.includes(vid) ? 2 : 0;
            };
            const candidates = ports
                .filter(p => p && typeof p.path === 'string' && p.path)
                .filter(p => p.path.toUpperCase() !== normalizedCurrent)
                .map(p => ({path: p.path, vid: normalizeVid(p)}))
                .filter(p => {
                    if (os.platform() !== 'win32') return true;
                    if (this._config.allowLowComFallback === true) return true;
                    const n = comNum(p.path);
                    if (n <= 0) return true;
                    if (currentComNum > 3) return n > 3;
                    return true;
                })
                .filter(p => p.vid && normalizedAllowedVids.includes(p.vid));
            if (!candidates.length) return null;
            candidates.sort((a, b) => {
                const r = vidRank(b.vid) - vidRank(a.vid);
                if (r !== 0) return r;
                if (currentComNum > 0) {
                    const da = Math.abs(comNum(a.path) - currentComNum);
                    const db = Math.abs(comNum(b.path) - currentComNum);
                    if (da !== db) return da - db;
                }
                return comNum(b.path) - comNum(a.path);
            });
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
     * Retries once at 115200 baud when the first erase fails (USB UART often
     * drops high-speed esptool runs on Windows / long cables).
     * @returns {Promise<void>} resolves when erase completes.
     */
    _clearEsp32FirmwareBeforeUpload () {
        return new Promise((resolve, reject) => {
            const esptoolPath = this._resolveEsp32EsptoolPath();
            const chip = this._config.espChip || 'esp32s3';
            const before = this._config.espBefore || 'default_reset';
            const after = this._config.espAfter || 'hard_reset';
            const lowBaud = 115200;
            const runErase = (baud, isRetry) => {
                const args = [
                    '--chip', chip,
                    '--port', this._peripheralPath,
                    '--baud', String(baud),
                    '--before', before,
                    '--after', after,
                    'erase_flash'
                ];
                if (isRetry) {
                    this._sendstd(
                        `${ansi.yellow_dark}[upload] Retrying firmware erase at ${baud} baud...\n`
                    );
                } else {
                    this._sendstd(
                        `${ansi.yellow_dark}[upload] Clear old firmware before upload...\n`
                    );
                }
                const proc = spawn(esptoolPath, args, {windowsHide: true});
                proc.stdout.on('data', buf => this._sendstd(buf.toString()));
                proc.stderr.on('data', buf => this._sendstd(buf.toString()));
                proc.on('error', err => reject(new Error(`Failed to spawn esptool: ${err.message}`)));
                proc.on('exit', code => {
                    if (code === 0) {
                        this._sendstd(`${ansi.green_dark}[upload] Firmware erase done.\n`);
                        return resolve();
                    }
                    if (!isRetry && Number(baud) > lowBaud) {
                        return runErase(lowBaud, true);
                    }
                    return reject(new Error(`Failed to clear old firmware (exit code ${code})`));
                });
            };
            runErase(this._config.espEraseBaudrate || 460800, false);
        });
    }

    async flash (firmwarePath = null) {
        if (!firmwarePath && this._shouldClearFirmwareBeforeUpload()) {
            try {
                await this._clearEsp32FirmwareBeforeUpload();
                const afterErase = await this._resolveEsp32PortAfterErase(this._peripheralPath);
                if (afterErase && afterErase !== this._peripheralPath) {
                    this._sendstd([
                        `${ansi.yellow_dark}[upload] Port after chip erase: ${afterErase}`,
                        `(was ${this._peripheralPath})\n`
                    ].join(''));
                    this._peripheralPath = afterErase;
                } else if (!afterErase) {
                    this._sendstd([
                        `${ansi.yellow_dark}[upload] `,
                        'No USB serial port found after erase yet; ',
                        'upload may fail until the device re-enumerates.\n'
                    ].join(''));
                }
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

            if (!fs.existsSync(this._arduinoCliPath)) {
                return reject(new Error(`arduino-cli not found: ${this._arduinoCliPath}`));
            }

            let rawOutput = '';
            const arduinoCli = spawn(this._arduinoCliPath, args, {
                cwd: path.dirname(this._arduinoCliPath),
                windowsHide: true
            });
            this._attachSpawnError(arduinoCli, reject, 'Upload');

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
                if (code === 0) {
                    if (this._config.postUploadDelay) {
                        wait(this._config.postUploadDelay).then(() => resolve('Success'));
                    } else {
                        resolve('Success');
                    }
                    return;
                }
                if (this._abort) {
                    wait(100).then(() => resolve('Aborted'));
                    return;
                }
                const esptoolLikeFailure = code === 1 || code === 2;
                if (allowFallbackRetry && this._isEsp32Target() &&
                    esptoolLikeFailure &&
                    this._isSerialPortOpenError(rawOutput)) {
                    this._resolveFallbackSerialPath(uploadPort)
                        .then(fallbackPort => {
                            if (!fallbackPort) {
                                return reject(new Error(
                                    'Serial port missing or busy: no ESP/USB-UART device found. ' +
                                    'Reconnect USB, refresh the port list, pick the correct COM ' +
                                    '(Espressif/CP210x/CH343), and close Serial Monitor or other apps using the port.'
                                ));
                            }
                            this._sendstd(
                                `${ansi.yellow_dark}[upload] Port ${uploadPort} unavailable, retry on ${fallbackPort}\n`
                            );
                            this._peripheralPath = fallbackPort;
                            return resolve(runFlash(fallbackPort, false));
                        })
                        .catch(() => reject(new Error('avrdude failed to flash')));
                    return;
                }
                reject(new Error('avrdude failed to flash'));
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
