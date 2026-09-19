const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    selectFiles: () => ipcRenderer.invoke('select-files'),
    startServer: () => ipcRenderer.invoke('start-server'),
    stopServer: () => ipcRenderer.invoke('stop-server'),
    openUploadFolder: () => ipcRenderer.invoke('open-upload-folder'),
    getUploadDir: () => ipcRenderer.invoke('get-upload-dir'),
    onLog: (callback) => ipcRenderer.on('log', (_, msg) => callback(msg)),
    onFileStatus: (callback) => ipcRenderer.on('file-status', (_, data) => callback(data)),
    onFileUploaded: (callback) => ipcRenderer.on('file-uploaded', (_, data) => callback(data))
});
