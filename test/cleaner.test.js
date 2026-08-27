'use strict';

// The loader's job is to keep the promises targets.json makes. A rule that
// cannot be made to fail here is not enforced, so every validation rule below
// is exercised by deliberately breaking a copy of the real file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const cleaner = require('../src/main/cleaner');
const REAL = require('../src/main/cleaner/targets.json');

const clone = () => JSON.parse(JSON.stringify(REAL));
const find = (doc, id) => doc.targets.find((t) => t.id === id);

// Asserts that validation rejects, and that it says why in terms someone
// fixing the file can act on.
function rejects(doc, pattern, message) {
  assert.throws(
    () => cleaner.validate(doc),
    (err) => {
      assert.ok(err instanceof cleaner.TargetsError, 'must be a TargetsError');
      assert.ok(err.problems.length > 0, 'must list at least one problem');
      assert.match(err.problems.join('\n'), pattern, `problems were:\n${err.problems.join('\n')}`);
      return true;
    },
    message,
  );
}

// --- The file as shipped ----------------------------------------------------

test('the real targets.json passes its own rules', () => {
  const { targets, omitted } = cleaner.validate(clone());
  assert.ok(targets.length > 0);
  // ios-backups has an expand contract and there is no handler for it yet,
  // so it must be omitted rather than shipped as a folder-level checkbox.
  assert.deepEqual(omitted.map((o) => o.id), ['ios-backups']);
  assert.equal(targets.some((t) => t.id === 'ios-backups'), false);
});

// --- Nothing deletes permanently --------------------------------------------

// This rule used to read "exactly two". The Trash and the Recycle Bin were
// carved out of it for one phase and then dropped, so the count is now zero
// and the first entry to try is an error rather than the third.

test('permanent deletion is closed to zero ids', async (t) => {
  await t.test('the shipped file carries no emptyTrash entry and no confirm contract', () => {
    assert.equal(REAL.targets.filter((x) => x.method === 'emptyTrash').length, 0);
    assert.equal(REAL.targets.filter((x) => 'confirm' in x).length, 0);
  });

  await t.test('a first emptyTrash entry is a hard error, on any id', () => {
    for (const id of ['windows-user-temp', 'npm-cache', 'downloads-old-macos']) {
      const doc = clone();
      find(doc, id).method = 'emptyTrash';
      rejects(doc, /method "emptyTrash" no longer exists/, `${id} must be rejected`);
    }
  });

  await t.test('the rejection says where the reasoning is written down', () => {
    const doc = clone();
    find(doc, 'npm-cache').method = 'emptyTrash';
    rejects(doc, /excluded list/);
  });

  await t.test('re-adding the two ids does not re-open anything', () => {
    const doc = clone();
    doc.targets.push({
      id: 'macos-trash',
      label: 'Trash',
      platform: 'darwin',
      path: '~/.Trash',
      description: 'Files you have already deleted.',
      risk: 'caution',
      defaultEnabled: false,
      requiresAppClosed: [],
      method: 'emptyTrash',
    });
    rejects(doc, /macos-trash: method "emptyTrash" no longer exists/);
  });

  await t.test('an unknown method is rejected outright', () => {
    const doc = clone();
    find(doc, 'npm-cache').method = 'shred';
    rejects(doc, /method must be "trash" or absent/);
  });

  await t.test('"trash", stated explicitly, is fine', () => {
    const doc = clone();
    find(doc, 'npm-cache').method = 'trash';
    assert.doesNotThrow(() => cleaner.validate(doc));
  });

  await t.test('a confirm contract is rejected wherever it appears', () => {
    const doc = clone();
    find(doc, 'npm-cache').confirm = { style: 'permanent', mustContainWord: 'permanently' };
    rejects(doc, /carries a confirm contract/);
  });
});

test('both bins are recorded as excluded, with the reasoning', async (t) => {
  const reasonFor = (p) => (REAL.excluded.find((e) => e.path === p) || {}).reason;

  await t.test('neither is a target any more', () => {
    for (const id of ['macos-trash', 'windows-recycle-bin']) {
      assert.equal(REAL.targets.some((x) => x.id === id), false, `${id} must not be a target`);
    }
  });

  await t.test('each is in excluded, and says why', () => {
    for (const p of ['~/.Trash', 'C:\\$Recycle.Bin']) {
      assert.ok(reasonFor(p), `${p} must be listed in excluded`);
    }
    // The permission cost is the reason ~/.Trash went, and it is the part
    // someone re-proposing this needs to read.
    assert.match(reasonFor('~/.Trash'), /Full Disk Access/);
  });
});

