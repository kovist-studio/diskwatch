'use strict';

// The only module in DiskWatch that deletes anything.
//
// Every other file in this codebase observes. This one acts, so it is written
// on the assumption that its caller is wrong: the renderer may be compromised,
// the selection may be minutes stale, targets.json may have been edited since
// it was read, and the filesystem may have been rearranged underneath all of
// it. None of that is exotic. A cache directory that became a symlink between
// the survey and the click is a Tuesday.
//
// The single delete call is `shell.trashItem`, Electron's own move-to-Trash.
// There is no fs.unlink, no fs.rm, no rmdir here or anywhere in src/, and
// test/remove.test.js fails the build if one appears. Nothing is destroyed:
// every removal lands in the Trash or the Recycle Bin, where the person can
// put it back.
//
// The shape of the module is: plan() mints tokens for what could be removed,
// remove() takes tokens and re-proves every one of them from scratch before it
// touches anything. The proving is in screen(), which is exported so the
// hostile cases can be tested directly — the same reason the security audit
// exports its parsers.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');

const cleaner = require('./index');

// Every way an item can be refused. A closed set, so the UI that eventually
// reads this can phrase each case itself instead of parsing prose.
const REASONS = Object.freeze({
  UNKNOWN_TOKEN: 'unknown-token',
  TOKEN_ALREADY_USED: 'token-already-used',
  TARGET_NOT_IN_ALLOWLIST: 'target-not-in-allowlist',
  NOT_IN_LIVE_SURVEY: 'not-in-live-survey',
  IDENTITY_CHANGED: 'identity-changed',
  IS_SYMLINK: 'is-symlink',
  ESCAPES_TARGET_ROOT: 'escapes-target-root',
  UNDER_EXCLUSION: 'under-exclusion',
  CONTAINS_EXCLUSION: 'contains-exclusion',
  APP_RUNNING: 'app-running',
  APP_CHECK_FAILED: 'app-check-failed',
  TRASH_FAILED: 'trash-failed',
  VANISHED: 'vanished',
});

const APP_CHECK_TIMEOUT_MS = 5000;

// ---------- The delete call ----------

// Resolved lazily so that `node --test`, which has no Electron, never loads it.
// Tests pass their own trasher; nothing else in the module knows the difference.
function defaultTrasher() {
  const { shell } = require('electron');
  return (target) => shell.trashItem(path.resolve(target));
}

// ---------- The session ledger ----------

// token -> entry. In memory, never persisted: "this session" is meant
// literally, and a token from a previous run of the app is not a token.
const ledger = new Map();

// ---------- Enumeration ----------

// What counts as one removable item, decided by data already in targets.json
// rather than a new field:
//   minAgeDays absent  -> the glob root is the item (a whole cache directory)
//   minAgeDays present -> each eligible file is an item, never the folder
function unitOf(target) {
  return target.minAgeDays === undefined ? 'root' : 'file';
}

async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

