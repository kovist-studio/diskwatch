'use strict';

const { contextBridge } = require('electron');

// Narrow, deliberate surface. Nothing is exposed yet — future IPC wrappers
// go here. Never expose ipcRenderer (or any raw Electron object) directly.
contextBridge.exposeInMainWorld('diskwatch', {});
