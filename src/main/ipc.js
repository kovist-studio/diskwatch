'use strict';

const { ipcMain, dialog, shell } = require('electron');
const os = require('node:os');

// Channel names must match the preload's CH map.
const CH = {
  info: 'app:info',
  chooseFolder: 'dialog:chooseFolder',
  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
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

  // Stubs until the worker-thread scanner lands. Still validate the argument
  // so the contract is enforced from day one.
  ipcMain.handle(CH.scanStart, (_event, targetPath) => {
    assertNonEmptyString(targetPath, 'path');
    throw new Error('scan:start not implemented');
  });

  ipcMain.handle(CH.scanCancel, () => {
    throw new Error('scan:cancel not implemented');
  });
}

module.exports = { registerIpcHandlers };
