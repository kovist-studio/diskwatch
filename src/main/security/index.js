'use strict';

// Platform dispatch for the security audit.
//
// The audit is READ-ONLY and stays that way: it observes and reports, it never
// remediates, and it never asks for elevation. Anything that would need
// administrator rights is reported as 'unknown' with the reason, because a
// tool that nags for admin on launch trains people to approve prompts without
// reading them.
//
// Statuses:
//   pass    — the protection is on
//   fail    — the protection is off
//   unknown — could not be determined; the detail says why
//   na      — does not apply to this hardware or OS
//
// There is deliberately no score and no count. A number like "4/6 secure"
// invents a weighting nobody agreed to and pushes people to chase the number
// rather than read what it is made of.

const PLATFORMS = {
  darwin: () => require('./macos'),
  // win32 lands next phase; adding it here is the only wiring it needs.
};

async function runAudit() {
  const load = PLATFORMS[process.platform];
  if (!load) {
    return {
      platform: process.platform,
      supported: false,
      checks: [],
      note:
        process.platform === 'win32'
          ? 'The Windows security audit arrives in the next phase.'
          : `DiskWatch does not have a security audit for ${process.platform}.`,
    };
  }
  const platformModule = load();
  return {
    platform: process.platform,
    supported: true,
    checks: await platformModule.audit(),
  };
}

const SYMBOL = { pass: '+', fail: '-', unknown: '?', na: '.' };

// Plain-text rendering for the console, until the UI phase. Ordered as the
// checks were declared, not sorted by status: sorting failures to the top is
// the first step towards a scoreboard.
function formatAudit(audit) {
  const lines = [];
  lines.push(`Security audit — ${audit.platform}`);
  lines.push('');
  if (!audit.supported) {
    lines.push(`  ${audit.note}`);
    return lines.join('\n');
  }
  const width = audit.checks.reduce((w, c) => Math.max(w, c.label.length), 0);
  for (const check of audit.checks) {
    const mark = SYMBOL[check.status] || '?';
    lines.push(`  [${mark}] ${check.label.padEnd(width)}  ${check.status}`);
    lines.push(`      ${check.detail}`);
    if (check.fixUrl) lines.push(`      settings: ${check.fixUrl}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { runAudit, formatAudit };
