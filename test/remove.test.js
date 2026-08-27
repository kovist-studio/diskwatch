'use strict';

// remove.js is the only code in this project that deletes, so these tests are
// written to catch it deleting the wrong thing rather than to prove it deletes
// the right one.
//
// Two rules hold throughout:
//   - the trasher is a spy that records paths instead of removing them, so a
//     leak shows up as an unexpected recorded call rather than as lost data;
//   - every target points inside an fs.mkdtemp() directory. Nothing here ever
//     names a real user path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const remover = require('../src/main/cleaner/remove');
const { REASONS } = remover;

// Records what it was asked to trash. `fail` makes one path throw, which is
// the Windows locked-file case.
function spy(options = {}) {
  const calls = [];
  const fn = async (p) => {
    calls.push(p);
    if (options.fail && options.fail(p)) throw new Error('EBUSY: resource busy or locked');
  };
  fn.calls = calls;
  return fn;
}

// A one-target allowlist rooted in a temp directory.
function docFor(target) {
  return {
    version: 1,
    targets: [
      {
        id: 'temp-target',
        label: 'Temp target',
        platform: process.platform,
        path: target.path,
        description: 'A target that exists only for this test.',
        risk: 'safe',
        defaultEnabled: false,
        requiresAppClosed: target.requiresAppClosed || [],
        ...(target.minAgeDays === undefined ? {} : { minAgeDays: target.minAgeDays }),
        ...(target.exclude ? { exclude: target.exclude } : {}),
      },
    ],
  };
}

async function sandbox(t) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-rm-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const write = async (p, body = 'x') => {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body);
};

// plan() mints into a process-wide ledger; clear it so tokens cannot leak
// between tests.
test.beforeEach(() => remover.resetLedger());

// --- The happy path, so the refusals below mean something ---------------------

test('an eligible item is trashed, once, and reported', async (t) => {
  const dir = await sandbox(t);
  await write(path.join(dir, 'caches', 'appcache', 'blob.bin'), 'x'.repeat(1000));

  const doc = docFor({ path: path.join(dir, 'caches', '*') });
  const trasher = spy();

  const planned = await remover.plan({ doc });
  assert.equal(planned.items.length, 1, 'one cache directory to offer');
  assert.equal(planned.items[0].path, path.join(dir, 'caches', 'appcache'));

  const result = await remover.remove([planned.items[0].token], { doc, trasher });
  assert.deepEqual(trasher.calls, [path.join(dir, 'caches', 'appcache')]);
  assert.equal(result.totals.trashedCount, 1);
  assert.equal(result.totals.skippedCount, 0);
  assert.equal(result.trashed[0].bytes, 1000);
});

// --- Refusal 1: a path that was never on the allowlist ------------------------

test('a path that is not a token is refused', async (t) => {
  const dir = await sandbox(t);
  await write(path.join(dir, 'caches', 'appcache', 'blob.bin'));
  const doc = docFor({ path: path.join(dir, 'caches', '*') });
  const trasher = spy();

  await t.test('remove() takes tokens, not a path string', async () => {
    await assert.rejects(
      () => remover.remove('/etc/passwd', { doc, trasher }),
      TypeError,
      'a bare string must not be accepted at all',
    );
    assert.deepEqual(trasher.calls, []);
  });

  await t.test('an invented token is refused, and never read as a path', async () => {
    const result = await remover.remove(['/etc/passwd', 'not-a-real-token'], { doc, trasher });
    assert.equal(result.totals.trashedCount, 0);
    assert.equal(result.skipped.length, 2);
    for (const s of result.skipped) assert.equal(s.reason, REASONS.UNKNOWN_TOKEN);
    assert.deepEqual(trasher.calls, [], 'nothing may be trashed for an unknown token');
  });

  await t.test('an entry pointing outside every root is refused', async () => {
    // A ledger entry as a compromised caller would forge one: a real target
    // id, and a path from somewhere else entirely.
    const outside = path.join(dir, 'elsewhere', 'secret.txt');
    await write(outside);
    const st = await fsp.lstat(outside);
    const context = await remover.createContext({ doc });
    const verdict = await remover.screen(
      {
        targetId: 'temp-target',
        root: path.join(dir, 'caches', 'appcache'),
        path: outside,
        kind: 'root',
        bytes: 1,
        dev: st.dev,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
      },
      context,
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, REASONS.NOT_IN_LIVE_SURVEY);
    assert.deepEqual(trasher.calls, []);
  });
});

