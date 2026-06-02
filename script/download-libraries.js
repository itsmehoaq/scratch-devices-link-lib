const fs = require('fs');
const path = require('path');
const os = require('os');
const {execSync, spawn} = require('child_process');
const axios = require('axios');
const ProgressBar = require('progress');

// ── Paths ────────────────────────────────────────────────────────────────────
const repoRoot = path.resolve(__dirname, '..');
const arduinoRoot = path.join(repoRoot, 'tools', 'Arduino');
const arduinoCli = path.join(arduinoRoot,
    os.platform() === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
const librariesDir = path.join(arduinoRoot, 'libraries');
const arduinoCliConfigPath = path.join(arduinoRoot, 'arduino-cli.yaml');
const manifestPath = path.join(__dirname, 'libraries.json');

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const shouldHelp = args.has('--help') || args.has('-h');
const forceReinstall = args.has('--force');
const dryRun = args.has('--dry-run');

const printUsage = () => {
    console.log([
        'Usage: node script/download-libraries.js [--force] [--dry-run]',
        '',
        'Installs Arduino libraries listed in script/libraries.json into',
        'tools/Arduino/libraries using arduino-cli and direct GitHub downloads.',
        '',
        'Options:',
        '  --force     Remove existing library before installing (re-download)',
        '  --dry-run   Print what would be done without making changes',
        '  --help, -h  Show this help message'
    ].join('\n'));
};

if (shouldHelp) {
    printUsage();
    process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const formatBytes = bytes => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
    return `${bytes} B`;
};

const libraryExists = dirName => fs.existsSync(path.join(librariesDir, dirName));

/**
 * Convert an Arduino library name to the directory name that arduino-cli
 * creates on disk. Spaces become underscores, some special characters are
 * dropped.
 */
const toDirName = name => name.replace(/ /g, '_');

const runArduinoCli = (args, {stdio = 'pipe'} = {}) => {
    execSync(`"${arduinoCli}" ${args}`, {stdio, windowsHide: true});
};

/**
 * Point arduino-cli at tools/Arduino so `lib install` writes to tools/Arduino/libraries.
 * (arduino-cli 0.35.x has no --library-dir flag on lib install.)
 */
const ensureArduinoCliConfig = () => {
    if (dryRun) {
        return;
    }
    if (!fs.existsSync(arduinoCliConfigPath)) {
        runArduinoCli(`config init --dest-file "${arduinoCliConfigPath}"`);
    }
    runArduinoCli(
        `config set directories.data "${arduinoRoot}" --config-file "${arduinoCliConfigPath}"`
    );
    runArduinoCli(
        `config set directories.user "${arduinoRoot}" --config-file "${arduinoCliConfigPath}"`
    );
    runArduinoCli(
        `config set directories.downloads "${path.join(arduinoRoot, 'staging')}" --config-file "${arduinoCliConfigPath}"`
    );
    console.log('  ↓ Updating Arduino library index ...');
    runArduinoCli(`lib update-index --config-file "${arduinoCliConfigPath}"`);
};

// ── Arduino-CLI library install ──────────────────────────────────────────────
const installArduinoLib = (name, version, explicitDirName) => {
    const dirName = explicitDirName || toDirName(name);

    if (libraryExists(dirName) && !forceReinstall) {
        console.log(`  ✓ ${name}@${version} already installed, skipping`);
        return true;
    }

    if (forceReinstall && libraryExists(dirName)) {
        if (!dryRun) {
            fs.rmSync(path.join(librariesDir, dirName), {recursive: true, force: true});
        }
        console.log(`  ✗ Removed existing ${dirName}`);
    }

    const spec = `${name}@${version}`;
    const cmd = `"${arduinoCli}" lib install "${spec}" --config-file "${arduinoCliConfigPath}" --no-deps`;

    if (dryRun) {
        console.log(`  [dry-run] ${cmd}`);
        return true;
    }

    try {
        console.log(`  ↓ Installing ${spec} ...`);
        execSync(cmd, {stdio: 'pipe', windowsHide: true});
        console.log(`  ✓ ${spec} installed`);
        return true;
    } catch (err) {
        console.error(`  ✗ Failed to install ${spec}`);
        console.error(`    ${err.stderr ? err.stderr.toString().trim() : err.message}`);
        return false;
    }
};

// ── GitHub library install (zip download + extract) ──────────────────────────
const downloadGitHubLib = async (owner, repo, tag, dirName) => {
    const targetDir = path.join(librariesDir, dirName);

    if (libraryExists(dirName) && !forceReinstall) {
        console.log(`  ✓ ${owner}/${repo}@${tag} already installed, skipping`);
        return true;
    }

    if (forceReinstall && libraryExists(dirName)) {
        if (!dryRun) {
            fs.rmSync(targetDir, {recursive: true, force: true});
        }
        console.log(`  ✗ Removed existing ${dirName}`);
    }

    const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/tags/${tag}.zip`;

    if (dryRun) {
        console.log(`  [dry-run] Download ${zipUrl} → ${dirName}`);
        return true;
    }

    console.log(`  ↓ Downloading ${owner}/${repo}@${tag} ...`);

    try {
        const tmpDir = path.join(repoRoot, 'tmp');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, {recursive: true});
        }

        const zipPath = path.join(tmpDir, `${repo}-${tag}.zip`);

        // Download zip file
        const {headers} = await axios.head(zipUrl, {maxRedirects: 5});
        const fileSize = parseInt(headers['content-length'], 10) || 0;

        const response = await axios.get(zipUrl, {responseType: 'stream', maxRedirects: 5});
        const writer = fs.createWriteStream(zipPath);

        if (fileSize > 0) {
            const bar = new ProgressBar('    Downloading [:bar] :percent', {
                total: fileSize,
                width: 30,
                renderThrottle: 500,
                clear: true
            });

            response.data.on('data', chunk => {
                bar.tick(chunk.length);
            });
        }

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Extract using arduino-cli or native unzip
        // GitHub zips contain a top-level directory like `repo-tag/`
        // We extract to tmp, then move the inner dir to the target
        const extractTmp = path.join(tmpDir, `_extract_${repo}`);
        if (fs.existsSync(extractTmp)) {
            fs.rmSync(extractTmp, {recursive: true, force: true});
        }
        fs.mkdirSync(extractTmp, {recursive: true});

        // Extract zip file — cross-platform
        if (os.platform() === 'win32') {
            execSync(
                `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTmp}' -Force"`,
                {stdio: 'pipe', windowsHide: true}
            );
        } else {
            execSync(
                `unzip -o -q "${zipPath}" -d "${extractTmp}"`,
                {stdio: 'pipe'}
            );
        }

        // Find the extracted top-level directory
        const extracted = fs.readdirSync(extractTmp);
        if (extracted.length === 0) {
            throw new Error('Zip extraction produced no files');
        }

        const sourceDir = path.join(extractTmp, extracted[0]);

        // Move to libraries/
        if (!fs.existsSync(librariesDir)) {
            fs.mkdirSync(librariesDir, {recursive: true});
        }
        fs.renameSync(sourceDir, targetDir);

        // Cleanup
        fs.rmSync(extractTmp, {recursive: true, force: true});
        fs.rmSync(zipPath, {force: true});

        console.log(`  ✓ ${owner}/${repo}@${tag} installed to ${dirName}`);
        return true;
    } catch (err) {
        console.error(`  ✗ Failed to install ${owner}/${repo}@${tag}`);
        console.error(`    ${err.message}`);
        return false;
    }
};

