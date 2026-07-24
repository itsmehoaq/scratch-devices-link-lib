const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const toolsRoot = path.join(repoRoot, 'tools');
const arduinoRoot = path.join(toolsRoot, 'Arduino');

const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');
const shouldHelp = args.has('--help') || args.has('-h');

const arduinoCliBin = process.platform === 'win32' ? 'Arduino/arduino-cli.exe' : 'Arduino/arduino-cli';

const requiredPaths = [
    arduinoCliBin,
    'Arduino/packages/arduino/hardware/avr',
    'Arduino/packages/arduino/tools/avr-gcc',
    'Arduino/packages/arduino/tools/avrdude',
    'Arduino/packages/builtin/tools/ctags',
    'Arduino/packages/esp32/hardware/esp32',
    'Arduino/packages/esp32/tools/esp-x32',
    'Arduino/packages/esp32/tools/esp32-arduino-libs',
    'Arduino/packages/esp32/tools/esptool_py'
];

const removePaths = [
    'Arduino/packages/Maixduino',
    'Arduino/packages/SparkFun',
    'Arduino/packages/esp8266',
    'Arduino/packages/rp2040',

    'Arduino/packages/arduino/hardware/renesas_uno',
    'Arduino/packages/arduino/tools/arm-none-eabi-gcc',
    'Arduino/packages/arduino/tools/bossac',
    'Arduino/packages/arduino/tools/dfu-util',
    'Arduino/packages/arduino/tools/openocd',

    'Arduino/packages/esp32/tools/esp-rv32',
    'Arduino/packages/esp32/tools/openocd-esp32',
    'Arduino/packages/esp32/tools/riscv32-esp-elf-gcc',
    'Arduino/packages/esp32/tools/riscv32-esp-elf-gdb',
    'Arduino/packages/esp32/tools/xtensa-esp-elf-gdb',
    'Arduino/packages/esp32/tools/xtensa-esp32-elf-gcc',
    'Arduino/packages/esp32/tools/xtensa-esp32s2-elf-gcc',
    'Arduino/packages/esp32/tools/xtensa-esp32s3-elf-gcc'
];

const esp32LibRelativeRoot = path.join(
    'Arduino',
    'packages',
    'esp32',
    'tools',
    'esp32-arduino-libs'
);

const removableEsp32LibTargets = [
    'esp32',
    'esp32c3',
    'esp32c6',
    'esp32h2',
    'esp32p4',
    'esp32s2'
];

const formatBytes = bytes => {
    if (!Number.isFinite(bytes)) return '0 B';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
};

const getPathSize = targetPath => {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) return stat.size;

    let total = 0;
    const entries = fs.readdirSync(targetPath);
    for (const entry of entries) {
        total += getPathSize(path.join(targetPath, entry));
    }
    return total;
};

const toAbsolute = relativePath => path.join(toolsRoot, relativePath);

const toDisplayPath = relativePath => `tools/${relativePath.replace(/\\/g, '/')}`;

const listEsp32LibPruneTargets = () => {
    const libRoot = toAbsolute(esp32LibRelativeRoot);
    if (!fs.existsSync(libRoot)) return [];

    return fs.readdirSync(libRoot)
        .map(version => path.join(esp32LibRelativeRoot, version))
        .filter(relativeVersionPath => fs.statSync(toAbsolute(relativeVersionPath)).isDirectory())
        .reduce((targets, relativeVersionPath) => {
            removableEsp32LibTargets.forEach(chip => {
                targets.push(path.join(relativeVersionPath, chip));
            });
            return targets;
        }, []);
};

const assertRequiredPaths = () => {
    const missing = requiredPaths.filter(relativePath => !fs.existsSync(toAbsolute(relativePath)));
    if (missing.length === 0) return;

    console.error('Missing required tools for Arduino Uno / ESP32-S3:');
    missing.forEach(relativePath => console.error(`  - ${toDisplayPath(relativePath)}`));
    process.exit(1);
};

const findFileNamed = (root, wanted) => {
    if (!fs.existsSync(root)) return null;
    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
        const candidate = path.join(root, entry.name);
        if (entry.isFile() && entry.name === wanted) return candidate;
        if (entry.isDirectory()) {
            const nested = findFileNamed(candidate, wanted);
            if (nested) return nested;
        }
    }
    return null;
};

