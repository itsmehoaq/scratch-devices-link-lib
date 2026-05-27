const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL_REGISTRY_KEY = 'HKLM\\Software\\Windify\\Future Academy';

/**
 * Resolve runtime root beside the exe when packaged, repo root in dev.
 * @returns {string}
 */
const resolveRuntimeBaseDir = () => {
    if (process.pkg) {
        return path.dirname(process.execPath);
    }
    return path.resolve(__dirname, '../..');
};

/**
 * Resolve a tool binary with Windows `.exe` handling and absolute paths.
 * @param {string} toolsPath tools root directory.
 * @param {string} relativePath path relative to tools root, without extension.
 * @returns {string} absolute executable path.
 */
const resolveToolBinary = (toolsPath, relativePath) => {
    const basePath = path.join(toolsPath, relativePath);
    if (os.platform() === 'win32') {
        const exePath = basePath.endsWith('.exe') ? basePath : `${basePath}.exe`;
        if (fs.existsSync(exePath)) {
            return path.resolve(exePath);
        }
    }
    if (fs.existsSync(basePath)) {
        return path.resolve(basePath);
    }
    return path.resolve(
        os.platform() === 'win32' && !basePath.endsWith('.exe') ?
            `${basePath}.exe` :
            basePath
    );
};

/**
 * Why: MSI installs to Program Files where normal users cannot write build cache.
 * @param {string} baseDir runtime root beside the exe.
 * @returns {boolean}
 */
const isInstalledInProgramFiles = baseDir => {
    const normalized = path.resolve(baseDir).replace(/\//g, '\\').toLowerCase();
    return normalized.includes('\\program files\\') ||
        normalized.includes('\\program files (x86)\\');
};

/**
 * Resolve writable user data directory for build cache and arduino-cli state.
 * @param {string} baseDir runtime root beside the exe.
 * @returns {string}
 */
const resolveUserDataPath = baseDir => {
    if (process.env.WINDY_USER_DATA) {
        return process.env.WINDY_USER_DATA;
    }
    if (process.pkg || isInstalledInProgramFiles(baseDir)) {
        const localAppData = process.env.LOCALAPPDATA ||
            path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'WindyLink');
    }
    return path.join(baseDir, '.winblockData');
};

/**
 * Read installer registry values written by the Inno Setup package.
 * @returns {{installPath: string|null, toolsPath: string|null}|null}
 */
const readInstallRegistry = () => {
    if (os.platform() !== 'win32') {
        return null;
    }

    try {
        const {execFileSync} = require('child_process'); // eslint-disable-line global-require
        const output = execFileSync('reg', ['query', INSTALL_REGISTRY_KEY], {
            encoding: 'utf8',
            windowsHide: true
        });
        const readValue = name => {
            const match = output.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`, 'i'));
            return match && match[1] ? match[1].trim() : null;
        };
        const installPath = readValue('InstallPath');
        const toolsPath = readValue('ToolsPath');
        if (!installPath && !toolsPath) {
            return null;
        }
        return {installPath, toolsPath};
    } catch (err) {
        return null;
    }
};

/**
 * Resolve build/upload tools directory for dev, portable, and installed layouts.
 * @param {string} baseDir runtime root beside the exe.
 * @returns {string}
 */
const resolveToolsPath = baseDir => {
    if (process.env.WINDY_TOOLS_PATH) {
        return process.env.WINDY_TOOLS_PATH;
    }

    const installInfo = readInstallRegistry();
    if (installInfo && installInfo.toolsPath && fs.existsSync(installInfo.toolsPath)) {
        return installInfo.toolsPath;
    }

    return path.join(baseDir, 'tools');
};

/**
 * Why: packaged exe crashes are often caused by missing external tool folders.
 * @param {string} toolsPath tools root directory.
 * @returns {{ok: boolean, arduinoCliPath: string, missing: string[]}}
 */
const validateToolsLayout = toolsPath => {
    const arduinoCliPath = resolveToolBinary(toolsPath, path.join('Arduino', 'arduino-cli'));
    const missing = [];
    if (!fs.existsSync(arduinoCliPath)) {
        missing.push(arduinoCliPath);
    }
    const arduinoRoot = path.join(toolsPath, 'Arduino');
    if (!fs.existsSync(arduinoRoot)) {
        missing.push(arduinoRoot);
    }
    return {
        ok: missing.length === 0,
        arduinoCliPath,
        missing
    };
};

module.exports = {
    resolveRuntimeBaseDir,
    resolveUserDataPath,
    resolveToolsPath,
    readInstallRegistry,
    resolveToolBinary,
    validateToolsLayout
};
