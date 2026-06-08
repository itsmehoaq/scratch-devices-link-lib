/**
 * Package FutureAcademy-win/ (Windows) — Rust-only, no Node runtime.
 * Usage: node script/package-win-dist.js
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const rustTarget = (targetIdx !== -1 && args[targetIdx + 1])
    ? args[targetIdx + 1]
    : 'x86_64-pc-windows-gnu';
const trayExe = path.join(
    repoRoot, 'shell', 'target', rustTarget, 'release', 'FutureAcademyTray.exe'
);

if (!fs.existsSync(trayExe)) {
    console.error(`Missing shell binary: ${trayExe}`);
    console.error('Run npm run build:shell:win first.');
    process.exit(1);
}

const distDir = path.join(repoRoot, 'dist', 'FutureAcademy-win');
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, {recursive: true, force: true});
}
fs.mkdirSync(distDir, {recursive: true});

fs.copyFileSync(trayExe, path.join(distDir, 'FutureAcademyTray.exe'));
fs.writeFileSync(
    path.join(distDir, 'version.txt'),
    `${pkg.version}\n`,
    'utf8'
);
fs.writeFileSync(
    path.join(distDir, 'README.txt'),
    [
        'Future Academy Link — Windows',
        '',
        'Run FutureAcademyTray.exe.',
        'arduino-cli and esp32 core are downloaded on first run.',
        '',
        `Version: ${pkg.version}`,
        'Editor: https://stem.windify.edu.vn/',
        ''
    ].join('\r\n'),
    'utf8'
);

const size = (fs.statSync(trayExe).size / 1024 / 1024).toFixed(1);
console.log(`\nBuilt: ${distDir}`);
console.log(`Size:  ${size} MB (FutureAcademyTray.exe)`);
console.log('\nTools (arduino-cli + esp32 core) are downloaded on first run.');
