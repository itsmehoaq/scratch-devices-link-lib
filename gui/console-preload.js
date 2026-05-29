const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('windyConsole', {
    getHistory: () => ipcRenderer.invoke('console:getHistory'),
    clear: () => ipcRenderer.invoke('console:clear'),
    onEntry: callback => {
        const handler = (_event, entry) => callback(entry);
        ipcRenderer.on('console:entry', handler);
        return () => ipcRenderer.removeListener('console:entry', handler);
    }
});
