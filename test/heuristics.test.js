'use strict';

// The three local signals. Real punycode domains, real brand lookalikes, and
// a real RDAP answer for a domain whose registration date is public record.
//
// The rule these tests exist to defend is the framing one: nothing here may
// produce a verdict. A check that says "scam" on its own is how a false
// accusation ships, and every one of these signals fires on legitimate
// domains.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { analyse } = require('../src/main/checker/homograph');
const { distance, loadBrands, nearestBrand } = require('../src/main/checker/similarity');
const { normalise } = require('../src/main/checker/parse');
const rdap = require('../src/main/checker/rdap');
const heuristics = require('../src/main/checker/heuristics');

async function sandbox(t) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'diskwatch-heur-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- Homograph: real punycode -------------------------------------------------

test('mixed script is the signal, not the presence of another script', async (t) => {
  await t.test('Latin with Cyrillic spliced in is flagged', () => {
    // "аpple.com" — the first character is Cyrillic а, U+0430.
    const r = analyse('аpple.com');
    assert.equal(r.signal, true);
    assert.deepEqual(r.scripts.sort(), ['Cyrillic', 'Latin']);
    assert.equal(r.confusables[0].codePoint, 'U+0430');
    assert.equal(r.confusables[0].looksLike, 'a');
    assert.equal(r.confidence, 'high');
  });

  await t.test('a wholly Cyrillic domain is NOT flagged', () => {
    // президент.рф is a real Russian government domain. It is full of
    // characters that look like Latin ones, and it is entirely legitimate.
    const r = analyse('президент.рф');
    assert.equal(r.signal, false, 'one script throughout is a language, not a disguise');
    assert.deepEqual(r.scripts, ['Cyrillic']);
    assert.ok(r.confusables.length > 0, 'and it does contain confusable characters');
  });

  await t.test('plain ASCII is not an IDN and carries no signal', () => {
    const r = analyse('apple.com');
    assert.equal(r.signal, false);
    assert.equal(r.isIdn, false);
    assert.deepEqual(r.scripts, ['Latin']);
  });

  await t.test('both forms are reported, because both are the attack', () => {
    const r = analyse('аpple.com');
    assert.equal(r.ascii, 'xn--pple-43d.com', 'what the machine resolves');
    assert.equal(r.unicode, 'аpple.com', 'what the person saw');
    assert.notEqual(r.ascii, r.unicode);
  });

  await t.test('real punycode input decodes back to Unicode', () => {
    const r = analyse('xn--pple-43d.com');
    assert.equal(r.unicode, 'аpple.com');
    assert.equal(r.signal, true, 'and is still caught when given in ASCII form');
  });
});

test('a Unicode domain survives normalisation as punycode', () => {
  // Regression: an ASCII-only pattern rejected exactly the domains the
  // homograph check exists to examine, and did it silently.
  assert.equal(normalise('аpple.com', 'domains'), 'xn--pple-43d.com');
  // And a punycode TLD (.рф) is legitimate — it contains digits.
  assert.equal(
    normalise('пример.рф', 'domains'),
    'xn--e1afmkfd.xn--p1ai',
  );
});

// --- Brand lookalikes ---------------------------------------------------------

test('edit distance catches real lookalikes and never the brand itself', async () => {
  const doc = await loadBrands();

  // Capital I for lowercase l, and the digit 1 for l. Both are real.
  for (const fake of ['paypaI.com'.toLowerCase(), 'paypa1.com']) {
    const n = nearestBrand(fake, doc);
    assert.ok(n, `${fake} should match a brand`);
    assert.equal(n.brand, 'paypal.com');
    assert.equal(n.distance, 1);
  }

  // Distance 0 is the real thing and must never be reported as a lookalike.
  for (const real of ['paypal.com', 'google.com', 'apple.com']) {
    assert.equal(nearestBrand(real, doc), null, `${real} is not impersonating itself`);
  }

  // Far away is not a match.
  assert.equal(nearestBrand('totallyunrelated.example', doc), null);
});

test('a legitimate domain close to a brand still matches — which is why this is a signal', async () => {
  const doc = await loadBrands();
  // paypay.com is a real Japanese payment company, one edit from paypal.com.
  const n = nearestBrand('paypay.com', doc);
  assert.ok(n, 'it does match');
  assert.equal(n.distance, 1);
  // Nothing in the result says it is bad, because it is not.
  assert.equal(Object.keys(n).includes('verdict'), false);
});

test('every brand explains why it is on the list', async () => {
  const doc = await loadBrands();
  assert.ok(doc.brands.length >= 20);
  for (const b of doc.brands) {
    assert.ok(b.why.length > 30, `${b.domain} must say why it is impersonated`);
    assert.equal(normalise(b.domain, 'domains'), b.domain, `${b.domain} must be a clean domain`);
  }
});

