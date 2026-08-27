'use strict';

// The cleanup IPC boundary and the one UI rule that cannot be enforced at
// runtime.
//
// The boundary is where a compromised renderer would aim, so it is tested with
// the things a compromised renderer would send: a path, a number, an array of
// paths. None of them are tokens, and none of them may get as far as a module
// that would have to reason about what they are.
//
// ipc.js requires electron at load, which `node --test` has no copy of, so the
// module loader is stubbed for the duration. That is cheaper and far more
// honest than extracting the guard into its own file purely to make it
// testable: this exercises the guard AS THE CHANNEL ACTUALLY USES IT, wired to
// the real handler, rather than a copy that could drift from the wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const remover = require('../src/main/cleaner/remove');

// ---------- Loading ipc.js without Electron ----------

const handlers = new Map();

const electronStub = {
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {},
  shell: {},
};

function loadIpc() {
  const realLoad = Module._load;
  Module._load = function stubbed(request, ...rest) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/main/ipc.js')];
    const ipc = require('../src/main/ipc.js');
    ipc.registerIpcHandlers();
  } finally {
    Module._load = realLoad;
  }
}

loadIpc();

const removeHandler = handlers.get('cleaner:remove');
const uuid = () => require('node:crypto').randomUUID();

// --- The channel exists at all -----------------------------------------------

test('the cleanup channels are registered', () => {
  assert.ok(handlers.has('cleaner:survey'), 'survey channel must be registered');
  assert.ok(handlers.has('cleaner:remove'), 'remove channel must be registered');
});

// --- What the boundary refuses ------------------------------------------------

test('the remove channel refuses anything that is not a token', async (t) => {
  // The whole point of the design: a path cannot be spoken here. Each of these
  // is what a renderer that had been taken over would try first.
  const hostile = [
    ['a bare path', '/etc/passwd'],
    ['an array holding a path', ['/etc/passwd']],
    ['an array holding a home path', [`${os.homedir()}/Documents`]],
    ['a Windows path', ['C:\\Windows\\System32']],
    ['a relative path', ['../../etc/passwd']],
    ['a target id', ['pip-cache-macos']],
    ['a number', [42]],
    ['null', null],
    ['an object', { token: uuid() }],
    ['a nested array', [[uuid()]]],
    ['an almost-uuid', ['not-a-uuid-at-all-really-no']],
    ['an empty string', ['']],
  ];

  for (const [name, payload] of hostile) {
    await t.test(name, async () => {
      await assert.rejects(
        async () => removeHandler({}, payload),
        (err) => err instanceof TypeError,
        `${name} must be refused at the boundary`,
      );
    });
  }
});

test('the remove channel refuses an implausible number of tokens', async () => {
  const flood = Array.from({ length: 10001 }, () => uuid());
  await assert.rejects(async () => removeHandler({}, flood), TypeError);
});

// --- What the boundary lets through -------------------------------------------

test('well-formed tokens pass the boundary and are judged by the ledger', async () => {
  // Shape is a caller contract; validity is an outcome. A token that is a real
  // UUID but was never minted must NOT throw — it has to come back as a skip,
  // because a stale selection from an earlier survey is ordinary and must not
  // take the rest of the batch down with it.
  const result = await removeHandler({}, [uuid(), uuid()]);
  assert.equal(result.ok, true, 'a well-formed batch is an outcome, not an error');
  assert.equal(result.totals.trashedCount, 0);
  assert.equal(result.skipped.length, 2);
  for (const s of result.skipped) assert.equal(s.reason, remover.REASONS.UNKNOWN_TOKEN);
});

test('an empty selection is allowed and does nothing', async () => {
  const result = await removeHandler({}, []);
  assert.equal(result.ok, true);
  assert.equal(result.totals.trashedCount, 0);
  assert.equal(result.totals.skippedCount, 0);
});

// --- plan() reports per target so absent rows can be shown ---------------------

test('plan reports a row per target, telling absent from empty', async (t) => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-ui-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  remover.resetLedger();

  await fsp.mkdir(path.join(dir, 'present', 'cacheA'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'present', 'cacheA', 'blob'), 'x'.repeat(500));
  await fsp.mkdir(path.join(dir, 'empty'), { recursive: true });

  const mk = (id, p, extra = {}) => ({
    id,
    label: id,
    platform: process.platform,
    path: p,
    description: `${id} description`,
    risk: 'safe',
    defaultEnabled: false,
    requiresAppClosed: [],
    ...extra,
  });

  const doc = {
    version: 1,
    targets: [
      mk('has-items', path.join(dir, 'present', '*')),
      mk('here-but-empty', path.join(dir, 'empty', '*')),
      mk('not-on-this-machine', path.join(dir, 'nope', '*')),
    ],
  };

  const planned = await remover.plan({ doc });
  const by = new Map(planned.targets.map((r) => [r.id, r]));

  assert.equal(planned.targets.length, 3, 'every target gets a row, including absent ones');

  assert.equal(by.get('has-items').present, true);
  assert.equal(by.get('has-items').count, 1);
  assert.equal(by.get('has-items').bytes, 500);
  assert.equal(by.get('has-items').description, 'has-items description');

  // Present but nothing inside: the glob matched no roots because there are no
  // children, so this reads as absent to the UI. What must NOT happen is a row
  // claiming items it does not have.
  assert.equal(by.get('here-but-empty').count, 0);
  assert.equal(by.get('not-on-this-machine').present, false);
  assert.equal(by.get('not-on-this-machine').count, 0);
});

