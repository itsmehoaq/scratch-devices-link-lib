const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const sleep = ms => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        // busy wait — keeps script synchronous for npm callers
    }
};

/**
 * Stop packaged Windy Link so dist/ and app.asar are not locked during rebuilds.
 */
const stopRunningWindyLink = () => {
    if (process.platform !== 'win32') {
        return;
    }
    spawnSync('taskkill', ['/IM', 'WindyLink.exe', '/F'], {
        stdio: 'ignore',
        windowsHide: true
    });
    sleep(400);
};

/**
 * Remove or rename aside a directory that may be locked on Windows.
 * @param {string} targetDir absolute path to remove.
 * @param {string} label log label.
 * @returns {boolean} true when target does not exist or was cleared.
 */
const cleanLockedDir = (targetDir, label) => {
    if (!fs.existsSync(targetDir)) {
        return true;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            fs.rmSync(targetDir, {recursive: true, force: true});
            return true;
        } catch (err) {
            if (err.code !== 'EPERM' && err.code !== 'EBUSY') {
                throw err;
            }
            if (attempt < 3) {
                console.warn(`[${label}] locked, retry ${attempt}/3…`);
                sleep(800);
            }
        }
    }

    const parent = path.dirname(targetDir);
    const staleName = `${path.basename(targetDir)}.stale-${Date.now()}`;
    const stalePath = path.join(parent, staleName);
    try {
        fs.renameSync(targetDir, stalePath);
        console.warn(`[${label}] moved locked folder to ${staleName}`);
        return true;
    } catch (err) {
        return false;
    }
};

module.exports = {
    sleep,
    stopRunningWindyLink,
    cleanLockedDir
};
