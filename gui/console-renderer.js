const outputEl = document.getElementById('log-output');
const clearBtn = document.getElementById('btn-clear');
let autoScroll = true;

const formatTime = iso => {
    const date = new Date(iso);
    return date.toLocaleTimeString('vi-VN', {hour12: false});
};

const levelClass = level => {
    if (level === 'error') {
        return 'log-line--error';
    }
    if (level === 'warn') {
        return 'log-line--warn';
    }
    if (level === 'info') {
        return 'log-line--info';
    }
    return 'log-line--log';
};

const appendLine = entry => {
    const line = document.createElement('div');
    line.className = `log-line ${levelClass(entry.level)}`;
    line.textContent = '';
    const ts = document.createElement('span');
    ts.className = 'log-line__ts';
    ts.textContent = formatTime(entry.ts);
    line.appendChild(ts);
    line.appendChild(document.createTextNode(entry.text));
    outputEl.appendChild(line);
    if (autoScroll) {
        outputEl.scrollTop = outputEl.scrollHeight;
    }
};

outputEl.addEventListener('scroll', () => {
    const atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 24;
    autoScroll = atBottom;
});

clearBtn.addEventListener('click', async () => {
    await window.windyConsole.clear();
    outputEl.textContent = '';
    autoScroll = true;
});

const boot = async () => {
    const history = await window.windyConsole.getHistory();
    history.forEach(appendLine);
    window.windyConsole.onEntry(appendLine);
};

boot();
