/**
 * Build tools/ + firmwares/ without winblock-tools GitHub release (404 / private).
 * Uses, in order:
 *  1. WINDY_TOOLS_SOURCE or an existing install (copy)
 *  2. TOOLS_7Z_PATH local archive extract
 *  3. setup:arduino + download-libraries + optional Windify sync
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const toolsRoot = path.join(repoRoot, 'tools');
const firmwaresRoot = path.join(repoRoot, 'firmwares');
const arduinoCli = path.join(toolsRoot, 'Arduino', 'arduino-cli.exe');

const log = msg => console.log(`[fetch:local] ${msg}`);

const run = (command, args, label) => {
    log(label || `${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: os.platform() === 'win32'
    });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
};

const runNpmScript = script => run('npm', ['run', script], `npm run ${script}`);

const copyDir = (from, to) => {
    fs.mkdirSync(path.dirname(to), {recursive: true});
    fs.cpSync(from, to, {recursive: true, force: true});
};

const resolveToolsSource = () => {
    const candidates = [
        process.env.WINDY_TOOLS_SOURCE,
        process.env.WINDY_TOOLS_PATH,
        os.platform() === 'win32' &&
            path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Future Academy', 'tools'),
        os.platform() === 'win32' &&
            path.join(process.env.ProgramData || 'C:\\ProgramData', 'Windify', 'Future Academy', 'tools')
    ].filter(Boolean);
    for (const src of candidates) {
        const resolved = path.resolve(src);
        const cli = path.join(resolved, 'Arduino', os.platform() === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
        if (fs.existsSync(cli)) {
            return resolved;
        }
    }
    return null;
};

const copyToolsTree = source => {
    log(`copying tools from ${source}`);
    if (fs.existsSync(toolsRoot)) {
        fs.rmSync(toolsRoot, {recursive: true, force: true});
    }
    copyDir(source, toolsRoot);
};

const extractLocal7z = () => {
    const archive = process.env.TOOLS_7Z_PATH;
    if (!archive || !fs.existsSync(archive)) {
        return false;
    }
    log(`extracting ${archive}`);
    run('node', [path.join(__dirname, 'extract-tools-7z.js'), archive], 'extract tools.7z');
    return fs.existsSync(arduinoCli);
};

const syncWindifyLib = () => {
    const blocksRoot = path.resolve(repoRoot, '../windify-scratch-editor/packages/windblock-blocks');
    const syncScript = path.join(blocksRoot, 'scripts', 'sync-windify-lib.mts');
    if (!fs.existsSync(syncScript)) {
        log('Windify sync script not found — skip (set WINDY_TOOLS_SOURCE if local libs missing).');
        return;
    }
    log('syncing Windify library from windblock-blocks');
    const result = spawnSync('npx', ['tsx', syncScript], {
        cwd: blocksRoot,
        stdio: 'inherit',
        shell: true
    });
    if (result.status !== 0) {
        log('Windify sync failed — continue (run manually if needed).');
    }
};

const ensureFirmwaresDir = () => {
    fs.mkdirSync(path.join(firmwaresRoot, 'arduino'), {recursive: true});
    const readme = path.join(firmwaresRoot, 'README.txt');
    if (!fs.existsSync(readme)) {
        fs.writeFileSync(
            readme,
            'Firmware binaries. Populate via npm run fetch:small when GitHub is available,\n' +
            'or copy from an existing WindyLink install.\n',
            'utf8'
        );
    }
};

const main = () => {
    log('GitHub winblock-tools unavailable — using local bootstrap.');

    const source = resolveToolsSource();
    if (source) {
        copyToolsTree(source);
    } else if (!extractLocal7z()) {
        log('no WINDY_TOOLS_SOURCE / TOOLS_7Z_PATH — running setup:arduino + libraries');
        runNpmScript('setup:arduino');
        runNpmScript('fetch:libs');
        syncWindifyLib();
    } else {
        runNpmScript('fetch:libs');
        syncWindifyLib();
    }

    if (!fs.existsSync(arduinoCli)) {
        console.error(`[fetch:local] Missing ${arduinoCli}`);
        console.error('Set WINDY_TOOLS_SOURCE to an existing tools folder, or TOOLS_7Z_PATH to a tools.7z archive.');
        process.exit(1);
    }

    run('node', [path.join(__dirname, 'download-firmwares.js')], 'download firmwares');
    ensureFirmwaresDir();

    if (!fs.existsSync(firmwaresRoot) || fs.readdirSync(firmwaresRoot).length === 0) {
        log('firmwares/ still empty — created placeholder (AVR prebuilt upload may be limited).');
    }

    log('done.');
};

main();
