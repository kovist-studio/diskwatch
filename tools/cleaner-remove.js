'use strict';

// Dev-only harness for src/main/cleaner/remove.js. NOT part of the app.
//
// This exists because remove.js is the first code in DiskWatch that writes,
// and every one of its tests injects a fake trasher — the real
// `shell.trashItem` is never executed by `npm test`. Something has to run the
// actual call against a real disk before any UI can reach it, and that
// something should not be a button.
//
// It is not shipped: electron-builder's `files` list is an allowlist naming
// src/ and package.json, so tools/ is excluded structurally rather than by a
// rule someone has to remember. Nothing under src/ references this file, and
// test/remove.test.js fails if that ever stops being true.
//
// It has to run inside Electron, because shell.trashItem is an Electron API:
//
//   npm run cleaner:remove -- --list
//   npm run cleaner:remove -- --target pip-cache-macos --dry-run
//   npm run cleaner:remove -- --target pip-cache-macos --confirm
//
// Without --confirm it never calls the trasher at all.

const path = require('node:path');

// Under plain `node`, requiring electron yields the path to the binary rather
// than the API surface. Say so plainly instead of failing on `app` later.
const electron = require('electron');
if (typeof electron === 'string' || !electron.app) {
  process.stderr.write(
    'This tool needs Electron\'s shell.trashItem, so it must run inside an Electron\n' +
      'process. Plain `node tools/cleaner-remove.js` cannot work.\n\n' +
      '  npm run cleaner:remove -- --target <id> --dry-run\n',
  );
  process.exit(2);
}

const { app } = electron;
const cleaner = require('../src/main/cleaner');
const remover = require('../src/main/cleaner/remove');

// ---------- Arguments ----------

// Scans the whole argv rather than slicing a fixed prefix: how many entries
// Electron puts in front of the script varies with how it was launched, and
// none of Electron's own flags collide with these.
function parseArgs(argv) {
  const out = { target: null, confirm: false, list: false, unknown: [] };
  const known = new Set(['--target', '--confirm', '--dry-run', '--list']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      out.target = argv[i + 1] || null;
      i++;
    } else if (arg.startsWith('--target=')) {
      out.target = arg.slice('--target='.length);
    } else if (arg === '--confirm') {
      out.confirm = true;
    } else if (arg === '--list') {
      out.list = true;
    } else if (arg === '--dry-run') {
      // The default. Accepted so the intent can be written down explicitly.
    } else if (arg.startsWith('--') && !known.has(arg)) {
      out.unknown.push(arg);
    }
  }
  return out;
}

// ---------- Formatting ----------

// Same 1024-based scale the renderer uses (src/renderer/app.js), so a number
// here reads the same as the same number in the app. The exact byte count is
// printed alongside the total, because this is a verification tool and a
// rounded figure is not something you can check against anything.
function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

const commas = (n) => n.toLocaleString('en-US');
const out = (line = '') => process.stdout.write(`${line}\n`);

function itemLine(item) {
  const kind = item.kind === 'file' ? 'file ' : 'whole';
  return `  ${kind}  ${formatBytes(item.bytes).padStart(9)}  ${item.path}`;
}

// ---------- The run ----------

