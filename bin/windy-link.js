#!/usr/bin/env node

const path = require('path');
const {spawn} = require('child_process');
const clc = require('cli-color');
const startLinkServer = require('../src/start-link-server');
const {
    shouldOpenStartupUrl,
    resolveStartupUrl,
    openUrl
} = require('../src/lib/open-url');

const launchGui = () => {
    let electronPath;
    try {
        electronPath = require('electron');
    } catch (err) {
        console.error(clc.red(
            '[link] GUI requires electron. Run: npm install && npm run start:gui'
        ));
        process.exit(1);
    }
    const mainScript = path.join(__dirname, '..', 'gui', 'main.js');
    const child = spawn(electronPath, [mainScript], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
};

if (process.argv.includes('--gui')) {
    launchGui();
    process.exit(0);
}

process.on('uncaughtException', err => {
    console.error(clc.red(`[link] uncaught exception: ${err.stack || err}`));
});

process.on('unhandledRejection', err => {
    console.error(clc.red(`[link] unhandled rejection: ${err && err.stack ? err.stack : err}`));
});

startLinkServer({
    onReady: () => {
        if (shouldOpenStartupUrl()) {
            const startupUrl = resolveStartupUrl();
            console.info(`[link] opening ${startupUrl}`);
            openUrl(startupUrl);
        }
    },
    onError: err => {
        console.error(err);
        process.exit(1);
    }
});
