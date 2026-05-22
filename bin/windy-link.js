#!/usr/bin/env node

const path = require('path');
const clc = require('cli-color');
const OpenBlockLink = require('../src/index');
const {
    resolveRuntimeBaseDir,
    resolveUserDataPath,
    validateToolsLayout
} = require('../src/lib/runtime-paths');

const baseDir = resolveRuntimeBaseDir();
const userDataPath = resolveUserDataPath(baseDir);
const toolsPath = process.env.WINDY_TOOLS_PATH ||
    path.join(baseDir, 'tools');

process.on('uncaughtException', err => {
    console.error(clc.red(`[link] uncaught exception: ${err.stack || err}`));
});

process.on('unhandledRejection', err => {
    console.error(clc.red(`[link] unhandled rejection: ${err && err.stack ? err.stack : err}`));
});

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
        '[link] place tools/ and firmwares/ beside the exe, then restart.'
    ));
}

const link = new OpenBlockLink(userDataPath, toolsPath);

link.listen();

link.on('ready', () => {
    console.info('Windy Link server is ready.');
});

link.on('port-in-use', () => {
    console.info('Port is already in use by another Windy Link server.');
});

link.on('error', err => {
    console.error(err);
    process.exit(1);
});
