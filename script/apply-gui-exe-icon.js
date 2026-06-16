/**
 * Embed FutureAcademy.ico into the Electron-built Future Academy Link.exe.
 * Why: signAndEditExecutable is disabled (no winCodeSign symlinks), so
 * electron-builder leaves the default Electron icon on the exe.
 */
const fs = require('fs');
const path = require('path');

const {getGuiUnpackedDir} = require('./lib/electron-output');

const repoRoot = path.resolve(__dirname, '..');
const exePath = path.join(getGuiUnpackedDir(repoRoot), 'Future Academy Link.exe');
const iconPath = path.join(repoRoot, 'assets', 'FutureAcademy.ico');

const run = async () => {
    if (!fs.existsSync(exePath)) {
        console.error(`Missing exe: ${exePath}`);
        console.error('Run npm run build:gui:win first (electron-builder step).');
        process.exit(1);
    }
    if (!fs.existsSync(iconPath)) {
        console.error(`Missing icon: ${iconPath}`);
        console.error('Run npm run gui:logo first.');
        process.exit(1);
    }

    const {rcedit} = await import('rcedit');
    await rcedit(exePath, {
        icon: iconPath,
        'product-name': 'Future Academy Link',
        'file-description': 'Future Academy Link local hardware link server'
    });
    console.info(`[apply-gui-exe-icon] icon applied to ${exePath}`);
};

run().catch(err => {
    console.error(err);
    process.exit(1);
});
