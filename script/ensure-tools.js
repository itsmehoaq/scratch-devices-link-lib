/**
 * Ensure tools/ and firmwares/ exist before release packaging.
 * Tries GitHub bundle first; falls back to local bootstrap when winblock-tools 404.
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const toolsRoot = path.join(repoRoot, 'tools');
const firmwaresRoot = path.join(repoRoot, 'firmwares');
const arduinoCli = path.join(toolsRoot, 'Arduino', 'arduino-cli.exe');

const hasTools = () =>
    fs.existsSync(arduinoCli) &&
    fs.statSync(arduinoCli).isFile();

const hasFirmwares = () =>
    fs.existsSync(firmwaresRoot) &&
    fs.readdirSync(firmwaresRoot).length > 0;

const run = (command, args) => {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: true
    });
    return result.status || 0;
};

if (hasTools() && hasFirmwares()) {
    console.log('[ensure:tools] tools/ and firmwares/ already present — skipping fetch.');
    process.exit(0);
}

console.log('[ensure:tools] Missing tools/ or firmwares/ — fetching build assets…');

const fetchSmallOk = run('npm', ['run', 'fetch:small']) === 0;

if (!fetchSmallOk) {
    console.warn('[ensure:tools] fetch:small failed — trying fetch:local…');
    if (run('npm', ['run', 'fetch:local']) !== 0) {
        process.exit(1);
    }
}

if (!hasTools()) {
    console.error(`[ensure:tools] Still missing ${arduinoCli}`);
    console.error('Copy an existing tools folder:');
    console.error('  set WINDY_TOOLS_SOURCE=C:\\Program Files\\Future Academy\\tools');
    console.error('Or provide a local archive:');
    console.error('  set TOOLS_7Z_PATH=D:\\path\\to\\tools.7z');
    process.exit(1);
}

if (!hasFirmwares()) {
    fs.mkdirSync(path.join(firmwaresRoot, 'arduino'), {recursive: true});
    console.warn('[ensure:tools] firmwares/ empty — created placeholder (OK for installer build).');
}

console.log('[ensure:tools] Ready for release packaging.');
