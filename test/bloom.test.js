'use strict';

// The Bloom filter, and the one property everything else rests on.
//
// A filter that is merely usually right is worthless here: a false negative is
// the app telling someone a known scam domain is not on any list. So the
// no-false-negative test is exhaustive rather than sampled — every key that
// went in is checked, and it must never be one that got lucky.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { BloomFilter, optimalParams, actualRate } = require('../src/main/checker/bloom');
const { normalise, parseList } = require('../src/main/checker/parse');
const { perSourceRate } = require('../src/main/checker/filter');

// --- The property ---------------------------------------------------------

test('never a false negative, over every key added', () => {
  const keys = Array.from({ length: 20000 }, (_, i) => `domain-${i}.example`);
  const f = BloomFilter.sized(keys.length, 0.01);
  for (const k of keys) f.add(k);

  let missing = 0;
  for (const k of keys) if (!f.has(k)) missing += 1;
  assert.equal(missing, 0, 'a key that was added must always be found');
});

test('never a false negative even when massively overloaded', () => {
  // Sized for 100, given 10,000. The false-positive rate collapses to useless
  // — but the guarantee is structural, not statistical, and must still hold.
  const f = BloomFilter.sized(100, 0.01);
  const keys = Array.from({ length: 10000 }, (_, i) => `over-${i}.example`);
  for (const k of keys) f.add(k);

  for (const k of keys) assert.equal(f.has(k), true, `${k} must still be found`);
  assert.ok(f.falsePositiveRate() > 0.9, 'and the filter should admit it is now useless');
});

test('bits are only ever set, never cleared — which is WHY there are no false negatives', () => {
  const f = BloomFilter.sized(1000, 0.01);
  f.add('first.example');
  const after = Buffer.from(f.buffer);

  for (let i = 0; i < 500; i++) f.add(`later-${i}.example`);

  // Every bit set by the first key is still set. Nothing an add() does can
  // take a bit away, so nothing can make an earlier key stop being found.
  for (let byte = 0; byte < after.length; byte++) {
    assert.equal(f.buffer[byte] & after[byte], after[byte], 'a set bit was cleared');
  }
});

// --- Absent is certain, present is not ------------------------------------

test('a key never added is usually absent, and absent is proof', () => {
  const f = BloomFilter.sized(10000, 0.001);
  for (let i = 0; i < 10000; i++) f.add(`in-${i}.example`);

  let positives = 0;
  const probes = 20000;
  for (let i = 0; i < probes; i++) if (f.has(`out-${i}.example`)) positives += 1;

  // Sized at 0.1%; allow generous slack so this cannot flake.
  assert.ok(positives / probes < 0.01, `observed ${positives}/${probes}`);
});

// --- Sizing ----------------------------------------------------------------

test('sizing follows the standard formulas and reports its real rate', () => {
  const o = optimalParams(664666, 0.001);
  assert.ok(Math.abs(o.bits / o.entries - 14.38) < 0.1, 'about 14.4 bits per entry at 0.1%');
  assert.equal(o.hashes, 10);

  // A filter holding what it was sized for is at about its target rate.
  assert.ok(Math.abs(actualRate(o.bits, o.hashes, o.entries) - 0.001) < 0.0005);
  // Holding twice that, it is much worse — and says so.
  assert.ok(actualRate(o.bits, o.hashes, o.entries * 2) > 0.01);
});

test('the combined rate across three filters is what gets targeted', () => {
  // The user-facing rate is the chance ANY filter is wrong, not each one.
  const each = perSourceRate(0.001, 3);
  const combined = 1 - Math.pow(1 - each, 3);
  assert.ok(Math.abs(combined - 0.001) < 1e-9, 'three filters at this rate combine to the target');
  assert.ok(each < 0.001, 'so each individual filter must be stricter than the headline');
});

// --- Serialisation ---------------------------------------------------------

test('a filter survives a round trip through bytes with its shape intact', () => {
  const f = BloomFilter.sized(5000, 0.001);
  for (let i = 0; i < 5000; i++) f.add(`rt-${i}.example`);

  const back = BloomFilter.deserialize(f.serialize());
  assert.equal(back.bits, f.bits);
  assert.equal(back.hashes, f.hashes);
  assert.equal(back.entries, f.entries);
  for (let i = 0; i < 5000; i++) assert.equal(back.has(`rt-${i}.example`), true);
});

test('a corrupt filter file is refused, not silently misread', () => {
  assert.throws(() => BloomFilter.deserialize(Buffer.alloc(4)), /too short/);
  const bad = Buffer.alloc(32);
  bad.writeUInt32BE(0xdeadbeef, 0);
  assert.throws(() => BloomFilter.deserialize(bad), /bad magic/);
});

// --- Parsing ---------------------------------------------------------------

test('the three list dialects normalise to the same bare domain', () => {
  assert.equal(normalise('0.0.0.0 Evil.Example', 'hosts'), 'evil.example');
  assert.equal(normalise('||evil.example^$third-party', 'domains'), 'evil.example');
  assert.equal(normalise('*.evil.example.', 'domains'), 'evil.example');
  assert.equal(normalise('evil.example # added 2026-01-01', 'domains-commented'), 'evil.example');
});

test('routing addresses and junk never become domains', () => {
  for (const [line, fmt] of [
    ['0.0.0.0 0.0.0.0', 'hosts'],
    ['127.0.0.1 localhost', 'hosts'],
    ['192.168.1.1', 'domains'],
    ['# a comment', 'domains-commented'],
    ['! adblock comment', 'domains'],
    ['notadomain', 'domains'],
    ['', 'domains'],
  ]) {
    assert.equal(normalise(line, fmt), null, `${JSON.stringify(line)} must not parse as a domain`);
  }
});

test('a list deduplicates within itself', () => {
  const { domains, lines } = parseList('a.example\nA.EXAMPLE\n*.a.example\nb.example\n', 'domains');
  assert.equal(lines, 5);
  assert.deepEqual([...domains].sort(), ['a.example', 'b.example']);
});

// --- End to end on generated data -----------------------------------------

test('a filter built from parsed lists finds every domain in them', () => {
  const hosts = Array.from({ length: 3000 }, (_, i) => `0.0.0.0 h${i}.example`).join('\n');
  const { domains } = parseList(hosts, 'hosts');
  assert.equal(domains.size, 3000);

  const f = BloomFilter.sized(domains.size, perSourceRate(0.001, 3));
  for (const d of domains) f.add(d);

  for (const d of domains) assert.equal(f.has(d), true, `${d} went in and must be found`);
  assert.equal(f.has(`${crypto.randomBytes(6).toString('hex')}.example`), false);
});
