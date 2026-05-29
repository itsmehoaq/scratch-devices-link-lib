const fs = require('fs');
const path = require('path');

const POINTER_FILE = 'electron-output.txt';
const DEFAULT_DIR = 'electron';
const GUI_EXE = 'WindyLink.exe';

/**
 * @param {string} outputDir electron-builder output directory.
 * @returns {string|null} win-unpacked path when WindyLink.exe is present.
 */
const getWinUnpackedIfReady = outputDir => {
    const unpacked = path.join(outputDir, 'win-unpacked');
    const exe = path.join(unpacked, GUI_EXE);
    if (fs.existsSync(exe)) {
        return unpacked;
    }
    return null;
};

/**
 * Newest dist/electron* output that contains a packaged GUI.
 * @param {string} repoRoot repository root.
 * @returns {string|null} absolute win-unpacked path.
 */
const findLatestGuiUnpacked = repoRoot => {
    const distDir = path.join(repoRoot, 'dist');
    if (!fs.existsSync(distDir)) {
        return null;
    }

    let bestPath = null;
    let bestMtime = 0;

    const consider = outputDir => {
        const unpacked = getWinUnpackedIfReady(outputDir);
        if (!unpacked) {
            return;
        }
        const mtime = fs.statSync(path.join(unpacked, GUI_EXE)).mtimeMs;
        if (mtime > bestMtime) {
            bestMtime = mtime;
            bestPath = unpacked;
        }
    };

    consider(path.join(distDir, DEFAULT_DIR));

    for (const name of fs.readdirSync(distDir)) {
        if (name.startsWith(`${DEFAULT_DIR}-`)) {
            consider(path.join(distDir, name));
        }
    }

    return bestPath;
};

/**
 * @param {string} repoRoot repository root.
 * @returns {string} absolute path to electron-builder output directory.
 */
const getElectronOutputDir = repoRoot => {
    const unpacked = getGuiUnpackedDir(repoRoot);
    return path.dirname(unpacked);
};

/**
 * @param {string} repoRoot repository root.
 * @returns {string} absolute path to win-unpacked GUI folder.
 */
const getGuiUnpackedDir = repoRoot => {
    const pointerPath = path.join(repoRoot, 'dist', POINTER_FILE);
    if (fs.existsSync(pointerPath)) {
        const written = fs.readFileSync(pointerPath, 'utf8').trim();
        if (written) {
            const fromPointer = getWinUnpackedIfReady(written);
            if (fromPointer) {
                return fromPointer;
            }
        }
    }

    const latest = findLatestGuiUnpacked(repoRoot);
    if (latest) {
        return latest;
    }

    return path.join(repoRoot, 'dist', DEFAULT_DIR, 'win-unpacked');
};

/**
 * Remember which dist/electron* folder the last GUI build used.
 * @param {string} repoRoot repository root.
 * @param {string} outputDir absolute electron-builder output path.
 */
const setElectronOutputPointer = (repoRoot, outputDir) => {
    const distDir = path.join(repoRoot, 'dist');
    fs.mkdirSync(distDir, {recursive: true});
    fs.writeFileSync(
        path.join(distDir, POINTER_FILE),
        path.resolve(outputDir),
        'utf8'
    );
};

module.exports = {
    DEFAULT_DIR,
    GUI_EXE,
    findLatestGuiUnpacked,
    getElectronOutputDir,
    getGuiUnpackedDir,
    getWinUnpackedIfReady,
    setElectronOutputPointer
};