// --- Refusal 2: symlink escape ------------------------------------------------

test('a symlink escape is refused', async (t) => {
  const dir = await sandbox(t);
  const outside = path.join(dir, 'outside');
  await write(path.join(outside, 'real-work.txt'), 'user data');

  await t.test('an item that resolves outside its root', async () => {
    const caches = path.join(dir, 'a-caches');
    await fsp.mkdir(caches, { recursive: true });
    await fsp.symlink(outside, path.join(caches, 'evil'));

    const doc = docFor({ path: path.join(caches, '*') });
    const trasher = spy();

    // enumerateTarget skips it outright: expandGlob and the walk both refuse
    // symlinks, so it never becomes a token in the first place.
    const planned = await remover.plan({ doc });
    assert.equal(planned.items.length, 0, 'a symlinked root is never offered');

    // And if an entry for it is fabricated anyway, the gate refuses it.
    const st = await fsp.lstat(path.join(caches, 'evil'));
    const context = await remover.createContext({ doc });
    const verdict = await remover.screen(
      {
        targetId: 'temp-target',
        root: path.join(caches, 'evil'),
        path: path.join(caches, 'evil'),
        kind: 'root',
        bytes: 0,
        dev: st.dev,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
      },
      context,
    );
    assert.equal(verdict.ok, false);
    assert.ok(
      [REASONS.NOT_IN_LIVE_SURVEY, REASONS.IS_SYMLINK, REASONS.ESCAPES_TARGET_ROOT].includes(verdict.reason),
      `refused for ${verdict.reason}`,
    );
    assert.deepEqual(trasher.calls, []);
    assert.equal((await fsp.readFile(path.join(outside, 'real-work.txt'), 'utf8')), 'user data');
  });

  await t.test('the root itself swapped for a symlink after planning', async () => {
    const caches = path.join(dir, 'b-caches');
    await write(path.join(caches, 'appcache', 'blob.bin'));
    const doc = docFor({ path: path.join(caches, '*') });
    const trasher = spy();

    const planned = await remover.plan({ doc });
    assert.equal(planned.items.length, 1);
    const token = planned.items[0].token;

    // Between plan and remove, the cache directory becomes a link to the
    // user's real work. This is the case a per-item check alone would miss.
    await fsp.rm(path.join(caches, 'appcache'), { recursive: true, force: true });
    await fsp.symlink(outside, path.join(caches, 'appcache'));

    const result = await remover.remove([token], { doc, trasher });
    assert.equal(result.totals.trashedCount, 0);
    assert.deepEqual(trasher.calls, [], 'the swapped root must never be trashed');
    assert.equal((await fsp.readFile(path.join(outside, 'real-work.txt'), 'utf8')), 'user data');
  });
});

// --- Refusal 3: a stale path whose target moved between survey and remove ------

