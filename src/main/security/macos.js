'use strict';

// macOS security audit. READ-ONLY: every check observes and reports. Nothing
// here changes a setting, and nothing asks for elevation — a check that would
// need administrator rights reports 'unknown' with the reason instead. Telling
// someone their machine is unprotected when it isn't is a false alarm, and a
// false alarm from a tool like this costs more than a missing answer.
//
// The parsers are pure functions of the command's text and are exported, so
// the failure cases can be tested without a machine in that state. That
// matters here: a developer's own Mac passes everything, which means the
// interesting half of this file would otherwise never be exercised.

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const DISKUTIL_TIMEOUT_MS = 15000;

// System Settings deep links. These identifiers were read off
// /System/Library/ExtensionKit/Extensions rather than guessed. The `?Anchor`
// suffix scrolls to a section; an anchor macOS doesn't recognise is ignored
// and the pane still opens, so it can only help.
const PANE = {
  privacy: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension',
  network: 'x-apple.systempreferences:com.apple.Network-Settings.extension',
  softwareUpdate: 'x-apple.systempreferences:com.apple.Software-Update-Settings.extension',
};

// Never rejects. Command failure is data here, not an exception: a missing
// binary and a binary that printed something unexpected have to be told apart,
// and both have to be survivable.
function run(file, args, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let child;
    const done = (error, stdout, stderr) =>
      resolve({ stdout: stdout || '', stderr: stderr || '', error: error || null });
    try {
      child = execFile(
        file,
        args,
        { timeout: opts.timeout || DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        done,
      );
    } catch (err) {
      // execFile can throw synchronously on a malformed invocation.
      resolve({ stdout: '', stderr: '', error: err });
      return;
    }
    if (typeof opts.input === 'string' && child.stdin) {
      child.stdin.on('error', () => {}); // EPIPE if the child died first
      child.stdin.end(opts.input);
    }
  });
}

// ---------- Parsers ----------
// Each returns { status, detail } when it recognises the output, or null when
// it does not. Returning null is what hands control to the failure reporting,
// so a parser must never guess.

function parseFileVault(text) {
  if (/FileVault is On/i.test(text)) {
    return {
      status: 'pass',
      detail: 'On. The disk is encrypted, so its contents stay unreadable without your login password.',
    };
  }
  if (/FileVault is Off/i.test(text)) {
    // Deferred enablement means it is off now but set to turn on at next login
    // — reporting that as a flat "off" would be true but misleading.
    if (/deferred enablement/i.test(text)) {
      return {
        status: 'fail',
        detail: 'Off for now. It is set to turn on the next time a user logs in.',
      };
    }
    return {
      status: 'fail',
      detail: 'Off. The disk is not encrypted, so its contents can be read by anyone holding the drive.',
    };
  }
  return null;
}

function parseSip(text) {
  if (/System Integrity Protection status:\s*enabled/i.test(text)) {
    // "enabled (Custom Configuration)" means some protections were switched
    // off individually. That is neither on nor off, and calling it either
    // would be wrong, so it is reported as what it is.
    if (/custom configuration/i.test(text)) {
      return {
        status: 'unknown',
        detail: 'Enabled, but with a custom configuration — some protections have been turned off individually. Running csrutil status in Terminal lists which ones.',
      };
    }
    return {
      status: 'pass',
      detail: 'Enabled. macOS protects system files and processes from being modified, including by administrators.',
    };
  }
  if (/System Integrity Protection status:\s*disabled/i.test(text)) {
    return {
      status: 'fail',
      detail: 'Disabled. System files and processes can be modified. Turning it back on is done from macOS Recovery, not from System Settings.',
    };
  }
  return null;
}

function parseGatekeeper(text) {
  if (/assessments enabled/i.test(text)) {
    return {
      status: 'pass',
      detail: 'On. macOS checks apps for a known developer signature before opening them for the first time.',
    };
  }
  if (/assessments disabled/i.test(text)) {
    return {
      status: 'fail',
      detail: 'Off. Apps open without macOS checking who signed them first.',
    };
  }
  return null;
}