async function realpathOrNull(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

// An item collides with an exclusion if it sits under one OR contains one.
//
// The second half is the one that matters and the one that is easy to miss.
// measure() applies a target's exclusions to the children it walks — it does
// not apply them to the roots. An excluded directory therefore measures as
// zero bytes and looks inert in a survey, while still being returned as a
// glob root in its own right. The exclusion that is correct for *measuring*
// is silently wrong for *removing*: trash each root and the exclusion goes
// with it, having advertised itself as empty the whole way there.
//
// Concretely, on this machine on 2026-08-27, `~/Library/Caches/*` returned
// 168 roots and three of them WERE the exclusions — Homebrew, pip, and
// JetBrains. Without this check `~/Library/Caches/JetBrains` goes to the
// Trash carrying LocalHistory: a developer's uncommitted edit history, the
// exact thing the V3 allowlist decision exists to protect. The root count is
// a snapshot that drifts with whatever is installed; the three are fixed by
// the target's own exclude list, which is the half worth remembering.
function exclusionClash(itemPath, excludes) {
  for (const ex of excludes) {
    if (cleaner.isUnder(itemPath, ex)) return REASONS.UNDER_EXCLUSION;
    if (cleaner.isUnder(ex, itemPath)) return REASONS.CONTAINS_EXCLUSION;
  }
  return null;
}

// Resolves one target the way survey() does and returns its removable items.
// Both plan() and screen() call this, so the list a token was minted from and
// the list it is checked against are produced by the same code.
async function enumerateTarget(target, options = {}) {
  const wantSizes = options.sizes === true;
  const resolved = cleaner.resolvePath(target.path, options);
  const roots = resolved ? await cleaner.expandGlob(resolved) : [];
  const excludes = (target.exclude || [])
    .map((ex) => cleaner.resolvePath(ex, options))
    .filter(Boolean);
  const kind = unitOf(target);

  const items = [];
  const refused = [];

  for (const root of roots) {
    if (kind === 'root') {
      const clash = exclusionClash(root, excludes);
      if (clash) {
        refused.push({ path: root, reason: clash });
        continue;
      }
      const st = await lstatOrNull(root);
      if (!st || st.isSymbolicLink()) continue;

      let bytes = 0;
      if (wantSizes) {
        const m = await cleaner.measure(root, { exclude: excludes, now: options.now });
        bytes = m ? m.bytes : 0;
      }
      items.push({ path: root, root, kind, bytes, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs });
      continue;
    }

    // Age-filtered: the walk decides which files are eligible, applying the
    // same symlink, mount-point and exclusion rules it applies when measuring.
    const m = await cleaner.measure(root, {
      exclude: excludes,
      minAgeDays: target.minAgeDays,
      now: options.now,
      collect: true,
    });
    if (!m || !m.items) continue;
    for (const it of m.items) {
      items.push({
        path: it.path,
        root,
        kind,
        bytes: it.size,
        dev: it.dev,
        ino: it.ino,
        mtimeMs: it.mtimeMs,
      });
    }
  }

  return { items, refused, roots, excludes, kind, base: cleaner.globBase(resolved || target.path) };
}

// ---------- Is the app running? ----------

// Display names in requiresAppClosed are what a person calls the app. These
// are the process names the OS calls it. A name absent from this table cannot
// be checked, and an unanswerable check is a refusal, never a pass.
const PROCESS_NAMES = Object.freeze({
  darwin: {
    Xcode: ['xcode'],
    Simulator: ['simulator'],
    Finder: ['finder'],
    iTunes: ['itunes', 'music'],
  },
  win32: {
    'Google Chrome': ['chrome.exe'],
    'Microsoft Edge': ['msedge.exe'],
    Firefox: ['firefox.exe'],
  },
});

// Never rejects — a failed command is data, not an exception. Same contract as
// the runner in src/main/security/macos.js, and for the same reason: a missing
// binary and a binary that printed nonsense have to be told apart.
function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: APP_CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) =>
          resolve({ stdout: stdout || '', stderr: stderr || '', error: error || null }),
      );
    } catch (err) {
      resolve({ stdout: '', stderr: '', error: err });
    }
  });
}

