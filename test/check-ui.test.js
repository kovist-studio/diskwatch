'use strict';

// The wording rule, enforced rather than trusted.
//
// A false "this might be a scam" costs someone a minute. A false "this is
// safe" is how a person loses their savings. So the app is permitted to be
// wrong in the first direction and must be structurally incapable of being
// wrong in the second — which it achieves by never making the claim at all.
//
// These tests fail the build if that claim reappears.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { extract, refang } = require('../src/main/checker/extract');
const { candidates } = require('../src/main/checker/check');
const suffix = require('../src/main/checker/suffix');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const HTML = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

// Strings that assert a site is fine. Every one of these is a claim the app
// has no evidence for: absence from a blocklist is not safety.
const FORBIDDEN = [
  'is safe',
  'safe to visit',
  'safe to open',
  'looks safe',
  'no threats',
  'no threats found',
  'threat level',
  'nothing suspicious',
  'this site is legitimate',
  'verified safe',
];

async function checkView() {
  const src = await fsp.readFile(RENDERER, 'utf8');
  const start = src.indexOf('// ---------- Check ----------');
  const end = src.indexOf('// ---------- Start ----------');
  assert.ok(start > 0 && end > start, 'the Check view must be findable');
  return src.slice(start, end);
}

// --- The rule -----------------------------------------------------------------

test('the Check view never tells anyone a site is safe', async () => {
  const view = await checkView();
  // Comments discuss the rule; only emitted strings are the concern.
  const strings = [...view.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`]*)`/g)]
    .map((m) => (m[1] || m[2] || '').toLowerCase());
  const blob = strings.join('\n');

  for (const phrase of FORBIDDEN) {
    assert.equal(blob.includes(phrase), false, `the UI must never emit "${phrase}"`);
  }
});

