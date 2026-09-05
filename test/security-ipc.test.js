'use strict';

// The security IPC boundary: what the renderer is allowed to make the
// operating system open.
//
// `shell.openExternal` is the one call in this app that hands a string to the
// OS and asks it to act on it, so the renderer is not allowed to compose that
// string. It names a CHECK, and main resolves the destination from the audit
// it ran — the same shape as cleanup taking tokens rather than paths. These
// tests are the proof, written with what a compromised renderer would send.
//
// ipc.js requires electron at load, which `node --test` has no copy of, so the
// module loader is stubbed for the duration. That exercises the guard AS THE
// CHANNEL ACTUALLY USES IT rather than a copy of it that could drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { isSettingsUrl, SETTINGS_SCHEMES } = require('../src/main/security/index');

// ---------- Loading ipc.js without Electron ----------

const handlers = new Map();
const opened = [];

const electronStub = {
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {},
  shell: {
    openExternal: async (url) => {
      opened.push(url);
    },
    showItemInFolder: () => {},
  },
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

const auditHandler = handlers.get('security:audit');
const openFixHandler = handlers.get('security:openFix');

// --- The channels exist at all -------------------------------------------------

test('the security channels are registered', () => {
  assert.ok(handlers.has('security:audit'), 'the audit channel must be registered');
  assert.ok(handlers.has('security:openFix'), 'the openFix channel must be registered');
});

// --- The scheme allowlist ------------------------------------------------------

test('only settings schemes are ever openable', () => {
  for (const scheme of SETTINGS_SCHEMES) {
    assert.equal(isSettingsUrl(`${scheme}whatever`), true, `${scheme} must be allowed`);
  }

  // Everything a URL could otherwise be. http and https are absent on purpose:
  // a disk audit has no business opening a web page, and the app's one
  // permitted network call lives in the checker, not here.
  const refused = [
    'https://example.com',
    'http://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'vscode://file/etc/passwd',
    'x-apple.systempreferences',
    ' x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension',
    '',
    null,
    undefined,
    42,
    {},
  ];
  for (const url of refused) {
    assert.equal(isSettingsUrl(url), false, `${String(url)} must not be openable`);
  }
});

// --- What the boundary refuses -------------------------------------------------

test('openFix refuses anything that is not a check id', async (t) => {
  const hostile = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { id: 'filevault' }],
    ['an array', ['filevault']],
    ['an empty string', ''],
    ['whitespace', '   '],
  ];

  for (const [name, payload] of hostile) {
    await t.test(name, async () => {
      await assert.rejects(
        async () => openFixHandler({}, payload),
        (err) => err instanceof TypeError,
        `${name} must be refused at the boundary`,
      );
      assert.deepEqual(opened, [], 'nothing may have been opened');
    });
  }
});

test('a URL is not a check id, however well-formed it looks', async () => {
  // The whole point of the design: a destination cannot be spoken here. A
  // renderer that had been taken over would try this first, and the well-formed
  // settings URL is the interesting case — it is refused for being a URL at
  // all, not for being the wrong one.
  const urls = [
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension',
    'ms-settings:deviceencryption',
    'windowsdefender://threat',
    'https://example.com',
    'file:///Applications/Calculator.app',
    'javascript:alert(1)',
  ];

  for (const url of urls) {
    const result = await openFixHandler({}, url);
    assert.equal(result.ok, false, `${url} must not open`);
    assert.equal(result.reason, 'no-settings-pane');
  }
  assert.deepEqual(opened, [], 'nothing may have been opened');
});

test('an id no audit has produced opens nothing', async () => {
  // Before any audit has run there is no allowlist at all, so even the id of a
  // real check resolves to nothing. A pane cannot outlive — or precede — the
  // audit that named it.
  for (const id of ['filevault', 'firewall', 'defender', '../../etc/passwd', '__proto__', 'constructor']) {
    const result = await openFixHandler({}, id);
    assert.equal(result.ok, false, `${id} must not open before an audit`);
    assert.equal(result.reason, 'no-settings-pane');
  }
  assert.deepEqual(opened, []);
});

// --- What the boundary allows, driven by the real audit ------------------------

test('after an audit, each check opens its own pane and nothing else', async () => {
  const audit = await auditHandler({});
  assert.equal(audit.platform, process.platform);

  if (!audit.supported) {
    // No audit for this OS means no ids, so nothing is openable at all — which
    // is the assertion worth making here.
    const result = await openFixHandler({}, 'filevault');
    assert.equal(result.ok, false);
    return;
  }

  assert.ok(audit.checks.length > 0, 'a supported platform must return checks');

  for (const check of audit.checks) {
    opened.length = 0;
    const result = await openFixHandler({}, check.id);

    if (check.fixUrl === null) {
      // SIP is set from macOS Recovery; drive health is read in Disk Utility.
      // Neither has a settings pane, so neither may open one.
      assert.equal(result.ok, false, `${check.id} has no pane and must not open one`);
      assert.equal(result.reason, 'no-settings-pane');
      assert.deepEqual(opened, [], `${check.id} must have opened nothing`);
    } else {
      assert.equal(result.ok, true, `${check.id} must open its pane`);
      assert.deepEqual(opened, [check.fixUrl], `${check.id} must open exactly its own pane`);
      assert.equal(isSettingsUrl(opened[0]), true, `${check.id} must open a settings scheme`);
    }
  }

  opened.length = 0;
});

test('SIP and drive health are the checks with no pane, on this platform', async () => {
  const audit = await auditHandler({});
  if (audit.platform !== 'darwin') return;

  const withoutPane = audit.checks.filter((c) => c.fixUrl === null).map((c) => c.id).sort();
  assert.deepEqual(withoutPane, ['sip', 'smart']);
});

test('an id belonging to another platform opens nothing', async () => {
  await auditHandler({});
  opened.length = 0;

  // The allowlist holds this machine's checks and only those. A Windows id on
  // macOS is exactly as unknown as an invented one.
  const foreign = process.platform === 'darwin' ? ['bitlocker', 'defender', 'secureboot'] : ['filevault', 'gatekeeper'];

  for (const id of foreign) {
    const result = await openFixHandler({}, id);
    assert.equal(result.ok, false, `${id} must not open on ${process.platform}`);
    assert.equal(result.reason, 'no-settings-pane');
  }
  assert.deepEqual(opened, []);
});

test('the audit itself changes nothing and needs no argument', async () => {
  opened.length = 0;
  const audit = await auditHandler({});
  assert.deepEqual(opened, [], 'running the audit must not open anything');
  assert.equal(typeof audit.platform, 'string');
  assert.equal(typeof audit.supported, 'boolean');
  assert.ok(Array.isArray(audit.checks));
});
