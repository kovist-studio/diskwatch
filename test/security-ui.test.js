'use strict';

// The Security view's rules, enforced rather than trusted.
//
// This is the view most likely to drift into scareware, because it is the one
// with bad news to deliver. The rules it must keep:
//
//   1. No score, no rating, no count of problems, no urgency language. There
//      is no scale these checks share, so a total would be invented.
//   2. Nothing is ranked. The list stays in the order the audit returned it —
//      sorting failures to the top is a scoreboard with the numbers filed off.
//   3. Unknown is not a failure. It means the answer could not be read, and
//      the copy has to say so where the person will read it.
//   4. A check with no settings pane gets no link. SIP is set from macOS
//      Recovery and drive health is read in Disk Utility; a link to a pane
//      without the switch sends someone hunting for a control that isn't there.
//   5. The renderer never names a destination. It sends a check id and main
//      resolves the URL — see security-ipc.test.js for the other half.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const HTML = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

// The same banned vocabulary the macOS and Windows audits are held to, applied
// to the view that displays them. A check module that stayed calm is no use if
// the UI adds the alarm back.
const BANNED = /\b(score|rating|\d+\s*\/\s*\d+|threats?|at risk|danger|critical|urgent|immediately|vulnerable|insecure)\b/i;

async function securityView() {
  const src = await fsp.readFile(RENDERER, 'utf8');
  const start = src.indexOf('// ---------- Security ----------');
  const end = src.indexOf('// ---------- Check ----------');
  assert.ok(start > 0 && end > start, 'the Security view must be findable');
  return src.slice(start, end);
}

// Comments explain the rules at length and necessarily use the words they
// forbid. What must not exist is emitted copy or computing code, so comment
// lines come out first — the same distinction the fs.rm guard makes.
const withoutComments = (view) =>
  view
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

// Every string literal the view can put on screen.
const emittedStrings = (view) =>
  [...withoutComments(view).matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`]*)`/g)]
    .map((m) => m[1] || m[2] || '')
    .join('\n');

async function securityMarkup() {
  const html = await fsp.readFile(HTML, 'utf8');
  const start = html.indexOf('id="view-security"');
  const end = html.indexOf('</section>', start);
  assert.ok(start > 0 && end > start, 'the Security markup must be findable');
  return html.slice(start, end);
}

// Pulls one function out of the source so its behaviour can be exercised
// directly. Brace counting is enough here and keeps the test honest: it runs
// the shipped function rather than a copy that could drift from it.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in the view`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is unbalanced`);
}

// --- Rule 1: no score, no count, no urgency ------------------------------------

test('the Security view emits no score, count or urgency copy', async () => {
  const strings = emittedStrings(await securityView());
  assert.doesNotMatch(strings, BANNED, 'the view must not emit alarm or scoreboard copy');
});

test('the Security markup carries no alarm styling or urgency copy', async () => {
  const markup = await securityMarkup();
  for (const banned of [/danger/i, /alert/i, /warning/i, /urgent/i, /\bat risk\b/i, /\bscore\b/i, /threats?\b/i]) {
    assert.doesNotMatch(markup, banned, `the Security markup must not contain ${banned}`);
  }
});

test('no score, verdict or problem count is computed in the view', async () => {
  const code = withoutComments(await securityView());
  for (const banned of [/\bscore\b/i, /riskLevel/, /threatCount/, /\bverdict\b/i, /passCount/, /failCount/]) {
    assert.doesNotMatch(code, banned, `the view must not compute ${banned}`);
  }
});

// --- Rule 2: nothing is ranked or totalled -------------------------------------