// --- Nothing ships pre-selected ---------------------------------------------

test('every target defaults off', async (t) => {
  await t.test('defaultEnabled true is a hard error', () => {
    const doc = clone();
    find(doc, 'npm-cache').defaultEnabled = true;
    rejects(doc, /defaultEnabled must be false — no target may ship pre-selected/);
  });

  await t.test('so is omitting it, and so is a truthy non-boolean', () => {
    const missing = clone();
    delete find(missing, 'npm-cache').defaultEnabled;
    rejects(missing, /missing required field "defaultEnabled"|defaultEnabled must be false/);

    const truthy = clone();
    find(truthy, 'npm-cache').defaultEnabled = 'no';
    rejects(truthy, /defaultEnabled must be false/);
  });

  await t.test('the shipped file has none enabled', () => {
    assert.equal(REAL.targets.filter((t) => t.defaultEnabled !== false).length, 0);
  });
});

// --- Expansion may never degrade -------------------------------------------

test('an expand contract is a requirement, not a suggestion', async (t) => {
  await t.test('with no handler and ifUnsupported=omit, the entry does not ship', () => {
    const { targets, omitted } = cleaner.validate(clone());
    assert.equal(targets.some((t2) => t2.id === 'ios-backups'), false);
    assert.match(omitted[0].reason, /no handler for expand unit "deviceBackup"/);
  });

  await t.test('with no handler and no omit instruction, it is a hard error', () => {
    const doc = clone();
    find(doc, 'ios-backups').expand.ifUnsupported = 'folder';
    rejects(doc, /may never\s+degrade to a folder-level checkbox|must be handled or omitted/);
  });

  await t.test('a folder-level checkbox is rejected even with a handler present', () => {
    const doc = clone();
    find(doc, 'ios-backups').expand.wholeTargetSelectable = true;
    const handlers = new Map([['deviceBackup', () => []]]);
    assert.throws(
      () => cleaner.validate(doc, { handlers }),
      (err) => {
        assert.match(err.problems.join('\n'), /wholeTargetSelectable must be false/);
        return true;
      },
    );
  });

  await t.test('given a handler, the entry ships instead of being omitted', () => {
    const handlers = new Map([['deviceBackup', () => []]]);
    const { targets, omitted } = cleaner.validate(clone(), { handlers });
    assert.equal(targets.some((t2) => t2.id === 'ios-backups'), true);
    assert.equal(omitted.length, 0);
  });
});

// --- Exclusions must be able to exclude -------------------------------------

test('a stale exclusion is a hard error, because it protects nothing', async (t) => {
  await t.test('an exclusion outside its target can never match', () => {
    const doc = clone();
    find(doc, 'macos-user-caches').exclude = ['~/Library/Application Support/JetBrains'];
    rejects(doc, /is not under the target .*so it can never exclude anything/);
  });

  await t.test('the JetBrains exclusion specifically must stay under the glob', () => {
    // The find that motivated the whole allowlist. If this ever stops being
    // structurally valid, the sweep silently reclaims PyCharm Local History.
    const jb = find(clone(), 'macos-user-caches').exclude.find((e) => e.includes('JetBrains'));
    assert.ok(jb, 'the JetBrains exclusion must exist');
    assert.equal(cleaner.isUnder(jb, '~/Library/Caches'), true);
  });

  await t.test('excluding the target itself would exclude everything', () => {
    const doc = clone();
    find(doc, 'macos-user-caches').exclude = ['~/Library/Caches'];
    rejects(doc, /is the target itself, which would exclude everything/);
  });

  await t.test('malformed exclusions are rejected', () => {
    const notArray = clone();
    find(notArray, 'macos-user-caches').exclude = '~/Library/Caches/JetBrains';
    rejects(notArray, /exclude must be an array/);

    const empty = clone();
    find(empty, 'macos-user-caches').exclude = [''];
    rejects(empty, /exclude entries must be non-empty strings/);
  });

  await t.test('the separately-listed targets stay excluded from the glob', () => {
    // pip and Homebrew live inside ~/Library/Caches and are their own entries.
    // Without these exclusions they are measured and deleted twice.
    const caches = find(clone(), 'macos-user-caches');
    for (const p of ['~/Library/Caches/pip', '~/Library/Caches/Homebrew']) {
      assert.ok(caches.exclude.includes(p), `${p} must be excluded from the glob`);
    }
  });
});

