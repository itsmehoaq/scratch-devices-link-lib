/**
 * Figma MCP asset URLs often return SVG XML saved as *.png.
 * Electron <img> cannot display those; convert to real PNG in gui/assets.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const assetsDir = path.join(__dirname, '..', 'gui', 'assets');
const mirrorDir = path.join(__dirname, '..', 'assets', 'gui');

/** @type {Record<string, {width: number, height: number}>} */
const TARGET_SIZES = {
    'logo.png': {width: 128, height: 100},
    'iconSetting.png': {width: 72, height: 72},
    'iconClose.png': {width: 72, height: 72},
    'iconChip.png': {width: 48, height: 48},
    'iconWebsite.png': {width: 48, height: 48},
    'iconConsole.png': {width: 48, height: 48},
    'iconRefresh.png': {width: 48, height: 48},
    'iconDevice.png': {width: 48, height: 48},
    'iconChevron.png': {width: 48, height: 48}
};

const isPngBuffer = buffer =>
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;

const isSvgBuffer = buffer => {
    const head = buffer.slice(0, 256).toString('utf8').trimStart();
    return head.startsWith('<svg') || head.startsWith('<?xml');
};

/**
 * @param {string} filePath
 */
const convertToPng = async filePath => {
    const name = path.basename(filePath);
    const input = fs.readFileSync(filePath);
    if (isPngBuffer(input)) {
        return false;
    }
    if (!isSvgBuffer(input)) {
        console.warn(`[convert-gui-assets] skip unknown format: ${name}`);
        return false;
    }

    const dims = TARGET_SIZES[name] || {width: 48, height: 48};
    const tmpPath = `${filePath}.tmp`;
    await sharp(input, {density: 300})
        .resize(dims.width, dims.height, {
            fit: 'contain',
            background: {r: 0, g: 0, b: 0, alpha: 0}
        })
        .png()
        .toFile(tmpPath);
    fs.renameSync(tmpPath, filePath);
    console.info(`[convert-gui-assets] converted ${name} → PNG ${dims.width}×${dims.height}`);
    return true;
};

const run = async () => {
    if (!fs.existsSync(assetsDir)) {
        console.error(`[convert-gui-assets] missing ${assetsDir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(assetsDir).filter(f => f.endsWith('.png'));
    let converted = 0;
    for (const file of files) {
        const fullPath = path.join(assetsDir, file);
        if (await convertToPng(fullPath)) {
            converted += 1;
            if (fs.existsSync(mirrorDir)) {
                fs.copyFileSync(fullPath, path.join(mirrorDir, file));
            }
        }
    }
    console.info(`[convert-gui-assets] done (${converted} file(s) converted)`);
};

run().catch(err => {
    console.error(err);
    process.exit(1);
});
