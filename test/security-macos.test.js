'use strict';

// The developer's own Mac passes every check, so the failure branches would
// otherwise never run. These feed each parser the strings it will see on a
// machine in the states we cannot reproduce here.

const test = require('node:test');
const assert = require('node:assert/strict');
const macos = require('../src/main/security/macos');

const STATUSES = new Set(['pass', 'fail', 'unknown', 'na']);

test('FileVault', async (t) => {
  await t.test('on (real output from a machine with it enabled)', () => {
    const r = macos.parseFileVault('FileVault is On.\n');
    assert.equal(r.status, 'pass');
  });

  await t.test('off', () => {
    const r = macos.parseFileVault('FileVault is Off.\n');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /not encrypted/i);
  });

  await t.test('off but deferred is reported as pending, not a flat off', () => {
    const r = macos.parseFileVault(
      "FileVault is Off.\nDeferred enablement appears to be active for user 'kim'.\n",
    );
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /next time a user logs in/i);
  });

  await t.test('unrecognised output returns null rather than guessing', () => {
    assert.equal(macos.parseFileVault(''), null);
    assert.equal(macos.parseFileVault('command not found'), null);
    assert.equal(macos.parseFileVault('FileVault is confused.'), null);
  });
});

test('System Integrity Protection', async (t) => {
  await t.test('enabled', () => {
    const r = macos.parseSip('System Integrity Protection status: enabled.\n');
    assert.equal(r.status, 'pass');
  });

  await t.test('disabled', () => {
    const r = macos.parseSip('System Integrity Protection status: disabled.\n');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /Recovery/i);
  });

  await t.test('custom configuration is neither on nor off, so it is unknown', () => {
    const r = macos.parseSip(
      'System Integrity Protection status: enabled (Custom Configuration).\n\nConfiguration:\n\tApple Internal: disabled\n\tKext Signing: disabled\n',
    );
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /custom configuration/i);
  });

  await t.test('unrecognised output returns null', () => {
    assert.equal(macos.parseSip(''), null);
    assert.equal(macos.parseSip('csrutil: command not found'), null);
  });
});

test('Gatekeeper', async (t) => {
  await t.test('enabled', () => {
    assert.equal(macos.parseGatekeeper('assessments enabled\n').status, 'pass');
  });

  await t.test('disabled', () => {
    const r = macos.parseGatekeeper('assessments disabled\n');
    assert.equal(r.status, 'fail');
  });

  await t.test('unrecognised output returns null', () => {
    assert.equal(macos.parseGatekeeper(''), null);
    assert.equal(macos.parseGatekeeper('spctl: unrecognized option'), null);
  });
});

test('Application firewall', async (t) => {
  await t.test('enabled (State = 1)', () => {
    const r = macos.parseFirewall('Firewall is enabled. (State = 1)\n');
    assert.equal(r.status, 'pass');
  });

  await t.test('disabled (State = 0)', () => {
    const r = macos.parseFirewall('Firewall is disabled. (State = 0)\n');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /not being filtered/i);
  });

  await t.test('block-all (State = 2) is still on', () => {
    const r = macos.parseFirewall('Firewall is enabled. (State = 2)\n');
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /block all incoming/i);
  });

  await t.test('an unrecognised state is not reported as either on or off', () => {
    const r = macos.parseFirewall('Firewall is something. (State = 7)\n');
    assert.equal(r.status, 'unknown');
  });

  await t.test('falls back to the words when no state number is printed', () => {
    assert.equal(macos.parseFirewall('Firewall is enabled.').status, 'pass');
    assert.equal(macos.parseFirewall('Firewall is disabled.').status, 'fail');
  });

  await t.test('unrecognised output returns null', () => {
    assert.equal(macos.parseFirewall(''), null);
    assert.equal(macos.parseFirewall('no such file or directory'), null);
  });
});