// --- Structural validation --------------------------------------------------

test('structural problems are all reported, not just the first', async (t) => {
  await t.test('required fields', () => {
    for (const field of ['id', 'label', 'platform', 'path', 'description', 'risk', 'requiresAppClosed']) {
      const doc = clone();
      delete find(doc, 'npm-cache')[field];
      rejects(doc, new RegExp(`missing required field "${field}"|${field} must be`), `${field}`);
    }
  });

  await t.test('a duplicate id', () => {
    const doc = clone();
    doc.targets.push({ ...find(doc, 'npm-cache') });
    rejects(doc, /duplicate id/);
  });

  await t.test('an unknown platform or risk', () => {
    const p = clone();
    find(p, 'npm-cache').platform = 'linux';
    rejects(p, /platform must be one of/);

    const r = clone();
    find(r, 'npm-cache').risk = 'probably fine';
    rejects(r, /risk must be one of/);
  });

  await t.test('a document with no targets array', () => {
    rejects({}, /no targets array/);
    rejects({ targets: 'lots' }, /no targets array/);
  });

  await t.test('every problem is listed in one pass, not one at a time', () => {
    const doc = clone();
    find(doc, 'npm-cache').risk = 'nope';
    find(doc, 'pip-cache-macos').platform = 'linux';
    find(doc, 'homebrew-cache-macos').defaultEnabled = true;
    try {
      cleaner.validate(doc);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.problems.length >= 3, `expected 3+ problems, got ${err.problems.length}`);
    }
  });
});

