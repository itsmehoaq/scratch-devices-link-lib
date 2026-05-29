const path = require('path');
const {app, BrowserWindow, ipcMain, Tray, Menu} = require('electron');

const logBuffer = require('./lib/log-buffer');
logBuffer.installLogCapture();

const startLinkServer = require('../src/start-link-server');
const {listSerialDevices} = require('../src/lib/serial-device-list');
const {
    resolveStartupUrl,
    openUrl
} = require('../src/lib/open-url');

const DEFAULT_PORT = 11337;
const DEFAULT_HOST = '127.0.0.1';

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let consoleWindow = null;
/** @type {Tray | null} */
let tray = null;
let serverReady = false;

logBuffer.subscribe(entry => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
        consoleWindow.webContents.send('console:entry', entry);
    }
});

process.env.WINDY_OPEN_STARTUP_URL = '0';

const getGuiDir = () => path.join(__dirname);

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 680,
        height: 720,
        minWidth: 560,
        minHeight: 600,
        show: false,
        frame: false,
        resizable: true,
        backgroundColor: '#0e69b3',
        icon: path.join(__dirname, '..', 'assets', 'FutureAcademy.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.loadFile(path.join(getGuiDir(), 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('close', event => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
};

const openAppConsole = () => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
        consoleWindow.show();
        consoleWindow.focus();
        return;
    }

    consoleWindow = new BrowserWindow({
        width: 720,
        height: 480,
        minWidth: 480,
        minHeight: 280,
        title: 'Future Academy — Console',
        backgroundColor: '#0d1117',
        autoHideMenuBar: true,
        icon: path.join(__dirname, '..', 'assets', 'FutureAcademy.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'console-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    consoleWindow.loadFile(path.join(getGuiDir(), 'console.html'));
    consoleWindow.on('closed', () => {
        consoleWindow = null;
    });
};

const createTray = () => {
    tray = new Tray(path.join(__dirname, '..', 'assets', 'FutureAcademy.ico'));
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Mở Future Academy',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                }
            }
        },
        {
            label: 'Mở trình duyệt',
            click: () => openUrl(resolveStartupUrl())
        },
        {
            label: 'Console',
            click: () => openAppConsole()
        },
        {type: 'separator'},
        {
            label: 'Thoát',
            click: () => {
                app.isQuiting = true;
                app.quit();
            }
        }
    ]);
    tray.setToolTip('Future Academy Link');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
        }
    });
};

app.whenReady().then(() => {
    startLinkServer({
        onReady: () => {
            serverReady = true;
        },
        onPortInUse: () => {
            serverReady = true;
        },
        onError: err => {
            console.error(err);
        }
    });

    createWindow();
    createTray();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else if (mainWindow) {
            mainWindow.show();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // Keep link server running in tray on Windows.
    }
});

app.on('before-quit', () => {
    app.isQuiting = true;
});

ipcMain.handle('devices:list', async () => {
    try {
        const devices = await listSerialDevices();
        return {devices, error: null};
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.error('[gui] devices:list failed:', message);
        return {devices: [], error: message};
    }
});

ipcMain.handle('server:status', () => ({
    ready: serverReady,
    url: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
}));

ipcMain.handle('app:openWebsite', () => {
    openUrl(resolveStartupUrl());
});

ipcMain.handle('app:openConsole', () => {
    openAppConsole();
});

ipcMain.handle('console:getHistory', () => logBuffer.getEntries());

ipcMain.handle('console:clear', () => {
    logBuffer.clearEntries();
});

ipcMain.on('window:minimize', () => {
    if (mainWindow) {
        mainWindow.hide();
    }
});

ipcMain.on('window:close', () => {
    if (mainWindow) {
        mainWindow.hide();
    }
});
