const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('windyLink', {
    listDevices: () => ipcRenderer.invoke('devices:list'),
    openWebsite: () => ipcRenderer.invoke('app:openWebsite'),
    openConsole: () => ipcRenderer.invoke('app:openConsole'),
    getServerStatus: () => ipcRenderer.invoke('server:status'),
    minimizeWindow: () => ipcRenderer.send('window:minimize'),
    closeWindow: () => ipcRenderer.send('window:close')
});