test('a malformed targets.json on disk fails loudly', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-targets-'));
  const file = path.join(dir, 'targets.json');
  await fsp.writeFile(file, '{ "targets": [ this is not json }');
  await assert.rejects(
    () => cleaner.loadDocument(file),
    (err) => {
      assert.ok(err instanceof cleaner.TargetsError);
      assert.match(err.message, /could not be parsed as JSON/);
      return true;
    },
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

// --- Path resolution --------------------------------------------------------

test('paths resolve, and refuse to resolve into nonsense', async (t) => {
  const opts = { home: '/Users/x', env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' } };

  await t.test('~ and %VAR% expand', () => {
    assert.equal(cleaner.resolvePath('~/Library/Caches', opts), '/Users/x/Library/Caches');
    assert.equal(cleaner.resolvePath('~', opts), '/Users/x');
    assert.equal(cleaner.resolvePath('%LOCALAPPDATA%\\npm-cache', opts), 'C:\\Users\\x\\AppData\\Local\\npm-cache');
  });

  await t.test('an unset variable resolves to nothing, not to a partial path', () => {
    // The dangerous failure would be %TEMP%\\foo becoming \\foo — an absolute
    // path at the filesystem root.
    assert.equal(cleaner.resolvePath('%TEMP%\\x', { ...opts, env: {} }), null);
    assert.equal(cleaner.resolvePath('%NOPE%', opts), null);
  });

  await t.test('a literal path is returned unchanged', () => {
    assert.equal(cleaner.resolvePath('C:\\Windows\\Temp', opts), 'C:\\Windows\\Temp');
  });

  await t.test('empty and non-string inputs resolve to nothing', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.equal(cleaner.resolvePath(bad, opts), null);
    }
  });

  await t.test('every shipped target resolves or is explicitly absent', () => {
    const env = { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U', TEMP: 'C:\\T', APPDATA: 'C:\\A' };
    for (const target of REAL.targets) {
      const r = cleaner.resolvePath(target.path, { home: '/Users/x', env });
      assert.ok(typeof r === 'string' && r.length > 0, `${target.id}: ${target.path} did not resolve`);
      assert.ok(!r.includes('%'), `${target.id}: unexpanded variable in ${r}`);
      assert.ok(!r.includes('~'), `${target.id}: unexpanded home in ${r}`);
    }
  });
});

test('globBase and isUnder', async (t) => {
  await t.test('globBase stops at the first star', () => {
    assert.equal(cleaner.globBase('~/Library/Caches/*'), '~/Library/Caches');
    assert.equal(cleaner.globBase('%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache'),
      '%LOCALAPPDATA%\\Google\\Chrome\\User Data');
    assert.equal(cleaner.globBase('~/.npm/_cacache'), '~/.npm/_cacache');
  });

  await t.test('isUnder does not match on a shared name prefix', () => {
    assert.equal(cleaner.isUnder('/a/b', '/a'), true);
    assert.equal(cleaner.isUnder('/a', '/a'), true);
    assert.equal(cleaner.isUnder('/ab/c', '/a'), false, 'a sibling starting with the same letters is not under it');
    assert.equal(cleaner.isUnder('/a/b', '/a/'), true);
    assert.equal(cleaner.isUnder('/x', ''), false);
  });
});

// --- Measuring --------------------------------------------------------------

test('measuring never follows a symlink', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-measure-'));
  const cache = path.join(dir, 'cache');
  const precious = path.join(dir, 'precious');
  await fsp.mkdir(cache);
  await fsp.mkdir(precious);
  await fsp.writeFile(path.join(cache, 'a.bin'), Buffer.alloc(1024));
  await fsp.writeFile(path.join(precious, 'thesis.txt'), Buffer.alloc(4096));
  await fsp.symlink(precious, path.join(cache, 'link-to-precious'), 'dir');

  await t.test('a symlinked directory inside the target is skipped, not walked', () => {
    // This is the leak the rule exists to stop: an innocuous path on the
    // allowlist pointing at anything at all.
    return measureAnd(cache, (m) => {
      assert.equal(m.bytes, 1024, 'the linked-to directory must not be counted');
      assert.equal(m.files, 1);
      assert.equal(m.symlinksSkipped, 1);
    });
  });

  await t.test('a target that is itself a symlink is refused', async () => {
    const linked = path.join(dir, 'linked-cache');
    await fsp.symlink(precious, linked, 'dir');
    const m = await cleaner.measure(linked);
    assert.equal(m.rootIsSymlink, true);
    assert.equal(m.bytes, 0, 'nothing behind a symlinked target may be measured');
  });

  await t.test('an absent path measures as null, which is not an error', async () => {
    assert.equal(await cleaner.measure(path.join(dir, 'not-here')), null);
  });

  await t.test('exclusions are honoured while walking', async () => {
    const keep = path.join(cache, 'keep');
    await fsp.mkdir(keep);
    await fsp.writeFile(path.join(keep, 'history.bin'), Buffer.alloc(2048));

    const without = await cleaner.measure(cache);
    assert.equal(without.bytes, 1024 + 2048);

    const with_ = await cleaner.measure(cache, { exclude: [keep] });
    assert.equal(with_.bytes, 1024, 'the excluded subtree must not be counted');
    assert.ok(with_.excludedHits.has(keep), 'a matched exclusion is recorded');
  });

  async function measureAnd(target, check) {
    check(await cleaner.measure(target));
  }

  await fsp.rm(dir, { recursive: true, force: true });
});

test('an age-filtered target reports what it would remove, not the folder total', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-age-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const DAY = 86400000;
  const now = Date.now();
  const write = async (name, bytes, ageDays) => {
    const f = path.join(dir, name);
    await fsp.writeFile(f, Buffer.alloc(bytes));
    const when = new Date(now - ageDays * DAY);
    await fsp.utimes(f, when, when);
    return f;
  };

  await write('ancient.bin', 1000, 400);
  await write('old.bin', 2000, 120);
  await write('recent.bin', 4000, 5);

  await t.test('only files past the cutoff are counted as removable', async () => {
    const m = await cleaner.measure(dir, { minAgeDays: 90, now });
    assert.equal(m.bytes, 3000, 'the two old files, and only those');
    assert.equal(m.files, 2);
    assert.equal(m.tooRecent, 1);
    assert.equal(m.scannedBytes, 7000, 'everything is still reported as scanned');
    assert.equal(m.scannedFiles, 3);
  });

  await t.test('without a filter, everything is eligible', async () => {
    const m = await cleaner.measure(dir, { now });
    assert.equal(m.bytes, 7000);
    assert.equal(m.tooRecent, 0);
  });

  await t.test('a recently opened file is not stale, whatever its mtime', async () => {
    // The rule from targets.json: use the later of modification and access
    // time. An installer downloaded a year ago but opened last week is in use.
    const f = await write('kept.bin', 8000, 400);
    await fsp.utimes(f, new Date(now - 2 * DAY), new Date(now - 400 * DAY));
    const m = await cleaner.measure(dir, { minAgeDays: 90, now });
    assert.equal(m.bytes, 3000, 'the recently-accessed file must not be eligible');
    assert.equal(cleaner.eligible({ mtimeMs: now - 400 * DAY, atimeMs: now - 2 * DAY }, now - 90 * DAY), false);
    assert.equal(cleaner.eligible({ mtimeMs: now - 400 * DAY, atimeMs: now - 400 * DAY }, now - 90 * DAY), true);
  });
});

