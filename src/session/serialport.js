const {SerialPort} = require('serialport');
const ansi = require('ansi-string');

const Session = require('./session');
const Arduino = require('../upload/arduino');
const usbId = require('../lib/usb-id');

const PERIPHERAL_UNPLUG_CHECK_INTERVAL = 100;
/** Treat as unplug only after this many consecutive polls see the port closed. */
const PERIPHERAL_UNPLUG_CLOSED_STREAK = 5;
/** Ignore transient close/reboot gaps right after the port is opened (e.g. ESP32 RTC WDT reset). */
const POST_OPEN_UNPLUG_GRACE_MS = 2500;

const POST_FLASH_RECONNECT_INITIAL_DELAY_MS = 600;
const POST_FLASH_RECONNECT_ATTEMPTS = 12;
const POST_FLASH_RECONNECT_RETRY_DELAY_MS = 450;

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
    }

    /**
     * Refresh cached discovery entry for a COM path (needed after flash when the device resets).
     * @param {string} path - peripheralId / SerialPort path.
     */
    async _refreshReportedPeripheralByPath (path) {
        const list = await SerialPort.list();
        const device = list.find(d => d.path === path);
        if (!device) {
            throw new Error(`Serial port not listed yet: ${path}`);
        }
        this.reportedPeripherals[path] = device;
    }

    /**
     * Re-open serial after esptool/arduino-cli reset; OS may need time before the port is free.
     */
    async _connectAfterFlashWithRetries () {
        await delay(POST_FLASH_RECONNECT_INITIAL_DELAY_MS);
        const path = this.peripheralParams && this.peripheralParams.peripheralId;
        let lastErr;
        for (let attempt = 0; attempt < POST_FLASH_RECONNECT_ATTEMPTS; attempt++) {
            try {
                if (path) {
                    await this._refreshReportedPeripheralByPath(path);
                }
                const isLastAttempt = attempt === POST_FLASH_RECONNECT_ATTEMPTS - 1;
                await this.connect(this.peripheralParams, true, !isLastAttempt);
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
            await this.connect(params);
            completion(null, null);
            break;
        case 'disconnect':
            await this.disconnect();
            completion(null, null);
            break;
        case 'updateBaudrate':
            completion(await this.updateBaudrate(params), null);
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
                    currentScanPaths.add(device.path);
                    const name = this._formatDiscoveredName(device, pnpid);
                    this.reportedPeripherals[device.path] = device;
                    const signature = JSON.stringify({
                        name,
                        vendorId: vendorId || null,
                        productId: productId || null,
                        manufacturer: device.manufacturer || null,
                        serialNumber: device.serialNumber || null,
                        path: device.path
                    });
                    if (this.reportedPeripheralSignatures[device.path] === signature) {
                        return;
                    }
                    this.reportedPeripheralSignatures[device.path] = signature;
                    console.info(
                        `[discover] name="${name}", port=${device.path}, vid=${vendorId || 'N/A'}, pid=${productId || 'N/A'}`
                    );
                    this.sendRemoteRequest('didDiscoverPeripheral', {
                        peripheralId: device.path,
                        name: name,
                        vendorId: vendorId || null,
                        productId: productId || null,
                        manufacturer: device.manufacturer || null,
                        serialNumber: device.serialNumber || null,
                        path: device.path
                    });
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

                        this._unplugClosedStreak = 0;
                        this._unplugGraceUntil = Date.now() + POST_OPEN_UNPLUG_GRACE_MS;

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
                                    this.disconnect();
                                    this.sendRemoteRequest('peripheralUnplug', null);
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

                        port.on('error', error => {
                            console.log('OpenBlock Link Error:', error);
                            this.disconnect();
                            this.sendRemoteRequest('peripheralUnplug', null);
                        });

                        resolve();
                    });
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    onMessageCallback (rev) {
        const params = {
            encoding: 'base64',
            message: rev.toString('base64')
        };
        if (this.isRead) {
            this.sendRemoteRequest('onMessage', params);
        }
    }

    updateBaudrate (params) {
        return new Promise((resolve, reject) => {
            if (this.isInDisconnect) {
                return resolve();
            }
            this.peripheralParams.peripheralConfig.config.baudRate = params.baudRate;
            this.peripheral.update(params, err => {
                if (err) {
                    return reject(new Error(`Error while attempting to update baudrate: ${err.message}`));
                }

                const rts = (typeof this.peripheralParams.peripheralConfig.config.rts === 'undefined') ?
                    true : this.peripheralParams.peripheralConfig.config.rts;
                const dtr = (typeof this.peripheralParams.peripheralConfig.config.dtr === 'undefined') ?
                    true : this.peripheralParams.peripheralConfig.config.dtr;

                // After update baudrate, the rts and dtr will be automatically modified,
                // we have to set them again.
                this.peripheral.set({rts: rts, dtr: dtr}, setErr => {
                    if (setErr) {
                        this.sendRemoteRequest('peripheralUnplug', null);
                        return reject(new Error(setErr));
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

    disconnect () {
        this.isInDisconnect = true;
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
                                return reject(Error(error));
                            }
                            this.peripheral = null;
                            this.isInDisconnect = false;
                            return resolve();
                        });
                    });
                } catch (err) {
                    this.isInDisconnect = false;
                    return reject(err);
                }
            } else {
                this.peripheral = null;
                return resolve();
            }
        });
    }

    async upload (params) {
        const {message, config, encoding} = params;
        const code = new Buffer.from(message, encoding).toString();

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
                    await this._connectAfterFlashWithRetries();
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
