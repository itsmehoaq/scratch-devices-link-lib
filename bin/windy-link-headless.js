#!/usr/bin/env node

const clc = require('cli-color');
const startLinkServer = require('../src/start-link-server');

process.on('uncaughtException', err => {
    console.error(clc.red(`[link] uncaught exception: ${err.stack || err}`));
});

process.on('unhandledRejection', err => {
    console.error(clc.red(`[link] unhandled rejection: ${err && err.stack ? err.stack : err}`));
});

startLinkServer({
    onError: err => {
        console.error(err);
        process.exit(1);
    }
});