test('a stale path is refused', async (t) => {
  const dir = await sandbox(t);

  await t.test('the path is now a different object', async () => {
    const caches = path.join(dir, 'c-caches');
    await write(path.join(caches, 'appcache', 'blob.bin'));
    const doc = docFor({ path: path.join(caches, '*') });
    const trasher = spy();

    const planned = await remover.plan({ doc });
    const token = planned.items[0].token;

    // Same path, different inode. A check on the path string alone passes here.
    await fsp.rm(path.join(caches, 'appcache'), { recursive: true, force: true });
    await write(path.join(caches, 'appcache', 'blob.bin'), 'different');

    const result = await remover.remove([token], { doc, trasher });
    assert.equal(result.totals.trashedCount, 0);
    assert.equal(result.skipped[0].reason, REASONS.IDENTITY_CHANGED);
    assert.deepEqual(trasher.calls, []);
  });

  await t.test('the whole target moved away', async () => {
    const caches = path.join(dir, 'd-caches');
    await write(path.join(caches, 'appcache', 'blob.bin'));
    const doc = docFor({ path: path.join(caches, '*') });
    const trasher = spy();

    const planned = await remover.plan({ doc });
    const token = planned.items[0].token;

    await fsp.rename(caches, path.join(dir, 'd-caches-moved'));

    const result = await remover.remove([token], { doc, trasher });
    assert.equal(result.totals.trashedCount, 0);
    assert.equal(result.skipped[0].reason, REASONS.NOT_IN_LIVE_SURVEY);
    assert.deepEqual(trasher.calls, []);
  });

  await t.test('an age-filtered file that is no longer old enough', async () => {
    const downloads = path.join(dir, 'downloads');
    const old = path.join(downloads, 'installer.dmg');
    await write(old, 'x'.repeat(500));
    const ancient = Date.now() - 200 * 86400000;
    await fsp.utimes(old, new Date(ancient), new Date(ancient));

    const doc = docFor({ path: downloads, minAgeDays: 90 });
    const trasher = spy();

    const planned = await remover.plan({ doc });
    assert.equal(planned.items.length, 1, 'the old file is offered');
    assert.equal(planned.items[0].kind, 'file', 'age-filtered targets remove files, never the folder');

    // Touched since. It is in use now, and must drop out of the live survey.
    await fsp.utimes(old, new Date(), new Date());

    const result = await remover.remove([planned.items[0].token], { doc, trasher });
    assert.equal(result.totals.trashedCount, 0);
    assert.equal(result.skipped[0].reason, REASONS.NOT_IN_LIVE_SURVEY);
    assert.deepEqual(trasher.calls, []);
  });
});

// --- Refusal 4: the exclusion collision that motivated the design -------------

test('a root that collides with an exclusion is never removable', async (t) => {
  const dir = await sandbox(t);
  const caches = path.join(dir, 'caches');

  // The shape of the real thing: a glob over a cache directory, where three of
  // the matched roots ARE the exclusions. JetBrains here stands for
  // ~/Library/Caches/JetBrains, whose LocalHistory is a developer's
  // uncommitted edit history.
  await write(path.join(caches, 'ordinary', 'blob.bin'));
  await write(path.join(caches, 'JetBrains', 'LocalHistory', 'edits.dat'), 'uncommitted work');
  await write(path.join(caches, 'nested', 'keep', 'precious.dat'), 'precious');

  const doc = docFor({
    path: path.join(caches, '*'),
    exclude: [path.join(caches, 'JetBrains'), path.join(caches, 'nested', 'keep')],
  });
  const trasher = spy();

  await t.test('the excluded roots are not offered, and say why', async () => {
    const planned = await remover.plan({ doc });
    assert.deepEqual(planned.items.map((i) => path.basename(i.path)), ['ordinary']);

    const byPath = Object.fromEntries(planned.refused.map((r) => [path.basename(r.path), r.reason]));
    assert.equal(byPath.JetBrains, REASONS.UNDER_EXCLUSION, 'a root that IS an exclusion');
    assert.equal(byPath.nested, REASONS.CONTAINS_EXCLUSION, 'a root that CONTAINS an exclusion');
  });

  await t.test('and the gate refuses them even if an entry is fabricated', async () => {
    const context = await remover.createContext({ doc });
    for (const [name, expected] of [
      ['JetBrains', REASONS.UNDER_EXCLUSION],
      ['nested', REASONS.CONTAINS_EXCLUSION],
    ]) {
      const p = path.join(caches, name);
      const st = await fsp.lstat(p);
      const verdict = await remover.screen(
        { targetId: 'temp-target', root: p, path: p, kind: 'root', bytes: 0, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs },
        context,
      );
      assert.equal(verdict.ok, false, `${name} must be refused`);
      // It drops out of the live enumeration too, which is a refusal in its
      // own right; either answer is correct, silence is not.
      assert.ok([expected, REASONS.NOT_IN_LIVE_SURVEY].includes(verdict.reason), `${name}: ${verdict.reason}`);
    }
    assert.deepEqual(trasher.calls, []);
    assert.equal(await fsp.readFile(path.join(caches, 'JetBrains', 'LocalHistory', 'edits.dat'), 'utf8'), 'uncommitted work');
  });
});

