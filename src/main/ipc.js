'use strict';

const { ipcMain, dialog, shell } = require('electron');
const os = require('node:os');
const { startScan, cancelScan } = require('./scanner');
const { runAudit, formatAudit } = require('./security');
const { getSurface } = require('./surface');
const cleaner = require('./cleaner');
const remover = require('./cleaner/remove');

// Channel names must match the preload's CH map.
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

// Tokens are the ONLY thing the cleanup channel accepts. They are v4 UUIDs
// minted by plan(), and the shape is checked here so that a renderer cannot
// hand this channel a path even by accident — `/etc/passwd` is not a UUID and
// is rejected before it reaches a module that would have to reason about it.
//
// Shape is a caller contract and throws. Whether a well-formed token is still
// VALID — known to the ledger, unspent, still true of the disk — is an
// outcome, decided by remove() per item and reported as a skip. A stale token
// from an earlier survey is the ordinary case, not a bug, and it must not take
// the rest of the batch down with it.
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKENS = 10000;

function assertTokenArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array of tokens, got ${typeof value}`);
  }
  if (value.length > MAX_TOKENS) {
    throw new TypeError(`${name} must not exceed ${MAX_TOKENS} tokens, got ${value.length}`);
  }
  for (const token of value) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      throw new TypeError(`${name} must contain only tokens issued by survey()`);
    }
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

  // ---------- Cleanup ----------

  // Survey: what cleanup could remove, per target, with a provenance token for
  // every item. READ-ONLY — it resolves, measures and mints, and touches
  // nothing.
  //
  // Reported INCREMENTALLY, one target at a time, for the same reason the
  // scanner streams: a full survey of ~/Library/Caches/* walks 168 directories
  // and takes about 17 seconds on the machine this was written against. A UI
  // that waits for the whole thing shows nothing for 17 seconds and looks
  // broken. Rows arrive as they are measured.
  //
  // Failure RESOLVES with { ok: false }, matching scan:start: a targets.json
  // that no longer validates is something the person needs told, not an
  // exception to swallow. Electron would flatten a rejection into "Error
  // invoking remote method" and drop the reason.
  ipcMain.handle(CH.cleanerSurvey, async (event) => {
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(CH.cleanerProgress, payload);
    };

    try {
      const platform = process.platform;
      const doc = await cleaner.loadDocument();
      const { targets, omitted } = cleaner.validate(doc);
      const mine = targets.filter((t) => t.platform === platform);

      // Every previous survey's tokens die here. A selection made against a
      // survey the person can no longer see is not a selection, and this also
      // stops the ledger growing without bound across repeated surveys.
      remover.resetLedger();

      // validate() reports omissions by id and reason only. The label and the
      // description live on the raw entry, and the UI needs them: an entry
      // omitted by its own expand contract is shown as unavailable WITH the
      // reason, never left as a gap in the list.
      const raw = new Map((doc.targets || []).map((t) => [t.id, t]));
      const unavailable = omitted
        .filter((o) => {
          const entry = raw.get(o.id);
          return entry && entry.platform === platform;
        })
        .map((o) => {
          const entry = raw.get(o.id) || {};
          return {
            id: o.id,
            label: entry.label || o.id,
            description: entry.description || '',
            risk: entry.risk || 'caution',
            reason: o.reason,
          };
        });

      send({
        phase: 'start',
        total: mine.length,
        pending: mine.map((t) => ({
          id: t.id,
          label: t.label,
          description: t.description,
          risk: t.risk,
          requiresAppClosed: t.requiresAppClosed,
        })),
        unavailable,
      });

      const reports = [];
      for (let i = 0; i < mine.length; i++) {
        const target = mine[i];
        const planned = await remover.plan({ only: target.id });
        const summary = planned.targets[0];
        if (!summary) continue;

        // Tokens grouped by the target that minted them: selecting a row means
        // selecting its items, and the renderer never sees them individually.
        const report = { ...summary, tokens: planned.items.map((it) => it.token) };
        reports.push(report);
        send({ phase: 'target', done: i + 1, total: mine.length, target: report });
      }

      const present = reports.filter((r) => r.present && r.count > 0);
      const result = {
        ok: true,
        platform,
        targets: reports,
        unavailable,
        totals: {
          bytes: present.reduce((a, r) => a + r.bytes, 0),
          count: present.reduce((a, r) => a + r.count, 0),
          present: present.length,
          absent: reports.length - present.length,
        },
      };
      send({ phase: 'done', result });
      return result;
    } catch (err) {
      const failure = {
        ok: false,
        code: err && err.code ? err.code : 'ECLEANERSURVEY',
        detail: err && err.message ? err.message : String(err),
      };
      send({ phase: 'error', ...failure });
      return failure;
    }
  });

  // What is inside a target, by name and date, for the disclosure a per-file
  // target must show before its checkbox can be ticked. Reads the ledger the
  // last survey filled; it walks nothing and removes nothing.
  //
  // Basenames, never paths — see describe(). A target id is not a path: it is a
  // key from an allowlist we shipped, and an unknown one simply matches no
  // ledger entries.
  ipcMain.handle(CH.cleanerContents, (_event, targetId) => {
    assertNonEmptyString(targetId, 'targetId');
    return { ok: true, ...remover.describe(targetId) };
  });

  // Remove: takes tokens, never paths. Every gate in remove.js re-proves each
  // one against the live filesystem before anything is trashed, and each item
  // that does not survive comes back as a skip with a reason.
  ipcMain.handle(CH.cleanerRemove, async (_event, tokens) => {
    assertTokenArray(tokens, 'tokens');
    try {
      const result = await remover.remove(tokens);
      return { ok: true, ...result };
    } catch (err) {
      return {
        ok: false,
        code: err && err.code ? err.code : 'ECLEANERREMOVE',
        detail: err && err.message ? err.message : String(err),
      };
    }
  });
}

module.exports = { registerIpcHandlers };
