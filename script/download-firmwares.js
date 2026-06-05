const downloadRelease = require('download-github-release');
const path = require('path');
const fs = require('fs');

const user = process.env.WINBLOCK_FIRMWARES_USER || 'winblockcc';
const repo = process.env.WINBLOCK_FIRMWARES_REPO || 'winblock-firmwares';
const outputdir = path.resolve('./firmwares');
const leaveZipped = false;

const filterRelease = release => release.prerelease === false;

const filterAsset = () => true;

if (!fs.existsSync(outputdir)) {
    fs.mkdirSync(outputdir, {recursive: true});
}

downloadRelease(user, repo, outputdir, filterRelease, filterAsset, leaveZipped)
    .then(() => {
        console.log('Firmwares download complete');
    })
    .catch(err => {
        console.error(`[download-firmwares] ${err.message}`);
        console.error(
            '[download-firmwares] GitHub release unavailable — empty firmwares/ placeholder is OK for GUI-only release.'
        );
        process.exit(0);
    });