function parseFirewall(text) {
  // The numeric state is the reliable signal; the sentence beside it is not
  // always printed the same way across releases.
  const match = text.match(/State\s*=\s*(-?\d+)/i);
  if (match) {
    const state = Number(match[1]);
    if (state === 0) {
      return {
        status: 'fail',
        detail: 'Off. Incoming network connections are not being filtered.',
      };
    }
    if (state === 1) {
      return {
        status: 'pass',
        detail: 'On. Incoming connections are filtered for apps that are not allowed to accept them.',
      };
    }
    if (state === 2) {
      return {
        status: 'pass',
        detail: 'On, set to block all incoming connections except those needed for basic network services.',
      };
    }
    return {
      status: 'unknown',
      detail: `The firewall reported a state this version of DiskWatch does not recognise (State = ${state}).`,
    };
  }
  if (/firewall is enabled/i.test(text)) {
    return { status: 'pass', detail: 'On. Incoming network connections are being filtered.' };
  }
  if (/firewall is disabled/i.test(text)) {
    return { status: 'fail', detail: 'Off. Incoming network connections are not being filtered.' };
  }
  return null;
}

// Input is diskutil's plist already converted to JSON by plutil. Parsed with a
// real parser rather than grepped: the -A1 trick works at a shell prompt and
// breaks the moment key order or formatting shifts.
function parseSmart(jsonText) {
  let info;
  try {
    info = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!info || typeof info !== 'object') return null;
  const value = info.SMARTStatus;
  if (typeof value !== 'string' || value.trim() === '') return null;

  switch (value.trim().toLowerCase()) {
    case 'verified':
      return { status: 'pass', detail: 'The drive reports itself healthy (SMART status: Verified).' };
    case 'failing':
      return {
        status: 'fail',
        detail: 'The drive reports that it is failing (SMART status: Failing). Copy anything you need off it and have the drive looked at.',
      };
    case 'not supported':
      return {
        status: 'na',
        detail: 'This drive does not report SMART status. That is normal for many external, network and virtual disks.',
      };
    default:
      return {
        status: 'unknown',
        detail: `The drive reported a SMART status DiskWatch does not recognise (${value.trim()}).`,
      };
  }
}

// ---------- Failure reporting ----------
// Reached only when the parser did not recognise the output. Says which of the
// several different "couldn't tell" cases actually happened.
function explainFailure(result, file) {
  const error = result.error;
  const combined = `${result.stdout}\n${result.stderr}`;

  if (error && error.code === 'ENOENT') {
    return `The ${file} command is not present on this system, so this could not be checked.`;
  }
  if (error && (error.killed || error.signal)) {
    return `The ${file} command did not finish in time, so this could not be checked.`;
  }
  if (/not permitted|permission denied|must be run as root|requires? root|only.*root/i.test(combined)) {
    return 'Reading this needs administrator rights. DiskWatch does not ask for them, so it is left unchecked rather than prompting you.';
  }
  const noise = combined.trim().split('\n')[0].trim();
  if (noise) {
    return `This could not be read. The system said: ${noise}`;
  }
  if (error) {
    return `This could not be read (${error.code || error.message}).`;
  }
  return 'This could not be read, and the system did not say why.';
}

// ---------- Check specs ----------

