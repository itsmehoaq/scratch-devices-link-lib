const os = require('os');
const {SerialPort} = require('serialport');
const ansi = require('ansi-string');

const Session = require('./session');
const Arduino = require('../upload/arduino');
const Esp32 = require('../upload/esp32');
const usbId = require('../lib/usb-id');

const PERIPHERAL_UNPLUG_CHECK_INTERVAL = 100;
/** Debounce brief COM close gaps (sensor hot-plug / ESP reset / Windows USB). */
const PERIPHERAL_UNPLUG_CLOSED_STREAK = os.platform() === 'win32' ? 15 : 8;
const POST_OPEN_UNPLUG_GRACE_MS = 2500;

/** ESP32-S3 native USB needs longer than UART bridges to re-enumerate after hard_reset. */
const POST_FLASH_RECONNECT_INITIAL_DELAY_MS = os.platform() === 'win32' ? 2800 : 1400;
const POST_FLASH_RECONNECT_ATTEMPTS = 16;
const POST_FLASH_RECONNECT_RETRY_DELAY_MS = os.platform() === 'win32' ? 700 : 500;
const POST_FLASH_OPEN_UNPLUG_GRACE_MS = os.platform() === 'win32' ? 12000 : 8000;
const TRANSIENT_RECONNECT_ATTEMPTS = 12;
const TRANSIENT_RECONNECT_DELAY_MS = os.platform() === 'win32' ? 500 : 400;
const PORT_LIST_POLL_INTERVAL_MS = 250;
const PORT_LIST_RECONNECT_MAX_WAIT_MS = os.platform() === 'win32' ? 18000 : 12000;
const ESP_RECONNECT_VENDOR_IDS = ['303A', '10C4', '1A86'];

/** Espressif native USB VID for ESP32-S3 OTG / Serial-JTAG (not UART bridge). */
const ESP32S3_OTG_VENDOR_ID = '303A';
/** Known ESP32-S3 native USB product IDs (OTG port, not CH340/CP2102 UART). */
const ESP32S3_OTG_PRODUCT_IDS = new Set([
    '1001', // USB Serial/JTAG (Hardware CDC on boot)
    '0002' // USB CDC ACM on some ESP32-S3 builds
]);

