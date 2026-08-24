'use strict';

// Windows security audit. READ-ONLY, same contract as macos.js: every check
// observes and reports, nothing remediates, nothing asks for elevation.
//
// TWO RULES SHAPE THIS FILE.
//
// 1. Nothing is ever classified by reading an error MESSAGE. Windows localises
//    them — on the machine this was written against they arrive in Korean —
//    so matching English text would misclassify every non-English install.
//    Classification uses only values that are the same in every locale: the
//    ErrorCategory enum name, the FullyQualifiedErrorId, and .NET exception
//    type names. The message is carried through for diagnostics and is never
//    read by a decision.
//
// 2. "Could not look" is never reported as "not protected". A PermissionDenied
//    anywhere in a check's errors makes that check 'unknown', full stop.
//    Telling someone their disk is unencrypted when we merely lacked the right
//    to check is the exact false alarm this app exists to prevent.

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 20000;

// Microsoft treats definitions older than this as out of date.
const SIGNATURE_STALE_DAYS = 7;

// AntivirusSignatureAge is a UInt32, not an Int32. Two consequences, both
// handled rather than assumed away:
//
//   - PowerShell must not cast it with [int]. Defender fills the field with an
//     all-ones sentinel (4294967295) when it has no update to date from, and
//     [int] on that value fails. OBSERVED on PowerShell 5.1, ko-KR:
//     RuntimeException, "Value was either too large or too small for an
//     Int32". It is not a terminating error, so the try/catch never sees it:
//     it lands in $Error, the assignment does not happen, and $data stays
//     null. That loses AntivirusEnabled and RealTimeProtectionEnabled too --
//     both perfectly readable -- and degrades the whole check to 'unknown'
//     over one unreadable field. [int64] holds every UInt32 there is, so the
//     cast cannot fail.
//   - The sentinel is not an age. Anything past a human lifetime is Defender
//     saying "no idea", and is reported as unreported rather than rendered as
//     "definitions are 4294967295 days old".
const SIGNATURE_AGE_SENTINEL_DAYS = 36500; // a hundred years

// Deep links into the Windows Security app and Settings. Unlike the macOS
// pane identifiers, these could not be verified on the machine this was
// written on — there is no Windows install here.
const LINK = {
  defender: 'windowsdefender://threat',
  firewall: 'windowsdefender://network',
  encryption: 'ms-settings:deviceencryption',
};

const ELEVATION_DETAIL =
  'This needs administrator rights to read. DiskWatch does not ask for them, so it reports what it could not check rather than prompting you.';

// ---------- Locale-independent error classification ----------

// ErrorCategory is a .NET enum; its name is identical in every locale.
const PERMISSION_CATEGORY = 'PermissionDenied';

// Access-denied HRESULTs, which travel inside FullyQualifiedErrorId.
// 0x80041003 = WBEM_E_ACCESS_DENIED (the CIM/WMI layer)
// 0x80070005 = E_ACCESSDENIED (the Win32 layer)
const ACCESS_DENIED_HRESULT = /0x80041003|0x80070005/i;

// .NET type names, also locale-invariant.
const UNAUTHORIZED_EXCEPTION = /UnauthorizedAccessException/;
const NOT_SUPPORTED_EXCEPTION = /PlatformNotSupportedException|NotSupportedException/;
const COMMAND_MISSING_EXCEPTION = /CommandNotFoundException/;