test('Drive health (SMART)', async (t) => {
  const plist = (status) => JSON.stringify({ DeviceIdentifier: 'disk3s1', SMARTStatus: status });

  await t.test('Verified', () => {
    assert.equal(macos.parseSmart(plist('Verified')).status, 'pass');
  });

  await t.test('Failing', () => {
    const r = macos.parseSmart(plist('Failing'));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /failing/i);
  });

  await t.test('Not Supported is not applicable, not a failure', () => {
    const r = macos.parseSmart(plist('Not Supported'));
    assert.equal(r.status, 'na');
    assert.match(r.detail, /normal/i);
  });

  await t.test('an unrecognised value is unknown, not assumed healthy', () => {
    assert.equal(macos.parseSmart(plist('Bananas')).status, 'unknown');
  });

  await t.test('missing key, empty value, bad JSON all return null', () => {
    assert.equal(macos.parseSmart(JSON.stringify({ DeviceIdentifier: 'disk3s1' })), null);
    assert.equal(macos.parseSmart(plist('   ')), null);
    assert.equal(macos.parseSmart('not json at all'), null);
    assert.equal(macos.parseSmart(''), null);
    assert.equal(macos.parseSmart('null'), null);
  });

  await t.test('parses a real plist through plutil, not by grepping', async () => {
    // Proves the actual pipeline: plist XML -> plutil -> JSON -> parser.
    const { execFile } = require('node:child_process');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>DeviceIdentifier</key><string>disk3s1</string>
  <key>SMARTStatus</key><string>Failing</string>
</dict></plist>`;
    const json = await new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin.end(xml);
    });
    assert.equal(macos.parseSmart(json).status, 'fail');
  });
});

test('automatic updates is always unknown, and says why', () => {
  const c = macos.automaticUpdatesCheck();
  assert.equal(c.status, 'unknown');
  assert.equal(c.id, 'automatic-updates');
  // The reasoning must survive in the copy: absence is not evidence of "off".
  assert.match(c.detail, /absent|never touched/i);
  assert.match(c.fixUrl, /Software-Update-Settings/);
});

test('a missing command is survivable, not just unexpected output', async () => {
  const check = await macos.runCheck({
    id: 'bogus',
    label: 'Command that is not there',
    file: '/usr/bin/definitely-not-a-real-binary-xyz',
    args: ['--status'],
    fixUrl: null,
    parse: macos.parseFileVault,
  });
  assert.equal(check.status, 'unknown');
  assert.match(check.detail, /not present on this system/i);
});

test('a check that throws does not take the audit down', async () => {
  const check = await macos.runCheck({
    id: 'explodes',
    label: 'Throws on parse',
    file: '/bin/echo',
    args: ['hello'],
    fixUrl: null,
    parse() {
      throw new Error('boom');
    },
  });
  assert.equal(check.status, 'unknown');
  assert.match(check.detail, /boom/);
});

test('needing elevation reports unknown with the reason, never a prompt', () => {
  const detail = macos.explainFailure(
    { stdout: '', stderr: 'Error: must be run as root\n', error: new Error('exit 1') },
    '/usr/bin/something',
  );
  assert.match(detail, /administrator rights/i);
  assert.match(detail, /does not ask/i);
});

test('a timeout is reported as a timeout', () => {
  const err = new Error('timed out');
  err.killed = true;
  err.signal = 'SIGTERM';
  const detail = macos.explainFailure({ stdout: '', stderr: '', error: err }, '/usr/bin/slow');
  assert.match(detail, /did not finish in time/i);
});

test('every check on this machine has the agreed shape', async () => {
  const checks = await macos.audit();
  assert.ok(checks.length >= 6, 'expected all checks to be present');

  const ids = checks.map((c) => c.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'ids must be unique');
  for (const id of ['filevault', 'sip', 'gatekeeper', 'firewall', 'smart', 'automatic-updates']) {
    assert.ok(ids.includes(id), `missing check: ${id}`);
  }

  for (const c of checks) {
    assert.deepEqual(
      Object.keys(c).sort(),
      ['detail', 'fixUrl', 'id', 'label', 'status'],
      `${c.id} must have exactly the agreed keys`,
    );
    assert.ok(STATUSES.has(c.status), `${c.id} has an invalid status: ${c.status}`);
    assert.ok(typeof c.label === 'string' && c.label.length > 0, `${c.id} needs a label`);
    assert.ok(typeof c.detail === 'string' && c.detail.length > 0, `${c.id} needs a detail`);
    assert.ok(c.fixUrl === null || c.fixUrl.startsWith('x-apple.systempreferences:'),
      `${c.id} fixUrl must be a System Settings link or null, got: ${c.fixUrl}`);
  }
});

test('no check copy contains a score, a count, or urgency language', async () => {
  const checks = await macos.audit();
  const banned = /\b(score|rating|\d+\s*\/\s*\d+|threats?|at risk|danger|critical|urgent|immediately|warning|vulnerable)\b/i;
  for (const c of checks) {
    assert.doesNotMatch(c.label, banned, `${c.id} label`);
    assert.doesNotMatch(c.detail, banned, `${c.id} detail`);
  }
});

test('SIP deliberately has no settings link', async () => {
  const checks = await macos.audit();
  const sip = checks.find((c) => c.id === 'sip');
  // It cannot be changed from System Settings at all — it is set from
  // Recovery. A link to a pane without the switch would send someone hunting.
  assert.equal(sip.fixUrl, null);
  assert.match(sip.detail, /Recovery|protects system files/i);
});

test('the audit dispatches on platform', async () => {
  const { runAudit } = require('../src/main/security/index');
  const audit = await runAudit();
  assert.equal(audit.platform, process.platform);
  if (process.platform === 'darwin') {
    assert.equal(audit.supported, true);
    assert.ok(Array.isArray(audit.checks) && audit.checks.length > 0);
  } else {
    assert.equal(audit.supported, false);
    assert.deepEqual(audit.checks, []);
  }
});
