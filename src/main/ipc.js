'use strict';

const { ipcMain, dialog, shell } = require('electron');
const os = require('node:os');
const { startScan, cancelScan } = require('./scanner');

// Channel names must match the preload's CH map.
const CH = {
  info: 'app:info',
  chooseFolder: 'dialog:chooseFolder',
  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanProgress: 'scan:progress',
  reveal: 'shell:reveal',
};

// Everything arriving over IPC is untrusted input, even though we authored the
// renderer ourselves. A compromised renderer (or an injected script that slips
// past the CSP) can call these channels with anything. Guard the boundary.
function assertNonEmptyString(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string, got ${typeof value}`);
  }
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function registerIpcHandlers() {
  // Read-only app/environment info. No arguments to validate.
  ipcMain.handle(CH.info, () => ({
    platform: process.platform,
    home: os.homedir(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  // Native folder picker. Returns an absolute path or null on cancel.
  ipcMain.handle(CH.chooseFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Reveal a path in Finder/Explorer.
  ipcMain.handle(CH.reveal, (_event, targetPath) => {
    assertNonEmptyString(targetPath, 'path');
    shell.showItemInFolder(targetPath);
    return true;
  });

  // Run a scan in the worker thread, streaming throttled progress back to the
  // window that asked for it. Resolves with the done payload (tree + stats).
  ipcMain.handle(CH.scanStart, (event, targetPath) => {
    assertNonEmptyString(targetPath, 'path');
    return startScan(targetPath, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(CH.scanProgress, progress);
      }
    });
  });

  ipcMain.handle(CH.scanCancel, () => cancelScan());
}

module.exports = { registerIpcHandlers };