// "A, B and C" — the copy is read aloud in a UI, not printed as a CSV.
function joinList(items) {
  const list = items.filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return String(list[0]);
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function toArray(value) {
  // PowerShell's ConvertTo-Json serialises a one-element array as a bare
  // object, so a machine with a single disk produces a different shape from
  // one with two. Both arrive here.
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function errorList(envelope) {
  return envelope && envelope.errors ? toArray(envelope.errors) : [];
}

function hasPermissionDenied(errors) {
  return toArray(errors).some(
    (e) =>
      e &&
      (e.category === PERMISSION_CATEGORY ||
        UNAUTHORIZED_EXCEPTION.test(e.exception || '') ||
        ACCESS_DENIED_HRESULT.test(e.fqid || '')),
  );
}

function hasCommandMissing(errors) {
  return toArray(errors).some(
    (e) => e && (COMMAND_MISSING_EXCEPTION.test(e.exception || '') || e.category === 'ObjectNotFound'),
  );
}

function hasNotSupported(errors) {
  return toArray(errors).some((e) => e && NOT_SUPPORTED_EXCEPTION.test(e.exception || ''));
}

// A reading, or null when Defender reported a sentinel instead of an age.
function signatureAgeDays(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return value < SIGNATURE_AGE_SENTINEL_DAYS ? value : null;
}

// ---------- Parsers ----------
// Pure functions of the JSON envelope. Return { status, detail }, or null when
// the envelope is not recognisable — which hands over to failure reporting
// rather than guessing.

function parseDefender(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const errors = errorList(envelope);
  if (hasPermissionDenied(errors)) return { status: 'unknown', detail: ELEVATION_DETAIL };
  if (hasCommandMissing(errors)) {
    return {
      status: 'unknown',
      detail:
        'Microsoft Defender’s status command is not available here, so this could not be read. Another security product may be handling protection instead.',
    };
  }

  const data = envelope.data;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.antivirusEnabled !== 'boolean') return null;

  if (data.antivirusEnabled !== true) {
    return {
      status: 'fail',
      detail: 'Microsoft Defender antivirus is turned off. Another security product may be running in its place.',
    };
  }
  if (data.realtimeEnabled !== true) {
    // On but not watching is a different state from off, and reads differently.
    return {
      status: 'fail',
      detail: 'Defender is on, but real-time protection is off, so files are only checked during a scan you start yourself.',
    };
  }

  const age = signatureAgeDays(data.signatureAgeDays);
  if (age === null) {
    // Protection is observably on; only the age is missing. That is a gap in
    // what Defender reported, not a finding about the machine, so it stays a
    // pass and points at the pane that holds the real answer. Phrased about
    // the age rather than the update itself: the timestamp may well be
    // present, it is the age field that came back as a sentinel.
    return {
      status: 'pass',
      detail:
        'On, with real-time protection. Defender did not report how old its definitions are. Windows Security shows when they last updated.',
    };
  }
  if (age > SIGNATURE_STALE_DAYS) {
    // Distinct from "off": protection is running, but on old information.
    return {
      status: 'fail',
      detail: `On, with real-time protection, but its definitions are ${age} days old. Defender recognises what it has definitions for, so it is working from an old picture.`,
    };
  }
  return {
    status: 'pass',
    detail:
      age === 0
        ? 'On, with real-time protection, and its definitions were updated today.'
        : `On, with real-time protection. Its definitions are ${age} ${age === 1 ? 'day' : 'days'} old.`,
  };
}

function parseFirewall(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const errors = errorList(envelope);
  if (hasPermissionDenied(errors)) return { status: 'unknown', detail: ELEVATION_DETAIL };
  if (hasCommandMissing(errors)) {
    return { status: 'unknown', detail: 'The firewall status command is not available here, so this could not be read.' };
  }

  const profiles = toArray(envelope.data).filter((p) => p && typeof p.name === 'string');
  if (profiles.length === 0) return null;

  const names = (list) => joinList(list.map((p) => p.name));
  // 'True' / 'False' / 'NotConfigured' are GpoBoolean enum names, so they read
  // the same in every locale. A plain boolean cast would turn NotConfigured
  // (which is 2) into "on".
  const off = profiles.filter((p) => String(p.enabled) === 'False');
  const unset = profiles.filter((p) => String(p.enabled) === 'NotConfigured');
  const on = profiles.filter((p) => String(p.enabled) === 'True');

  if (off.length > 0) {
    const rest = on.length > 0 ? ` It is on for ${names(on)}.` : '';
    const which = `the ${names(off)} ${off.length === 1 ? 'profile' : 'profiles'}`;
    return { status: 'fail', detail: `The firewall is off for ${which}.${rest}` };
  }
  if (unset.length > 0) {
    return {
      status: 'unknown',
      detail: `The firewall has no setting recorded for ${names(unset)}, so whether it is on there could not be determined. It is on for ${names(on)}.`,
    };
  }
  return {
    status: 'pass',
    detail: `On for all ${profiles.length} network profiles (${names(profiles)}).`,
  };
}

function describeDisk(disk) {
  const media = String(disk.media || '');
  const kind = media === 'SSD' || media === 'HDD' || media === 'SCM' ? ` (${media})` : '';
  return `${disk.name || 'an unnamed drive'}${kind}`;
}

function parseDisks(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const errors = errorList(envelope);
  if (hasPermissionDenied(errors)) return { status: 'unknown', detail: ELEVATION_DETAIL };
  if (hasCommandMissing(errors)) {
    return { status: 'unknown', detail: 'The drive status command is not available here, so this could not be read.' };
  }

  const disks = toArray(envelope.data).filter((d) => d && typeof d.health === 'string');
  if (disks.length === 0) return null;

  // HealthStatus is an enum: Healthy | Warning | Unhealthy | Unknown.
  const unhealthy = disks.filter((d) => d.health === 'Unhealthy');
  const warning = disks.filter((d) => d.health === 'Warning');
  const healthy = disks.filter((d) => d.health === 'Healthy');
  const unreported = disks.filter((d) => !['Healthy', 'Warning', 'Unhealthy'].includes(d.health));

  if (unhealthy.length > 0 || warning.length > 0) {
    const flagged = [...unhealthy, ...warning];
    const each = joinList(
      flagged.map((d) => `${describeDisk(d)} reports ${d.health === 'Unhealthy' ? 'unhealthy' : 'a warning'}`),
    );
    const rest =
      healthy.length > 0
        ? ` The other ${healthy.length === 1 ? 'drive reports' : 'drives report'} healthy.`
        : '';
    return {
      status: 'fail',
      detail: `${each}. Copy anything you need off ${flagged.length === 1 ? 'it' : 'them'} and have the hardware looked at.${rest}`,
    };
  }
  if (unreported.length === disks.length) {
    return {
      status: 'unknown',
      detail: `None of the ${disks.length} drives reported a health status Windows recognises.`,
    };
  }
  const listed = joinList(disks.map(describeDisk));
  return {
    status: 'pass',
    detail:
      disks.length === 1
        ? `The drive reports healthy: ${listed}.`
        : `All ${disks.length} drives report healthy: ${listed}.`,
  };
}

function parseBitLocker(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const errors = errorList(envelope);

  // THIS CHECK ORDERS ITS BRANCHES DELIBERATELY.
  //
  // Get-BitLockerVolume without administrator rights emits two errors: a
  // PermissionDenied from the CIM query, and then a "no BitLocker volume is
  // attached" that is a CONSEQUENCE of the first — the cmdlet could not see
  // the volumes, so of course it found none. Read on its own, that second
  // error looks exactly like a machine with no BitLocker at all.
  //
  // So permission is checked first and wins outright. Never 'fail', never
  // 'na', regardless of what the empty data set appears to say.
  if (hasPermissionDenied(errors)) {
    return {
      status: 'unknown',
      detail: `Whether this disk is encrypted could not be read. ${ELEVATION_DETAIL}`,
    };
  }
  if (hasCommandMissing(errors)) {
    return {
      status: 'unknown',
      detail: 'The BitLocker commands are not available on this edition of Windows, so encryption status could not be read.',
    };
  }

  const volumes = toArray(envelope.data).filter((v) => v && typeof v.status === 'string');
  if (volumes.length === 0) {
    // No permission problem and nothing reported: genuinely nothing to manage.
    return {
      status: 'na',
      detail: 'Windows reported no BitLocker-manageable volumes on this system.',
    };
  }

  const unprotected = volumes.filter((v) => String(v.protection) !== 'On');
  const mounts = (list) => joinList(list.map((v) => v.mount));

  if (unprotected.length === 0) {
    return {
      status: 'pass',
      detail:
        volumes.length === 1
          ? `On for ${mounts(volumes)}. Its contents stay unreadable without the key.`
          : `On for all ${volumes.length} volumes (${mounts(volumes)}). Their contents stay unreadable without the key.`,
    };
  }
  return {
    status: 'fail',
    detail:
      unprotected.length === 1
        ? `Off for ${mounts(unprotected)}. That volume is not encrypted, so its contents can be read by anyone holding the drive.`
        : `Off for ${mounts(unprotected)}. Those volumes are not encrypted, so their contents can be read by anyone holding the drive.`,
  };
}

function parseSecureBoot(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const errors = errorList(envelope);
  if (hasPermissionDenied(errors)) return { status: 'unknown', detail: ELEVATION_DETAIL };
  if (hasNotSupported(errors)) {
    return {
      status: 'na',
      detail: 'This PC does not use UEFI firmware, so Secure Boot does not apply to it.',
    };
  }
  if (hasCommandMissing(errors)) {
    return { status: 'unknown', detail: 'The Secure Boot command is not available here, so this could not be read.' };
  }

  const data = envelope.data;
  if (!data || typeof data !== 'object' || typeof data.enabled !== 'boolean') return null;

  return data.enabled
    ? {
        status: 'pass',
        detail: 'On. The firmware checks the signature of the boot loader before Windows starts.',
      }
    : {
        status: 'fail',
        detail: 'Off. The firmware starts Windows without checking the boot loader’s signature first. This is changed in the PC’s firmware settings, not in Windows.',
      };
}

// ---------- PowerShell ----------

// Everything the script emits is a value that means the same in every locale:
// enum names, booleans, ISO-8601 timestamps and HRESULT ids. Message text is
// carried for diagnostics only. That is also why a mismatched console code
// page cannot corrupt a decision — nothing decisive is ever non-ASCII.
function buildScript(body) {
  return `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Error.Clear()
$data = $null
try {
${body}
} catch { }
$errs = New-Object System.Collections.ArrayList
foreach ($e in $Error) {
  $null = $errs.Add([pscustomobject]@{
    category  = [string]$e.CategoryInfo.Category
    fqid      = [string]$e.FullyQualifiedErrorId
    exception = $(if ($e.Exception -ne $null) { [string]$e.Exception.GetType().FullName } else { '' })
    message   = $(if ($e.Exception -ne $null) { [string]$e.Exception.Message } else { '' })
  })
}
[pscustomobject]@{ data = $data; errors = @($errs) } | ConvertTo-Json -Compress -Depth 6
`;
}

// -EncodedCommand takes base64 of UTF-16LE, which sidesteps every quoting and
// code-page question between Node and PowerShell.
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const POWERSHELL_CANDIDATES = ['powershell.exe', 'pwsh.exe', 'pwsh'];

function execOnce(file, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) =>
          resolve({ file, stdout: stdout || '', stderr: stderr || '', error: error || null }),
      );
    } catch (err) {
      resolve({ file, stdout: '', stderr: '', error: err });
    }
  });
}

