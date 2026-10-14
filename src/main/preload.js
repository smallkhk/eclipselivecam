// Bridge between the bundled pages and the app. Pages check for
// window.eclipseDesktop to light up desktop-only features (virtual camera).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eclipseDesktop', {
  vcamFrame: (rgba) => ipcRenderer.send('vcam:frame', rgba),
  vcamStatus: () => ipcRenderer.invoke('vcam:status'),
  vcamInstall: () => ipcRenderer.invoke('vcam:install'),
  onVcamStatus: (cb) => ipcRenderer.on('vcam:status', (e, s) => cb(s)),
  version: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
});