const CHECK_SPECS = [
  {
    id: 'filevault',
    label: 'FileVault disk encryption',
    file: '/usr/bin/fdesetup',
    args: ['status'],
    fixUrl: `${PANE.privacy}?FileVault`,
    parse: parseFileVault,
  },
  {
    id: 'sip',
    label: 'System Integrity Protection',
    file: '/usr/bin/csrutil',
    args: ['status'],
    // Deliberately null: SIP cannot be changed from System Settings at all —
    // it is set from macOS Recovery. Pointing at a pane that cannot change it
    // would send someone on a search for a switch that isn't there.
    fixUrl: null,
    parse: parseSip,
  },
  {
    id: 'gatekeeper',
    label: 'Gatekeeper app checks',
    file: '/usr/sbin/spctl',
    args: ['--status'],
    fixUrl: PANE.privacy,
    parse: parseGatekeeper,
  },
  {
    id: 'firewall',
    label: 'Application firewall',
    file: '/usr/libexec/ApplicationFirewall/socketfilterfw',
    args: ['--getglobalstate'],
    fixUrl: `${PANE.network}?Firewall`,
    parse: parseFirewall,
  },
  {
    id: 'smart',
    label: 'Drive health (SMART)',
    // No System Settings pane reports drive health; Disk Utility does.
    fixUrl: null,
    parse: parseSmart,
    // Two commands: diskutil emits a plist, plutil turns it into JSON.
    async collect() {
      const diskutil = await run('/usr/sbin/diskutil', ['info', '-plist', '/'], {
        timeout: DISKUTIL_TIMEOUT_MS,
      });
      if (diskutil.error || diskutil.stdout.trim() === '') {
        return { result: diskutil, file: '/usr/sbin/diskutil' };
      }
      const plutil = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
        input: diskutil.stdout,
      });
      return { result: plutil, file: '/usr/bin/plutil' };
    },
  },
];

// Automatic updates is answered without running anything at all.
//
// macOS does not expose this reliably. AutomaticCheckEnabled is absent from
// the system domain, the user domain and the current-host domain on a machine
// where nobody has ever changed the setting — so absence is the normal state,
// not evidence the setting is off. Any inference from that absence would be a
// guess, and the guess that fires is "updates are off" on a machine where they
// are on. That is a false alarm, which is the one thing this app exists not to
// produce. It reports 'unknown' and points at the pane that knows.
function automaticUpdatesCheck() {
  return {
    id: 'automatic-updates',
    label: 'Automatic macOS updates',
    status: 'unknown',
    detail:
      'macOS does not report this in a way that can be read reliably. The setting is simply absent until someone changes it, so a missing value means "never touched" rather than "off". Software Update shows the real answer.',
    fixUrl: PANE.softwareUpdate,
  };
}

// ---------- Runner ----------

async function runCheck(spec) {
  const base = { id: spec.id, label: spec.label, fixUrl: spec.fixUrl };
  try {
    const { result, file } = spec.collect
      ? await spec.collect()
      : { result: await run(spec.file, spec.args, { timeout: spec.timeout }), file: spec.file };

    // Parse first, exit status second. Some of these tools report a perfectly
    // readable answer alongside a non-zero exit code, and throwing that answer
    // away because of the exit code would turn a known state into an unknown.
    const parsed = spec.parse(`${result.stdout}\n${result.stderr}`);
    if (parsed) return { ...base, status: parsed.status, detail: parsed.detail };

    return { ...base, status: 'unknown', detail: explainFailure(result, file) };
  } catch (err) {
    // Nothing a single check does may take the audit down with it.
    return {
      ...base,
      status: 'unknown',
      detail: `This check could not run (${err && err.message ? err.message : String(err)}).`,
    };
  }
}

async function audit() {
  // allSettled, not all: checks are independent and one rejecting must not
  // remove the answers the others found.
  const settled = await Promise.allSettled(CHECK_SPECS.map((spec) => runCheck(spec)));
  const checks = settled.map((outcome, i) => {
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
  checks.push(automaticUpdatesCheck());
  return checks;
}

module.exports = {
  audit,
  runCheck,
  automaticUpdatesCheck,
  parseFileVault,
  parseSip,
  parseGatekeeper,
  parseFirewall,
  parseSmart,
  explainFailure,
  CHECK_SPECS,
  PANE,
};
