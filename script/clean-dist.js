/**
 * Stop Future Academy Link and clear dist build outputs (GUI + installer payload).
 * Use when release:setup fails with EPERM / file-in-use on Windows.
 */
const fs = require('fs');
const path = require('path');
const {
    stopRunningWindyLink,
    cleanLockedDir
} = require('./lib/clean-locked-dir');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');

console.info('[clean-dist] stopping Future Academy Link if running…');
stopRunningWindyLink();

const targets = [path.join(distRoot, 'installer-payload')];

if (fs.existsSync(distRoot)) {
    for (const name of fs.readdirSync(distRoot)) {
        if (name === 'electron' || name.startsWith('electron-')) {
            targets.push(path.join(distRoot, name));
        }
    }
}

let hadFailure = false;
for (const target of targets) {
    if (!fs.existsSync(target)) {
        continue;
    }
    const ok = cleanLockedDir(target, 'clean-dist');
    if (!ok) {
        console.warn(
            `[clean-dist] skipped locked ${path.relative(repoRoot, target)} (release:setup can use a fresh folder)`
        );
        hadFailure = true;
        continue;
    }
    console.info(`[clean-dist] cleared ${path.relative(repoRoot, target)}`);
}

const pointerPath = path.join(distRoot, 'electron-output.txt');
if (fs.existsSync(pointerPath)) {
    fs.unlinkSync(pointerPath);
}

// Remove stale renamed folders from earlier failed builds
if (fs.existsSync(distRoot)) {
    for (const name of fs.readdirSync(distRoot)) {
        if (name.includes('.stale-')) {
            const stale = path.join(distRoot, name);
            cleanLockedDir(stale, 'clean-dist');
            console.info(`[clean-dist] removed ${name}`);
        }
    }
}

if (hadFailure) {
    console.warn('[clean-dist] some folders stayed locked — close Explorer on dist\\, then retry or run release:setup anyway.');
} else {
    console.info('[clean-dist] done — run npm run release:setup');
}
