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

/**
 * Try to remove `dir`. Returns true on success, false on the
 * admin-owned-files EPERM that this script falls back from. Other
 * errors propagate.
 *
 * The Windows-only failure mode is: an earlier elevated build wrote
 * files into `dir` owned by BUILTIN\Administrators, and the current
 * non-elevated user has no DELETE on those entries. fs.rmSync, rename,
 * and icacls-from-non-elevated all fail. The user can still create
 * new sibling folders, so we fall back to a timestamped output.
 */
const tryRemove = (dir) => {
    if (!fs.existsSync(dir)) {
        return true;
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            fs.rmSync(dir, {recursive: true, force: true});
            return true;
        } catch (err) {
            lastErr = err;
            if (err.code !== 'EPERM' && err.code !== 'EBUSY') {
                throw err;
            }
            if (attempt < 3) {
                const wait = 800 * attempt;
                const deadline = Date.now() + wait;
                while (Date.now() < deadline) {}
            }
        }
    }
    if (lastErr && (lastErr.code === 'EPERM' || lastErr.code === 'EBUSY')) {
        return false;
    }
    throw lastErr;
};

/**
 * Recursively copy `srcDir` into `dstDir`. Creates `dstDir` if needed. Uses
 * a stream copy for files so large binaries (the bundled arduino-cli, ESP32
 * toolchain, etc.) do not need to be fully buffered in memory. Skips the copy
 * when `srcDir` does not exist — the calling script emits a warning instead
 * of failing the build, so a missing `tools/` does not break packaging.
 * @param {string} srcDir absolute source directory to copy from.
 * @param {string} dstDir absolute destination directory to populate.
 * @returns {{copied: number, skipped: boolean}} `skipped` is true when
 *   `srcDir` did not exist; otherwise `copied` is the number of regular files
 *   and symlinks written.
 */
const copyDirRecursive = (srcDir, dstDir) => {
    if (!fs.existsSync(srcDir)) {
        return {copied: 0, skipped: true};
    }
    fs.mkdirSync(dstDir, {recursive: true});
    let copied = 0;
    const walk = (currentSrc, currentDst) => {
        for (const entry of fs.readdirSync(currentSrc, {withFileTypes: true})) {
            const s = path.join(currentSrc, entry.name);
            const d = path.join(currentDst, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(d, {recursive: true});
                walk(s, d);
            } else if (entry.isFile()) {
                fs.copyFileSync(s, d);
                copied += 1;
            } else if (entry.isSymbolicLink()) {
                const link = fs.readlinkSync(s);
                fs.symlinkSync(link, d);
                copied += 1;
            }
        }
    };
    walk(srcDir, dstDir);
    return {copied, skipped: false};
};

/**
 * Build the portable output. Writes to `outDir`, creating it fresh.
 * @param {string} outDir absolute directory to populate with the portable
 *   artifact (exe, version.txt, README.txt, and the bundled `tools/`).
 */
const writeOutput = outDir => {
    fs.mkdirSync(outDir, {recursive: true});
    fs.copyFileSync(trayExe, path.join(outDir, 'FutureAcademyTray.exe'));
    fs.writeFileSync(
        path.join(outDir, 'version.txt'),
        `${pkg.version}\n`,
        'utf8'
    );
    fs.writeFileSync(
        path.join(outDir, 'README.txt'),
        [
            'Future Academy Link — Windows',
            '',
            'Run FutureAcademyTray.exe.',
            'arduino-cli and esp32 core are bundled in tools/ next to this folder.',
            '',
            `Version: ${pkg.version}`,
            'Editor: https://stem.windify.edu.vn/',
            ''
        ].join('\r\n'),
        'utf8'
    );
    const toolsResult = copyDirRecursive(
        path.join(repoRoot, 'tools'),
        path.join(outDir, 'tools')
    );
    if (toolsResult.skipped) {
        console.warn(
            '[package-win-dist] tools/ not found at repo root — output will rely on the end user ' +
            'populating it. Run `npm run update:tools` first.'
        );
    } else {
        console.log(`[package-win-dist] bundled ${toolsResult.copied} files from tools/`);
    }

    // Bundle 7zr.exe so the binary can extract tools.7z on first launch without
    // requiring the user to install 7-Zip system-wide.
    const sevenzSource = path.join(repoRoot, 'shell', '7zr.exe');
    if (fs.existsSync(sevenzSource)) {
        fs.copyFileSync(sevenzSource, path.join(outDir, '7zr.exe'));
        console.log('[package-win-dist] bundled 7zr.exe for runtime extraction');
    } else {
        console.warn(
            '[package-win-dist] shell/7zr.exe not found — the app will need 7-Zip ' +
            'installed on the client machine for first-launch tool download.'
        );
    }
};

const canonicalDir = path.join(repoRoot, 'dist', 'FutureAcademy-win');
const removable = tryRemove(canonicalDir);

let outDir = canonicalDir;
if (!removable) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    outDir = path.join(repoRoot, 'dist', `FutureAcademy-win-${stamp}`);
    console.warn(
        `[package-win-dist] ${canonicalDir} is owned by BUILTIN\\Administrators and cannot be removed without elevation.`
    );
    console.warn(
        `[package-win-dist] Building portable output into a fresh sibling: ${outDir}`
    );
    console.warn(
        `[package-win-dist] To reclaim disk space, run an elevated cmd and rmdir /s /q the stale folder.`
    );
}

writeOutput(outDir);

const size = (fs.statSync(trayExe).size / 1024 / 1024).toFixed(1);
console.log(`\nBuilt: ${outDir}`);
console.log(`Size:  ${size} MB (FutureAcademyTray.exe)`);
console.log('\nTools (arduino-cli + esp32 core) are bundled in tools/ next to the binary.');