test('hardlinked files are counted once', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-link-'));
  const a = path.join(dir, 'a.bin');
  await fsp.writeFile(a, Buffer.alloc(8192));
  await fsp.link(a, path.join(dir, 'b.bin'));
  const m = await cleaner.measure(dir);
  assert.equal(m.files, 2, 'both names are seen');
  assert.equal(m.bytes, 8192, 'but the bytes are counted once');
  await fsp.rm(dir, { recursive: true, force: true });
});

// --- Survey -----------------------------------------------------------------

test('survey reports what is there without touching it', async (t) => {
  const sandboxHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-home-'));
  t.after(() => fsp.rm(sandboxHome, { recursive: true, force: true }));

  await t.test('absent targets are reported quietly, not as errors', async () => {
    const report = await survey({ home: '/nonexistent-home-for-this-test', env: {} });
    assert.ok(report.targets.length > 0);
    for (const r of report.targets) {
      assert.equal(r.present, false);
      assert.equal(r.bytes, 0);
    }
    assert.equal(report.totals.present, 0);
    assert.ok(report.totals.absent > 0);
  });

  await t.test('only this platform\u2019s targets are surveyed', async () => {
    const win = await survey({ platform: 'win32' });
    assert.ok(win.targets.length > 0);
    assert.equal(win.targets.every((r) => r.id.includes('windows') || r.id.includes('-windows')
      || ['npm-cache-windows', 'pip-cache-windows'].includes(r.id)), true);
    const mac = await survey({ platform: 'darwin' });
    assert.equal(mac.targets.some((r) => r.id === 'macos-user-caches'), true);
    assert.equal(mac.targets.some((r) => r.id === 'windows-user-temp'), false);
  });

  await t.test('an omitted target never appears in the survey', async () => {
    const report = await survey({ platform: 'darwin' });
    assert.equal(report.targets.some((r) => r.id === 'ios-backups'), false);
    assert.deepEqual(report.omitted.map((o) => o.id), ['ios-backups']);
  });

  await t.test('no target reports itself as permanent, because none is', async () => {
    for (const platform of ['darwin', 'win32']) {
      const report = await survey({ platform });
      assert.equal(report.targets.some((r) => r.permanent), false);
    }
  });

  await t.test('a survey against a broken document refuses to run at all', async () => {
    const doc = clone();
    find(doc, 'npm-cache').defaultEnabled = true;
    await assert.rejects(() => cleaner.survey({ doc, platform: 'darwin' }), cleaner.TargetsError);
  });

  // Every survey here runs against an isolated empty home. Pointing them at
  // the real one would walk this machine's actual ~/Library/Caches -- 9.3 GB
  // and about twenty seconds per test -- and would make the assertions depend
  // on whatever happens to be installed.
  function survey(opts) {
    return cleaner.survey({
      doc: clone(),
      home: sandboxHome,
      env: { LOCALAPPDATA: path.join(sandboxHome, 'L'), USERPROFILE: sandboxHome, TEMP: path.join(sandboxHome, 'T') },
      ...opts,
    });
  }
});