/** Default timeout for a `scanDevices` request waiting on JSON `{devices:[...]}`. */
const SCAN_DEVICES_DEFAULT_TIMEOUT_MS = 10000;
/** Cap to keep the scan accumulator from growing unbounded while waiting for JSON. */
const SCAN_DEVICES_BUFFER_LIMIT = 64 * 1024;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class SerialportSession extends Session {
    constructor (socket, userDataPath, toolsPath) {
        super(socket);

        this.userDataPath = userDataPath;
        this.toolsPath = toolsPath;

        this._type = 'serialport';
        this.peripheral = null;
        this.peripheralParams = null;
        this.services = null;
        this.reportedPeripherals = {};
        this.reportedPeripheralSignatures = {};
        this.connectStateDetectorTimer = null;
        this.peripheralsScanorTimer = null;
        this.isRead = false;
        this.isInDisconnect = false;
        this.tool = null;
        this._unplugGraceUntil = 0;
        this._unplugClosedStreak = 0;
        this._recoveringTransientClose = false;
        this._intentionalDisconnect = false;
        this._postFlashReconnecting = false;
        this._scanContext = null;
    }

    _pickBestEspReconnectDevice (devices, preferredPath) {
        if (!Array.isArray(devices) || !devices.length) {
            return null;
        }
        const prefCom = this._comNum(preferredPath);
        const rank = device => {
            let score = 0;
            if (this._isEsp32S3OtgDevice(device)) {
                score += 100;
            }
            const vid = this._normalizeUsbId(device.vendorId);
            if (vid === ESP32S3_OTG_VENDOR_ID) {
                score += 50;
            }
            if (prefCom > 0) {
                score -= Math.abs(this._comNum(device.path) - prefCom);
            }
            return score;
        };
        const sorted = devices.slice().sort((a, b) => rank(b) - rank(a));
        return sorted[0];
    }

    _normalizeUsbId (raw) {
        return String(raw || '').replace(/^0x/i, '').toUpperCase();
    }

    /**
     * Extract a comparable numeric identifier from a serial port path.
     * Windows: COM3 → 3, COM12 → 12
     * macOS/Linux: /dev/ttyUSB0 → 0, /dev/tty.usbmodem14101 → 14101
     * @param {string} serialPath serial port path.
     * @returns {number} numeric port identifier, or -1 if not parseable.
     */
    _comNum (serialPath) {
        if (!serialPath) return -1;
        // Windows: COMn
        const comMatch = /COM(\d+)/i.exec(serialPath);
        if (comMatch) return Number(comMatch[1]);
        // macOS/Linux: trailing digits in /dev/tty* paths
        const unixMatch = /(\d+)$/.exec(serialPath);
        if (unixMatch) return Number(unixMatch[1]);
        return -1;
    }

    /**
     * Why: Windify ESP32-S3 boards expose runtime serial on native USB OTG,
     * not on external UART bridge chips (CH340/CP2102).
     * @param {object} device serialport list entry.
     * @returns {boolean}
     */
    _isEsp32S3OtgDevice (device) {
        const vid = this._normalizeUsbId(device && device.vendorId);
        const pid = this._normalizeUsbId(device && device.productId);
        if (vid !== ESP32S3_OTG_VENDOR_ID) {
            return false;
        }
        return ESP32S3_OTG_PRODUCT_IDS.has(pid);
    }

    async _resolveReconnectPort (preferredPath) {
        if (!preferredPath) {
            throw new Error('Missing serial path for reconnect');
        }
        const cached = this.reportedPeripherals[preferredPath];
        const preferredVid = this._normalizeUsbId(cached && cached.vendorId);
        const preferredPid = this._normalizeUsbId(cached && cached.productId);
        const deadline = Date.now() + PORT_LIST_RECONNECT_MAX_WAIT_MS;

        while (Date.now() < deadline) {
            const list = await SerialPort.list();
            const exact = list.find(d => d.path === preferredPath);
            if (exact) {
                this.reportedPeripherals[preferredPath] = exact;
                return {device: exact, path: preferredPath};
            }

            if (preferredVid) {
                const vidMatches = list.filter(d => {
                    const vid = this._normalizeUsbId(d.vendorId);
                    const pid = this._normalizeUsbId(d.productId);
                    if (vid !== preferredVid || !d.path) {
                        return false;
                    }
                    return !preferredPid || pid === preferredPid;
                });
                if (vidMatches.length >= 1) {
                    const prefCom = this._comNum(preferredPath);
                    vidMatches.sort((a, b) => {
                        if (prefCom > 0) {
                            const da = Math.abs(this._comNum(a.path) - prefCom);
                            const db = Math.abs(this._comNum(b.path) - prefCom);
                            if (da !== db) {
                                return da - db;
                            }
                        }
                        return this._comNum(b.path) - this._comNum(a.path);
                    });
                    const device = vidMatches[0];
                    this.reportedPeripherals[device.path] = device;
                    return {device, path: device.path};
                }
            }

            const espMatches = list.filter(d => {
                const vid = this._normalizeUsbId(d.vendorId);
                return ESP_RECONNECT_VENDOR_IDS.includes(vid) && d.path;
            });
            if (espMatches.length >= 1) {
                const device = this._pickBestEspReconnectDevice(espMatches, preferredPath);
                if (device) {
                    this.reportedPeripherals[device.path] = device;
                    return {device, path: device.path};
                }
            }

            await delay(PORT_LIST_POLL_INTERVAL_MS);
        }

        throw new Error(`Serial port not listed yet: ${preferredPath}`);
    }

    async _refreshReportedPeripheralByPath (path) {
        const {device, path: resolvedPath} = await this._resolveReconnectPort(path);
        if (resolvedPath !== path && this.peripheralParams) {
            this.peripheralParams.peripheralId = resolvedPath;
            this.sendstd(
                `${ansi.yellow_dark}[serialport] Port re-enumerated as ${resolvedPath} (was ${path}).\n`
            );
        }
        return device;
    }

    /**
     * Arduino upload may switch COM after erase/flash; keep session params in sync.
     */
    async _syncUploadPortFromTool () {
        if (!this.tool || !this.peripheralParams) {
            return;
        }
        const uploadPath = typeof this.tool.getPeripheralPath === 'function' ?
            this.tool.getPeripheralPath() :
            this.tool._peripheralPath;
        if (!uploadPath) {
            return;
        }
        try {
            await this._refreshReportedPeripheralByPath(uploadPath);
        } catch (err) {
            console.warn(`[serialport] upload port sync warning: ${err.message}`);
        }
    }

    /**
     * Re-open serial after esptool/arduino-cli reset; OS may need time before the port is free.
     */
    async _connectAfterFlashWithRetries () {
        this._postFlashReconnecting = true;
        try {
            await this._syncUploadPortFromTool();
            await delay(POST_FLASH_RECONNECT_INITIAL_DELAY_MS);
            const path = this.peripheralParams && this.peripheralParams.peripheralId;
            let lastErr;
            for (let attempt = 0; attempt < POST_FLASH_RECONNECT_ATTEMPTS; attempt++) {
                try {
                    if (path) {
                        await this._refreshReportedPeripheralByPath(path);
                    }
                    await this.connect(this.peripheralParams, true, true);
                    return;
                } catch (err) {
                    lastErr = err;
                    console.warn(
                        `[serialport] reconnect after flash attempt ${attempt + 1}/${POST_FLASH_RECONNECT_ATTEMPTS}: ${err.message}`
                    );
                    if (attempt < POST_FLASH_RECONNECT_ATTEMPTS - 1) {
                        await delay(POST_FLASH_RECONNECT_RETRY_DELAY_MS);
                    }
                }
            }
            throw lastErr;
        } finally {
            this._postFlashReconnecting = false;
        }
    }

    async didReceiveCall (method, params, completion) {
        switch (method) {
        case 'discover':
            this.discover(params);
            completion(null, null);
            break;
        case 'stopDiscover':
            this.stopDiscover();
            completion(null, null);
            break;
        case 'connect':
            try {
                await this.connect(params);
                completion(null, null);
            } catch (err) {
                completion(null, err && err.message ? err.message : String(err));
            }
            break;
        case 'disconnect':
            await this.disconnect(true);
            completion(null, null);
            break;
        case 'updateBaudrate':
            try {
                completion(await this.updateBaudrate(params), null);
            } catch (err) {
                const message = (err && err.message) ? err.message : String(err);
                console.warn(`[serialport] updateBaudrate failed: ${message}`);
                this.sendRemoteRequest('connectError', {message});
                completion(null, null);
            }
            break;
        case 'write':
            completion(await this.write(params), null);
            break;
        case 'read':
            await this.read(params);
            completion(null, null);
            break;
        case 'upload':
            completion(await this.upload(params), null);
            break;
        case 'uploadFirmware':
            completion(await this.uploadFirmware(params), null);
            break;
        case 'uploadEsp32Bin':
            completion(await this.uploadEsp32Bin(params), null);
            break;
        case 'scanDevices':
            try {
                completion(await this.scanDevices(params), null);
            } catch (err) {
                completion(null, err.message || String(err));
            }
            break;
        case 'abortUpload':
            completion(await this.abortUpload(), null);
            break;
        case 'getServices':
            completion((this.services || []).map(service => service.uuid), null);
            break;
        case 'pingMe':
            completion('willPing', null);
            this.sendRemoteRequest('ping', null, result => {
                console.log(`Got result from ping: ${result}`);
            });
            break;
        default:
            throw new Error(`Method not found`);
        }
    }

    /**
     * Stop periodic COM discovery started by {@link SerialportSession.discover}.
     */
    stopDiscover () {
        if (this.peripheralsScanorTimer) {
            clearInterval(this.peripheralsScanorTimer);
            this.peripheralsScanorTimer = null;
        }
    }

    /**
     * Notify client whether abort upload may be used (GUI enables/disables button).
     * @param {boolean} enabled - true while build/flash may be interrupted.
     */
    _emitSetUploadAbortEnabled (enabled) {
        if (this._socket) {
            this.sendRemoteRequest('setUploadAbortEnabled', {enabled: Boolean(enabled)});
        }
    }

    /**
     * Map serial open failures to user-facing connectError where useful.
     * @param {Error} openErr - error from SerialPort.open.
     */
    /**
     * True when a serialport error is usually a transient reset/glitch, not a user unplug.
     * @param {Error} error
     * @returns {boolean}
     */
    _isTransientSerialError (error) {
        const msg = (error && error.message) ? error.message : String(error);
        return /disconnected|not open|FILE_NOT_FOUND|Operation aborted|EBADF|ENOENT|Access denied|Unknown error code 31|Resource temporarily unavailable|EAGAIN|Framing|Break|Overrun|Parity/i.test(msg);
    }

    /**
     * Try reconnect after a brief port close or driver error (e.g. hot-plugging I2C sensors).
     */
    _scheduleTransientRecovery (reason) {
        if (this.isInDisconnect || this._recoveringTransientClose || this._intentionalDisconnect) {
            return;
        }
        if (!this.peripheralParams || this.tool || this._postFlashReconnecting) {
            return;
        }
        if (Date.now() < this._unplugGraceUntil) {
            return;
        }
        if (this.connectStateDetectorTimer) {
            clearInterval(this.connectStateDetectorTimer);
            this.connectStateDetectorTimer = null;
        }
        this._unplugClosedStreak = 0;
        const label = reason ? `: ${reason}` : '';
        console.warn(`[serialport] scheduling transient reconnect${label}`);
        this._recoverFromTransientClose();
    }

    _notifyConnectOpenFailure (openErr) {
        const msg = (openErr && openErr.message) ? openErr.message : String(openErr);
        if (msg.includes('Access denied')) {
            this.sendRemoteRequest('connectError', {message: 'Access denied'});
        }
        if (msg.includes('Permission denied')) {
            this.sendRemoteRequest('connectError', {message: 'Permission denied'});
        }
        if (msg.includes('Open (SetCommState): Unknown error code 31')) {
            this.sendRemoteRequest('connectError', {message: 'Unknown error code 31'});
        }
        if (msg.includes('Resource temporarily unavailable') || msg.includes('EAGAIN')) {
            this.sendRemoteRequest('connectError', {message: 'Resource temporarily unavailable'});
        }
    }

    /**
     * Why: baud-rate changes can arrive before connect finishes; warn the VM
     * without rejecting the RPC (rejection disconnects the peripheral).
     * @param {string} title - short operation label.
     * @param {string} detail - human-readable reason.
     */
    _warnSerialOperationSkipped (title, detail) {
        const message = `${title}: ${detail}`;
        console.warn(`[serialport] ${message}`);
        this.sendRemoteRequest('connectError', {message});
    }

    /**
     * Build a user-facing label from SerialPort.list() metadata.
     * Prefer usb-id lookup, then friendlyName/manufacturer/serialNumber.
     * @param {object} device serialport entry.
     * @param {string} pnpid normalized USB VID/PID key.
     * @returns {string} display label for connection modal.
     */
    _formatDiscoveredName (device, pnpid) {
        const mapped = usbId[pnpid];
        const friendly = device.friendlyName || device.manufacturer || device.serialNumber;
        const baseName = mapped || friendly || 'Unknown device';
        return `${baseName} (${device.path})`;
    }

    /**
     * Build discovery metadata object consumed by VM/GUI.
     * @param {object} device serialport entry.
     * @param {string} pnpid normalized USB VID/PID key.
     * @param {string} name resolved display name.
     * @returns {object} normalized peripheral metadata.
     */
    _buildDiscoveryPayload (device, pnpid, name) {
        const vendorId = String(device.vendorId || '').toUpperCase() || null;
        const productId = String(device.productId || '').toUpperCase() || null;
        const details = {
            path: device.path || null,
            pnpId: pnpid || null,
            vendorId,
            productId,
            manufacturer: device.manufacturer || null,
            serialNumber: device.serialNumber || null,
            friendlyName: device.friendlyName || null
        };
        const detailSuffix = [];
        if (details.manufacturer) detailSuffix.push(details.manufacturer);
        if (details.serialNumber) detailSuffix.push(`#${details.serialNumber}`);
        if (details.vendorId && details.productId) {
            detailSuffix.push(`VID:${details.vendorId}/PID:${details.productId}`);
        }
        return {
            peripheralId: device.path,
            name: detailSuffix.length > 0 ? `${name} - ${detailSuffix.join(' | ')}` : name,
            ...details
        };
    }

    discover (params) {
        if (this.services) {
            throw new Error('cannot discover when connected');
        }
        const {filters} = params;
        if (!Array.isArray(filters.pnpid) || filters.pnpid.length < 1) {
            throw new Error('discovery request must include filters');
        }
        this.reportedPeripherals = {};
        this.reportedPeripheralSignatures = {};

        this.peripheralsScanorTimer = setInterval(() => {
            SerialPort.list().then(peripheral => {
                this.onAdvertisementReceived(peripheral, filters);
            });
        }, 100);
    }

    onAdvertisementReceived (peripheral, filters) {
        if (peripheral) {
            const currentScanPaths = new Set();
            peripheral.forEach(device => {
                const vendorId = String(device.vendorId || '').toUpperCase();
                const productId = String(device.productId || '').toUpperCase();
                const pnpid = `USB\\VID_${vendorId}&PID_${productId}`;

                if (filters.pnpid.includes('*') || filters.pnpid.includes(pnpid)) {
                    if (!this._isEsp32S3OtgDevice(device)) {
                        return;
                    }
                    currentScanPaths.add(device.path);
                    const name = this._formatDiscoveredName(device, pnpid);
                    const payload = this._buildDiscoveryPayload(device, pnpid, name);
                    this.reportedPeripherals[device.path] = device;
                    const signature = JSON.stringify({
                        ...payload
                    });
                    if (this.reportedPeripheralSignatures[device.path] === signature) {
                        return;
                    }
                    this.reportedPeripheralSignatures[device.path] = signature;
                    console.info(
                        `[discover] name="${name}", port=${device.path}, vid=${vendorId || 'N/A'}, pid=${productId || 'N/A'}`
                    );
                    this.sendRemoteRequest('didDiscoverPeripheral', payload);
                }
            });

            Object.keys(this.reportedPeripheralSignatures).forEach(path => {
                if (!currentScanPaths.has(path)) {
                    delete this.reportedPeripheralSignatures[path];
                }
            });
        }
    }

    /**
     * @param {boolean} [silentReconnectAttempt] - When true with isConnectAfterUpload, do not notify VM of failures (internal retries).
     */
    connect (params, isConnectAfterUpload = false, silentReconnectAttempt = false) {
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.isOpen === true) {
                return reject(new Error('already connected to peripheral'));
            }
            const {peripheralId, peripheralConfig} = params;

            const peripheral = this.reportedPeripherals[peripheralId];
            if (!peripheral) {
                return reject(new Error(`invalid peripheral ID: ${peripheralId}`));
            }
            if (this.peripheralsScanorTimer) {
                clearInterval(this.peripheralsScanorTimer);
                this.peripheralsScanorTimer = null;
            }
            const port = new SerialPort({
                path: peripheral.path,
                baudRate: peripheralConfig.config.baudRate,
                dataBits: peripheralConfig.config.dataBits,
                stopBits: peripheralConfig.config.stopBits,
                autoOpen: false
            });
            const rts = (typeof peripheralConfig.config.rts === 'undefined') ? true : peripheralConfig.config.rts;
            const dtr = (typeof peripheralConfig.config.dtr === 'undefined') ? true : peripheralConfig.config.dtr;

            try {
                port.open(openErr => {
                    if (openErr) {
                        if (isConnectAfterUpload === true && !silentReconnectAttempt) {
                            this.sendRemoteRequest('uploadError', {
                                message: ansi.red + openErr.message
                            });
                            this.sendRemoteRequest('peripheralUnplug', null);
                        }
                        if (!silentReconnectAttempt) {
                            this._notifyConnectOpenFailure(openErr);
                        }
                        return reject(new Error(openErr));
                    }

                    port.set({rts: rts, dtr: dtr}, setErr => {
                        if (setErr) {
                            if (isConnectAfterUpload === true && !silentReconnectAttempt) {
                                this.sendRemoteRequest('peripheralUnplug', null);
                            }
                            return reject(new Error(setErr));
                        }

                        this.peripheral = port;
                        this.peripheralParams = params;
                        this._intentionalDisconnect = false;

                        this._unplugClosedStreak = 0;
                        this._unplugGraceUntil = Date.now() + (
                            isConnectAfterUpload ?
                                POST_FLASH_OPEN_UNPLUG_GRACE_MS :
                                POST_OPEN_UNPLUG_GRACE_MS
                        );

                        // Scan COM status — debounced so ESP reset / brief driver glitches do not drop the session.
                        this.connectStateDetectorTimer = setInterval(() => {
                            if (Date.now() < this._unplugGraceUntil) {
                                return;
                            }
                            if (!this.peripheral) {
                                return;
                            }
                            if (this.peripheral.isOpen === false) {
                                this._unplugClosedStreak++;
                                if (this._unplugClosedStreak >= PERIPHERAL_UNPLUG_CLOSED_STREAK) {
                                    clearInterval(this.connectStateDetectorTimer);
                                    this.connectStateDetectorTimer = null;
                                    this._unplugClosedStreak = 0;
                                    this._scheduleTransientRecovery('port closed');
                                }
                            } else {
                                this._unplugClosedStreak = 0;
                            }
                        }, PERIPHERAL_UNPLUG_CHECK_INTERVAL);

                        // Only when the receiver function is set, can isopen detect that the device is pulled out
                        // A strange features of npm serialport package
                        port.on('data', rev => {
                            this.onMessageCallback(rev);
                        });

                        port.on('close', () => {
                            this._scheduleTransientRecovery('close event');
                        });

                        port.on('error', error => {
                            console.warn('OpenBlock Link serial error:', error);
                            if (this.isInDisconnect || this._recoveringTransientClose) {
                                return;
                            }
                            const msg = (error && error.message) ? error.message : String(error);
                            if (this._isTransientSerialError(error) ||
                                !this.peripheral ||
                                this.peripheral.isOpen === false) {
                                this._scheduleTransientRecovery(msg);
                                return;
                            }
                            // Port still reports open — log and keep session (avoid false unplug on noise).
                            this.sendstd(
                                `${ansi.yellow_dark}[serialport] Serial warning (still connected): ${msg}\n`
                            );
                        });

                        resolve();
                    });
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Recover serial session after transient reset (ESP32 reboot / RTC WDT).
     * Falls back to unplug signal only when all retries fail.
     */
    async _recoverFromTransientClose () {
        if (this._recoveringTransientClose || this.isInDisconnect) {
            return;
        }
        this._recoveringTransientClose = true;
        try {
            if (!this.peripheralParams) {
                throw new Error('Missing reconnect params');
            }
            const path = this.peripheralParams.peripheralId;
            let lastErr = null;
            await this.disconnect().catch(() => {});
            for (let attempt = 0; attempt < TRANSIENT_RECONNECT_ATTEMPTS; attempt++) {
                try {
                    if (path) {
                        await this._refreshReportedPeripheralByPath(path);
                    }
                    await this.connect(this.peripheralParams, true, true);
                    this.sendstd(
                        `${ansi.yellow_dark}[serialport] Recovered connection after transient reset.\n`
                    );
                    return;
                } catch (err) {
                    lastErr = err;
                    if (attempt < TRANSIENT_RECONNECT_ATTEMPTS - 1) {
                        await delay(TRANSIENT_RECONNECT_DELAY_MS);
                    }
                }
            }
            throw lastErr || new Error('Failed to reconnect after transient close');
        } catch (error) {
            this.sendstd(
                `${ansi.red}[serialport] Connection recovery failed: ${error.message}\n`
            );
            this.sendRemoteRequest('peripheralUnplug', null);
        } finally {
            this._recoveringTransientClose = false;
        }
    }

    onMessageCallback (rev) {
        const params = {
            encoding: 'base64',
            message: rev.toString('base64')
        };
        if (this.isRead) {
            this.sendRemoteRequest('onMessage', params);
        }
        if (this._scanContext) {
            this._feedScanContext(rev);
        }
        try {
            const text = rev.toString('utf8');
            for (const line of text.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed.includes('WINDIFY_MOBILE_')) {
                    this.sendRemoteRequest('mobileUiSerialLine', {line: trimmed});
                }
            }
        } catch (_e) {
            // ignore decode errors on binary chunks
        }
    }

    /**
     * Append a serial chunk to the in-flight scan accumulator and resolve
     * once the buffer contains a balanced JSON object with `devices: Array`.
     * Mirrors the logic in hardware-console.jsx onWebSerialData (lines 904-934).
     * @param {Buffer} rev - chunk delivered by node-serialport.
     */
    _feedScanContext (rev) {
        const ctx = this._scanContext;
        if (!ctx) return;
        let text;
        try {
            text = rev.toString('utf8');
        } catch (err) {
            return;
        }
        ctx.buffer += text;
        if (ctx.buffer.length > SCAN_DEVICES_BUFFER_LIMIT) {
            ctx.buffer = ctx.buffer.slice(-SCAN_DEVICES_BUFFER_LIMIT);
        }
        const startIdx = ctx.buffer.indexOf('{');
        const endIdx = ctx.buffer.lastIndexOf('}');
        if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
            return;
        }
        const candidate = ctx.buffer.substring(startIdx, endIdx + 1);
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        } catch (err) {
            return; // not yet a complete JSON, keep accumulating
        }
        if (!parsed || !Array.isArray(parsed.devices)) {
            return;
        }
        this._resolveScanContext({devices: parsed.devices, raw: parsed});
    }

    /**
     * Tear down the scan accumulator and resolve/reject its waiter.
     * @param {object|null} result - parsed scan response, or null when rejecting.
     * @param {Error} [err] - reject reason.
     */
    _resolveScanContext (result, err) {
        const ctx = this._scanContext;
        if (!ctx) return;
        this._scanContext = null;
        if (ctx.timeout) {
            clearTimeout(ctx.timeout);
            ctx.timeout = null;
        }
        if (err) {
            ctx.reject(err);
        } else {
            ctx.resolve(result);
        }
    }

    updateBaudrate (params) {
        return new Promise(resolve => {
            if (this.isInDisconnect) {
                return resolve();
            }
            if (!this.peripheral || this.peripheral.isOpen !== true) {
                this._warnSerialOperationSkipped(
                    'Baud rate update skipped',
                    'serial port is not open'
                );
                return resolve();
            }
            const config = this.peripheralParams &&
                this.peripheralParams.peripheralConfig &&
                this.peripheralParams.peripheralConfig.config;
            if (!config) {
                this._warnSerialOperationSkipped(
                    'Baud rate update skipped',
                    'device connection is not ready'
                );
                return resolve();
            }
            if (!params || typeof params.baudRate === 'undefined') {
                this._warnSerialOperationSkipped(
                    'Baud rate update skipped',
                    'missing baud rate'
                );
                return resolve();
            }

            config.baudRate = params.baudRate;
            this.peripheral.update(params, err => {
                if (err) {
                    this._warnSerialOperationSkipped(
                        'Baud rate update failed',
                        err.message || String(err)
                    );
                    return resolve();
                }

                const rts = (typeof config.rts === 'undefined') ? true : config.rts;
                const dtr = (typeof config.dtr === 'undefined') ? true : config.dtr;

                // After update baudrate, the rts and dtr will be automatically modified,
                // we have to set them again.
                this.peripheral.set({rts: rts, dtr: dtr}, setErr => {
                    if (setErr) {
                        this._warnSerialOperationSkipped(
                            'Baud rate update failed',
                            setErr.message || String(setErr)
                        );
                        return resolve();
                    }
                    return resolve();
                });
            });

        });
    }

    write (params) {
        return new Promise((resolve, reject) => {
            const {message, encoding} = params;
            const buffer = new Buffer.from(message, encoding);

            try {
                if (!this.isInDisconnect) {
                    this.peripheral.write(buffer, 'binary', err => {
                        if (err) {
                            return reject(new Error(`Error while attempting to write: ${err.message}`));
                        }
                    });
                    this.peripheral.drain(() => resolve(buffer.length));
                }
                return resolve();
            } catch (err) {
                return reject(err);
            }
        });
    }

    read () {
        this.isRead = true;
    }

    /**
     * Why: after flashing, the device resets and the serial session is reopened.
     * Enabling read immediately ensures runtime logs are streamed without
     * requiring the client to re-issue a separate read command.
     */
    _resumeReadAfterFlashReconnect () {
        this.read();
        this.sendstd(`${ansi.clear}Serial log stream resumed after flash reconnect.\n`);
    }

    disconnect (intentional = false) {
        this.isInDisconnect = true;
        if (intentional) {
            this._intentionalDisconnect = true;
        }
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.isOpen === true) {
                if (this.connectStateDetectorTimer) {
                    clearInterval(this.connectStateDetectorTimer);
                    this.connectStateDetectorTimer = null;
                }
                const peripheral = this.peripheral;
                try {
                    peripheral.pause();
                    // clear all cache data
                    peripheral.flush(() => {
                        peripheral.close(error => {
                            if (error) {
                                this.isInDisconnect = false;
                                if (!intentional) {
                                    this._intentionalDisconnect = false;
                                }
                                return reject(Error(error));
                            }
                            this.peripheral = null;
                            if (intentional) {
                                this.peripheralParams = null;
                            }
                            this.isInDisconnect = false;
                            return resolve();
                        });
                    });
                } catch (err) {
                    this.isInDisconnect = false;
                    if (!intentional) {
                        this._intentionalDisconnect = false;
                    }
                    return reject(err);
                }
            } else {
                this.peripheral = null;
                if (intentional) {
                    this.peripheralParams = null;
                }
                return resolve();
            }
        });
    }

    async upload (params) {
        const {message, config, encoding} = params;
        const code = Buffer.from(message, encoding).toString();

        this.tool = new Arduino(this.peripheral.path, config, this.userDataPath,
            this.toolsPath, this.sendstd.bind(this), this.sendRemoteRequest.bind(this));

        try {
            this._emitSetUploadAbortEnabled(true);
            const exitCode = await this.tool.build(code);
            if (exitCode === 'Success') {
                try {
                    this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                    await this.disconnect();
                    this.sendstd(`${ansi.clear}Disconnected successfully, flash program starting...\n`);
                    const flashExitCode = await this.tool.flash();
                    try {
                        await this._connectAfterFlashWithRetries();
                        this._resumeReadAfterFlashReconnect();
                    } catch (reconnectErr) {
                        this.sendstd(
                            `${ansi.yellow_dark}[serialport] Flash OK but serial reopen failed: ${reconnectErr.message}. Reconnect manually.\n`
                        );
                        this.sendRemoteRequest('connectError', {
                            message: reconnectErr.message
                        });
                    }
                    this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
                } catch (err) {
                    this.sendRemoteRequest('uploadError', {
                        message: ansi.red + err.message
                    });
                    this.sendRemoteRequest('peripheralUnplug', null);
                }
            } else if (exitCode === 'Aborted') {
                this.sendRemoteRequest('uploadSuccess', {aborted: true});
            }
        } catch (err) {
            this.sendRemoteRequest('uploadError', {
                message: ansi.red + err.message
            });
        } finally {
            this._emitSetUploadAbortEnabled(false);
            this.tool = null;
        }
    }

    async uploadFirmware (params) {
        this.tool = new Arduino(this.peripheral.path, params, this.userDataPath,
            this.toolsPath, this.sendstd.bind(this));
        try {
            this._emitSetUploadAbortEnabled(true);
            this.sendstd(`${ansi.clear}Disconnect serial port\n`);
            await this.disconnect();
            this.sendstd(`${ansi.clear}Disconnected successfully, flash program starting...\n`);
            const flashExitCode = await this.tool.flashRealtimeFirmware();
            await this._connectAfterFlashWithRetries();
            this._resumeReadAfterFlashReconnect();
            this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
        } catch (err) {
            this.sendRemoteRequest('uploadError', {
                message: ansi.red + err.message
            });
        } finally {
            this._emitSetUploadAbortEnabled(false);
            this.tool = null;
        }
    }

    /**
     * Flash a triple of pre-compiled ESP32 bins (bootloader/partitions/firmware)
     * via the bundled esptool binary, then re-establish the serial session.
     * Mirrors hardware-console.jsx flashBinFilesToESP32 (lines 430-622) but
     * server-side over node-serialport.
     *
     * @param {object} params - {chip?, baudrate?, eraseAll?, addresses?, bins:{...}}
     */
    async uploadEsp32Bin (params) {
        if (!this.peripheral && !(this.peripheralParams && this.peripheralParams.peripheralId)) {
            this.sendRemoteRequest('uploadError', {
                message: `${ansi.red}uploadEsp32Bin requires a connected serial peripheral`
            });
            return;
        }
        const peripheralPath = (this.peripheral && this.peripheral.path) ||
            (this.peripheralParams && this.peripheralParams.peripheralId);
        // Drop any pending scan waiter — we are about to release the port.
        if (this._scanContext) {
            this._resolveScanContext(null, new Error('Scan aborted: ESP32 flash starting'));
        }
        this.tool = new Esp32(
            peripheralPath,
            params || {},
            this.userDataPath,
            this.toolsPath,
            this.sendstd.bind(this)
        );
        try {
            this._emitSetUploadAbortEnabled(true);
            this.sendstd(`${ansi.clear}Disconnect serial port\n`);
            await this.disconnect();
            this.sendstd(`${ansi.clear}Disconnected successfully, ESP32 flash starting...\n`);
            const flashExitCode = await this.tool.flashBins((params && params.bins) || params);
            try {
                await this._connectAfterFlashWithRetries();
                this._resumeReadAfterFlashReconnect();
            } catch (reconnectErr) {
                // Reconnect failure is recoverable from the client side; still
                // report the flash result so the GUI can decide what to do.
                this.sendstd(
                    `${ansi.yellow_dark}[esp32] reconnect after flash failed: ${reconnectErr.message}\n`
                );
                this.sendRemoteRequest('peripheralUnplug', null);
            }
            this.sendRemoteRequest('uploadSuccess', {
                aborted: flashExitCode === 'Aborted',
                kind: 'esp32'
            });
        } catch (err) {
            this.sendRemoteRequest('uploadError', {
                message: ansi.red + err.message
            });
            this.sendRemoteRequest('peripheralUnplug', null);
        } finally {
            try {
                if (this.tool && typeof this.tool.cleanup === 'function') {
                    this.tool.cleanup();
                }
            } catch (cleanupErr) {
                this.sendstd(
                    `${ansi.yellow_dark}[esp32] cleanup warning: ${cleanupErr.message}\n`
                );
            }
            this._emitSetUploadAbortEnabled(false);
            this.tool = null;
        }
    }

    /**
     * Send a discovery command (default `scan`) to the connected peripheral,
     * accumulate incoming bytes, and resolve when a balanced JSON
     * `{devices:[...]}` object arrives. Mirrors hardware-console.jsx scan
     * loop at lines 566-607.
     *
     * @param {object} [params] - {command, terminator, timeoutMs}
     * @returns {Promise<object>} resolves with `{devices, raw}` parsed from the firmware's JSON reply.
     */
    scanDevices (params) {
        const opts = params || {};
        const command = typeof opts.command === 'string' ? opts.command : 'scan';
        const terminator = typeof opts.terminator === 'string' ? opts.terminator : '\n';
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : SCAN_DEVICES_DEFAULT_TIMEOUT_MS;

        return new Promise((resolve, reject) => {
            if (!this.peripheral || this.peripheral.isOpen !== true) {
                return reject(new Error('scanDevices requires an open serial peripheral'));
            }
            if (this._scanContext) {
                return reject(new Error('scanDevices already in progress'));
            }

            const ctx = {
                buffer: '',
                resolve,
                reject,
                timeout: null
            };
            ctx.timeout = setTimeout(() => {
                if (this._scanContext === ctx) {
                    this._resolveScanContext(null, new Error(`scan timeout after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            this._scanContext = ctx;

            // Make sure existing read flag does not block the scan parser:
            // _feedScanContext runs unconditionally when a context is active.
            const payload = command + terminator;
            this.write({encoding: 'utf8', message: payload}).catch(err => {
                if (this._scanContext === ctx) {
                    this._resolveScanContext(null, new Error(`scan write failed: ${err.message}`));
                }
            });
        });
    }

    async abortUpload () {
        if (this.tool !== null) {
            this.tool.abortUpload();
        }
    }

    /**
     * Stream compiler/uploader output to the client; optional flash progress 0..1.
     * @param {string} message - text chunk (may include ansi).
     * @param {number} [progress] - optional normalized progress for GUI bars.
     */
    sendstd (message, progress) {
        if (this._socket) {
            const payload = {message};
            if (typeof progress === 'number' && !Number.isNaN(progress)) {
                payload.progress = progress;
            }
            this.sendRemoteRequest('uploadStdout', payload);
        }
    }

    dispose () {
        if (this._scanContext) {
            this._resolveScanContext(null, new Error('Session disposed'));
        }
        this.disconnect();
        super.dispose();
        this.socket = null;
        this.peripheral = null;
        this.peripheralParams = null;
        this.services = null;
        this.reportedPeripherals = {};
        if (this.connectStateDetectorTimer) {
            clearInterval(this.connectStateDetectorTimer);
            this.connectStateDetectorTimer = null;
        }
        if (this.peripheralsScanorTimer) {
            clearInterval(this.peripheralsScanorTimer);
            this.peripheralsScanorTimer = null;
        }
    }
}

module.exports = SerialportSession;
