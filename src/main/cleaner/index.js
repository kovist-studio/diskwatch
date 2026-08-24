'use strict';

// The targets loader. READ-ONLY: it resolves what is on disk and reports what
// cleanup *would* remove. Nothing in this file deletes, moves, or writes.
//
// targets.json carries contracts — the trash exception, the expand
// requirement, the exclusions — that are inert as long as they are only read
// by people. This module is what keeps them. Every rule below fails LOUDLY on
// load, because a cleanup allowlist that silently degrades is worse than no
// allowlist: it still runs, it just no longer means what it says.

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const TARGETS_FILE = path.join(__dirname, 'targets.json');

// The two ids CLAUDE.md permits to delete permanently, verbatim and closed.
// This is not configuration. A third id here is a change to the app's only
// irreversible operation and must be argued for in CLAUDE.md first.
const EMPTY_TRASH_IDS = Object.freeze(['macos-trash', 'windows-recycle-bin']);

const CONFIRM_FIELDS = Object.freeze([
  'style',
  'mustState',
  'mustContainWord',
  'separateCodePath',
  'excludeFromSelectAll',
]);
const CONFIRM_MUST_STATE = Object.freeze(['itemCount', 'totalSize']);
const CONFIRM_WORD = 'permanently';

const REQUIRED_FIELDS = Object.freeze([
  'id',
  'label',
  'platform',
  'path',
  'description',
  'risk',
  'defaultEnabled',
  'requiresAppClosed',
]);

const PLATFORMS = Object.freeze(['darwin', 'win32']);
const RISKS = Object.freeze(['safe', 'caution']);

// Handlers that know how to turn one target into the individually selectable
// items its expand contract demands. Empty in this phase: nothing can expand
// yet, which is exactly the condition ifUnsupported exists to describe.
const EXPAND_HANDLERS = new Map();

class TargetsError extends Error {
  constructor(problems) {
    const list = problems.map((p) => `  - ${p}`).join('\n');
    super(`targets.json failed validation:\n${list}`);
    this.name = 'TargetsError';
    this.problems = problems;
  }
}

// ---------- Validation ----------

// Returns { targets, omitted }. Throws TargetsError listing EVERY problem
// found rather than the first — a malformed file should be fixed in one pass.
function validate(doc, options = {}) {
  const handlers = options.handlers || EXPAND_HANDLERS;
  const problems = [];
  const omitted = [];

  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.targets)) {
    throw new TargetsError(['the document has no targets array']);
  }

  const seen = new Set();
  const kept = [];

  for (const t of doc.targets) {
    const id = t && typeof t.id === 'string' ? t.id : '(entry with no id)';

    for (const field of REQUIRED_FIELDS) {
      if (!(field in t)) problems.push(`${id}: missing required field "${field}"`);
    }
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);

    if (!PLATFORMS.includes(t.platform)) problems.push(`${id}: platform must be one of ${PLATFORMS.join(', ')}`);
    if (!RISKS.includes(t.risk)) problems.push(`${id}: risk must be one of ${RISKS.join(', ')}`);
    if (!Array.isArray(t.requiresAppClosed)) problems.push(`${id}: requiresAppClosed must be an array`);

    // RULE: nothing is pre-selected. Cleanup is a thing a person chooses,
    // never a thing they find already chosen for them.
    if (t.defaultEnabled !== false) {
      problems.push(`${id}: defaultEnabled must be false — no target may ship pre-selected`);
    }

    // RULE: the trash exception is closed.
    if (t.method !== undefined && t.method !== 'trash' && t.method !== 'emptyTrash') {
      problems.push(`${id}: method must be "trash" or "emptyTrash", got "${t.method}"`);
    }
    if (t.method === 'emptyTrash') {
      if (!EMPTY_TRASH_IDS.includes(id)) {
        problems.push(
          `${id}: method "emptyTrash" is permitted only for ${EMPTY_TRASH_IDS.join(' and ')}. ` +
            'Permanent deletion is the app\'s single documented exception and this id is not in it.',
        );
      }
      problems.push(...validateConfirm(id, t.confirm));
    } else if (t.confirm !== undefined) {
      problems.push(`${id}: carries a confirm contract but does not delete permanently`);
    }

    problems.push(...validateExclusions(id, t));

    // RULE: an expand contract is a requirement, not a suggestion.
    if (t.expand && t.expand.required) {
      const unit = t.expand.unit;
      if (t.expand.wholeTargetSelectable !== false) {
        problems.push(`${id}: expand.wholeTargetSelectable must be false — that is what the contract is for`);
      }
      if (!handlers.has(unit)) {
        if (t.expand.ifUnsupported === 'omit') {
          // The designed outcome: the entry does not ship at all rather than
          // degrading into one checkbox over the whole folder.
          omitted.push({ id, reason: `no handler for expand unit "${unit}"; ifUnsupported=omit` });
          continue;
        }
        problems.push(
          `${id}: expand.required with no handler for unit "${unit}" and ifUnsupported=` +
            `${JSON.stringify(t.expand.ifUnsupported)}. It must be handled or omitted; it may never ` +
            'degrade to a folder-level checkbox.',
        );
      }
    }

    kept.push(t);
  }

  // RULE: exactly two, counted across the whole file.
  const permanent = doc.targets.filter((t) => t && t.method === 'emptyTrash').map((t) => t.id);
  if (permanent.length !== EMPTY_TRASH_IDS.length) {
    problems.push(
      `expected exactly ${EMPTY_TRASH_IDS.length} entries with method "emptyTrash", found ` +
        `${permanent.length}${permanent.length ? ` (${permanent.join(', ')})` : ''}`,
    );
  }

  if (problems.length > 0) throw new TargetsError(problems);
  return { targets: kept, omitted };
}

