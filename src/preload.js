const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getState: () => ipcRenderer.invoke('get-state'),
    startBot: () => ipcRenderer.send('start-bot'),
    stopBot: () => ipcRenderer.send('stop-bot'),
    saveCredentials: (email, password) => ipcRenderer.invoke('save-credentials', email, password),
    quit: () => ipcRenderer.send('quit'),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
    logout: () => ipcRenderer.invoke('logout'),
    showLogin: () => ipcRenderer.send('show-login'),
    onStateUpdate: (callback) => ipcRenderer.on('state-update', (_, data) => callback(data))
});
