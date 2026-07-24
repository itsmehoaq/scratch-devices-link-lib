const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {path7za} = require('7zip-bin');

const repoRoot = path.resolve(__dirname, '..');
const toolsRoot = path.join(repoRoot, 'tools');
const outputDir = path.join(repoRoot, 'tmp');
const archiveName = `tools-pruned-${os.platform()}-${os.arch()}.7z`;
const archivePath = path.join(outputDir, archiveName);

const args = new Set(process.argv.slice(2));
const shouldHelp = args.has('--help') || args.has('-h');
const shouldOverwrite = args.has('--overwrite');

const printUsage = () => {
    console.log([
        'Usage: node script/archive-tools.js [--overwrite]',
        '',
        `Creates tmp/${archiveName} from the current tools directory.`,
        'Use --overwrite to replace an existing archive.'
    ].join('\n'));
};

if (shouldHelp) {
    printUsage();
    process.exit(0);
}

if (!fs.existsSync(toolsRoot)) {
    console.error(`Tools directory was not found: ${toolsRoot}`);
    console.error('Run npm run fetch before archiving.');
    process.exit(1);
}

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, {recursive: true});
}

if (fs.existsSync(archivePath)) {
    if (!shouldOverwrite) {
        console.error(`Archive already exists: ${archivePath}`);
        console.error('Use --overwrite to replace it.');
        process.exit(1);
    }
    fs.rmSync(archivePath, {force: true});
}

console.log(`Creating ${archivePath}...`);

const sevenZip = spawn(path7za, [
    'a',
    '-t7z',
    '-mx=9',
    '-sccUTF-8',
    archivePath,
    'tools'
], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true
});

sevenZip.on('error', err => {
    console.error(`Failed to start 7-Zip: ${err.message}`);
    process.exit(1);
});

sevenZip.on('exit', code => {
    if (code !== 0) {
        console.error(`7-Zip failed with exit code ${code}`);
        process.exit(code || 1);
    }

    const size = fs.statSync(archivePath).size;
    console.log(`Archive created: ${archivePath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
});
