const clc = require('cli-color');
const OpenBlockLink = require('./index');
const {
    resolveRuntimeBaseDir,
    resolveUserDataPath,
    resolveToolsPath,
    validateToolsLayout
} = require('./lib/runtime-paths');

/**
 * Boot the Windy Link HTTP/WebSocket server (shared by CLI and desktop GUI).
 * @param {object} [hooks] lifecycle callbacks.
 * @param {Function} [hooks.onReady] called when listen succeeds.
 * @param {Function} [hooks.onPortInUse] called when port is used by same server.
 * @param {Function} [hooks.onError] called on fatal listen error.
 * @returns {{link: OpenBlockLink, baseDir: string, toolsPath: string, userDataPath: string}} runtime
 */
const startLinkServer = (hooks = {}) => {
    const baseDir = resolveRuntimeBaseDir();
    const userDataPath = resolveUserDataPath(baseDir);
    const toolsPath = resolveToolsPath(baseDir);

    const toolsCheck = validateToolsLayout(toolsPath);
    console.info(`[link] runtime base: ${baseDir}`);
    console.info(`[link] tools path: ${toolsPath}`);
    console.info(`[link] user data: ${userDataPath}`);
    if (!toolsCheck.ok) {
        console.error(clc.red('[link] build/upload tools are missing:'));
        toolsCheck.missing.forEach(item => {
            console.error(clc.red(`  - ${item}`));
        });
        console.error(clc.yellow(
            '[link] reinstall Future Academy or place tools/ beside the exe, then restart.'
        ));
    }

    const link = new OpenBlockLink(userDataPath, toolsPath);
    link.listen();

    link.on('ready', () => {
        console.info('Future Academy link server is ready.');
        if (hooks.onReady) {
            hooks.onReady();
        }
    });

    link.on('port-in-use', () => {
        console.info('Port is already in use by another Windy Link server.');
        if (hooks.onPortInUse) {
            hooks.onPortInUse();
        }
    });

    link.on('error', err => {
        if (hooks.onError) {
            hooks.onError(err);
        }
    });

    return {link, baseDir, toolsPath, userDataPath};
};

module.exports = startLinkServer;
