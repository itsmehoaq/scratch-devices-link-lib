/**
 * Resize future-academy-logo.png for GUI header and mirror to assets/gui.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoRoot = path.join(__dirname, '..');
const sourcePath = path.join(repoRoot, 'assets', 'future-academy-logo.png');
const guiLogoPath = path.join(repoRoot, 'gui', 'assets', 'logo.png');
const mirrorLogoPath = path.join(repoRoot, 'assets', 'gui', 'logo.png');

const run = async () => {
    if (!fs.existsSync(sourcePath)) {
        console.error(`Missing ${sourcePath}`);
        process.exit(1);
    }

    await sharp(sourcePath)
        .ensureAlpha()
        .resize(168, 132, {
            fit: 'contain',
            background: {r: 0, g: 0, b: 0, alpha: 0}
        })
        .png()
        .toFile(guiLogoPath);

    fs.mkdirSync(path.dirname(mirrorLogoPath), {recursive: true});
    fs.copyFileSync(guiLogoPath, mirrorLogoPath);
    console.info(`[sync-logo] ${guiLogoPath}`);
};

run().catch(err => {
    console.error(err);
    process.exit(1);
});
