'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Channel names are an implementation detail — they stay inside the preload.
// The renderer only ever sees the small, named `api` surface below.
const CH = {
  info: 'app:info',
  chooseFolder: 'dialog:chooseFolder',
  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanProgress: 'scan:progress',
  reveal: 'shell:reveal',
};

const api = {
  // Resolves to { platform, home, electron, node }. It's a Promise because
  // `home` (os.homedir) lives in the main process; the sandboxed preload has
  // no `os` module.
  platform: () => ipcRenderer.invoke(CH.info),

  // Resolves to an absolute path, or null if the user cancels.
  chooseFolder: () => ipcRenderer.invoke(CH.chooseFolder),

  scan: {
    start: (targetPath) => ipcRenderer.invoke(CH.scanStart, targetPath),
    cancel: () => ipcRenderer.invoke(CH.scanCancel),

    // Subscribe to scan progress. Returns a real unsubscribe function so the
    // renderer can always detach and never leaks listeners.
    onProgress: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('onProgress expects a callback function');
      }
      // Wrap the listener so the raw IpcRendererEvent (which carries a
      // `sender` reference) never reaches the renderer — only the payload does.
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on(CH.scanProgress, listener);
      return () => ipcRenderer.removeListener(CH.scanProgress, listener);
    },
  },

  // Resolves to true once the OS file manager has been asked to reveal the path.
  reveal: (targetPath) => ipcRenderer.invoke(CH.reveal, targetPath),
};

// Expose exactly `window.api` and nothing else. ipcRenderer itself is never
// exposed — the renderer cannot reach arbitrary channels.
contextBridge.exposeInMainWorld('api', api);
