#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Manual end-to-end test for the new ESP32 .bin flash + scan flow.
 *
 * Usage:
 *   node test/test-esp32-flash.js \
 *     --port COM5 \
 *     --bootloader path/to/bootloader.bin \
 *     --partitions path/to/partitions.bin \
 *     --firmware   path/to/firmware.bin \
 *     [--vid 303A] [--pid 1001] \
 *     [--baudrate 921600] [--chip esp32s3] [--scan-only]
 *
 * Requirements:
 *   - link server running locally (npm start) on ws://127.0.0.1:11337
 *   - the ESP32-S3 plugged in and listed by SerialPort.list().
 *   - npm install ws (peer dep already in package.json)
 *
 * The script:
 *   1) opens a JSON-RPC session at /winblock/serialport
 *   2) discovers the requested port and connects
 *   3) (unless --scan-only) sends `uploadEsp32Bin` with the three bins
 *   4) waits for `uploadSuccess`
 *   5) sends `scanDevices` and prints the parsed devices array
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const args = parseArgs(process.argv.slice(2));
if (!args.port) {
    console.error('Missing --port <COMx>');
    process.exit(2);
}
const scanOnly = Boolean(args['scan-only']);
if (!scanOnly) {
    for (const k of ['bootloader', 'partitions', 'firmware']) {
        if (!args[k]) {
            console.error(`Missing --${k} <path>`);
            process.exit(2);
        }
    }
}

const wsUrl = args.url || 'ws://127.0.0.1:11337/winblock/serialport';
const ws = new WebSocket(wsUrl);

const pending = new Map();
let nextId = 1;

ws.on('open', async () => {
    console.log(`[ws] connected to ${wsUrl}`);
    try {
        const filters = buildPnpFilters(args);
        await call('discover', {filters});
        const peripheralId = await waitForDiscovery(args.port, 5000);
        console.log(`[ws] discovered ${peripheralId}`);
        await call('connect', {
            peripheralId,
            peripheralConfig: {
                config: {
                    baudRate: parseInt(args.consoleBaud || args.baudrate || '115200', 10),
                    dataBits: 8,
                    stopBits: 1,
                    rts: true,
                    dtr: true
                }
            }
        });
        console.log('[ws] connected to peripheral');

        if (!scanOnly) {
            const bins = {
                bootloader: encodeBin(args.bootloader),
                partitions: encodeBin(args.partitions),
                firmware: encodeBin(args.firmware)
            };
            console.log('[ws] sending uploadEsp32Bin...');
            const upload = waitForNotification('uploadSuccess', 120000);
            await call('uploadEsp32Bin', {
                chip: args.chip || 'esp32s3',
                baudrate: parseInt(args.baudrate || '921600', 10),
                bins
            });
            const result = await upload;
            console.log('[ws] uploadSuccess:', result);
        }

        console.log('[ws] sending scanDevices...');
        const scan = await call('scanDevices', {
            command: args.scanCommand || 'scan',
            terminator: '\n',
            timeoutMs: parseInt(args.scanTimeout || '10000', 10)
        });
        console.log('[ws] scanDevices result:');
        console.log(JSON.stringify(scan, null, 2));
        process.exit(0);
    } catch (err) {
        console.error('[ws] failure:', err && err.message ? err.message : err);
        process.exit(1);
    }
});

ws.on('message', raw => {
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch (err) {
        return;
    }
    if (msg.id && pending.has(msg.id)) {
        const {resolve, reject} = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
            reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
        } else {
            resolve(msg.result);
        }
        return;
    }
    if (msg.method) {
        handleNotification(msg);
    }
});

ws.on('close', () => {
    console.log('[ws] closed');
});

ws.on('error', err => {
    console.error('[ws] error:', err.message);
});

const notificationWaiters = [];
const discoveredPaths = new Map();

function handleNotification (msg) {
    switch (msg.method) {
    case 'didDiscoverPeripheral':
        if (msg.params && msg.params.peripheralId) {
            discoveredPaths.set(msg.params.peripheralId, msg.params);
        }
        break;
    case 'uploadStdout':
        if (msg.params && msg.params.message) {
            process.stdout.write(stripAnsi(msg.params.message));
            if (typeof msg.params.progress === 'number') {
                process.stdout.write(` [${Math.round(msg.params.progress * 100)}%]`);
            }
        }
        break;
    default:
        break;
    }
    for (let i = notificationWaiters.length - 1; i >= 0; i--) {
        const waiter = notificationWaiters[i];
        if (waiter.method === msg.method) {
            notificationWaiters.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(msg.params);
        }
    }
}

function call (method, params) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {resolve, reject});
        ws.send(JSON.stringify({jsonrpc: '2.0', id, method, params}));
    });
}

function waitForNotification (method, timeoutMs) {
    return new Promise((resolve, reject) => {
        const waiter = {method, resolve};
        waiter.timer = setTimeout(() => {
            const idx = notificationWaiters.indexOf(waiter);
            if (idx !== -1) notificationWaiters.splice(idx, 1);
            reject(new Error(`Timed out waiting for ${method}`));
        }, timeoutMs);
        notificationWaiters.push(waiter);
    });
}

function waitForDiscovery (port, timeoutMs) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            for (const [pid] of discoveredPaths) {
                if (pid.toUpperCase() === port.toUpperCase()) {
                    return resolve(pid);
                }
            }
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`Discovery timeout for ${port}`));
            }
            setTimeout(tick, 200);
        };
        tick();
    });
}

function encodeBin (filePath) {
    const abs = path.resolve(filePath);
    const data = fs.readFileSync(abs).toString('base64');
    return {encoding: 'base64', data};
}

function buildPnpFilters (cli) {
    if (cli.vid && cli.pid) {
        return {pnpid: [`USB\\VID_${cli.vid.toUpperCase()}&PID_${cli.pid.toUpperCase()}`]};
    }
    return {pnpid: ['*']};
}

function stripAnsi (s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseArgs (argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                out[key] = true;
            } else {
                out[key] = next;
                i++;
            }
        }
    }
    return out;
}
