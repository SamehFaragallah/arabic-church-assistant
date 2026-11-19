// What the pages may ask the desktop app for (window.vfDesktop). In a normal browser it doesn't exist,
// and the pages fall back to browser behaviour.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vfDesktop', {
  displays: () => ipcRenderer.invoke('vf:displays'),
  openDisplay: () => ipcRenderer.invoke('vf:display-open'),
  closeDisplay: () => ipcRenderer.invoke('vf:display-close'),
  displayState: () => ipcRenderer.invoke('vf:display-state'),
  toggleDisplayFullscreen: () => ipcRenderer.invoke('vf:display-fullscreen'),
  pickFile: () => ipcRenderer.invoke('vf:pick-file'),
  openExternal: url => ipcRenderer.invoke('vf:open-external', url),
  openFolder: which => ipcRenderer.invoke('vf:open-folder', which),
  info: () => ipcRenderer.invoke('vf:info'),
  onDisplayState: fn => ipcRenderer.on('display-state', (e, st) => fn(st)),
});
