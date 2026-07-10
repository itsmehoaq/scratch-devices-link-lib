#!/usr/bin/env node

/**
 * Generate the public OTA manifest from packaged release archives.
 *
 * Usage:
 *   node script/generate-ota-manifest.js <artifacts-dir> <output-file>
 *
 * Env:
 *   OTA_VERSION          Release version without the leading "v".
 *   R2_PUBLIC_BASE_URL   Public custom-domain URL for the R2 bucket.
 *   R2_OTA_PREFIX        Optional object prefix (default: "ota").
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const artifactNames = [
    'FutureAcademy-win.zip',
    'FutureAcademy-arm64.zip',
    'FutureAcademy-intel.zip'
];

const artifactsDir = path.resolve(process.argv[2] || 'artifacts');
const outputFile = path.resolve(process.argv[3] || 'ota/latest.json');
const version = (process.env.OTA_VERSION || '').replace(/^v/, '');
const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const otaPrefix = (process.env.R2_OTA_PREFIX || 'ota').replace(/^\/+|\/+$/g, '');

if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('OTA_VERSION must be a stable semantic version such as 2.0.7');
}

if (!/^https:\/\//.test(publicBaseUrl)) {
    throw new Error('R2_PUBLIC_BASE_URL must be a public HTTPS URL');
}

const sha256File = filePath => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
});

const main = async () => {
    const assets = [];
    for (const name of artifactNames) {
        const filePath = path.join(artifactsDir, name);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing OTA artifact: ${filePath}`);
        }

        assets.push({
            name,
            url: `${publicBaseUrl}/${otaPrefix}/releases/v${version}/${name}`,
            sha256: await sha256File(filePath),
            size: fs.statSync(filePath).size
        });
    }

    const manifest = {
        schema_version: 1,
        version,
        published_at: new Date().toISOString(),
        assets
    };

    fs.mkdirSync(path.dirname(outputFile), {recursive: true});
    fs.writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Generated ${outputFile} for v${version}`);
    for (const asset of assets) {
        console.log(`  ${asset.name}: ${asset.size} bytes, sha256 ${asset.sha256}`);
    }
};

main().catch(error => {
    console.error(error);
    process.exit(1);
});
