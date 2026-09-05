'use strict';

// fetch.js is the only code in DiskWatch that touches the network, so these
// tests are written to catch it contacting something it shouldn't rather than
// to prove it can download a file.
//
// No test here makes a real request. Every one injects a fake `request`, so a
// leak shows up as an unexpected recorded URL rather than as traffic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const checker = require('../src/main/checker/fetch');
const { REASONS } = checker;

// Records every URL it was asked for. Nothing reaches a socket.
function spy(reply) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return typeof reply === 'function' ? reply(url) : (reply || { ok: true, body: Buffer.from('example.com\n') });
  };
  fn.calls = calls;
  return fn;
}

function docWith(overrides = {}) {
  return {
    version: 1,
    refreshIntervalHours: 24,
    sources: [
      {
        id: 'test-source',
        label: 'Test source',
        url: 'https://example.invalid/list.txt',
        format: 'domains',
        licence: 'MIT',
        attribution: 'Test source — https://example.invalid',
        maintainer: 'Nobody. This entry exists only for a test.',
        ...overrides,
      },
    ],
  };
}

async function sandbox(t) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-net-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- The shipped allowlist ----------------------------------------------------

test('the real sources.json validates, is https-only, and credits every source', async () => {
  const doc = await checker.loadDocument();
  const { sources } = checker.validate(doc);

  assert.equal(sources.length, 3, 'three sources — Phishing Army is deliberately absent');

  for (const src of sources) {
    assert.ok(src.url.startsWith('https://'), `${src.id} must be https`);
    assert.ok(src.licence, `${src.id} must name a licence`);
    assert.ok(src.attribution, `${src.id} must carry attribution`);
    assert.ok(src.maintainer.length > 40, `${src.id} must say who maintains it`);
  }

  // The NC source must stay out, and stay explained. An entry that is merely
  // absent gets re-proposed.
  const ids = sources.map((s) => s.id);
  assert.equal(ids.includes('phishing-army'), false, 'CC BY-NC source must not be a source');
  const excluded = (doc.excluded || []).find((e) => e.id === 'phishing-army');
  assert.ok(excluded, 'phishing-army must be recorded in excluded');
  assert.match(excluded.reason, /NonCommercial/i);
});

// --- Nothing outside the allowlist is ever requested ---------------------------

test('only URLs in sources.json are ever requested', async (t) => {
  const dir = await sandbox(t);
  const request = spy();

  await checker.refresh({ doc: docWith(), cacheDir: dir, request, force: true });

  assert.deepEqual(request.calls, ['https://example.invalid/list.txt']);
});

test('refresh has no way to be handed a URL', async (t) => {
  const dir = await sandbox(t);
  const request = spy();

  // A caller trying to smuggle one in via the options it does accept. `only`
  // filters by id, so a URL simply matches no source and nothing is fetched.
  await checker.refresh({
    doc: docWith(),
    cacheDir: dir,
    request,
    force: true,
    only: ['https://evil.invalid/payload.txt'],
  });

  assert.deepEqual(request.calls, [], 'a URL in `only` must match no source');
});

test('a non-https source is refused on load, before any socket', async (t) => {
  const dir = await sandbox(t);
  const request = spy();

  await assert.rejects(
    () => checker.refresh({
      doc: docWith({ url: 'http://example.invalid/list.txt' }),
      cacheDir: dir,
      request,
      force: true,
    }),
    (err) => err.name === 'SourcesError' && /must be https/.test(err.message),
  );
  assert.deepEqual(request.calls, [], 'nothing may be requested for an http source');
});

test('a redirect off https is refused rather than followed', async (t) => {
  const dir = await sandbox(t);
  const request = spy({ ok: false, reason: REASONS.REDIRECT_OFF_HTTPS, detail: 'http://elsewhere' });

  const result = await checker.refresh({ doc: docWith(), cacheDir: dir, request, force: true });

  assert.equal(result.totals.fetchedCount, 0);
  assert.equal(result.failed[0].reason, REASONS.REDIRECT_OFF_HTTPS);
});

// --- One dead source must not block the others --------------------------------

test('a failing source is reported and the others still cache', async (t) => {
  const dir = await sandbox(t);
  const doc = {
    version: 1,
    refreshIntervalHours: 24,
    sources: [
      { ...docWith().sources[0], id: 'good-a', url: 'https://a.invalid/l.txt' },
      { ...docWith().sources[0], id: 'dead', url: 'https://dead.invalid/l.txt' },
      { ...docWith().sources[0], id: 'good-b', url: 'https://b.invalid/l.txt' },
    ],
  };
  const request = spy((url) =>
    url.includes('dead.invalid')
      ? { ok: false, reason: REASONS.TIMED_OUT, detail: 'no response' }
      : { ok: true, body: Buffer.from('one.example\ntwo.example\n') });

  const result = await checker.refresh({ doc, cacheDir: dir, request, force: true });

  assert.equal(result.totals.fetchedCount, 2, 'the healthy sources still cache');
  assert.equal(result.totals.failedCount, 1);
  assert.equal(result.failed[0].id, 'dead');
  assert.equal(result.failed[0].reason, REASONS.TIMED_OUT);

  // And the two that worked are on disk.
  assert.ok(await fsp.stat(path.join(dir, 'good-a.txt')));
  assert.ok(await fsp.stat(path.join(dir, 'good-b.txt')));
  await assert.rejects(() => fsp.stat(path.join(dir, 'dead.txt')));
});

