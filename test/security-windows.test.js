'use strict';

// There is no Windows machine here, so every branch is exercised against
// envelopes built to match what the real cmdlets emit — including the Korean
// error text from the machine this was specified against.

const test = require('node:test');
const assert = require('node:assert/strict');
const win = require('../src/main/security/windows');

const STATUSES = new Set(['pass', 'fail', 'unknown', 'na']);

// --- Error shapes, exactly as the real machine produced them -----------------

// Get-BitLockerVolume, non-elevated. TWO errors: the CIM query is refused,
// and then a downstream "no BitLocker volume attached" which is a consequence
// of the refusal, not a finding.
const BITLOCKER_DENIED_KO = [
  {
    category: 'PermissionDenied',
    fqid: 'HRESULT 0x80041003,Microsoft.PowerShell.Commands.GetCimInstanceCommand',
    exception: 'Microsoft.Management.Infrastructure.CimException',
    message: '액세스가 거부되었습니다.',
  },
  {
    category: 'NotSpecified',
    fqid: 'Microsoft.PowerShell.Commands.WriteErrorException,Get-Win32EncryptableVolumeInternal',
    exception: 'System.Runtime.InteropServices.COMException',
    message: '에 연결된 BitLocker 볼륨이 없습니다.',
  },
];

const BITLOCKER_DENIED_EN = BITLOCKER_DENIED_KO.map((e, i) => ({
  ...e,
  message: i === 0 ? 'Access is denied.' : 'No BitLocker volume is attached to.',
}));

const SECUREBOOT_DENIED_KO = [
  {
    category: 'PermissionDenied',
    fqid: 'Confirm-SecureBootUEFI',
    exception: 'System.UnauthorizedAccessException',
    message: '적절한 권한을 설정할 수 없습니다. 액세스가 거부되었습니다.',
  },
];

const SECUREBOOT_DENIED_EN = [
  { ...SECUREBOOT_DENIED_KO[0], message: 'Unable to set proper privileges. Access was denied.' },
];

const env = (data, errors = []) => ({ data, errors });

// --- The cascade ------------------------------------------------------------

test('BitLocker: a permission failure is never reported as unencrypted', async (t) => {
  await t.test('the real two-error, non-elevated output maps to unknown', () => {
    const r = win.parseBitLocker(env(null, BITLOCKER_DENIED_KO));
    assert.equal(r.status, 'unknown');
    assert.notEqual(r.status, 'fail');
    assert.notEqual(r.status, 'na');
  });

  await t.test('the downstream error alone must not be read as "no BitLocker"', () => {
    // This is the whole trap: read on its own, the second error looks exactly
    // like a machine that has no BitLocker volumes. It must not win.
    const r = win.parseBitLocker(env([], BITLOCKER_DENIED_KO));
    assert.equal(r.status, 'unknown', 'permission must outrank an empty volume list');
  });

  await t.test('permission wins even if a volume list somehow came back', () => {
    const r = win.parseBitLocker(
      env([{ mount: 'C:', status: 'FullyDecrypted', protection: 'Off' }], BITLOCKER_DENIED_KO),
    );
    assert.equal(r.status, 'unknown');
  });

  await t.test('the detail says it could not look, not that it is off', () => {
    const r = win.parseBitLocker(env(null, BITLOCKER_DENIED_KO));
    assert.match(r.detail, /could not be read/i);
    assert.doesNotMatch(r.detail, /\bis off\b|not encrypted/i);
  });

  await t.test('without a permission error, an empty list is genuinely n/a', () => {
    const r = win.parseBitLocker(env([], [BITLOCKER_DENIED_KO[1]]));
    assert.equal(r.status, 'na');
  });

  await t.test('encrypted volumes pass; an unprotected one is named', () => {
    assert.equal(
      win.parseBitLocker(env([{ mount: 'C:', status: 'FullyEncrypted', protection: 'On' }])).status,
      'pass',
    );
    const r = win.parseBitLocker(
      env([
        { mount: 'C:', status: 'FullyEncrypted', protection: 'On' },
        { mount: 'D:', status: 'FullyDecrypted', protection: 'Off' },
      ]),
    );
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /D:/);
    assert.doesNotMatch(r.detail, /C:.*not encrypted/);
  });
});

// --- Locale independence ----------------------------------------------------

