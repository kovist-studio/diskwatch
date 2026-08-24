'use strict';

const { ipcMain, dialog, shell } = require('electron');
const os = require('node:os');
const { startScan, cancelScan } = require('./scanner');
const { runAudit, formatAudit } = require('./security');
const { getSurface } = require('./surface');

// Channel names must match the preload's CH map.
const CH = {
  info: 'app:info',
  chooseFolder: 'dialog:chooseFolder',
  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanProgress: 'scan:progress',
  reveal: 'shell:reveal',
  securityAudit: 'security:audit',
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
    // Which window material the app actually got, so the renderer knows
    // whether its chrome may be translucent. 'solid' means it may not.
    surface: getSurface(),
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
  // window that asked for it.
  //
  // A failed scan RESOLVES with { ok: false, code } rather than rejecting. A
  // rejection would not survive the trip: Electron rewrites the message into
  // "Error invoking remote method ..." and drops custom properties, so the
  // error code — the one thing that lets the UI say which failure this was —
  // would be gone by the time the renderer saw it. An unreadable folder is a
  // scan outcome, not an exception.
  //
  // A malformed argument still throws. That is a caller bug, not an outcome,
  // and the P2 boundary contract is unchanged.
  ipcMain.handle(CH.scanStart, async (event, targetPath) => {
    assertNonEmptyString(targetPath, 'path');
    try {
      const done = await startScan(targetPath, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(CH.scanProgress, progress);
        }
      });
      return { ok: true, ...done };
    } catch (err) {
      return {
        ok: false,
        code: err && err.code ? err.code : 'ESCANFAILED',
        detail: err && err.message ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(CH.scanCancel, () => cancelScan());

  // Read-only security audit. No arguments to validate. It never changes a
  // setting and never asks for elevation — checks that would need admin
  // rights come back as 'unknown' with the reason.
  //
  // Runs only when asked. Nothing here fires on launch: an audit that greets
  // you with warnings before you have asked anything is a nag, and this app
  // does not nag.
  ipcMain.handle(CH.securityAudit, async () => {
    const audit = await runAudit();
    // No UI yet — the console is the readout for this phase.
    console.log(formatAudit(audit));
    return audit;
  });
}

module.exports = { registerIpcHandlers };
