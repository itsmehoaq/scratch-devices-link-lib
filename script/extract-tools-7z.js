/**
 * Extract a local tools.7z into ./tools (used when GitHub release is unavailable).
 * Usage: node script/extract-tools-7z.js <path-to-tools.7z>
 */
const fs = require('fs');
const path = require('path');
const {extractFull} = require('node-7z');
const {path7za} = require('7zip-bin');

const repoRoot = path.resolve(__dirname, '..');
const archivePath = path.resolve(process.argv[2] || process.env.TOOLS_7Z_PATH || '');
const extractPath = path.join(repoRoot, 'tools');

if (!archivePath || !fs.existsSync(archivePath)) {
    console.error('Usage: node script/extract-tools-7z.js <tools.7z>');
    process.exit(1);
}

if (fs.existsSync(extractPath)) {
    fs.rmSync(extractPath, {recursive: true, force: true});
}
fs.mkdirSync(extractPath, {recursive: true});

console.log(`Extracting ${archivePath} → ${extractPath}`);

const stream = extractFull(archivePath, extractPath, {$bin: path7za});

stream.on('end', () => {
    console.log('Extract complete.');
});

stream.on('error', err => {
    console.error(err);
    process.exit(1);
});
