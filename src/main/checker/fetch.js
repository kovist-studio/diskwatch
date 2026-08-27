'use strict';

// The ONLY code in DiskWatch that makes a network request.
//
// Everything else in this application is deliberately offline. This file is
// the single exception, and it is written to be narrow enough that the
// exception stays auditable: it can request the URLs written in sources.json
// and it has no code path that can request anything else. A caller cannot pass
// a URL in — the public functions take source ids, and the URL is looked up
// from the validated document. That is the same move remove.js makes with
// tokens instead of paths, for the same reason.
//
// It is also the first thing this app writes outside the Trash. The cache
// lives under app.getPath('userData')/blocklists, and DECISIONS.md records
// what lands there.
//
// PHASE 1: fetch, validate, cache, report. Nothing parses these lists into a
// lookup structure yet. When that arrives it must be built HERE, on the user's
// machine, from the user's own copy — two of the three sources are copyleft
// and a distributed derivative would have to carry both licences. See
// CLAUDE.md and DECISIONS.md before changing that.

const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const SOURCES_FILE = path.join(__dirname, 'sources.json');

// Only ever this. An http URL is not downgraded-but-accepted, it is refused.
const PROTOCOL = 'https:';

const PER_SOURCE_TIMEOUT_MS = 30000;
const TOTAL_BUDGET_MS = 120000;
// Well above the ~10 MB largest source, low enough that a misbehaving origin
// cannot fill the disk.
const MAX_BYTES = 48 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const REQUIRED_FIELDS = Object.freeze([
  'id', 'label', 'url', 'format', 'licence', 'attribution', 'maintainer',
]);
const FORMATS = Object.freeze(['hosts', 'domains', 'domains-commented']);

// Every way a source can fail to refresh. A closed set, so a UI can phrase
// each case itself instead of parsing prose.
const REASONS = Object.freeze({
  NOT_IN_SOURCES: 'not-in-sources',
  NOT_HTTPS: 'not-https',
  REDIRECT_OFF_HTTPS: 'redirect-off-https',
  TOO_MANY_REDIRECTS: 'too-many-redirects',
  TIMED_OUT: 'timed-out',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  HTTP_ERROR: 'http-error',
  TOO_LARGE: 'too-large',
  EMPTY: 'empty',
  NETWORK: 'network',
  WRITE_FAILED: 'write-failed',
});

class SourcesError extends Error {
  constructor(problems) {
    super(`sources.json is not usable:\n  - ${problems.join('\n  - ')}`);
    this.name = 'SourcesError';
    this.problems = problems;
  }
}

// ---------- The allowlist ----------

async function loadDocument(file) {
  const raw = await fsp.readFile(file || SOURCES_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SourcesError([`could not be parsed as JSON: ${err.message}`]);
  }
}

// Fails loudly on load. A blocklist allowlist that silently degrades is worse
// than none: it still runs, it just no longer means what it says.
function validate(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sources)) {
    throw new SourcesError(['the document has no sources array']);
  }

  const seen = new Set();
  for (const src of doc.sources) {
    const id = src && typeof src.id === 'string' ? src.id : '(entry with no id)';
    for (const field of REQUIRED_FIELDS) {
      if (!src[field]) problems.push(`${id}: missing required field "${field}"`);
    }
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);

    if (src.format && !FORMATS.includes(src.format)) {
      problems.push(`${id}: format must be one of ${FORMATS.join(', ')}`);
    }

    // RULE: https, always. Checked here so a bad entry cannot reach a socket.
    if (typeof src.url === 'string') {
      let parsed = null;
      try {
        parsed = new URL(src.url);
      } catch {
        problems.push(`${id}: url is not a valid URL`);
      }
      if (parsed && parsed.protocol !== PROTOCOL) {
        problems.push(`${id}: url must be https, got ${parsed.protocol}`);
      }
    }

    // Attribution is not decoration. CyberHost is CC BY-SA 4.0 and the credit
    // has to survive into whatever eventually displays a verdict, so it is
    // required on load rather than hoped for later.
    if (src.licence && !src.attribution) {
      problems.push(`${id}: has a licence but no attribution string`);
    }
  }

  if (problems.length > 0) throw new SourcesError(problems);
  return { sources: doc.sources, refreshIntervalHours: doc.refreshIntervalHours || 24 };
}