function validateConfirm(id, confirm) {
  const problems = [];
  if (!confirm || typeof confirm !== 'object') {
    return [`${id}: deletes permanently but carries no confirm contract`];
  }
  for (const field of CONFIRM_FIELDS) {
    if (!(field in confirm)) problems.push(`${id}: confirm is missing "${field}"`);
  }
  const stated = Array.isArray(confirm.mustState) ? confirm.mustState : [];
  for (const field of CONFIRM_MUST_STATE) {
    if (!stated.includes(field)) problems.push(`${id}: confirm.mustState must include "${field}"`);
  }
  if (confirm.mustContainWord !== CONFIRM_WORD) {
    problems.push(`${id}: confirm.mustContainWord must be "${CONFIRM_WORD}"`);
  }
  if (confirm.separateCodePath !== true) {
    problems.push(`${id}: confirm.separateCodePath must be true — permanent deletion may not share a code path with trash`);
  }
  if (confirm.excludeFromSelectAll !== true) {
    problems.push(`${id}: confirm.excludeFromSelectAll must be true`);
  }
  return problems;
}

// A stale exclusion is the dangerous kind of wrong: it looks like protection
// and provides none. What is checkable without a filesystem is that the path
// could ever match — an exclusion not under its target excludes nothing, for
// ever, silently.
//
// Existence on disk is deliberately NOT checked here. ~/Library/Caches/JetBrains
// is legitimately absent on a machine without PyCharm, and four of the ten
// macOS targets are absent on the machine this was written on. Absence is the
// normal case. survey() reports exclusions that matched nothing instead.
function validateExclusions(id, t) {
  if (t.exclude === undefined) return [];
  if (!Array.isArray(t.exclude)) return [`${id}: exclude must be an array`];

  const problems = [];
  const base = globBase(t.path);
  for (const ex of t.exclude) {
    if (typeof ex !== 'string' || ex === '') {
      problems.push(`${id}: exclude entries must be non-empty strings`);
      continue;
    }
    if (ex === base || ex === t.path) {
      problems.push(`${id}: exclude "${ex}" is the target itself, which would exclude everything`);
      continue;
    }
    if (!isUnder(ex, base)) {
      problems.push(
        `${id}: exclude "${ex}" is not under the target "${base}", so it can never exclude anything`,
      );
    }
  }
  return problems;
}

// The literal prefix of a path up to its first glob segment.
function globBase(p) {
  const star = p.indexOf('*');
  if (star === -1) return p;
  const cut = p.lastIndexOf('/', star);
  const cutWin = p.lastIndexOf('\\', star);
  return p.slice(0, Math.max(cut, cutWin));
}

