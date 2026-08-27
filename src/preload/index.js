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
  securityAudit: 'security:audit',
  cleanerSurvey: 'cleaner:survey',
  cleanerRemove: 'cleaner:remove',
  cleanerProgress: 'cleaner:progress',
  cleanerContents: 'cleaner:contents',
  checkerCheck: 'checker:check',
  checkerStatus: 'checker:status',
  checkerRefresh: 'checker:refresh',
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

  security: {
    // Resolves to { platform, supported, checks[] }. Read-only: running this
    // never changes a setting and never asks for elevation.
    audit: () => ipcRenderer.invoke(CH.securityAudit),
  },

  cleaner: {
    // Resolves to { ok, platform, targets[], unavailable[], totals }. Each
    // target carries its own opaque tokens. Read-only: surveying measures and
    // mints, and removes nothing.
    //
    // Slow by nature — a full survey walks every cache directory on the
    // machine — so subscribe with onProgress first and let rows arrive.
    survey: () => ipcRenderer.invoke(CH.cleanerSurvey),

    // Takes ONLY tokens from a survey in this session. There is deliberately
    // no overload here that accepts a path or a target id: the renderer has no
    // way to name a thing on disk, and that is the point of the whole design.
    // Resolves to { ok, trashed[], skipped[], totals }.
    remove: (tokens) => ipcRenderer.invoke(CH.cleanerRemove, tokens),

    // Resolves to { ok, items: [{ token, name, bytes, mtimeMs }], total, shown }.
    // Names, not paths: enough to recognise your own file, and no more.
    contents: (targetId) => ipcRenderer.invoke(CH.cleanerContents, targetId),

    // Subscribe to survey progress. Returns a real unsubscribe function, the
    // same contract as scan.onProgress.
    onProgress: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('onProgress expects a callback function');
      }
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on(CH.cleanerProgress, listener);
      return () => ipcRenderer.removeListener(CH.cleanerProgress, listener);
    },
  },

  checker: {
    // Resolves to { ok, found[], results[], cache }. Each result carries the
    // blocklist finding and the three heuristic signals SEPARATELY. There is
    // no score and no verdict in the payload, deliberately — the renderer is
    // required to show the signals rather than a conclusion drawn from them.
    check: (text) => ipcRenderer.invoke(CH.checkerCheck, text),

    // How old the cached lists are. A "not found" from a six-day-old cache is
    // a weaker claim than one from this morning, and the UI says which.
    status: () => ipcRenderer.invoke(CH.checkerStatus),

    // Fetch anything due and rebuild if the content changed. Both are no-ops
    // when nothing is stale.
    refresh: () => ipcRenderer.invoke(CH.checkerRefresh),
  },
};

// Expose exactly `window.api` and nothing else. ipcRenderer itself is never
// exposed — the renderer cannot reach arbitrary channels.
contextBridge.exposeInMainWorld('api', api);