test('an empty body is a failure, not a cached empty list', async (t) => {
  const dir = await sandbox(t);
  const request = spy({ ok: true, body: Buffer.alloc(0) });

  const result = await checker.refresh({ doc: docWith(), cacheDir: dir, request, force: true });

  assert.equal(result.failed[0].reason, REASONS.EMPTY);
  await assert.rejects(() => fsp.stat(path.join(dir, 'test-source.txt')));
});

// --- At most once a day -------------------------------------------------------

test('a fresh source is not re-fetched, and the timestamp is what makes that true', async (t) => {
  const dir = await sandbox(t);
  const doc = docWith();
  const t0 = Date.parse('2026-08-28T00:00:00Z');

  const first = spy();
  await checker.refresh({ doc, cacheDir: dir, request: first, now: t0 });
  assert.equal(first.calls.length, 1, 'first run fetches');

  // An hour later, and again at 23 hours: still fresh, still no request.
  for (const hours of [1, 23]) {
    const later = spy();
    const r = await checker.refresh({ doc, cacheDir: dir, request: later, now: t0 + hours * 3600e3 });
    assert.deepEqual(later.calls, [], `no request at +${hours}h`);
    assert.equal(r.skipped[0].reason, 'fresh');
  }

  // At 24 hours it is due again.
  const due = spy();
  await checker.refresh({ doc, cacheDir: dir, request: due, now: t0 + 24 * 3600e3 });
  assert.equal(due.calls.length, 1, 'due after the interval');
});

// --- The two clocks ------------------------------------------------------------

// `now` and the total budget answer different questions, and deriving one from
// the other made a refresh with an injected `now` report that it had run out
// of time before it made a single request. Both directions are pinned here,
// because a fix that simply removed the budget check would also go green.

test('an injected now far from the real clock does not consume the budget', async (t) => {
  const dir = await sandbox(t);
  const request = spy();

  // Deliberately a date well outside any plausible budget — this is what a
  // test fixture with a fixed timestamp looks like once the calendar moves
  // past it. The budget is a duration spent, so it must be unaffected.
  const result = await checker.refresh({
    doc: docWith(),
    cacheDir: dir,
    request,
    now: Date.parse('2001-01-01T00:00:00Z'),
  });

  assert.equal(request.calls.length, 1, 'the source is stale and must be fetched');
  assert.deepEqual(result.failed, [], 'and nothing may be blamed on the budget');
  assert.equal(result.fetched[0].id, 'test-source');

  // The stamp on the cached copy still comes from `now` — that one IS logical.
  const index = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.sources['test-source'].fetchedAt, '2001-01-01T00:00:00.000Z');
});

test('an exhausted budget still stops the loop', async (t) => {
  const dir = await sandbox(t);
  const request = spy();

  // Zero milliseconds of budget: nothing may be attempted, and the reason
  // given must be the budget rather than a network outcome.
  const result = await checker.refresh({ doc: docWith(), cacheDir: dir, request, totalBudgetMs: 0 });

  assert.deepEqual(request.calls, [], 'no source may be attempted');
  assert.equal(result.failed[0].reason, REASONS.BUDGET_EXHAUSTED);
  assert.deepEqual(result.fetched, []);
});

test('isStale treats a missing or unreadable timestamp as due', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  assert.equal(checker.isStale(null, 24, now), true);
  assert.equal(checker.isStale({}, 24, now), true);
  assert.equal(checker.isStale({ fetchedAt: 'not a date' }, 24, now), true);
  assert.equal(checker.isStale({ fetchedAt: '2026-08-28T11:00:00Z' }, 24, now), false);
});

// --- Attribution survives into the cache --------------------------------------

test('licence and attribution are stored with the data, not just in sources.json', async (t) => {
  const dir = await sandbox(t);
  const doc = docWith({ licence: 'CC BY-SA 4.0', attribution: 'Someone — https://example.invalid — CC BY-SA 4.0' });

  await checker.refresh({ doc, cacheDir: dir, request: spy(), force: true });

  const index = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'));
  const entry = index.sources['test-source'];
  assert.equal(entry.licence, 'CC BY-SA 4.0');
  assert.match(entry.attribution, /CC BY-SA 4\.0/);
  assert.ok(entry.sha256 && entry.sha256.length === 64, 'the cached body is checksummed');
  assert.ok(entry.fetchedAt, 'and stamped');
});

test('status reports licence and staleness without fetching anything', async (t) => {
  const dir = await sandbox(t);
  const request = spy();
  const doc = docWith();

  const before = await checker.status({ doc, cacheDir: dir });
  assert.equal(before.sources[0].cached, false);
  assert.equal(before.sources[0].stale, true);
  assert.equal(before.sources[0].attribution, 'Test source — https://example.invalid');

  await checker.refresh({ doc, cacheDir: dir, request, force: true });

  const after = await checker.status({ doc, cacheDir: dir });
  assert.equal(after.sources[0].cached, true);
  assert.equal(after.sources[0].stale, false);
  assert.deepEqual(request.calls.length, 1, 'status itself requested nothing');
});

// --- The rule, held in the source ---------------------------------------------

test('no module outside checker/ makes a network request', async () => {
  const root = path.join(__dirname, '..', 'src');
  const offenders = [];

  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'vendor') continue;
        await walk(full);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      if (full.includes(path.join('main', 'checker'))) continue;

      const code = (await fsp.readFile(full, 'utf8'))
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');

      if (/require\(['"]node:(https|http)['"]\)|\bfetch\s*\(|XMLHttpRequest|new WebSocket/.test(code)) {
        offenders.push(path.relative(root, full));
      }
    }
  }

  await walk(root);
  assert.deepEqual(offenders, [], 'only src/main/checker may reach the network');
});