test('the clean result describes the SEARCH, not the site', async () => {
  const view = await checkView();
  // The required shape: "Not found in N blocklists, checked <when>".
  assert.match(view, /Not found in \$\{listCount\}/, 'must state how many lists were searched');
  assert.match(view, /checked \$\{ago\(/, 'must state when they were last updated');
  assert.match(
    view,
    /It is not a statement about the site/,
    'and must say explicitly that this is not a verdict',
  );
});

test('no score, verdict or threat count is computed in the view', async () => {
  // Comments explain the rule at length and necessarily use the words. What
  // must not exist is CODE that computes one, so the comments come out first —
  // the same distinction the fs.rm guard makes.
  const view = (await checkView())
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  for (const banned of [/\bscore\b/i, /riskLevel/, /threatCount/, /\bverdict\b/i]) {
    assert.equal(banned.test(view), false, `the view must not compute ${banned}`);
  }
});

test('the markup carries no alarm styling or urgency copy', async () => {
  const html = await fsp.readFile(HTML, 'utf8');
  const view = html.slice(html.indexOf('id="view-check"'), html.indexOf('</section>', html.indexOf('id="view-check"')));
  for (const banned of [/danger/i, /alert/i, /warning/i, /urgent/i, /\bat risk\b/i]) {
    assert.equal(banned.test(view), false, `the Check markup must not contain ${banned}`);
  }
});

test('unknown is never rendered as reassurance', async () => {
  const view = await checkView();
  assert.match(view, /Age could not be determined/);
  assert.match(view, /tells us nothing either way/, 'an unanswerable check must say so plainly');
});

// --- Extraction ---------------------------------------------------------------

test('a whole pasted message yields its links, in the order they appear', () => {
  const message = [
    'URGENT: Your PayPal account is locked.',
    'Verify at https://paypa1.com/verify?id=99 or www.paypal-secure.example',
    'See attached invoice.pdf. Reply by 5pm.',
  ].join('\n');

  const found = extract(message).map((f) => f.domain);
  assert.deepEqual(found, ['paypa1.com', 'paypal-secure.example']);
  assert.equal(found.includes('invoice.pdf'), false, 'a filename is not a domain');
});

test('defanged links are understood, because careful people send them that way', () => {
  assert.equal(refang('secure-chase[.]com').includes('secure-chase.com'), true);
  assert.equal(refang('hxxps://evil[.]example').includes('https://evil.example'), true);
  const found = extract('do not click hxxps://secure-chase[.]com/login').map((f) => f.domain);
  assert.deepEqual(found, ['secure-chase.com']);
});

test('a leading www. is dropped but a real subdomain is not', () => {
  assert.deepEqual(extract('www.paypal.com').map((f) => f.domain), ['paypal.com']);
  // Here the subdomain is the whole trick and must survive.
  assert.deepEqual(
    extract('paypal.com.verify-account.example').map((f) => f.domain),
    ['paypal.com.verify-account.example'],
  );
});

test('a homograph domain survives extraction as punycode', () => {
  const found = extract('go to pаypаl.com now');
  assert.equal(found.length, 1);
  assert.equal(found[0].domain, 'xn--pypl-53dc.com');
  assert.equal(found[0].raw, 'pаypаl.com', 'and what the person saw is kept');
});

test('text with no link yields nothing rather than a guess', () => {
  assert.deepEqual(extract('Hello, please call me back at 5pm.'), []);
  assert.deepEqual(extract(''), []);
  assert.deepEqual(extract(null), []);
});

// --- Subdomain coverage -------------------------------------------------------

test('a blocklisted parent domain covers its subdomains', async () => {
  assert.deepEqual(await candidates('login.evil.example'), ['login.evil.example', 'evil.example']);
  assert.deepEqual(await candidates('evil.example'), ['evil.example']);
});

// --- Public suffixes ----------------------------------------------------------

test('a public suffix is never queried against the blocklists', async () => {
  // The bug this fixes: co.uk is not a domain anybody owns, and asking whether
  // it is blocklisted is a question with a 1-in-1000 chance of a wrong yes and
  // no chance of a useful one.
  assert.deepEqual(await candidates('barclays.co.uk'), ['barclays.co.uk']);
  assert.deepEqual(await candidates('shop.com.au'), ['shop.com.au']);
  assert.deepEqual(await candidates('myrepo.github.io'), ['myrepo.github.io']);

  for (const list of [
    await candidates('login.barclays.co.uk'),
    await candidates('a.b.github.io'),
    await candidates('www.shop.com.au'),
  ]) {
    for (const suffixName of ['co.uk', 'com.au', 'github.io', 'uk', 'au', 'io']) {
      assert.equal(list.includes(suffixName), false, `${suffixName} must never be queried`);
    }
  }
});

test('the registrable domain is found for awkward suffixes', async () => {
  const rules = await suffix.load();
  const cases = [
    ['barclays.co.uk', 'co.uk', 'barclays.co.uk'],
    ['www.barclays.co.uk', 'co.uk', 'barclays.co.uk'],
    ['shop.com.au', 'com.au', 'shop.com.au'],
    ['myrepo.github.io', 'github.io', 'myrepo.github.io'],
    ['a.b.github.io', 'github.io', 'b.github.io'],
    ['evil.example', 'example', 'evil.example'],
    ['login.evil.example', 'example', 'evil.example'],
  ];
  for (const [domain, wantSuffix, wantRegistrable] of cases) {
    assert.equal(suffix.publicSuffix(domain, rules), wantSuffix, `suffix of ${domain}`);
    assert.equal(suffix.registrableDomain(domain, rules), wantRegistrable, `registrable of ${domain}`);
  }
});

test('a bare public suffix has no registrable domain, because nobody owns it', async () => {
  const rules = await suffix.load();
  for (const s of ['co.uk', 'com.au', 'github.io', 'com', 'uk']) {
    assert.equal(suffix.registrableDomain(s, rules), null, `${s} is not a registrable domain`);
  }
});

test('wildcard and exception rules are honoured', async () => {
  const rules = await suffix.load();

  // *.ck makes any single label under ck a suffix...
  assert.equal(suffix.publicSuffix('foo.bar.ck', rules), 'bar.ck');
  assert.equal(suffix.registrableDomain('foo.bar.ck', rules), 'foo.bar.ck');

  // ...and !www.ck carves one back out again. Exceptions beat wildcards, and
  // ignoring them would make a registrable domain look like a public suffix.
  assert.equal(suffix.publicSuffix('www.ck', rules), 'ck');
  assert.equal(suffix.registrableDomain('www.ck', rules), 'www.ck');
});

test('an unknown TLD falls back to the implicit * rule', async () => {
  const rules = await suffix.load();
  assert.equal(suffix.publicSuffix('some.unknown-tld-xyz', rules), 'unknown-tld-xyz');
  assert.equal(suffix.registrableDomain('some.unknown-tld-xyz', rules), 'some.unknown-tld-xyz');
});

test('the bundled list is verbatim, with its licence notice intact', async () => {
  const dat = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'main', 'checker', 'public_suffix_list.dat'),
    'utf8',
  );
  // MPL 2.0 is file-level copyleft: the notice is part of the Covered Software
  // and stripping it would break the terms the file is shipped under.
  assert.match(dat, /Mozilla Public[\s\S]{0,8}License, v\. 2\.0/);
  assert.match(dat, /^\/\/ VERSION: /m, 'the upstream version stamp must survive');
  assert.match(dat, /===BEGIN ICANN DOMAINS===/, 'and the file must not be reformatted');

  const meta = JSON.parse(
    await fsp.readFile(path.join(__dirname, '..', 'src', 'main', 'checker', 'suffix.json'), 'utf8'),
  );
  assert.equal(meta.source.licence, 'MPL 2.0');
  assert.ok(meta.source.url.startsWith('https://publicsuffix.org/'));
  assert.ok(meta.source.fetchedOn, 'provenance must record when it was taken');
});