// Never rejects. Tries Windows PowerShell first, then PowerShell 7, and
// reports honestly when neither is present.
async function runPowerShell(script, timeout) {
  const args = [
    '-NoProfile',
    '-NonInteractive', // never stop to ask the user anything
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodeCommand(script),
  ];
  let last = null;
  for (const candidate of POWERSHELL_CANDIDATES) {
    const result = await execOnce(candidate, args, timeout || DEFAULT_TIMEOUT_MS);
    if (!(result.error && result.error.code === 'ENOENT')) return result;
    last = result;
  }
  return last || { file: POWERSHELL_CANDIDATES[0], stdout: '', stderr: '', error: new Error('ENOENT') };
}

function parseEnvelope(stdout) {
  const text = String(stdout || '').trim();
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function explainFailure(result) {
  const error = result && result.error;
  if (error && error.code === 'ENOENT') {
    return 'PowerShell is not available on this system, so the security checks could not run.';
  }
  if (error && (error.killed || error.signal)) {
    return 'The check did not finish in time and was stopped, so this could not be read.';
  }
  if (error) {
    return `This could not be read (${error.code || error.message}).`;
  }
  return 'This could not be read, and Windows did not say why.';
}

// ---------- Check specs ----------

const CHECK_SPECS = [
  {
    id: 'defender',
    label: 'Microsoft Defender antivirus',
    fixUrl: LINK.defender,
    parse: parseDefender,
    body: `  $s = Get-MpComputerStatus
  if ($s -ne $null) {
    $data = [pscustomobject]@{
      antivirusEnabled = [bool]$s.AntivirusEnabled
      realtimeEnabled  = [bool]$s.RealTimeProtectionEnabled
      signatureAgeDays = [int64]$s.AntivirusSignatureAge
      signatureUpdated = $(if ($s.AntivirusSignatureLastUpdated -ne $null) { $s.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o') } else { $null })
    }
  }`,
  },
  {
    id: 'firewall',
    label: 'Windows Firewall',
    fixUrl: LINK.firewall,
    parse: parseFirewall,
    // Enabled is a GpoBoolean enum. Kept as its NAME, not cast to a boolean:
    // NotConfigured is 2, which would cast to true and read as "on".
    body: `  $data = @(Get-NetFirewallProfile | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.Name; enabled = [string]$_.Enabled }
  })`,
  },
  {
    id: 'disks',
    label: 'Drive health',
    fixUrl: null, // no Settings page reports this
    parse: parseDisks,
    body: `  $data = @(Get-PhysicalDisk | ForEach-Object {
    [pscustomobject]@{
      name   = [string]$_.FriendlyName
      health = [string]$_.HealthStatus
      media  = [string]$_.MediaType
    }
  })`,
  },
  {
    id: 'bitlocker',
    label: 'BitLocker drive encryption',
    fixUrl: LINK.encryption,
    parse: parseBitLocker,
    body: `  $data = @(Get-BitLockerVolume | ForEach-Object {
    [pscustomobject]@{
      mount      = [string]$_.MountPoint
      status     = [string]$_.VolumeStatus
      protection = [string]$_.ProtectionStatus
    }
  })`,
  },
  {
    id: 'secureboot',
    label: 'Secure Boot',
    // Set in firmware, not in Windows. A Settings link would send someone
    // hunting for a switch that is not there — same call as SIP on macOS.
    fixUrl: null,
    parse: parseSecureBoot,
    body: `  $v = Confirm-SecureBootUEFI
  if ($v -ne $null) { $data = [pscustomobject]@{ enabled = [bool]$v } }`,
  },
];

// ---------- Runner ----------

async function runCheck(spec, exec) {
  const base = { id: spec.id, label: spec.label, fixUrl: spec.fixUrl };
  try {
    const runner = exec || runPowerShell;
    const result = await runner(buildScript(spec.body), spec.timeout || DEFAULT_TIMEOUT_MS);
    const envelope = parseEnvelope(result.stdout);
    if (envelope) {
      const parsed = spec.parse(envelope);
      if (parsed) return { ...base, status: parsed.status, detail: parsed.detail };
    }
    return { ...base, status: 'unknown', detail: explainFailure(result) };
  } catch (err) {
    // One check may never take the audit down with it.
    return {
      ...base,
      status: 'unknown',
      detail: `This check could not run (${err && err.message ? err.message : String(err)}).`,
    };
  }
}

async function audit(exec) {
  const settled = await Promise.allSettled(CHECK_SPECS.map((spec) => runCheck(spec, exec)));
  return settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    const spec = CHECK_SPECS[i];
    return {
      id: spec.id,
      label: spec.label,
      status: 'unknown',
      detail: 'This check could not run.',
      fixUrl: spec.fixUrl,
    };
  });
}

module.exports = {
  audit,
  runCheck,
  parseDefender,
  parseFirewall,
  parseDisks,
  parseBitLocker,
  parseSecureBoot,
  parseEnvelope,
  explainFailure,
  hasPermissionDenied,
  hasCommandMissing,
  hasNotSupported,
  signatureAgeDays,
  toArray,
  joinList,
  buildScript,
  encodeCommand,
  CHECK_SPECS,
  LINK,
  SIGNATURE_STALE_DAYS,
  SIGNATURE_AGE_SENTINEL_DAYS,
};