// ---------- Where the cache lives ----------

// Resolved lazily so `node --test`, which has no Electron, never loads it.
// Tests pass their own dir; nothing else in the module knows the difference.
function defaultCacheDir() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'blocklists');
}

const cacheDirFor = (options) => options.cacheDir || defaultCacheDir();
const indexPath = (dir) => path.join(dir, 'index.json');
const bodyPath = (dir, id) => path.join(dir, `${id}.txt`);

async function readIndex(dir) {
  try {
    return JSON.parse(await fsp.readFile(indexPath(dir), 'utf8'));
  } catch {
    // No cache yet, or one we can't read. Either way: refresh everything.
    return { version: 1, sources: {} };
  }
}

async function writeIndex(dir, index) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(indexPath(dir), `${JSON.stringify(index, null, 2)}\n`);
}

// ---------- Staleness ----------

// At most once a day, and the record of when is what makes that true across
// restarts. Without a persisted timestamp every launch is a refresh.
function isStale(entry, intervalHours, now) {
  if (!entry || !entry.fetchedAt) return true;
  const age = now - Date.parse(entry.fetchedAt);
  if (!Number.isFinite(age)) return true;
  return age >= intervalHours * 3600 * 1000;
}

// ---------- The request ----------

// Never rejects for an HTTP-level outcome: a 404 and a dead DNS name are data,
// not exceptions. Same contract as the command runner in the security audit.
function get(url, options, deadline) {
  const request = options.request || httpsGet;
  return request(url, deadline);
}

function httpsGet(url, deadlineMs) {
  return new Promise((resolve) => {
    const started = Date.now();

    const attempt = (target, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        resolve({ ok: false, reason: REASONS.NETWORK, detail: 'unparseable URL' });
        return;
      }

      // The check that matters on a redirect: an origin can answer 302 to an
      // http location, and following it would put the request on the wire in
      // clear. Refuse rather than downgrade.
      if (parsed.protocol !== PROTOCOL) {
        resolve({
          ok: false,
          reason: redirectsLeft === MAX_REDIRECTS ? REASONS.NOT_HTTPS : REASONS.REDIRECT_OFF_HTTPS,
          detail: `${parsed.protocol}//${parsed.host}`,
        });
        return;
      }

      const remaining = Math.max(1, deadlineMs - (Date.now() - started));
      const req = https.get(
        target,
        { timeout: Math.min(PER_SOURCE_TIMEOUT_MS, remaining), headers: { 'user-agent': 'DiskWatch' } },
        (res) => {
          const status = res.statusCode || 0;

          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              resolve({ ok: false, reason: REASONS.TOO_MANY_REDIRECTS, detail: `${MAX_REDIRECTS} followed` });
              return;
            }
            attempt(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
            return;
          }

          if (status !== 200) {
            res.resume();
            resolve({ ok: false, reason: REASONS.HTTP_ERROR, detail: `HTTP ${status}` });
            return;
          }

          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BYTES) {
              req.destroy();
              resolve({ ok: false, reason: REASONS.TOO_LARGE, detail: `over ${MAX_BYTES} bytes` });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks) }));
          res.on('error', (err) => resolve({ ok: false, reason: REASONS.NETWORK, detail: err.message }));
        },
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, reason: REASONS.TIMED_OUT, detail: `no response in ${PER_SOURCE_TIMEOUT_MS}ms` });
      });
      req.on('error', (err) => resolve({ ok: false, reason: REASONS.NETWORK, detail: err.message }));
    };

    attempt(url, MAX_REDIRECTS);
  });
}

// ---------- refresh() ----------

