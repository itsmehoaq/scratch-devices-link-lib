const {spawn} = require('child_process');

const DEFAULT_STARTUP_URL = 'https://steam.windify.edu.vn/';

/**
 * Resolve startup URL from env with Future Academy default.
 * @returns {string}
 */
const resolveStartupUrl = () => {
    const fromEnv = process.env.WINDY_STARTUP_URL;
    if (fromEnv && String(fromEnv).trim()) {
        return String(fromEnv).trim();
    }
    return DEFAULT_STARTUP_URL;
};

/**
 * Whether the packaged app should open the startup URL in a browser.
 * @returns {boolean}
 */
const shouldOpenStartupUrl = () => {
    const flag = process.env.WINDY_OPEN_STARTUP_URL;
    if (flag === '0' || flag === 'false') {
        return false;
    }
    return true;
};

/**
 * Why: Future Academy launches the web GUI after the local link server is ready.
 * @param {string} url absolute URL to open.
 */
const openUrl = url => {
    if (!url) {
        return;
    }
    const platform = process.platform;
    let command;
    let args;
    if (platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', url];
    } else if (platform === 'darwin') {
        command = 'open';
        args = [url];
    } else {
        command = 'xdg-open';
        args = [url];
    }
    const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
};

module.exports = {
    DEFAULT_STARTUP_URL,
    resolveStartupUrl,
    shouldOpenStartupUrl,
    openUrl
};
