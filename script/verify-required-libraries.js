/**
 * Verify tools/Arduino/libraries contains every folder WindyLink needs to compile.
 * Usage: node script/verify-required-libraries.js [--tools-root <path>]
 */
const fs = require('fs');
const path = require('path');
const {
    getRequiredLibraryDirs,
    verifyRequiredLibraryDirs
} = require('./required-library-dirs');

const rawArgs = process.argv.slice(2);
const getFlagValue = name => {
    const index = rawArgs.indexOf(name);
    if (index === -1 || index + 1 >= rawArgs.length) {
        return '';
    }
    return rawArgs[index + 1];
};

const repoRoot = path.resolve(__dirname, '..');
const toolsRoot = getFlagValue('--tools-root') || path.join(repoRoot, 'tools');
const librariesDir = path.join(path.resolve(toolsRoot), 'Arduino', 'libraries');
const manifestPath = path.join(__dirname, 'libraries.json');

if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const requiredDirs = getRequiredLibraryDirs(manifest);
const {missing, present} = verifyRequiredLibraryDirs(librariesDir, requiredDirs);

console.log(`Libraries root: ${librariesDir}`);
console.log(`Required: ${requiredDirs.length}, present: ${present.length}, missing: ${missing.length}`);

if (missing.length > 0) {
    console.error('\nMissing:');
    for (const dirName of missing) {
        console.error(`  - ${dirName}`);
    }
    console.error('\nRun: npm run fetch:libs');
    process.exit(1);
}

console.log('\nAll required libraries present (including Adafruit_VL53L0X and Windify).');