test('classification never depends on the language of the message', async (t) => {
  await t.test('BitLocker: Korean and English produce the same result', () => {
    const ko = win.parseBitLocker(env(null, BITLOCKER_DENIED_KO));
    const en = win.parseBitLocker(env(null, BITLOCKER_DENIED_EN));
    assert.deepEqual(ko, en);
    assert.equal(ko.status, 'unknown');
  });

  await t.test('Secure Boot: Korean and English produce the same result', () => {
    const ko = win.parseSecureBoot(env(null, SECUREBOOT_DENIED_KO));
    const en = win.parseSecureBoot(env(null, SECUREBOOT_DENIED_EN));
    assert.deepEqual(ko, en);
    assert.equal(ko.status, 'unknown');
  });

  await t.test('a message in any language is ignored entirely', () => {
    // Adversarial: the message claims the opposite of the data. The data wins,
    // because the message is never read by a decision.
    const lying = [{ category: 'NotSpecified', fqid: 'x', exception: 'System.Exception',
      message: 'Firewall is disabled. Antivirus is off. Access is denied.' }];
    const r = win.parseFirewall(
      env([{ name: 'Domain', enabled: 'True' }, { name: 'Private', enabled: 'True' },
           { name: 'Public', enabled: 'True' }], lying),
    );
    assert.equal(r.status, 'pass', 'English words in a message must not classify anything');
  });

  await t.test('permission is detected by category, exception type, or HRESULT alike', () => {
    const byCategory = [{ category: 'PermissionDenied', fqid: '', exception: '', message: '한국어' }];
    const byException = [{ category: 'NotSpecified', fqid: '', exception: 'System.UnauthorizedAccessException', message: '日本語' }];
    const byHresult = [{ category: 'NotSpecified', fqid: 'HRESULT 0x80041003,Foo', exception: '', message: 'Deutsch' }];
    const byWin32 = [{ category: 'NotSpecified', fqid: 'HRESULT 0x80070005,Foo', exception: '', message: 'Français' }];
    for (const errs of [byCategory, byException, byHresult, byWin32]) {
      assert.equal(win.hasPermissionDenied(errs), true, JSON.stringify(errs));
    }
    assert.equal(win.hasPermissionDenied([{ category: 'ObjectNotFound', fqid: '', exception: '' }]), false);
    assert.equal(win.hasPermissionDenied([]), false);
  });
});

// --- Defender ---------------------------------------------------------------

test('Microsoft Defender', async (t) => {
  const defender = (over) => env({
    antivirusEnabled: true, realtimeEnabled: true, signatureAgeDays: 0,
    signatureUpdated: '2026-08-24T00:39:07.0000000Z', ...over,
  });

  await t.test('the real machine state: on, real-time on, fresh definitions', () => {
    const r = win.parseDefender(defender());
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /updated today/i);
  });

  await t.test('antivirus off', () => {
    const r = win.parseDefender(defender({ antivirusEnabled: false }));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /turned off/i);
  });

  await t.test('on but real-time protection off is its own finding', () => {
    const r = win.parseDefender(defender({ realtimeEnabled: false }));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /real-time protection is off/i);
    assert.doesNotMatch(r.detail, /antivirus is turned off/i);
  });

  await t.test('on with stale definitions is distinct from being off', () => {
    const r = win.parseDefender(defender({ signatureAgeDays: 30 }));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /30 days old/);
    assert.match(r.detail, /real-time protection/i, 'must still say protection is running');
  });

  await t.test('the staleness boundary', () => {
    assert.equal(win.parseDefender(defender({ signatureAgeDays: win.SIGNATURE_STALE_DAYS })).status, 'pass');
    assert.equal(win.parseDefender(defender({ signatureAgeDays: win.SIGNATURE_STALE_DAYS + 1 })).status, 'fail');
  });

  await t.test('a missing Defender module is unknown, never a pass or a fail', () => {
    const r = win.parseDefender(env(null, [{ category: 'ObjectNotFound', fqid: 'CommandNotFoundException',
      exception: 'System.Management.Automation.CommandNotFoundException', message: '용어가 인식되지 않습니다' }]));
    assert.equal(r.status, 'unknown');
  });

  await t.test('permission denied is unknown', () => {
    assert.equal(win.parseDefender(env(null, SECUREBOOT_DENIED_KO)).status, 'unknown');
  });

  await t.test('unrecognisable data returns null rather than guessing', () => {
    assert.equal(win.parseDefender(env(null)), null);
    assert.equal(win.parseDefender(env({ nothing: true })), null);
    assert.equal(win.parseDefender(null), null);
  });
});

