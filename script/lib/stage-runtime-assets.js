const fs = require('fs');
const os = require('os');
const path = require('path');

const arduinoCliRelativePath = () =>
    path.join('Arduino', os.platform() === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');

const requiredArduinoToolPaths = () => [
    arduinoCliRelativePath(),
    path.join('Arduino', 'packages', 'arduino', 'hardware', 'avr'),
    path.join('Arduino', 'packages', 'arduino', 'tools', 'avr-gcc'),
    path.join('Arduino', 'packages', 'arduino', 'tools', 'avrdude'),
    path.join('Arduino', 'packages', 'esp32', 'hardware', 'esp32'),
    path.join('Arduino', 'packages', 'esp32', 'tools', 'esp-x32'),
    path.join('Arduino', 'packages', 'esp32', 'tools', 'esptool_py')
];

const optionalArduinoToolPaths = [
    path.join('Arduino', 'package_index.json'),
    path.join('Arduino', 'package_index.json.sig'),
    path.join('Arduino', 'package_esp32_index.json'),
    path.join('Arduino', 'library_index.json'),
    path.join('Arduino', 'library_index.json.sig'),
    path.join('Arduino', 'inventory.yaml'),
    path.join('Arduino', 'libraries'),
    path.join('Arduino', 'packages', 'builtin', 'tools'),
    path.join('Arduino', 'packages', 'esp32', 'tools', 'mklittlefs'),
    path.join('Arduino', 'packages', 'esp32', 'tools', 'mkspiffs')
];

const esp32SdkLibraryPaths = [
    path.join('Arduino', 'packages', 'esp32', 'tools', 'esp32s3-libs'),
    path.join('Arduino', 'packages', 'esp32', 'tools', 'esp32-arduino-libs')
];

const copyPath = (sourceRoot, targetRoot, relativePath) => {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.cpSync(source, target, {
        recursive: true,
        force: true,
        verbatimSymlinks: true
    });
};

const assertExists = (sourceRoot, relativePaths) => {
    const missing = relativePaths.filter(relativePath =>
        !fs.existsSync(path.join(sourceRoot, relativePath))
    );
    if (missing.length > 0) {
        throw new Error(
            `Missing required Arduino tool paths:\n${missing.map(item => `  - ${item}`).join('\n')}`
        );
    }
};

/**
 * Stage the runtime Arduino tool subset this app supports:
 * Arduino Uno, ESP32-S3 compile/upload, and direct ESP32 bin flashing.
 * @param {string} sourceToolsRoot source tools directory.
 * @param {string} targetToolsRoot target tools directory.
 * @returns {{copied: string[]}}
 */
const stageRuntimeAssets = (sourceToolsRoot, targetToolsRoot) => {
    const requiredPaths = requiredArduinoToolPaths();
    assertExists(sourceToolsRoot, requiredPaths);

    const sdkLibraryPath = esp32SdkLibraryPaths.find(relativePath =>
        fs.existsSync(path.join(sourceToolsRoot, relativePath))
    );
    if (!sdkLibraryPath) {
        throw new Error(
            `Missing required ESP32-S3 SDK libraries:\n${
                esp32SdkLibraryPaths.map(item => `  - ${item}`).join('\n')
            }`
        );
    }

    fs.rmSync(targetToolsRoot, {recursive: true, force: true});
    fs.mkdirSync(targetToolsRoot, {recursive: true});

    const copied = [];
    const copyIfExists = relativePath => {
        if (!fs.existsSync(path.join(sourceToolsRoot, relativePath))) {
            return;
        }
        copyPath(sourceToolsRoot, targetToolsRoot, relativePath);
        copied.push(relativePath);
    };

    requiredPaths.forEach(copyIfExists);
    copyIfExists(sdkLibraryPath);
    optionalArduinoToolPaths.forEach(copyIfExists);

    return {copied};
};

const stageFirmwares = (sourceFirmwaresRoot, targetFirmwaresRoot) => {
    if (!fs.existsSync(sourceFirmwaresRoot)) {
        return false;
    }
    fs.rmSync(targetFirmwaresRoot, {recursive: true, force: true});
    fs.cpSync(sourceFirmwaresRoot, targetFirmwaresRoot, {
        recursive: true,
        force: true,
        verbatimSymlinks: true
    });
    return true;
};

module.exports = {
    stageRuntimeAssets,
    stageFirmwares
};
