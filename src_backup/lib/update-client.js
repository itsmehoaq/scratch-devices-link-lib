const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const DEFAULT_UPDATE_SERVER = 'http://14.225.209.18:8080';
const MANIFEST_PATH = '/api/v1/manifest';
const FETCH_TIMEOUT_MS = 8000;

/**
 * @returns {string}
 */
const getUpdateServerBaseUrl = () => {
    const fromEnv = process.env.WINDY_UPDATE_SERVER_URL;
    if (fromEnv && String(fromEnv).trim()) {
        return String(fromEnv).trim().replace(/\/$/, '');
    }
    return DEFAULT_UPDATE_SERVER;
};

/**
 * @param {string} baseDir runtime root beside exe
 * @returns {string}
 */
const readLocalAppVersion = baseDir => {
    if (!process.pkg) {
        try {
            const pkg = require('../../package.json');
            return pkg.version;
        } catch (_e) {
            return '0.0.0';
        }
    }
    const versionFile = path.join(baseDir, 'version.txt');
    if (fs.existsSync(versionFile)) {
        return fs.readFileSync(versionFile, 'utf8').trim();
    }
    return '0.0.0';
};

/**
 * @param {string} [baseUrl]
 * @returns {Promise<object|null>}
 */
const fetchRemoteManifest = async (baseUrl = getUpdateServerBaseUrl()) => {
    const url = `${baseUrl.replace(/\/$/, '')}${MANIFEST_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {signal: controller.signal});
        if (!res.ok) {
            return null;
        }
        return res.json();
    } catch (_err) {
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Compare semver strings (x.y.z only).
 * @param {string} local
 * @param {string} remote
 * @returns {boolean}
 */
const isOlderVersion = (local, remote) => {
    const parse = v => String(v).trim().split('.').map(n => Number.parseInt(n, 10) || 0);
    const a = parse(local);
    const b = parse(remote);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        if (av < bv) {
            return true;
        }
        if (av > bv) {
            return false;
        }
    }
    return false;
};

/**
 * @param {string} baseDir
 * @returns {Promise<{ action: string, downloadUrl?: string, sha256?: string, latestVersion?: string, portableUrl?: string }|null>}
 */
const checkApplicationUpdate = async baseDir => {
    const manifest = await fetchRemoteManifest();
    if (!manifest || !manifest.application) {
        return null;
    }
    const localVersion = readLocalAppVersion(baseDir);
    const latestVersion = manifest.application.latestVersion;
    const installer = manifest.application.installer || {};
    const portable = manifest.application.portable || {};
    const needsUpgrade = isOlderVersion(localVersion, latestVersion);

    if (!needsUpgrade && installer.url) {
        return {
            action: 'current',
            latestVersion,
            downloadUrl: installer.url,
            portableUrl: portable.url
        };
    }
    if (needsUpgrade && installer.url) {
        return {
            action: 'upgrade',
            latestVersion,
            downloadUrl: installer.url,
            sha256: installer.sha256,
            portableUrl: portable.url
        };
    }
    if (installer.url) {
        return {
            action: 'install',
            latestVersion,
            downloadUrl: installer.url,
            sha256: installer.sha256,
            portableUrl: portable.url
        };
    }
    return null;
};

module.exports = {
    DEFAULT_UPDATE_SERVER,
    getUpdateServerBaseUrl,
    fetchRemoteManifest,
    checkApplicationUpdate,
    readLocalAppVersion,
    isOlderVersion
};