// Refreshes the sources that are due and returns what happened to each.
//
// One dead source must never block the others: every outcome below is
// per-source, the loop never throws for a network reason, and a source that
// fails keeps whatever copy it already had. A refresh that half-worked leaves
// the cache better than it found it.
async function refresh(options = {}) {
  const now = options.now || Date.now();
  const doc = options.doc || (await loadDocument(options.file));
  const { sources, refreshIntervalHours } = validate(doc);

  const dir = cacheDirFor(options);
  const index = await readIndex(dir);
  index.sources = index.sources || {};

  const only = options.only === undefined ? null : [options.only].flat();
  const force = options.force === true;

  const fetched = [];
  const skipped = [];
  const failed = [];

  const budgetEnds = now + (options.totalBudgetMs || TOTAL_BUDGET_MS);

  for (const src of sources) {
    if (only !== null && !only.includes(src.id)) continue;

    const entry = index.sources[src.id];
    if (!force && !isStale(entry, refreshIntervalHours, now)) {
      skipped.push({ id: src.id, reason: 'fresh', fetchedAt: entry.fetchedAt });
      continue;
    }

    // The total budget is checked before each source rather than enforced by
    // a timer, so a source is either attempted with time to finish or not
    // attempted at all — never cut off halfway and written truncated.
    const timeLeft = budgetEnds - Date.now();
    if (timeLeft <= 0) {
      failed.push({ id: src.id, reason: REASONS.BUDGET_EXHAUSTED, detail: 'no time left in this refresh' });
      continue;
    }

    const result = await get(src.url, options, Math.min(PER_SOURCE_TIMEOUT_MS, timeLeft));

    if (!result.ok) {
      failed.push({ id: src.id, reason: result.reason, detail: result.detail });
      continue;
    }
    if (!result.body || result.body.length === 0) {
      failed.push({ id: src.id, reason: REASONS.EMPTY, detail: 'the response had no body' });
      continue;
    }

    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(bodyPath(dir, src.id), result.body);
    } catch (err) {
      failed.push({ id: src.id, reason: REASONS.WRITE_FAILED, detail: err.message });
      continue;
    }

    const text = result.body.toString('utf8');
    const lines = text.split('\n');
    const entries = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length;

    // Attribution is stored WITH the data, not looked up later from
    // sources.json. If the cache is ever read by something that has lost sight
    // of the allowlist, the credit and the licence are still attached to it.
    index.sources[src.id] = {
      fetchedAt: new Date(now).toISOString(),
      bytes: result.body.length,
      lines: lines.length,
      entries,
      sha256: crypto.createHash('sha256').update(result.body).digest('hex'),
      url: src.url,
      format: src.format,
      licence: src.licence,
      attribution: src.attribution,
    };
    fetched.push({ id: src.id, bytes: result.body.length, entries });
  }

  await writeIndex(dir, index);

  return {
    cacheDir: dir,
    fetched,
    skipped,
    failed,
    totals: {
      fetchedCount: fetched.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      bytes: fetched.reduce((a, f) => a + f.bytes, 0),
      entries: fetched.reduce((a, f) => a + f.entries, 0),
    },
  };
}

// What is cached right now, with the licence and credit for each. Read-only.
async function status(options = {}) {
  const doc = options.doc || (await loadDocument(options.file));
  const { sources, refreshIntervalHours } = validate(doc);
  const dir = cacheDirFor(options);
  const index = await readIndex(dir);
  const now = options.now || Date.now();

  return {
    cacheDir: dir,
    sources: sources.map((src) => {
      const entry = (index.sources || {})[src.id] || null;
      return {
        id: src.id,
        label: src.label,
        licence: src.licence,
        attribution: src.attribution,
        cached: !!entry,
        fetchedAt: entry ? entry.fetchedAt : null,
        entries: entry ? entry.entries : 0,
        stale: isStale(entry, refreshIntervalHours, now),
      };
    }),
  };
}

module.exports = {
  // Shared with rdap.js so there is ONE implementation of "https only, never
  // downgraded by a redirect, bounded by a timeout" rather than two that can
  // drift apart.
  httpsGet,
  refresh,
  status,
  validate,
  loadDocument,
  isStale,
  SOURCES_FILE,
  REASONS,
  SourcesError,
};
