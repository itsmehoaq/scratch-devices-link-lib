/**
 * Authenticode-sign Windows release artifacts when a PFX is configured.
 *
 * Env (all optional except WIN_SIGN_PFX_PATH):
 *   WIN_SIGN_PFX_PATH      — path to .pfx
 *   WIN_SIGN_PFX_PASSWORD  — PFX password (omit if unprotected)
 *   WIN_SIGN_TIMESTAMP_URL — default http://timestamp.digicert.com
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');

const pfxPath = process.env.WIN_SIGN_PFX_PATH;
const pfxPassword = process.env.WIN_SIGN_PFX_PASSWORD || '';
const timestampUrl =
    process.env.WIN_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';

const resolveSigntool = () => {
    const kits = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles;
    const candidates = [
        path.join(kits, 'Windows Kits', '10', 'bin', '10.0.22621.0', 'x64', 'signtool.exe'),
        path.join(kits, 'Windows Kits', '10', 'bin', '10.0.22000.0', 'x64', 'signtool.exe')
    ];
    for (const base of [path.join(kits, 'Windows Kits', '10', 'bin')]) {
        if (!fs.existsSync(base)) {
            continue;
        }
        for (const ver of fs.readdirSync(base).sort().reverse()) {
            const full = path.join(base, ver, 'x64', 'signtool.exe');
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }
    const where = spawnSync('where', ['signtool.exe'], {encoding: 'utf8'});
    if (where.status === 0 && where.stdout.trim()) {
        return where.stdout.trim().split(/\r?\n/)[0].trim();
    }
    return null;
};

const signFile = (signtool, filePath) => {
    if (!fs.existsSync(filePath)) {
        console.warn(`[sign] skip missing ${filePath}`);
        return false;
    }
    const args = [
        'sign',
        '/fd', 'SHA256',
        '/tr', timestampUrl,
        '/td', 'SHA256',
        '/f', pfxPath
    ];
    if (pfxPassword) {
        args.push('/p', pfxPassword);
    }
    args.push(filePath);

    console.log(`[sign] ${path.basename(filePath)}`);
    const result = spawnSync(signtool, args, {stdio: 'inherit'});
    return result.status === 0;
};

const main = () => {
    if (!pfxPath) {
        console.log('[sign] WIN_SIGN_PFX_PATH not set — skipping Authenticode signing.');
        process.exit(0);
    }
    if (!fs.existsSync(pfxPath)) {
        console.error(`[sign] PFX not found: ${pfxPath}`);
        process.exit(1);
    }

    const signtool = resolveSigntool();
    if (!signtool) {
        console.error('[sign] signtool.exe not found. Install Windows SDK.');
        process.exit(1);
    }

    const targets = process.argv.slice(2);
    if (targets.length === 0) {
        targets.push(
            path.join(repoRoot, 'dist', `FutureAcademy-${pkg.version}-x64-setup.exe`)
        );
        const guiExe = path.join(
            repoRoot,
            'dist',
            'electron',
            'win-unpacked',
            'WindyLink.exe'
        );
        if (fs.existsSync(guiExe)) {
            targets.push(guiExe);
        }
    }

    let ok = true;
    for (const file of targets) {
        if (!signFile(signtool, path.resolve(file))) {
            ok = false;
        }
    }
    process.exit(ok ? 0 : 1);
};

main();
