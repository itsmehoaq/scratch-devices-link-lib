const deviceListEl = document.getElementById('device-list');
const statusEl = document.getElementById('server-status');
const emptyEl = document.getElementById('device-empty');

const formatHexId = value => {
    if (!value) {
        return '—';
    }
    const normalized = String(value).replace(/^0x/i, '').toUpperCase();
    return normalized.length <= 4 ? normalized : normalized;
};

const renderDevices = devices => {
    deviceListEl.innerHTML = '';
    if (!devices.length) {
        emptyEl.textContent = 'Chưa phát hiện thiết bị USB nào.';
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;

    devices.forEach(device => {
        const card = document.createElement('article');
        card.className = 'device-card';
        card.innerHTML = `
            <header class="device-card__header">
                <img class="device-card__icon" src="assets/iconDevice.png" alt="" width="24" height="24" />
                <h2 class="device-card__title">${escapeHtml(device.name)}</h2>
                <img class="device-card__chevron" src="assets/iconChevron.png" alt="" width="24" height="24" />
            </header>
            <dl class="device-card__meta">
                <div><dt>Port:</dt><dd>${escapeHtml(device.path)}</dd></div>
                <div><dt>PID:</dt><dd>${escapeHtml(formatHexId(device.productId))}</dd></div>
                <div><dt>VID:</dt><dd>${escapeHtml(formatHexId(device.vendorId))}</dd></div>
            </dl>
        `;
        deviceListEl.appendChild(card);
    });
};

const escapeHtml = text => {
    const span = document.createElement('span');
    span.textContent = text;
    return span.innerHTML;
};

const refreshDevices = async () => {
    try {
        const result = await window.windyLink.listDevices();
        if (result.error) {
            emptyEl.hidden = false;
            emptyEl.textContent = result.error;
            deviceListEl.innerHTML = '';
            return;
        }
        renderDevices(result.devices || []);
    } catch (err) {
        emptyEl.hidden = false;
        emptyEl.textContent = `Không tải được danh sách: ${err.message || err}`;
        deviceListEl.innerHTML = '';
    }
};

const refreshStatus = async () => {
    try {
        const status = await window.windyLink.getServerStatus();
        statusEl.textContent = status.ready ?
            `Đang chạy · ${status.url}` :
            'Đang khởi động…';
        statusEl.dataset.state = status.ready ? 'ready' : 'pending';
    } catch (err) {
        statusEl.textContent = 'Không kết nối được máy chủ';
        statusEl.dataset.state = 'error';
    }
};

document.getElementById('btn-website').addEventListener('click', () => {
    window.windyLink.openWebsite();
});

document.getElementById('btn-console').addEventListener('click', () => {
    window.windyLink.openConsole();
});

document.getElementById('btn-refresh').addEventListener('click', () => {
    refreshDevices();
});

document.getElementById('btn-settings').addEventListener('click', () => {
    window.windyLink.openWebsite();
});

document.getElementById('btn-close').addEventListener('click', () => {
    window.windyLink.closeWindow();
});

refreshDevices();
refreshStatus();
setInterval(refreshDevices, 3000);
setInterval(refreshStatus, 5000);