test('the view neither sorts nor totals the checks', async () => {
  const code = withoutComments(await securityView());
  // Rendering is a straight walk of what the audit returned. Any of these
  // appearing means the view started deciding which answers matter more, or
  // adding up answers that share no scale.
  for (const banned of [/\.sort\(/, /\.reduce\(/, /\.filter\(/]) {
    assert.doesNotMatch(code, banned, `the view must not use ${banned}`);
  }
  assert.match(code, /for \(const check of checks\) elList\.appendChild/, 'rows are rendered in audit order');
});

// --- Rule 3: unknown is not a failure ------------------------------------------

test('the four statuses each read differently', async () => {
  const view = await securityView();
  const block = view.slice(view.indexOf('const STATUS_WORD'), view.indexOf('};', view.indexOf('const STATUS_WORD')));

  const words = {};
  for (const [, key, value] of block.matchAll(/(\w+):\s*'([^']+)'/g)) words[key] = value;

  assert.deepEqual(Object.keys(words).sort(), ['fail', 'na', 'pass', 'unknown'], 'all four statuses need a word');
  assert.equal(new Set(Object.values(words)).size, 4, 'no two statuses may read the same');

  // Neither of the two answers may be spelled as a pass/fail grade, and none of
  // the four may carry alarm.
  for (const [key, word] of Object.entries(words)) {
    assert.doesNotMatch(word, BANNED, `the ${key} word`);
    assert.doesNotMatch(word, /^(pass|fail)$/i, `the ${key} word must not be a grade`);
  }

  // Unknown says what it is: an unread answer, not a finding.
  assert.match(words.unknown, /check/i, 'unknown must say the check could not be made');
});

test('an unread check says plainly that nothing was established', async () => {
  const strings = emittedStrings(await securityView());
  assert.match(strings, /could not read/i, 'an unknown row must say the answer could not be read');
  assert.match(strings, /nothing either way/i, 'and that it therefore establishes nothing');
  assert.match(strings, /not something found/i, 'and that it is not a finding');
});

test('every unknown row carries that caveat, not just some', async () => {
  const code = withoutComments(await securityView());
  assert.match(
    code,
    /if \(check\.status === 'unknown'\) text\.appendChild\(span\('check__caveat', UNKNOWN_CAVEAT\)\)/,
    'the caveat must be attached by status, not by check id',
  );
});

// --- Rule 4: a check with no pane gets no link ---------------------------------

test('only a known settings scheme produces a link', async () => {
  const view = await securityView();
  const source = extractFunction(view, 'fixLabel');
  const fixLabel = new Function(`${source}; return fixLabel;`)();

  // The two checks that record null: SIP and drive health. No link, ever.
  assert.equal(fixLabel(null), null, 'a null fixUrl gets no link');
  assert.equal(fixLabel(undefined), null);

  // Nor does anything the main process would refuse to open anyway. A button
  // that quietly does nothing is worse than no button.
  for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', '', 'x-apple.systempreferences']) {
    assert.equal(fixLabel(url), null, `${url} must not produce a link`);
  }

  // The three that do, each naming the app you will land in.
  assert.equal(fixLabel('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'), 'Open System Settings');
  assert.equal(fixLabel('ms-settings:deviceencryption'), 'Open Settings');
  assert.equal(fixLabel('windowsdefender://threat'), 'Open Windows Security');
});

test('the link is built only when a label was resolved', async () => {
  const code = withoutComments(await securityView());
  assert.match(code, /const label = fixLabel\(check\.fixUrl\);/);
  assert.match(code, /if \(label\) row\.appendChild\(makeFixButton\(/, 'no label means no button');
});

// --- Rule 5: the renderer never names a destination ----------------------------

test('following a link sends the check id, never the URL', async () => {
  const code = withoutComments(await securityView());

  const calls = [...code.matchAll(/openFix\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(calls, ['checkId'], 'openFix is called once, with an id');

  // The URL is read to decide whether and how to label a link, and never
  // travels. Main resolves the destination from the audit it ran.
  assert.doesNotMatch(code, /openFix\([^)]*(fixUrl|http|x-apple|ms-settings|windowsdefender)/i);
});

test('the view asks for the audit and nothing else on the security surface', async () => {
  const code = withoutComments(await securityView());
  const used = [...code.matchAll(/api\.security\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['audit', 'openFix']);
});

// --- The audit runs only when asked --------------------------------------------

test('nothing runs the audit on launch', async () => {
  const src = await fsp.readFile(RENDERER, 'utf8');
  const start = src.indexOf('// ---------- Start ----------');
  const startup = src.slice(start);
  // The start block may show the empty stage and nothing more. An app that
  // greets you with findings you did not ask for is a nag.
  assert.match(startup, /security\.showEmpty\(\)/, 'the tab starts empty');
  assert.doesNotMatch(startup, /security\.run\(\)/, 'and must not audit on launch');

  const view = await securityView();
  assert.doesNotMatch(view, /return \{ showEmpty, run \}/, 'run must not be reachable from outside the view');
});
