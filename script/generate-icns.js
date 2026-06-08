/**
 * Generate assets/FutureAcademy.icns from assets/logo.png.
 * Requires: sharp (devDependency), macOS iconutil.
 * Usage: node script/generate-icns.js
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'assets', 'logo.png');
const iconset = path.join(repoRoot, 'assets', 'FutureAcademy.iconset');
const icns = path.join(repoRoot, 'assets', 'FutureAcademy.icns');

if (!fs.existsSync(src)) {
    console.error(`Missing: ${src}`);
    process.exit(1);
}

fs.mkdirSync(iconset, {recursive: true});

const sizes = [
    {name: 'icon_16x16.png',      size: 16},
    {name: 'icon_16x16@2x.png',   size: 32},
    {name: 'icon_32x32.png',      size: 32},
    {name: 'icon_32x32@2x.png',   size: 64},
    {name: 'icon_128x128.png',    size: 128},
    {name: 'icon_128x128@2x.png', size: 256},
    {name: 'icon_256x256.png',    size: 256},
    {name: 'icon_256x256@2x.png', size: 512},
    {name: 'icon_512x512.png',    size: 512},
    {name: 'icon_512x512@2x.png', size: 1024}
];

Promise.all(sizes.map(({name, size}) =>
    sharp(src)
        .resize(size, size, {fit: 'contain', background: {r: 0, g: 0, b: 0, alpha: 0}})
        .png()
        .toFile(path.join(iconset, name))
)).then(() => {
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icns], {stdio: 'inherit'});
    fs.rmSync(iconset, {recursive: true, force: true});
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
    console.log(`Generated: ${path.relative(repoRoot, icns)}`);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