// Returns a Set of lowercased process names, or throws. Throwing is the point:
// the caller turns any failure here into a refusal.
async function listRunning(platform, options = {}) {
  const runner = options.runner || run;

  if (platform === 'darwin') {
    const { stdout, error } = await runner('/bin/ps', ['-axo', 'comm=']);
    if (error) throw new Error(`ps failed: ${error.message}`);
    if (stdout.trim() === '') throw new Error('ps returned nothing');
    return new Set(
      stdout
        .split('\n')
        .map((line) => path.basename(line.trim()).toLowerCase())
        .filter(Boolean),
    );
  }

  if (platform === 'win32') {
    const { stdout, error } = await runner('tasklist', ['/FO', 'CSV', '/NH']);
    if (error) throw new Error(`tasklist failed: ${error.message}`);
    if (stdout.trim() === '') throw new Error('tasklist returned nothing');
    return new Set(
      stdout
        .split('\n')
        .map((line) => (line.match(/^"([^"]+)"/) || [])[1])
        .filter(Boolean)
        .map((name) => name.toLowerCase()),
    );
  }

  throw new Error(`no process listing for platform ${platform}`);
}

// { blocked: [names], error: Error|null }. An error means we could not tell,
// which screen() treats exactly as "running".
async function appStatus(names, platform, options = {}) {
  if (!Array.isArray(names) || names.length === 0) return { blocked: [], error: null };

  let running;
  try {
    running = await listRunning(platform, options);
  } catch (err) {
    return { blocked: [], error: err };
  }

  const table = PROCESS_NAMES[platform] || {};
  const blocked = [];
  for (const name of names) {
    const candidates = table[name];
    if (!candidates) {
      // A requiresAppClosed entry this table has never heard of. Refusing is
      // the only safe reading: we cannot show it is closed.
      return { blocked: [], error: new Error(`no process name known for "${name}" on ${platform}`) };
    }
    if (candidates.some((c) => running.has(c))) blocked.push(name);
  }
  return { blocked, error: null };
}

// ---------- Context ----------

// Everything screen() needs that is worth computing once per remove() call
// rather than once per item: the re-read allowlist, the live enumeration per
// target, and the process list.
async function createContext(options = {}) {
  const platform = options.platform || process.platform;
  const doc = options.doc || (await cleaner.loadDocument(options.file));

  let targets = null;
  let docError = null;
  try {
    ({ targets } = cleaner.validate(doc, options));
  } catch (err) {
    // A targets.json that no longer validates is not a reason to fall back to
    // the copy we read earlier. It is a reason to refuse everything.
    docError = err;
  }

  return {
    platform,
    options,
    targets,
    docError,
    live: new Map(),
    apps: new Map(),
  };
}

async function liveFor(context, target) {
  if (!context.live.has(target.id)) {
    context.live.set(target.id, await enumerateTarget(target, context.options));
  }
  return context.live.get(target.id);
}

async function appsFor(context, target) {
  if (!context.apps.has(target.id)) {
    context.apps.set(
      target.id,
      await appStatus(target.requiresAppClosed, context.platform, context.options),
    );
  }
  return context.apps.get(target.id);
}

// ---------- The gate ----------

const refuse = (reason, detail) => ({ ok: false, reason, detail });

// Re-proves one ledger entry against the world as it is right now. Nothing is
// trusted from when the token was minted except the claim of what was seen.
//
// Order matters only in that it decides which reason a caller is told first;
// every gate is checked before anything is trashed.
async function screen(entry, context) {
  // 2. The allowlist, re-read from disk and re-validated this call.
  if (context.docError) {
    return refuse(REASONS.TARGET_NOT_IN_ALLOWLIST, `targets.json no longer validates: ${context.docError.message}`);
  }
  const target = context.targets.find((t) => t.id === entry.targetId);
  if (!target) {
    return refuse(REASONS.TARGET_NOT_IN_ALLOWLIST, `no target "${entry.targetId}" in the allowlist`);
  }
  if (target.platform !== context.platform) {
    return refuse(REASONS.TARGET_NOT_IN_ALLOWLIST, `target "${entry.targetId}" is not for ${context.platform}`);
  }

  // 3. The live survey. A target that moved, a glob that no longer matches, or
  // a file that is no longer old enough all land here.
  const live = await liveFor(context, target);
  const stillListed = live.items.find((it) => it.path === entry.path);
  if (!stillListed) {
    return refuse(REASONS.NOT_IN_LIVE_SURVEY, 'the live survey no longer lists this path for its target');
  }

  // 4/5. The object at that path, right now.
  const st = await lstatOrNull(entry.path);
  if (!st) return refuse(REASONS.VANISHED, 'gone since it was surveyed');
  if (st.isSymbolicLink()) return refuse(REASONS.IS_SYMLINK, 'the path is a symlink');

  if (st.dev !== entry.dev || st.ino !== entry.ino) {
    return refuse(
      REASONS.IDENTITY_CHANGED,
      `expected dev/ino ${entry.dev}/${entry.ino}, found ${st.dev}/${st.ino}`,
    );
  }
  if (entry.kind === 'file' && (st.size !== entry.bytes || st.mtimeMs !== entry.mtimeMs)) {
    return refuse(REASONS.IDENTITY_CHANGED, 'the file changed since it was surveyed');
  }

  // 6. Symlink escape, on the item AND on its root.
  //
  // Checking the item alone is not enough: the root itself can be swapped for
  // a symlink, and then every "child" of it is really a child of somewhere
  // else. Both sides are compared after resolution, because a cache directory
  // that is really a link to a real one is precisely how an allowlist leaks.
  const realItem = await realpathOrNull(entry.path);
  const realRoot = await realpathOrNull(entry.root);
  const realBase = await realpathOrNull(live.base);
  if (!realItem || !realRoot) {
    return refuse(REASONS.ESCAPES_TARGET_ROOT, 'the path or its root could not be resolved');
  }
  if (!cleaner.isUnder(realItem, realRoot)) {
    return refuse(REASONS.ESCAPES_TARGET_ROOT, `${realItem} resolves outside ${realRoot}`);
  }
  if (realBase && !cleaner.isUnder(realRoot, realBase)) {
    return refuse(REASONS.ESCAPES_TARGET_ROOT, `the root ${realRoot} resolves outside ${realBase}`);
  }

  // 7. Exclusions, checked on both the literal and the resolved path so an
  // exclusion reached through a link still counts.
  const clash =
    exclusionClash(entry.path, live.excludes) ||
    exclusionClash(realItem, live.excludes);
  if (clash) return refuse(clash, 'the path collides with one of the target\'s exclusions');

  // 8. Is anything that must be closed still open? Fails closed: an
  // unanswerable check refuses, exactly as the security audit reports
  // 'unknown' rather than a false all-clear.
  const apps = await appsFor(context, target);
  if (apps.error) {
    return refuse(REASONS.APP_CHECK_FAILED, `could not determine whether the app is running: ${apps.error.message}`);
  }
  if (apps.blocked.length > 0) {
    return refuse(REASONS.APP_RUNNING, `${apps.blocked.join(', ')} must be closed first`);
  }

  // For a file the size is live, because it was just lstat'd anyway. For a
  // whole directory it is the figure measured at plan() time: re-walking every
  // root to report a number would roughly double the cost of a removal, and
  // the number is only ever shown as "you freed about this much". It is
  // deliberately the surveyed size, not a fresh one.
  return { ok: true, bytes: entry.kind === 'file' ? st.size : entry.bytes };
}

// ---------- plan() ----------

// Surveys, enumerates, and mints one single-use token per removable item.
// Nothing is removable that did not come out of here.
//
// options.only narrows the work to the named target ids. It is a performance
// filter and nothing more — it can only ever plan FEWER targets, never reach
// one that is not already in the validated allowlist for this platform.
// Without it a single-target run would walk every cache directory on the
// machine (167 of them here) to size targets the caller did not ask about.
async function plan(options = {}) {
  const platform = options.platform || process.platform;
  const doc = options.doc || (await cleaner.loadDocument(options.file));
  const { targets, omitted } = cleaner.validate(doc, options);

  const only = options.only === undefined ? null : [options.only].flat();

  const items = [];
  const refused = [];

  const selected = targets.filter(
    (t) => t.platform === platform && (only === null || only.includes(t.id)),
  );

  const reports = [];

  for (const target of selected) {
    const live = await enumerateTarget(target, { ...options, sizes: true });

    for (const r of live.refused) {
      refused.push({ targetId: target.id, path: r.path, reason: r.reason });
    }

    // Presence is a property of the glob, not of the item count. A target with
    // no roots is not installed on this machine; a target with roots but no
    // items is installed and has nothing to remove — every root excluded, or
    // simply empty. The UI states those differently, so they cannot collapse
    // into one "nothing here" case.
    reports.push({
      id: target.id,
      label: target.label,
      description: target.description,
      risk: target.risk,
      present: live.roots.length > 0,
      bytes: live.items.reduce((a, i) => a + i.bytes, 0),
      count: live.items.length,
      refusedCount: live.refused.length,
      requiresAppClosed: target.requiresAppClosed,
      minAgeDays: target.minAgeDays,
      unit: live.kind,
    });

    for (const it of live.items) {
      const token = randomUUID();
      ledger.set(token, {
        token,
        targetId: target.id,
        root: it.root,
        path: it.path,
        kind: it.kind,
        bytes: it.bytes,
        dev: it.dev,
        ino: it.ino,
        mtimeMs: it.mtimeMs,
        used: false,
      });
      items.push({
        token,
        targetId: target.id,
        label: target.label,
        risk: target.risk,
        path: it.path,
        kind: it.kind,
        bytes: it.bytes,
        requiresAppClosed: target.requiresAppClosed,
      });
    }
  }

  return {
    platform,
    planned: selected.map((t) => t.id),
    items,
    // Per-target summaries, in allowlist order. `items` stays the module's own
    // record of what may be removed; this is the same run described one row at
    // a time, which is the shape a list of checkboxes needs.
    targets: reports,
    refused,
    omitted,
    totals: {
      count: items.length,
      bytes: items.reduce((a, i) => a + i.bytes, 0),
    },
  };
}

// ---------- remove() ----------

// The one function that deletes. It takes tokens — never paths.
//
// A path from the renderer is a string someone could have typed; a token is a
// receipt for something this process actually saw on disk during this session.
// That is the whole reason the ledger exists, and it is why there is no
// overload here that accepts a path or an id.
async function remove(tokens, options = {}) {
  if (!Array.isArray(tokens)) {
    throw new TypeError('remove() takes an array of tokens from plan(), not a path');
  }

  const trasher = options.trasher || defaultTrasher();
  const context = await createContext(options);

  const trashed = [];
  const skipped = [];

  // Sequential on purpose. Promise.all would abandon the rest of the list on
  // the first rejection, and per-item failure is the expected case here: a
  // file locked by a running process on Windows is normal, not exceptional.
  for (const token of tokens) {
    if (typeof token !== 'string' || !ledger.has(token)) {
      skipped.push({
        targetId: null,
        path: null,
        reason: REASONS.UNKNOWN_TOKEN,
        detail: 'not a token issued by plan() in this session',
      });
      continue;
    }

    const entry = ledger.get(token);
    if (entry.used) {
      skipped.push({
        targetId: entry.targetId,
        path: entry.path,
        reason: REASONS.TOKEN_ALREADY_USED,
        detail: 'this token has already been spent',
      });
      continue;
    }

    const verdict = await screen(entry, context);
    if (!verdict.ok) {
      skipped.push({
        targetId: entry.targetId,
        path: entry.path,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      continue;
    }

    // Spent at the moment of the attempt, not on success. After the trasher
    // has been called the recorded identity describes a state that may no
    // longer exist, so the honest move is to make the caller re-plan.
    entry.used = true;

    try {
      await trasher(entry.path);
      trashed.push({ targetId: entry.targetId, path: entry.path, bytes: verdict.bytes });
    } catch (err) {
      // Recorded and moved past. Never forced, never retried: a locked file is
      // locked for a reason, and an installer mid-run keeps its working state
      // in exactly the directories this app offers to clean.
      skipped.push({
        targetId: entry.targetId,
        path: entry.path,
        reason: REASONS.TRASH_FAILED,
        detail: err && err.message ? err.message : String(err),
      });
    }
  }

  return {
    trashed,
    skipped,
    totals: {
      trashedCount: trashed.length,
      trashedBytes: trashed.reduce((a, t) => a + t.bytes, 0),
      skippedCount: skipped.length,
    },
  };
}

// ---------- describe() ----------

// What a target's pending items actually ARE, for a UI that has to show a
// person their own files before asking about them.
//
// Read from the ledger rather than by walking again: the entries are already
// there, so this is instant, and — more to the point — it describes exactly the
// items the tokens will act on. A fresh walk could return a different set from
// the one the tokens were minted for, and then the list a person read would not
// be the list they agreed to.
//
// NAMES ONLY. A basename is what someone recognises a file by; the directory
// path above it adds nothing they do not already know and is the part worth not
// sending. The token travels with each row so a future per-file selection needs
// no new channel.
function describe(targetId, options = {}) {
  const max = options.max === undefined ? 2000 : options.max;
  const rows = [];
  let total = 0;

  for (const entry of ledger.values()) {
    if (entry.targetId !== targetId || entry.used) continue;
    total += 1;
    rows.push({
      token: entry.token,
      name: path.basename(entry.path),
      bytes: entry.bytes,
      mtimeMs: entry.mtimeMs,
    });
  }

  // Newest first: the most recently touched are the ones most likely to still
  // be wanted, so they are the ones to put in front of the person.
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const items = rows.slice(0, max);
  // Never a silent cap. The caller is told the true total so the UI can say
  // what it is not showing.
  return { items, total, shown: items.length };
}

// Test seam. The ledger is process-local and this drops it, so one test's
// tokens can never be spent by another.
function resetLedger() {
  ledger.clear();
}

module.exports = {
  plan,
  remove,
  screen,
  createContext,
  enumerateTarget,
  describe,
  exclusionClash,
  appStatus,
  listRunning,
  unitOf,
  resetLedger,
  REASONS,
  PROCESS_NAMES,
};