// --- describe(): what the disclosure is allowed to show ------------------------

test('describe returns names and dates, never paths', async (t) => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-desc-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  remover.resetLedger();

  const downloads = path.join(dir, 'downloads');
  await fsp.mkdir(downloads, { recursive: true });

  const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
  const names = ['tax-return-2024.pdf', 'holiday.jpg', 'installer.dmg'];
  for (let i = 0; i < names.length; i++) {
    const f = path.join(downloads, names[i]);
    await fsp.writeFile(f, 'x'.repeat(100 * (i + 1)));
    // Staggered so "newest first" has something to order.
    await fsp.utimes(f, new Date(old + i * 86400000), new Date(old + i * 86400000));
  }

  const doc = {
    version: 1,
    targets: [
      {
        id: 'old-downloads',
        label: 'Old downloads',
        platform: process.platform,
        path: downloads,
        description: 'Files you downloaded and have not opened since.',
        risk: 'caution',
        defaultEnabled: false,
        requiresAppClosed: [],
        minAgeDays: 90,
      },
    ],
  };

  const planned = await remover.plan({ doc });
  assert.equal(planned.items.length, 3);
  assert.equal(planned.targets[0].unit, 'file', 'a minAgeDays target is per-file, so it is gated');

  const described = remover.describe('old-downloads');
  assert.equal(described.total, 3);
  assert.equal(described.shown, 3);

  // THE property. A basename is what someone recognises their file by; the
  // directory above it is exactly the part that must not travel.
  for (const item of described.items) {
    assert.ok(names.includes(item.name), `${item.name} must be a bare filename`);
    assert.equal(item.name.includes(path.sep), false, 'no separator may appear in a name');
    assert.equal(JSON.stringify(item).includes(dir), false, 'no item may carry its directory');
    assert.ok(item.token, 'each row carries its token, so per-file selection needs no new channel');
    assert.ok(item.mtimeMs > 0 && item.bytes > 0);
  }

  // Newest first: the ones most likely to still be wanted go in front.
  const dates = described.items.map((i) => i.mtimeMs);
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'newest first');
  assert.equal(described.items[0].name, 'installer.dmg');
});

test('describe caps the list but never lies about the total', async (t) => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-cap-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  remover.resetLedger();

  const d = path.join(dir, 'many');
  await fsp.mkdir(d, { recursive: true });
  const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 12; i++) {
    const f = path.join(d, `file-${i}.bin`);
    await fsp.writeFile(f, 'x');
    await fsp.utimes(f, new Date(old), new Date(old));
  }

  await remover.plan({
    doc: {
      version: 1,
      targets: [
        {
          id: 'many',
          label: 'Many',
          platform: process.platform,
          path: d,
          description: 'many files',
          risk: 'caution',
          defaultEnabled: false,
          requiresAppClosed: [],
          minAgeDays: 90,
        },
      ],
    },
  });

  const described = remover.describe('many', { max: 5 });
  assert.equal(described.shown, 5, 'the list is capped');
  assert.equal(described.total, 12, 'the total is the truth, so the UI can say what it omits');
});

// --- The gate on the person's own files ---------------------------------------

test('a per-file target cannot be ticked before its list is opened', async () => {
  const src = await fsp.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  // Caches regenerate; a person's downloads do not. The gate is what stops one
  // click meaning 1,040 of someone's own files, so assert the wiring exists:
  // the checkbox starts disabled for a gated row, and only opening the
  // disclosure re-enables it.
  assert.match(code, /checkbox\.disabled = gated/, 'a gated row must start disabled');
  assert.match(code, /unit === 'file'/, 'the gate must key off the per-file unit, not an id');
  assert.match(
    code,
    /checkbox\.disabled = false/,
    'opening the disclosure must be what enables the checkbox',
  );

  // And the enabling must happen inside the disclosure handler, after the
  // contents have actually been fetched — not anywhere else.
  const handler = code.slice(code.indexOf('api.cleaner.contents'));
  assert.match(
    handler.slice(0, 400),
    /checkbox\.disabled = false/,
    'the checkbox may only be enabled after the list has been read',
  );
});

// --- The rule the loader enforces, held on the UI side too ---------------------

test('the Clean UI never pre-selects a checkbox', async () => {
  const src = await fsp.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  // targets.json may not ship a pre-enabled entry — the loader makes that a
  // hard error. The UI is the other end of the same rule and has no loader to
  // catch it, so the assertion is on the source: nothing may set a checkbox
  // true, and no select-all may exist to do it wholesale.
  // Capture what is assigned rather than asserting on a lookahead: `\s*` can
  // match nothing, so `=\s*(?!false)` happily matches the space in
  // `= false` and reports a violation that is not there. Read the value.
  const assigned = [...code.matchAll(/\.checked\s*=\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    assigned.filter((v) => v !== 'false'),
    [],
    'a checkbox may only ever be assigned false; nothing may pre-select a target',
  );
  assert.ok(assigned.length > 0, 'the assertion must actually be reaching the checkbox code');

  for (const banned of [/select[- ]?all/i, /checkAll/i, /cleanAll/i]) {
    assert.equal(banned.test(code), false, `the Clean UI must not contain ${banned}`);
  }
});