// --- requiresAppClosed fails closed ------------------------------------------

test('a target whose app is running is refused', async (t) => {
  const dir = await sandbox(t);
  await write(path.join(dir, 'caches', 'appcache', 'blob.bin'));
  const base = { path: path.join(dir, 'caches', '*'), requiresAppClosed: ['Xcode'] };

  // Stand in for ps/tasklist so the test does not depend on what is running.
  const lister = (out) => async () => ({ stdout: out, stderr: '', error: null });
  const psWith = process.platform === 'win32'
    ? (names) => names.map((n) => `"${n}","1","Console","1","1 K"`).join('\n')
    : (names) => names.map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`).join('\n');
  const xcode = process.platform === 'win32' ? 'chrome.exe' : 'Xcode';

  await t.test('running means refused', async () => {
    const doc = docFor(process.platform === 'win32'
      ? { ...base, requiresAppClosed: ['Google Chrome'] }
      : base);
    const trasher = spy();
    const planned = await remover.plan({ doc, runner: lister('') });
    const result = await remover.remove([planned.items[0].token], {
      doc,
      trasher,
      runner: lister(psWith([xcode, 'other'])),
    });
    assert.equal(result.skipped[0].reason, REASONS.APP_RUNNING);
    assert.deepEqual(trasher.calls, []);
  });

  await t.test('an unanswerable check refuses too, rather than assuming closed', async () => {
    const doc = docFor(process.platform === 'win32'
      ? { ...base, requiresAppClosed: ['Google Chrome'] }
      : base);
    const trasher = spy();
    const planned = await remover.plan({ doc, runner: lister('') });

    for (const broken of [
      async () => ({ stdout: '', stderr: 'boom', error: new Error('ENOENT') }),
      async () => ({ stdout: '', stderr: '', error: null }), // ran, said nothing
    ]) {
      remover.resetLedger();
      const p = await remover.plan({ doc, runner: lister('') });
      const result = await remover.remove([p.items[0].token], { doc, trasher, runner: broken });
      assert.equal(result.skipped[0].reason, REASONS.APP_CHECK_FAILED);
    }
    assert.deepEqual(trasher.calls, [], 'a check we could not run is never a pass');
    assert.ok(planned.items.length > 0);
  });

  await t.test('an app name with no known process name is refused, not ignored', async () => {
    const status = await remover.appStatus(['Some App We Never Mapped'], process.platform, {
      runner: lister(psWith(['Finder'])),
    });
    assert.ok(status.error, 'an unmappable name must produce an error, not an empty pass');
    assert.deepEqual(status.blocked, []);
  });
});

// --- Per-item failure is normal ----------------------------------------------

test('a per-item failure is collected, not fatal, and never retried', async (t) => {
  const dir = await sandbox(t);
  for (const name of ['one', 'two', 'three']) {
    await write(path.join(dir, 'caches', name, 'blob.bin'), 'x'.repeat(100));
  }
  const doc = docFor({ path: path.join(dir, 'caches', '*') });
  const trasher = spy({ fail: (p) => path.basename(p) === 'two' });

  const planned = await remover.plan({ doc });
  assert.equal(planned.items.length, 3);

  const result = await remover.remove(planned.items.map((i) => i.token), { doc, trasher });

  assert.equal(result.totals.trashedCount, 2, 'the other two still go');
  assert.equal(result.totals.skippedCount, 1);
  assert.equal(result.skipped[0].reason, REASONS.TRASH_FAILED);
  assert.match(result.skipped[0].detail, /EBUSY/);
  assert.equal(trasher.calls.length, 3, 'three attempts, no retry of the failure');
  assert.equal(trasher.calls.filter((p) => path.basename(p) === 'two').length, 1);
});

test('a token is single use', async (t) => {
  const dir = await sandbox(t);
  await write(path.join(dir, 'caches', 'appcache', 'blob.bin'));
  const doc = docFor({ path: path.join(dir, 'caches', '*') });
  const trasher = spy();

  const planned = await remover.plan({ doc });
  const token = planned.items[0].token;

  const result = await remover.remove([token, token], { doc, trasher });
  assert.equal(trasher.calls.length, 1, 'spent once');
  assert.equal(result.skipped[0].reason, REASONS.TOKEN_ALREADY_USED);
});

// --- The allowlist is re-read, not remembered ---------------------------------

test('an allowlist that no longer validates refuses everything', async (t) => {
  const dir = await sandbox(t);
  await write(path.join(dir, 'caches', 'appcache', 'blob.bin'));
  const doc = docFor({ path: path.join(dir, 'caches', '*') });
  const trasher = spy();

  const planned = await remover.plan({ doc });

  // The file changes underneath us between plan and remove.
  const broken = JSON.parse(JSON.stringify(doc));
  broken.targets[0].defaultEnabled = true;

  const result = await remover.remove([planned.items[0].token], { doc: broken, trasher });
  assert.equal(result.totals.trashedCount, 0);
  assert.equal(result.skipped[0].reason, REASONS.TARGET_NOT_IN_ALLOWLIST);
  assert.match(result.skipped[0].detail, /no longer validates/);
  assert.deepEqual(trasher.calls, []);
});

// --- Rule 1, enforced rather than described ----------------------------------

test('nothing in src/ can delete except through the trasher', async () => {
  const root = path.join(__dirname, '..', 'src');

  async function jsFiles(dir) {
    const out = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'vendor') continue; // d3-hierarchy, copied verbatim
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await jsFiles(p)));
      else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
  }

  // Comment lines are stripped so that a file may name the forbidden calls in
  // order to say it does not use them — which remove.js does, at the top.
  const banned = /\b(?:fs|fsp|fsPromises)\s*\.\s*(?:unlink|rm|rmdir)\b|\b(?:unlinkSync|rmSync|rmdirSync)\b/;

  const offenders = [];
  for (const file of await jsFiles(root)) {
    const code = (await fsp.readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));
    code.forEach((line, i) => {
      if (banned.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `deletion must go through shell.trashItem only:\n${offenders.join('\n')}`,
  );
});

// --- The dev CLI is a dev CLI ------------------------------------------------

test('the dev harness cannot be reached from the app, and is not shipped', async (t) => {
  const repo = path.join(__dirname, '..');

  await t.test('nothing under src/ references tools/', async () => {
    async function jsFiles(dir) {
      const found = [];
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'vendor') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await jsFiles(p)));
        else if (entry.name.endsWith('.js')) found.push(p);
      }
      return found;
    }

    const offenders = [];
    for (const file of await jsFiles(path.join(repo, 'src'))) {
      const body = await fsp.readFile(file, 'utf8');
      if (/require\([^)]*tools\//.test(body) || /['"`][^'"`]*\.\.\/tools\//.test(body)) {
        offenders.push(path.relative(repo, file));
      }
    }
    assert.deepEqual(offenders, [], 'the app must not be able to reach tools/');
  });

  await t.test('electron-builder ships an allowlist that excludes tools/', async () => {
    const yml = await fsp.readFile(path.join(repo, 'electron-builder.yml'), 'utf8');
    const lines = yml.split('\n');
    const start = lines.findIndex((l) => /^files:\s*$/.test(l));
    assert.ok(start >= 0, 'electron-builder.yml must have a files: list');

    const entries = [];
    for (const line of lines.slice(start + 1)) {
      const m = line.match(/^\s+-\s+(.*)$/);
      if (!m) break; // the block ended
      entries.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
    assert.ok(entries.length > 0, 'the files: list must not be empty');

    // Every positive entry names src/ or package.json. This is what keeps
    // tools/ out: an allowlist, not a rule anyone has to remember. Widening it
    // to "**/*" or adding tools/ fails here.
    const included = entries.filter((e) => !e.startsWith('!'));
    for (const entry of included) {
      assert.ok(
        entry === 'package.json' || entry.startsWith('src/'),
        `files: may only ship src/ and package.json, found "${entry}"`,
      );
    }
  });

  await t.test('the npm script runs it under Electron, not node', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(repo, 'package.json'), 'utf8'));
    const script = pkg.scripts['cleaner:remove'];
    assert.ok(script, 'the cleaner:remove script must exist');
    assert.match(script, /^electron /, 'shell.trashItem needs an Electron process');
    assert.doesNotMatch(script, /^node /);
  });
});