/**
 * A compiler driver can exist and pass `--version` while its internal
 * `libexec/.../cc1plus` frontend is missing or unusable. Preprocessing an empty
 * C++ source forces the driver to launch cc1plus and catches that broken
 * package before it is archived.
 */
const assertEsp32CompilerUsable = () => {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const compilerRoot = toAbsolute('Arduino/packages/esp32/tools/esp-x32');
    const compiler = findFileNamed(compilerRoot, `xtensa-esp32s3-elf-g++${suffix}`);
    const frontend = findFileNamed(compilerRoot, `cc1plus${suffix}`);
    const missing = [];
    if (!compiler) missing.push(`xtensa-esp32s3-elf-g++${suffix}`);
    if (!frontend) missing.push(`cc1plus${suffix}`);
    if (missing.length > 0) {
        console.error(`Incomplete ESP32-S3 compiler package; missing: ${missing.join(', ')}`);
        process.exit(1);
    }

    const result = spawnSync(compiler, ['-x', 'c++', '-E', '-'], {
        cwd: repoRoot,
        input: '',
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error || result.status !== 0) {
        const detail = result.error ?
            result.error.message :
            (result.stderr || result.stdout || `exit ${result.status}`).trim();
        console.error(`ESP32-S3 compiler smoke test failed: ${detail}`);
        process.exit(1);
    }
    console.log(`Verified ESP32-S3 compiler frontend: ${toDisplayPath(path.relative(toolsRoot, frontend))}`);
};

const assertArduinoIndexerUsable = () => {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const ctagsRoot = toAbsolute('Arduino/packages/builtin/tools/ctags');
    const ctags = findFileNamed(ctagsRoot, `ctags${suffix}`);
    if (!ctags) {
        console.error(`Incomplete Arduino tools package; missing ctags${suffix}`);
        process.exit(1);
    }

    const result = spawnSync(ctags, ['--version'], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error || result.status !== 0) {
        const detail = result.error ?
            result.error.message :
            (result.stderr || result.stdout || `exit ${result.status}`).trim();
        console.error(`Arduino ctags smoke test failed: ${detail}`);
        process.exit(1);
    }
    console.log(`Verified Arduino source indexer: ${toDisplayPath(path.relative(toolsRoot, ctags))}`);
};

const printUsage = () => {
    console.log([
        'Usage: node script/prune-tools.js [--apply]',
        '',
        'Without --apply this prints the paths that would be removed.',
        'With --apply it removes unused board packages and toolchains while',
        'keeping Arduino Uno and ESP32-S3 build/flash support.'
    ].join('\n'));
};

if (shouldHelp) {
    printUsage();
    process.exit(0);
}

if (!fs.existsSync(arduinoRoot)) {
    console.error(`Tools directory was not found: ${arduinoRoot}`);
    console.error('Run npm run fetch before pruning.');
    process.exit(1);
}

assertRequiredPaths();
assertEsp32CompilerUsable();
assertArduinoIndexerUsable();

const pruneTargets = removePaths.concat(listEsp32LibPruneTargets())
    .filter(relativePath => fs.existsSync(toAbsolute(relativePath)));

const totalBytes = pruneTargets.reduce((sum, relativePath) => sum + getPathSize(toAbsolute(relativePath)), 0);
const action = shouldApply ? 'Removing' : 'Would remove';

console.log(`${action} ${pruneTargets.length} paths (${formatBytes(totalBytes)}):`);
pruneTargets.forEach(relativePath => {
    const absolutePath = toAbsolute(relativePath);
    console.log(`  - ${toDisplayPath(relativePath)} (${formatBytes(getPathSize(absolutePath))})`);
});

if (!shouldApply) {
    console.log('\nDry run only. Re-run with --apply to prune tools.');
    process.exit(0);
}

pruneTargets.forEach(relativePath => {
    fs.rmSync(toAbsolute(relativePath), {recursive: true, force: true});
});

console.log(`Pruned tools. Removed approximately ${formatBytes(totalBytes)}.`);
