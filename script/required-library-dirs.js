/**
 * Folder names under tools/Arduino/libraries required for WindyLink compile.
 * Keep in sync with script/libraries.json + Windify (sync-windify-lib.mts).
 */
const fs = require('fs');
const path = require('path');

const toDirName = name => name.replace(/ /g, '_');

/**
 * @param {object} manifest Parsed libraries.json
 * @returns {string[]}
 */
const getRequiredLibraryDirs = manifest => {
    const dirs = [];
    for (const lib of manifest.arduino || []) {
        dirs.push(lib.dirName || toDirName(lib.name));
    }
    for (const lib of manifest.github || []) {
        dirs.push(lib.dirName);
    }
    for (const name of manifest.local || []) {
        dirs.push(name);
    }
    dirs.push('Windify');
    return [...new Set(dirs)];
};

/**
 * @param {string} librariesDir Absolute path to Arduino/libraries
 * @param {string[]} requiredDirs
 * @returns {{ missing: string[], present: string[] }}
 */
const verifyRequiredLibraryDirs = (librariesDir, requiredDirs) => {
    const missing = [];
    const present = [];
    for (const dirName of requiredDirs) {
        const full = path.join(librariesDir, dirName);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
            present.push(dirName);
        } else {
            missing.push(dirName);
        }
    }
    return {missing, present};
};

module.exports = {
    getRequiredLibraryDirs,
    verifyRequiredLibraryDirs,
    toDirName
};
