/**
 * Upload dist installer + app zip to scratch-link-server admin API.
 *
 * Env: UPDATE_SERVER_URL, ADMIN_USERNAME, ADMIN_PASSWORD
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require('../package.json');

const baseUrl = (process.env.UPDATE_SERVER_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD || '';

const installerPath = path.join(
    repoRoot,
    'dist',
    `FutureAcademy-${pkg.version}-x64-setup.exe`
);
const zipPath = path.join(
    repoRoot,
    'dist',
    `FutureAcademy-${pkg.version}-x64-app.zip`
);

const requestJson = (url, options, body) => new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            try {
                resolve({status: res.statusCode, body: JSON.parse(data || '{}')});
            } catch (err) {
                reject(err);
            }
        });
    });
    req.on('error', reject);
    if (body) {
        req.write(body);
    }
    req.end();
});

const login = async cookieJar => {
    const body = JSON.stringify({username, password});
    const url = new URL(`${baseUrl}/admin/api/login`);
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            const cookies = res.headers['set-cookie'] || [];
            cookies.forEach(c => cookieJar.push(c.split(';')[0]));
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(data || 'Login failed'));
                    return;
                }
                resolve();
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
};

const uploadFile = (filePath, cookieJar) => new Promise((resolve, reject) => {
    const boundary = `----WindyPublish${Date.now()}`;
    const filename = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);
    const head = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        'Content-Type: application/octet-stream',
        '',
        ''
    ].join('\r\n');
    const tail = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
        Buffer.from(head, 'utf8'),
        fileData,
        Buffer.from(tail, 'utf8')
    ]);

    const url = new URL(`${baseUrl}/admin/api/upload`);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            Cookie: cookieJar.join('; ')
        }
    }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode >= 400) {
                reject(new Error(data || `Upload failed ${filename}`));
                return;
            }
            resolve(JSON.parse(data || '{}'));
        });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
});

const importLibraries = async (cookieJar) => {
    const libraries = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'script', 'libraries.json'), 'utf8')
    );
    const payload = JSON.stringify({
        libraries: {
            arduino: libraries.arduino || [],
            github: libraries.github || [],
            local: libraries.local || [],
            windify: [
                {dirName: 'Windify', version: pkg.version},
                {dirName: 'oled_lib_cus', version: '1.0.0'},
                {dirName: 'oled_number', version: '1.0.0'}
            ]
        }
    });
    const url = new URL(`${baseUrl}/admin/api/import-libraries`);
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                Cookie: cookieJar.join('; ')
            }
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(data || 'import-libraries failed'));
                    return;
                }
                resolve();
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
};

const main = async () => {
    if (!password) {
        console.error('Set ADMIN_PASSWORD for publish-to-update-server');
        process.exit(1);
    }
    const files = [installerPath, zipPath].filter(p => fs.existsSync(p));
    if (files.length === 0) {
        console.error('No release artifacts in dist/. Run npm run release first.');
        process.exit(1);
    }

    const cookieJar = [];
    console.log(`Logging in to ${baseUrl}…`);
    await login(cookieJar);
    await importLibraries(cookieJar);
    console.log('Libraries manifest imported.');

    for (const filePath of files) {
        console.log(`Uploading ${path.basename(filePath)}…`);
        const result = await uploadFile(filePath, cookieJar);
        console.log(`  → ${result.url}`);
    }
    console.log('Done.');
};

main().catch(err => {
    console.error(err);
    process.exit(1);
});