function isUnder(child, parent) {
  if (parent === '') return false;
  const p = parent.replace(/[/\\]+$/, '');
  return child === p || child.startsWith(`${p}/`) || child.startsWith(`${p}\\`);
}

// ---------- Path resolution ----------

// ~ and %VAR% only. Returns null when something cannot be resolved, which
// makes the target absent rather than an error: a Windows target on a Mac
// resolves to nothing, and that is correct.
function resolvePath(raw, options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  if (typeof raw !== 'string' || raw === '') return null;

  let out = raw;
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = path.posix.join(home, out.slice(2));

  let unresolved = false;
  out = out.replace(/%([^%]+)%/g, (_, name) => {
    const value = env[name] || env[name.toUpperCase()];
    if (!value) {
      unresolved = true;
      return '';
    }
    return value;
  });
  if (unresolved) return null;
  if (out.includes('~')) return null;
  return out;
}

// A single * matches one path segment. It only ever narrows: a match must
// exist on disk, so a glob cannot widen into its own parent.
async function expandGlob(resolved) {
  if (!resolved) return [];
  const star = resolved.indexOf('*');
  if (star === -1) return (await exists(resolved)) ? [resolved] : [];

  const sep = resolved.includes('\\') && !resolved.includes('/') ? '\\' : '/';
  const parts = resolved.split(/[/\\]/);
  const starIndex = parts.findIndex((p) => p.includes('*'));
  if (parts[starIndex] !== '*') return []; // partial-segment globs are not supported

  const head = parts.slice(0, starIndex).join(sep) || sep;
  const tail = parts.slice(starIndex + 1);

  let entries;
  try {
    entries = await fsp.readdir(head, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const candidate = [head, entry.name, ...tail].join(sep);
    if (await exists(candidate)) out.push(candidate);
  }
  return out.sort();
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- Measuring ----------

// Same rules as the scanner worker, for the same reasons:
//   - symlinks are never followed (dirent check plus an lstat backstop)
//   - mount points are not crossed
//   - hardlinked files are counted once
//
// The symlink rule matters more here than it does in the scanner. A cache
// directory that is really a symlink to somewhere real is precisely how an
// allowlist leaks: the path on the list stays innocuous while what it points
// at is anything at all.
// minAgeDays splits the answer in two, and the distinction is not cosmetic.
// bytes/files are what would ACTUALLY be removed; scannedBytes/scannedFiles are
// everything the walk looked at. Reporting the folder total against an
// age-filtered target would overstate the saving by whatever share of it is
// too recent to touch -- on the machine this was written against, that was
// 10.65 GB claimed against a single eligible file.
async function measure(root, options = {}) {
  const excluded = (options.exclude || []).filter(Boolean);
  const minAgeDays = Number.isFinite(options.minAgeDays) ? options.minAgeDays : null;
  const now = options.now || Date.now();
  const cutoff = minAgeDays === null ? null : now - minAgeDays * 86400000;
  const result = {
    bytes: 0,
    files: 0,
    scannedBytes: 0,
    scannedFiles: 0,
    dirs: 0,
    symlinksSkipped: 0,
    unreadable: 0,
    tooRecent: 0,
    excludedHits: new Set(),
  };

  let rootStat;
  try {
    rootStat = await fsp.lstat(root);
  } catch {
    return null; // absent: the normal case, reported quietly by survey()
  }
  if (rootStat.isSymbolicLink()) {
    result.symlinksSkipped++;
    result.rootIsSymlink = true;
    return result;
  }
  if (!rootStat.isDirectory()) {
    result.scannedBytes = rootStat.size;
    result.scannedFiles = 1;
    if (eligible(rootStat, cutoff)) {
      result.bytes = rootStat.size;
      result.files = 1;
    } else {
      result.tooRecent++;
    }
    return result;
  }

  const rootDev = rootStat.dev;
  const seenInodes = new Set();
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      result.unreadable++;
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        result.symlinksSkipped++;
        continue;
      }
      const child = path.join(dir, entry.name);

      const hit = excluded.find((ex) => isUnder(child, ex));
      if (hit) {
        result.excludedHits.add(hit);
        continue;
      }

      let st;
      try {
        st = await fsp.lstat(child);
      } catch {
        result.unreadable++;
        continue;
      }
      if (st.isSymbolicLink()) {
        result.symlinksSkipped++; // backstop if dirent d_type lied
        continue;
      }

      if (st.isDirectory()) {
        result.dirs++;
        if (st.dev === rootDev) stack.push(child); // don't cross mount points
      } else if (st.isFile()) {
        let size = st.size;
        if (st.nlink > 1) {
          const key = `${st.dev}:${st.ino}`;
          if (seenInodes.has(key)) size = 0;
          else seenInodes.add(key);
        }
        result.scannedBytes += size;
        result.scannedFiles++;
        if (eligible(st, cutoff)) {
          result.bytes += size;
          result.files++;
        } else {
          result.tooRecent++;
        }
      }
      // Sockets, fifos and devices are ignored, as in the scanner.
    }
  }

  return result;
}