// --- Firewall ---------------------------------------------------------------

test('Windows Firewall', async (t) => {
  const profiles = (d, p, u) => env([
    { name: 'Domain', enabled: d }, { name: 'Private', enabled: p }, { name: 'Public', enabled: u },
  ]);

  await t.test('the real machine state: all three profiles on', () => {
    const r = win.parseFirewall(profiles('True', 'True', 'True'));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /all 3 network profiles/i);
  });

  await t.test('one profile off names which one', () => {
    const r = win.parseFirewall(profiles('True', 'True', 'False'));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /Public/);
    assert.match(r.detail, /on for Domain and Private/i, 'must say which are still on');
  });

  await t.test('several off are all named', () => {
    const r = win.parseFirewall(profiles('False', 'True', 'False'));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /Domain/);
    assert.match(r.detail, /Public/);
  });

  await t.test('NotConfigured is not silently read as on', () => {
    // GpoBoolean.NotConfigured is 2, so a boolean cast would make it true.
    const r = win.parseFirewall(profiles('True', 'NotConfigured', 'True'));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /Private/);
  });

  await t.test('permission denied is unknown', () => {
    assert.equal(win.parseFirewall(env(null, BITLOCKER_DENIED_KO)).status, 'unknown');
  });
});

// --- Disks ------------------------------------------------------------------

test('drive health across N disks', async (t) => {
  const REAL = [
    { name: 'ST1000DM014-2UB10D', health: 'Healthy', media: 'HDD' },
    { name: 'WD_BLACK SN7100 4TB', health: 'Healthy', media: 'SSD' },
  ];

  await t.test('the real machine state: two drives, both healthy', () => {
    const r = win.parseDisks(env(REAL));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /All 2 drives report healthy/i);
    assert.match(r.detail, /ST1000DM014-2UB10D \(HDD\)/);
    assert.match(r.detail, /WD_BLACK SN7100 4TB \(SSD\)/);
    assert.match(r.detail, / and /, 'two drives read as prose, not CSV');
  });

  await t.test('a single disk works too (PowerShell serialises it as an object)', () => {
    // ConvertTo-Json turns a one-element array into a bare object, so a
    // one-disk machine produces a different JSON shape from a two-disk one.
    const r = win.parseDisks(env(REAL[0]));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /^The drive reports healthy/);
  });

  await t.test('four disks', () => {
    const four = [...REAL, { name: 'D3', health: 'Healthy', media: 'SSD' }, { name: 'D4', health: 'Healthy', media: 'HDD' }];
    assert.match(win.parseDisks(env(four)).detail, /All 4 drives report healthy/);
  });

  await t.test('an unhealthy drive is named and the healthy ones are not implicated', () => {
    const r = win.parseDisks(env([REAL[0], { ...REAL[1], health: 'Unhealthy' }]));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /WD_BLACK SN7100 4TB \(SSD\) reports unhealthy/);
    assert.match(r.detail, /other drive reports healthy/i);
  });

  await t.test('a warning is a finding too', () => {
    const r = win.parseDisks(env([{ ...REAL[0], health: 'Warning' }]));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /warning/i);
  });

  await t.test('drives reporting nothing recognisable are unknown, not healthy', () => {
    const r = win.parseDisks(env([{ name: 'X', health: 'Unknown', media: 'Unspecified' }]));
    assert.equal(r.status, 'unknown');
  });

  await t.test('unspecified media is simply not labelled', () => {
    const r = win.parseDisks(env([{ name: 'Some Disk', health: 'Healthy', media: 'Unspecified' }]));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /Some Disk\./);
  });
});

// --- Secure Boot ------------------------------------------------------------

test('Secure Boot', async (t) => {
  await t.test('the real machine state: permission denied, non-elevated', () => {
    const r = win.parseSecureBoot(env(null, SECUREBOOT_DENIED_KO));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /administrator rights/i);
    assert.match(r.detail, /does not ask/i);
  });

  await t.test('enabled and disabled', () => {
    assert.equal(win.parseSecureBoot(env({ enabled: true })).status, 'pass');
    const off = win.parseSecureBoot(env({ enabled: false }));
    assert.equal(off.status, 'fail');
    assert.match(off.detail, /firmware settings/i);
  });

  await t.test('a legacy BIOS machine is n/a, not a failure', () => {
    const r = win.parseSecureBoot(env(null, [{ category: 'InvalidOperation', fqid: 'Confirm-SecureBootUEFI',
      exception: 'System.PlatformNotSupportedException', message: '이 플랫폼에서 지원되지 않습니다' }]));
    assert.equal(r.status, 'na');
    assert.match(r.detail, /UEFI/);
  });
});

