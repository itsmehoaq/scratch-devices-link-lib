const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'dist', 'Future Academy Link.exe');
const iconPath = path.join(repoRoot, 'assets', 'FutureAcademy.ico');

/**
 * Why: rcedit truncates pkg-produced executables and breaks startup
 * ("Pkg: Error reading from file."). Icon is applied via WiX for MSI installs.
 * This script is kept for manual experiments only — not used in release builds.
 */
const run = async () => {
    if (!fs.existsSync(exePath)) {
        console.error(`Missing exe: ${exePath}`);
        process.exit(1);
    }
    const beforeSize = fs.statSync(exePath).size;
    const {rcedit} = await import('rcedit');
    await rcedit(exePath, {
        icon: iconPath,
        'product-name': 'Future Academy Link',
        'file-description': 'Future Academy Link local hardware link server'
    });
    const afterSize = fs.statSync(exePath).size;
    console.warn(
        '[apply-exe-icon] Warning: rcedit may corrupt pkg executables. ' +
        'Use WiX MSI icon instead.'
    );
    console.log(`Applied icon to ${exePath} (${beforeSize} -> ${afterSize} bytes)`);
};

run().catch(err => {
    console.error(err);
    process.exit(1);
});