// The later of modification and last-access time, per the rule recorded on the
// age-filtered targets: an installer downloaded a year ago but opened last week
// is in use, and must not read as stale because of its download date.
function eligible(st, cutoff) {
  if (cutoff === null) return true;
  return Math.max(st.mtimeMs, st.atimeMs) < cutoff;
}

// ---------- Survey ----------

async function loadDocument(file) {
  const text = await fsp.readFile(file || TARGETS_FILE, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new TargetsError([`could not be parsed as JSON: ${err.message}`]);
  }
}

// Resolves every target for this platform and reports what is there. Never
// deletes, never writes, never follows a symlink.
async function survey(options = {}) {
  const doc = options.doc || (await loadDocument(options.file));
  const platform = options.platform || process.platform;
  const { targets, omitted } = validate(doc, options);

  const forPlatform = targets.filter((t) => t.platform === platform);
  const reports = [];

  for (const t of forPlatform) {
    const resolvedExcludes = (t.exclude || [])
      .map((ex) => resolvePath(ex, options))
      .filter(Boolean);

    const resolved = resolvePath(t.path, options);
    const roots = await expandGlob(resolved);

    const report = {
      id: t.id,
      label: t.label,
      risk: t.risk,
      path: t.path,
      resolved,
      roots,
      present: false,
      bytes: 0,
      files: 0,
      scannedBytes: 0,
      scannedFiles: 0,
      dirs: 0,
      symlinksSkipped: 0,
      unreadable: 0,
      tooRecent: 0,
      permanent: t.method === 'emptyTrash',
      minAgeDays: t.minAgeDays,
      requiresAppClosed: t.requiresAppClosed,
      staleExclusions: [],
    };

    const hits = new Set();
    for (const root of roots) {
      const m = await measure(root, {
        exclude: resolvedExcludes,
        minAgeDays: t.minAgeDays,
        now: options.now,
      });
      if (!m) continue;
      report.present = true;
      report.bytes += m.bytes;
      report.files += m.files;
      report.scannedBytes += m.scannedBytes;
      report.scannedFiles += m.scannedFiles;
      report.dirs += m.dirs;
      report.symlinksSkipped += m.symlinksSkipped;
      report.unreadable += m.unreadable;
      report.tooRecent += m.tooRecent;
      for (const h of m.excludedHits) hits.add(h);
    }

    // Not an error — the excluded app may simply not be installed — but worth
    // surfacing, because this is also what a moved path looks like.
    report.staleExclusions = resolvedExcludes.filter((ex) => !hits.has(ex));
    reports.push(report);
  }

  return {
    platform,
    generatedAt: new Date().toISOString(),
    targets: reports,
    omitted,
    totals: {
      bytes: reports.reduce((a, r) => a + r.bytes, 0),
      files: reports.reduce((a, r) => a + r.files, 0),
      scannedBytes: reports.reduce((a, r) => a + r.scannedBytes, 0),
      present: reports.filter((r) => r.present).length,
      absent: reports.filter((r) => !r.present).length,
    },
  };
}

module.exports = {
  survey,
  validate,
  loadDocument,
  resolvePath,
  expandGlob,
  measure,
  globBase,
  isUnder,
  eligible,
  TargetsError,
  TARGETS_FILE,
  EMPTY_TRASH_IDS,
  EXPAND_HANDLERS,
};
