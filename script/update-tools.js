/**
 * Update the local `tools/` (Windows) and `tools-mac/` (macOS) folders from
 * the official Tools release on GitHub:
 *   https://github.com/Kannoki/scratch-devices-link-lib/releases/tag/Tools
 *
 * Each release publishes two `.7z` archives:
 *   - tools.7z       (Windows / Linux)
 *   - tools-mac.7z   (macOS — Mach-O arduino-cli and macOS-specific ESP32 binaries)
 *
 * The archive is downloaded once into `tmp/` (already in .gitignore) and
 * extracted in-place over the existing `tools/` or `tools-mac/` directory.
 *
 * Usage:
 *   node script/update-tools.js                # both Windows + macOS
 *   node script/update-tools.js --target win
 *   node script/update-tools.js --target mac
 */
const axios = require('axios');
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'Kannoki/scratch-devices-link-lib';
const TAG = 'Tools';
const releaseApiUrl = `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`;

const repoRoot = path.resolve(__dirname, '..');
const tmpDir = path.join(repoRoot, 'tmp');
fs.mkdirSync(tmpDir, {recursive: true});

const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const onlyTarget = targetIdx >= 0 ? argv[targetIdx + 1] : null;

const targets = [
    {key: 'win', asset: 'tools.7z', extract: 'C:\\futureacademy\\tools'},
    {key: 'mac', asset: 'tools-mac.7z', extract: path.join(repoRoot, 'tools-mac')}
].filter(t => !onlyTarget || t.key === onlyTarget);

const formatBytes = bytes => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
    return `${bytes} B`;
};

const downloadAsset = async (asset, destPath) => {
    const url = asset.browser_download_url;
    const writer = fs.createWriteStream(destPath);
    const response = await axios.get(url, {responseType: 'stream'});
    const total = parseInt(response.headers['content-length'], 10) || 0;
    let received = 0;
    const start = Date.now();
    response.data.on('data', chunk => {
        received += chunk.length;
        const elapsed = (Date.now() - start) / 1000;
        const speed = elapsed > 0 ? received / elapsed : 0;
        const pct = total ? ((received / total) * 100).toFixed(1) : '?';
        process.stdout.write(
            `\r[update-tools] ${asset.name}  ${formatBytes(received)}/${formatBytes(total)}` +
            `  ${pct}%  ${formatBytes(speed)}/s   `
        );
    });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    process.stdout.write('\n');
};

/**
 * Resolve a 7-Zip extractor that supports the LZMA2 + Delta method used by
 * modern archives. The version of 7za bundled with `7zip-bin` is 21.07, which
 * rejects those entries with "Unsupported Method". The standalone `7zr.exe`
 * published on 7-zip.org is small (~600 KB), current, and self-contained.
 * @returns {Promise<string>} absolute path to a `7zr.exe` / `7za.exe` that
 *   can be spawned to extract the release archives.
 */
const resolve7zip = () => {
    const local7zr = path.join(tmpDir, '7zr.exe');
    if (fs.existsSync(local7zr)) {
        return local7zr;
    }
    const local7za = path.join(tmpDir, '7za.exe');
    if (fs.existsSync(local7za)) {
        return local7za;
    }
    console.log('[update-tools] downloading modern 7-Zip standalone (tmp/7zr.exe)');
    const url = 'https://www.7-zip.org/a/7zr.exe';
    const writer = fs.createWriteStream(local7zr);
    return axios.get(url, {responseType: 'stream'}).then(response => new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', () => {
            writer.close(() => resolve(local7zr));
        });
        writer.on('error', reject);
    }));
};

const extractArchive = (sevenZipPath, archivePath, destDir) => {
    fs.mkdirSync(destDir, {recursive: true});
    console.log(`[update-tools] extracting ${path.basename(archivePath)} -> ${destDir}`);
    const result = spawnSync(
        sevenZipPath,
        ['x', archivePath, `-o${destDir}`, '-y', '-bso0', '-bsp0'],
        {stdio: 'inherit', windowsHide: true}
    );
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${path.basename(sevenZipPath)} exited with status ${result.status}`);
    }
};

const main = async () => {
    console.log(`[update-tools] fetching release ${REPO}@${TAG}`);
    const {data: release} = await axios.get(releaseApiUrl, {
        headers: {'User-Agent': 'scratch-devices-link-lib-update-tools'}
    });

    const sevenZip = await resolve7zip();

    for (const t of targets) {
        const asset = release.assets.find(a => a.name === t.asset);
        if (!asset) {
            console.error(`[update-tools] release has no asset named ${t.asset}; skipping ${t.key}`);
            continue;
        }

        const dest = path.join(tmpDir, t.asset);
        console.log(`[update-tools] downloading ${asset.name} (${formatBytes(asset.size)}) -> ${dest}`);
        await downloadAsset(asset, dest);

        extractArchive(sevenZip, dest, t.extract);
        console.log(`[update-tools] updated ${t.extract}`);
    }

    console.log('[update-tools] done');
};

main().catch(err => {
    console.error(`[update-tools] FAILED: ${err && err.message ? err.message : err}`);
    process.exit(1);
});