// --- Environment failures ---------------------------------------------------

test('PowerShell missing entirely is survivable', async () => {
  const noPowerShell = async () => {
    const err = new Error('spawn powershell.exe ENOENT');
    err.code = 'ENOENT';
    return { file: 'powershell.exe', stdout: '', stderr: '', error: err };
  };
  const checks = await win.audit(noPowerShell);
  assert.equal(checks.length, win.CHECK_SPECS.length);
  for (const c of checks) {
    assert.equal(c.status, 'unknown', `${c.id} must be unknown, not fail`);
    assert.match(c.detail, /PowerShell is not available/i);
  }
});

test('a hung query is stopped and reported, not left to hang the app', async () => {
  const timedOut = async () => {
    const err = new Error('timed out');
    err.killed = true;
    err.signal = 'SIGTERM';
    return { file: 'powershell.exe', stdout: '', stderr: '', error: err };
  };
  const checks = await win.audit(timedOut);
  for (const c of checks) {
    assert.equal(c.status, 'unknown');
    assert.match(c.detail, /did not finish in time/i);
  }
});

test('garbage on stdout does not become a finding', async () => {
  const garbage = async () => ({ file: 'powershell.exe', stdout: 'not json <<<', stderr: '', error: null });
  const checks = await win.audit(garbage);
  for (const c of checks) assert.equal(c.status, 'unknown');
});

test('a parser that throws does not take the audit down', async () => {
  const check = await win.runCheck(
    { id: 'x', label: 'X', fixUrl: null, body: '', parse() { throw new Error('boom'); } },
    async () => ({ stdout: '{"data":{},"errors":[]}', stderr: '', error: null }),
  );
  assert.equal(check.status, 'unknown');
  assert.match(check.detail, /boom/);
});

// --- The whole audit, simulating the real machine ---------------------------

test('the full audit against this machine’s actual output', async () => {
  const byId = {
    defender: { data: { antivirusEnabled: true, realtimeEnabled: true, signatureAgeDays: 0,
      signatureUpdated: '2026-08-24T00:39:07.0000000Z' }, errors: [] },
    firewall: { data: [{ name: 'Domain', enabled: 'True' }, { name: 'Private', enabled: 'True' },
      { name: 'Public', enabled: 'True' }], errors: [] },
    disks: { data: [{ name: 'ST1000DM014-2UB10D', health: 'Healthy', media: 'HDD' },
      { name: 'WD_BLACK SN7100 4TB', health: 'Healthy', media: 'SSD' }], errors: [] },
    bitlocker: { data: null, errors: BITLOCKER_DENIED_KO },
    secureboot: { data: null, errors: SECUREBOOT_DENIED_KO },
  };
  // Route each script to its envelope by the cmdlet it contains.
  const exec = async (script) => {
    const which = script.includes('Get-MpComputerStatus') ? 'defender'
      : script.includes('Get-NetFirewallProfile') ? 'firewall'
      : script.includes('Get-PhysicalDisk') ? 'disks'
      : script.includes('Get-BitLockerVolume') ? 'bitlocker'
      : 'secureboot';
    return { stdout: JSON.stringify(byId[which]), stderr: '', error: null };
  };

  const checks = await win.audit(exec);
  const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  assert.deepEqual(status, {
    defender: 'pass',
    firewall: 'pass',
    disks: 'pass',
    bitlocker: 'unknown', // NOT fail, NOT na — we could not look
    secureboot: 'unknown',
  });
});

// --- Contract ---------------------------------------------------------------

test('every check has the agreed shape', async () => {
  const checks = await win.audit(async () => ({ stdout: '', stderr: '', error: null }));
  const ids = checks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const c of checks) {
    assert.deepEqual(Object.keys(c).sort(), ['detail', 'fixUrl', 'id', 'label', 'status']);
    assert.ok(STATUSES.has(c.status), `${c.id}: ${c.status}`);
    assert.ok(c.label.length > 0 && c.detail.length > 0);
    assert.ok(c.fixUrl === null || /^(ms-settings:|windowsdefender:)/.test(c.fixUrl),
      `${c.id} fixUrl must be a Windows deep link or null, got: ${c.fixUrl}`);
  }
});