test('distance is bounded and symmetric', () => {
  assert.equal(distance('paypal.com', 'paypal.com', 2), 0);
  assert.equal(distance('paypal.com', 'paypa1.com', 2), 1);
  assert.equal(distance('abc', 'xyz', 2), 3, 'over the bound, reported as over');
  assert.equal(distance('kitten', 'sitting', 5), 3);
});

// --- RDAP ---------------------------------------------------------------------

test('RDAP reports a real registration date for a domain of known age', async (t) => {
  const dir = await sandbox(t);
  const r = await rdap.age('google.com', { cacheDir: dir });

  if (!r.known) {
    // The network is not guaranteed in every environment this runs in. Say so
    // loudly rather than passing quietly on a check that never ran.
    t.diagnostic(`RDAP unavailable (${r.reason}); the offline assertions still ran`);
    return;
  }

  // google.com was registered on 1997-09-15. That is public record and does
  // not change, which is what makes it a usable fixture.
  assert.equal(r.registeredAt.slice(0, 10), '1997-09-15');
  assert.ok(r.ageDays > 10000, 'and it is very old');
  assert.equal(r.band, 'established');
  assert.equal(r.signal, false, 'age is only a signal when the domain is new');
});

test('RDAP degrades to unknown instead of throwing or blocking', async (t) => {
  const dir = await sandbox(t);
  const dead = async () => ({ ok: false, reason: 'timed-out', detail: 'no response' });

  const r = await rdap.age('example.com', { cacheDir: dir, request: dead });
  assert.equal(r.known, false);
  assert.ok(r.reason, 'and says why');
});

test('a TLD with no published RDAP server is unknown, not an error', async (t) => {
  const dir = await sandbox(t);
  const services = [[['com'], ['https://rdap.verisign.com/com/v1/']]];
  const request = async () => ({ ok: true, body: Buffer.from(JSON.stringify({ services })) });

  const r = await rdap.age('something.invalidtld', { cacheDir: dir, request });
  assert.equal(r.known, false);
  assert.equal(r.reason, rdap.REASONS.NO_SERVER);
});

test('only https RDAP servers are used', () => {
  const services = [[['test'], ['http://insecure.example/rdap/', 'https://secure.example/rdap/']]];
  assert.equal(rdap.serverFor('test', services), 'https://secure.example/rdap/');
  assert.equal(rdap.serverFor('test', [[['test'], ['http://only-insecure.example/']]]), null);
});

test('the registration date is read from the registration event, not guessed', () => {
  assert.equal(rdap.registrationDate({ events: [] }), null);
  assert.equal(rdap.registrationDate({ events: [{ eventAction: 'last changed', eventDate: '2026-01-01T00:00:00Z' }] }), null);
  const ms = rdap.registrationDate({ events: [{ eventAction: 'registration', eventDate: '1997-09-15T04:00:00Z' }] });
  assert.equal(new Date(ms).toISOString().slice(0, 10), '1997-09-15');
});

// --- The framing rule ---------------------------------------------------------

test('the checks produce signals, never a verdict', async (t) => {
  const dir = await sandbox(t);
  heuristics.forget();

  // A domain that trips two of the three at once.
  const r = await heuristics.check('paypa1.com', { cacheDir: dir, skipNetwork: true });

  assert.equal(r.checked, true);
  assert.equal(r.signals.length, 3);

  const brand = r.signals.find((s) => s.id === 'brand-similarity');
  assert.equal(brand.present, true);
  assert.equal(brand.detail.brand, 'paypal.com');

  // Age was skipped, and that is reported as unknown rather than as "fine".
  const age = r.signals.find((s) => s.id === 'domain-age');
  assert.equal(age.known, false);
  assert.equal(age.present, false);
  assert.equal(r.unknown, 1, 'unknown is counted separately from absent');

  // No verdict anywhere in the payload.
  const json = JSON.stringify(r).toLowerCase();
  for (const word of ['"score"', '"risk"', '"verdict"', '"malicious"', '"dangerous"', '"safe"']) {
    assert.equal(json.includes(word), false, `a result must not carry ${word}`);
  }
  assert.equal(/\bscam\b/.test(json), false, 'and must never use the word scam');
});

test('no heuristic module renders a verdict in its own source', async () => {
  const dir = path.join(__dirname, '..', 'src', 'main', 'checker');
  const offenders = [];

  for (const file of ['heuristics.js', 'homograph.js', 'similarity.js', 'rdap.js']) {
    const code = (await fsp.readFile(path.join(dir, file), 'utf8'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    // Assigning a verdict-shaped field is the thing being forbidden, not
    // discussing one in a comment.
    if (/\b(verdict|isScam|malicious|riskScore|threatLevel)\s*[:=]/.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a heuristic must not decide');
});

test('an unparseable input is refused rather than guessed at', async () => {
  for (const bad of ['', '   ', 'notadomain', '192.168.1.1', null, 42]) {
    const r = await heuristics.check(bad, { skipNetwork: true });
    assert.equal(r.checked, false, `${JSON.stringify(bad)} must not be checked`);
    assert.deepEqual(r.signals, []);
  }
});
