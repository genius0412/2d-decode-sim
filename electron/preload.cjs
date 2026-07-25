// Bridges a SMALL, safe update API to the renderer (contextIsolation stays on,
// nodeIntegration off). The web UI shows the desktop version + update controls
// only when window.dsim exists (i.e. running inside the Electron app).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsim', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('dsim:version'),
  // check now (no native dialog) → { current, latest, updateAvailable }
  check: () => ipcRenderer.invoke('dsim:check'),
  getAutoCheck: () => ipcRenderer.invoke('dsim:getAuto'),
  setAutoCheck: (v) => ipcRenderer.invoke('dsim:setAuto', !!v),
  openDownload: () => ipcRenderer.invoke('dsim:openDownload'),
});
