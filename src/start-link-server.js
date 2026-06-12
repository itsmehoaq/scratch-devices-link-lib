const clc = require('cli-color');
const OpenBlockLink = require('./index');
const {
    resolveRuntimeBaseDir,
    resolveUserDataPath,
    resolveToolsPath,
    validateToolsLayout
} = require('./lib/runtime-paths');
const {checkToolchain, setupToolchain} = require('./lib/toolchain-setup');

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

    console.info(`[link] runtime base: ${baseDir}`);
    console.info(`[link] tools path: ${toolsPath}`);
    console.info(`[link] user data: ${userDataPath}`);

    const link = new OpenBlockLink(userDataPath, toolsPath);
    link.listen();

    const cliCheck = checkToolchain(toolsPath);
    if (cliCheck.ok) {
        const toolsCheck = validateToolsLayout(toolsPath);
        if (!toolsCheck.ok) {
            console.error(clc.red('[link] some tools are missing:'));
            toolsCheck.missing.forEach(item => console.error(clc.red(`  - ${item}`)));
        }
    } else {
        console.info(clc.yellow('[link] arduino-cli not found — downloading toolchain in background…'));
        link.setupPhase = 'downloading-cli';
        link.setupProgress = 0;
        let lastLoggedPhase = '';
        let lastLoggedPct = -1;
        setupToolchain(toolsPath, ({phase, progress}) => {
            link.setupPhase = phase === 'done' ? null : phase;
            link.setupProgress = progress;
            const pct = Math.round(progress);
            if (phase !== lastLoggedPhase || pct % 10 === 0 || pct === 100) {
                console.info(`[link] toolchain setup: ${phase} ${pct}%`);
                lastLoggedPhase = phase;
                lastLoggedPct = pct;
            }
        }).catch(err => {
            console.error(clc.red(`[link] toolchain setup failed: ${err && err.message}`));
            link.setupPhase = 'error';
        });
    }

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
