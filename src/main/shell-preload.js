// Bridge for the title bar / settings screen (shell.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  info: () => ipcRenderer.invoke('shell:info'),
  minimize: () => ipcRenderer.invoke('shell:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('shell:toggle-maximize'),
  close: () => ipcRenderer.invoke('shell:close'),
  showSettings: (show) => ipcRenderer.invoke('shell:show-settings', show),
  setSetting: (key, value) => ipcRenderer.invoke('shell:set-setting', key, value),
  reload: () => ipcRenderer.invoke('shell:reload'),
  clearCache: () => ipcRenderer.invoke('shell:clear-cache'),
  installCamera: () => ipcRenderer.invoke('vcam:install'),
  onMaximized: (cb) => ipcRenderer.on('shell:maximized', (e, v) => cb(v)),
  onSettingsVisible: (cb) => ipcRenderer.on('shell:settings-visible', (e, v) => cb(v)),
  onCameraStatus: (cb) => ipcRenderer.on('vcam:status', (e, s) => cb(s)),
});
