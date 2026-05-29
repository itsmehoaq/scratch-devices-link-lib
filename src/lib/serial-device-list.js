const {SerialPort} = require('serialport');
const usbId = require('./usb-id');

/**
 * Resolve a human-readable device label (matches serialport session naming).
 * @param {object} device serialport list entry.
 * @returns {string} display name with COM path suffix.
 */
const formatDeviceName = device => {
    const vendorId = String(device.vendorId || '').toUpperCase();
    const productId = String(device.productId || '').toUpperCase();
    const pnpid = vendorId && productId ?
        `USB\\VID_${vendorId}&PID_${productId}` :
        '';
    const mapped = pnpid ? usbId[pnpid] : null;
    const friendly = device.friendlyName || device.manufacturer || device.serialNumber;
    const baseName = mapped || friendly || 'Unknown device';
    return `${baseName} (${device.path})`;
};

/**
 * List serial ports for the desktop device panel (GUI / diagnostics).
 * @returns {Promise<Array<{name: string, path: string, vendorId: string|null, productId: string|null}>>} devices
 */
/**
 * USB serial entries with both VID and PID (excludes virtual COM placeholders).
 * @param {object} device serialport list entry.
 * @returns {boolean}
 */
const hasUsbIds = device => {
    const vendorId = String(device.vendorId || '').trim();
    const productId = String(device.productId || '').trim();
    return Boolean(vendorId && productId);
};

const listSerialDevices = async () => {
    const ports = await SerialPort.list();
    return ports
        .filter(device => device.path && hasUsbIds(device))
        .map(device => {
            const vendorId = String(device.vendorId || '').toUpperCase();
            const productId = String(device.productId || '').toUpperCase();
            return {
                name: formatDeviceName(device),
                path: device.path,
                vendorId,
                productId
            };
        })
        .sort((a, b) => String(a.path).localeCompare(String(b.path), 'en', {numeric: true}));
};

module.exports = {
    formatDeviceName,
    listSerialDevices
};