test('no check copy contains a score, a count, or urgency language', async () => {
  const exec = async () => ({ stdout: JSON.stringify(env(null, BITLOCKER_DENIED_KO)), stderr: '', error: null });
  const generated = await win.audit(exec);
  const sampled = [
    ...generated,
    { id: 'd1', label: '', detail: win.parseDefender(env({ antivirusEnabled: false })).detail },
    { id: 'd2', label: '', detail: win.parseDefender(env({ antivirusEnabled: true, realtimeEnabled: true, signatureAgeDays: 40 })).detail },
    { id: 'f1', label: '', detail: win.parseFirewall(env([{ name: 'Public', enabled: 'False' }])).detail },
    { id: 'k1', label: '', detail: win.parseDisks(env([{ name: 'X', health: 'Unhealthy', media: 'SSD' }])).detail },
    { id: 'b1', label: '', detail: win.parseBitLocker(env([{ mount: 'C:', status: 'FullyDecrypted', protection: 'Off' }])).detail },
    { id: 's1', label: '', detail: win.parseSecureBoot(env({ enabled: false })).detail },
  ];
  const banned = /\b(score|rating|\d+\s*\/\s*\d+|threats?|at risk|danger|critical|urgent|immediately|warning you|vulnerable|insecure)\b/i;
  for (const c of sampled) {
    assert.doesNotMatch(c.label || '', banned, `${c.id} label`);
    assert.doesNotMatch(c.detail, banned, `${c.id} detail: ${c.detail}`);
  }
});

test('the PowerShell it runs cannot prompt, and round-trips through base64', () => {
  const script = win.buildScript('  $data = 1');
  // -NonInteractive is passed as an argument; the script itself must also
  // avoid anything that could stop and wait.
  assert.doesNotMatch(script, /Read-Host|Get-Credential|RunAs|Start-Process/i);
  assert.match(script, /ConvertTo-Json -Compress/);
  assert.match(script, /CategoryInfo\.Category/, 'must capture the locale-invariant category');
  assert.match(script, /FullyQualifiedErrorId/);
  assert.match(script, /GetType\(\)\.FullName/, 'must capture the .NET exception type');

  const decoded = Buffer.from(win.encodeCommand(script), 'base64').toString('utf16le');
  assert.equal(decoded, script, 'EncodedCommand must round-trip exactly');
});

test('number agreement holds for one, two and many', async (t) => {
  await t.test('lists read as prose, not as CSV', () => {
    assert.equal(win.joinList(['A']), 'A');
    assert.equal(win.joinList(['A', 'B']), 'A and B');
    assert.equal(win.joinList(['A', 'B', 'C']), 'A, B and C');
    assert.equal(win.joinList([]), '');
  });

  await t.test('one drive is not "All 1 drive"', () => {
    const d = win.parseDisks(env({ name: 'X', health: 'Healthy', media: 'SSD' })).detail;
    assert.match(d, /^The drive reports healthy/);
    assert.doesNotMatch(d, /All 1/);
  });

  await t.test('one encrypted volume takes "Its", not "Their"', () => {
    const d = win.parseBitLocker(env([{ mount: 'C:', status: 'FullyEncrypted', protection: 'On' }])).detail;
    assert.match(d, /Its contents/);
    assert.doesNotMatch(d, /Their|the 1 volume/);
  });

  await t.test('one unencrypted volume takes "That volume is", not "Those volumes are"', () => {
    const d = win.parseBitLocker(env([{ mount: 'D:', status: 'FullyDecrypted', protection: 'Off' }])).detail;
    assert.match(d, /That volume is not encrypted/);
    assert.doesNotMatch(d, /Those volumes/);
  });

  await t.test('one firewall profile is singular, several are plural', () => {
    const one = win.parseFirewall(env([{ name: 'Domain', enabled: 'True' }, { name: 'Public', enabled: 'False' }])).detail;
    assert.match(one, /the Public profile\b/);
    const two = win.parseFirewall(env([{ name: 'Domain', enabled: 'False' }, { name: 'Public', enabled: 'False' }])).detail;
    assert.match(two, /the Domain and Public profiles\b/);
  });
});

test('toArray absorbs PowerShell’s single-element serialisation', () => {
  assert.deepEqual(win.toArray(null), []);
  assert.deepEqual(win.toArray(undefined), []);
  assert.deepEqual(win.toArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(win.toArray([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(win.toArray([1, 2]), [1, 2]);
});
