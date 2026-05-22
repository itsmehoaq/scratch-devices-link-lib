const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pngPath = path.join(repoRoot, 'assets', 'future-academy-logo.png');
const squarePath = path.join(repoRoot, 'assets', '.future-academy-square.png');
const icoPath = path.join(repoRoot, 'assets', 'FutureAcademy.ico');

if (!fs.existsSync(pngPath)) {
    console.error(`Missing logo PNG: ${pngPath}`);
    process.exit(1);
}

const run = async () => {
    const sharp = require('sharp');
    const pngToIco = (await import('png-to-ico')).default;

    await sharp(pngPath)
        .ensureAlpha()
        .resize(256, 256, {
            fit: 'contain',
            background: {r: 0, g: 0, b: 0, alpha: 0}
        })
        .png()
        .toFile(squarePath);

    const icoBuffer = await pngToIco(squarePath);
    fs.writeFileSync(icoPath, icoBuffer);
    fs.rmSync(squarePath, {force: true});
    console.log(`Icon created: ${icoPath}`);
};

run().catch(err => {
    console.error(err);
    process.exit(1);
});