async function main() {
  const args = parseArgs(process.argv);

  if (args.unknown.length > 0) {
    out(`Unknown option: ${args.unknown.join(', ')}`);
    out('Options: --list, --target <id>, --dry-run (default), --confirm');
    return 2;
  }

  const doc = await cleaner.loadDocument();
  const { targets, omitted } = cleaner.validate(doc);
  const mine = targets.filter((t) => t.platform === process.platform);

  if (args.list || !args.target) {
    out(`Cleanup targets for ${process.platform}:`);
    out();
    for (const t of mine) {
      const closed = t.requiresAppClosed.length > 0 ? `  (needs ${t.requiresAppClosed.join(', ')} closed)` : '';
      out(`  ${t.id.padEnd(28)} ${t.risk.padEnd(8)} ${t.path}${closed}`);
    }
    if (omitted.length > 0) {
      out();
      out('Omitted by their own expand contract, so not removable at all:');
      for (const o of omitted) out(`  ${o.id.padEnd(28)} ${o.reason}`);
    }
    if (!args.target && !args.list) {
      out();
      out('Name one with --target <id>.');
      return 2;
    }
    return 0;
  }

  const target = mine.find((t) => t.id === args.target);
  if (!target) {
    out(`No target "${args.target}" for ${process.platform}.`);
    out('Run with --list to see the ids that exist.');
    return 2;
  }

  // Scoped to the one target: planning everything would walk every cache
  // directory on the machine to size entries nobody asked about.
  const planned = await remover.plan({ only: target.id });

  out();
  out(args.confirm
    ? 'DiskWatch cleaner — CONFIRM. This moves files to the Trash.'
    : 'DiskWatch cleaner — DRY RUN. Nothing will be touched.');
  out();
  out(`  target    ${target.id} — ${target.label}`);
  out(`  risk      ${target.risk}`);
  out(`  path      ${target.path}`);
  out(`  unit      ${remover.unitOf(target) === 'file' ? 'per file, age-filtered' : 'the whole directory'}`);
  if (target.requiresAppClosed.length > 0) {
    out(`  requires  ${target.requiresAppClosed.join(', ')} closed`);
  }
  out();

  if (planned.refused.length > 0) {
    out('Not offered — collides with one of this target\'s exclusions:');
    out();
    for (const r of planned.refused) out(`  ${r.reason.padEnd(20)} ${r.path}`);
    out();
  }

  if (planned.items.length === 0) {
    out('Nothing to remove: the target is absent, empty, or entirely excluded.');
    return 0;
  }

  const totalBytes = planned.totals.bytes;
  const summary = `${planned.items.length} item${planned.items.length === 1 ? '' : 's'}, ` +
    `${formatBytes(totalBytes)} (${commas(totalBytes)} bytes)`;

  if (!args.confirm) {
    out('Would move to the Trash:');
    out();
    for (const item of planned.items) out(itemLine(item));
    out();
    out(`  ${summary}.`);
    out();
    out('Nothing was touched. Re-run with --confirm to move these to the Trash.');
    return 0;
  }

  out(`About to move to the Trash: ${summary}.`);
  out();

  // No trasher is passed, so remove() uses its default: the real
  // shell.trashItem. That is the entire point of this tool.
  const result = await remover.remove(planned.items.map((i) => i.token));

  if (result.trashed.length > 0) {
    out('Moved to the Trash:');
    out();
    for (const t of result.trashed) {
      out(`  ${formatBytes(t.bytes).padStart(9)}  ${t.path}`);
    }
    out();
  }

  if (result.skipped.length > 0) {
    out('Skipped:');
    out();
    for (const s of result.skipped) {
      out(`  ${s.reason.padEnd(22)} ${s.path || '(no path)'}`);
      out(`  ${' '.repeat(22)} ${s.detail}`);
    }
    out();
  }

  out(
    `  ${result.totals.trashedCount} moved, ${formatBytes(result.totals.trashedBytes)} ` +
      `(${commas(result.totals.trashedBytes)} bytes). ${result.totals.skippedCount} skipped.`,
  );
  out();
  out('Anything moved is in the Trash and can be put back from Finder.');

  // Non-zero when anything was refused, so a run that half-worked cannot be
  // mistaken for a clean one.
  return result.totals.skippedCount > 0 ? 1 : 0;
}

app.whenReady().then(async () => {
  // No window is ever created; keep it out of the Dock too.
  if (app.dock) app.dock.hide();

  let code = 2;
  try {
    code = await main();
  } catch (err) {
    process.stderr.write(`\n${err && err.stack ? err.stack : String(err)}\n`);
  }
  app.exit(code);
});