// ── Verify local (bundled) libraries ─────────────────────────────────────────
const verifyLocalLibs = localList => {
    let allPresent = true;
    for (const dirName of localList) {
        if (libraryExists(dirName)) {
            console.log(`  ✓ ${dirName} present`);
        } else {
            console.warn(`  ⚠ ${dirName} is MISSING – it should have been bundled with tools archive`);
            allPresent = false;
        }
    }
    return allPresent;
};

// ── Main ─────────────────────────────────────────────────────────────────────
const main = async () => {
    // Pre-flight checks
    if (!fs.existsSync(arduinoRoot)) {
        console.error(`Arduino tools directory not found: ${arduinoRoot}`);
        console.error('Run "node script/download-tools.js" first.');
        process.exit(1);
    }

    if (!fs.existsSync(arduinoCli)) {
        console.error(`arduino-cli not found: ${arduinoCli}`);
        console.error('Run "node script/download-tools.js" first.');
        process.exit(1);
    }

    if (!fs.existsSync(manifestPath)) {
        console.error(`Library manifest not found: ${manifestPath}`);
        process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    if (!fs.existsSync(librariesDir)) {
        fs.mkdirSync(librariesDir, {recursive: true});
    }

    let failed = 0;

    // 1. Arduino Library Manager libraries
    const arduinoLibs = manifest.arduino || [];
    if (arduinoLibs.length > 0) {
        ensureArduinoCliConfig();
        console.log(`\n── Arduino libraries (${arduinoLibs.length}) ──`);
        for (const lib of arduinoLibs) {
            const ok = installArduinoLib(lib.name, lib.version, lib.dirName);
            if (!ok) failed++;
        }
    }

    // 2. GitHub libraries
    const githubLibs = manifest.github || [];
    if (githubLibs.length > 0) {
        console.log(`\n── GitHub libraries (${githubLibs.length}) ──`);
        for (const lib of githubLibs) {
            const ok = await downloadGitHubLib(lib.owner, lib.repo, lib.tag, lib.dirName);
            if (!ok) failed++;
        }
    }

    // 3. Verify local (bundled) libraries
    const localLibs = manifest.local || [];
    if (localLibs.length > 0) {
        console.log(`\n── Local (bundled) libraries (${localLibs.length}) ──`);
        verifyLocalLibs(localLibs);
    }

    // Summary
    const totalManaged = arduinoLibs.length + githubLibs.length;
    const installed = fs.readdirSync(librariesDir).filter(
        entry => fs.statSync(path.join(librariesDir, entry)).isDirectory()
    ).length;

    console.log(`\n── Summary ──`);
    console.log(`  Libraries directory: ${librariesDir}`);
    console.log(`  Total libraries on disk: ${installed}`);
    console.log(`  Managed (arduino + github): ${totalManaged}`);
    console.log(`  Local (bundled): ${localLibs.length}`);

    if (failed > 0) {
        console.error(`\n${failed} library installation(s) failed.`);
        process.exit(1);
    }

    console.log('\nAll libraries up to date.');
};

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
