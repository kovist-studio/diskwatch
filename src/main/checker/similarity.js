'use strict';

// Levenshtein distance against a shipped list of frequently-impersonated
// domains.
//
// This produces a SIGNAL, never a verdict. "One character from paypal.com" is
// a fact about spelling, not a finding about intent — paypay.com is a real
// payment company one edit from PayPal, and gopaypal.com is a customer. The
// caller is handed the distance and the brand and decides what, if anything,
// that is worth saying.

const fsp = require('node:fs/promises');
const path = require('node:path');

const BRANDS_FILE = path.join(__dirname, 'brands.json');

// Standard two-row Levenshtein. Bounded: once every cell in a row exceeds the
// maximum we care about, no later row can come back under it, so the work
// stops. Against 22 brands per lookup that is the difference between a
// microsecond and a millisecond.
function distance(a, b, max) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;

  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[lb];
}

async function loadBrands(file) {
  const doc = JSON.parse(await fsp.readFile(file || BRANDS_FILE, 'utf8'));
  if (!doc || !Array.isArray(doc.brands)) {
    throw new Error('brands.json has no brands array');
  }
  for (const b of doc.brands) {
    if (!b.domain || !b.label || !b.why) {
      throw new Error(`brands.json: ${b.domain || '(no domain)'} is missing domain, label or why`);
    }
  }
  return doc;
}

// The nearest brand within the configured range, or null.
//
// Distance 0 is EXCLUDED deliberately: paypal.com is not impersonating
// paypal.com. Excluding it here rather than in the caller means there is no
// path by which the real domain gets flagged as a lookalike of itself.
function nearestBrand(domain, doc) {
  const cfg = doc.matching || {};
  const min = cfg.minDistance === undefined ? 1 : cfg.minDistance;
  const max = cfg.maxDistance === undefined ? 2 : cfg.maxDistance;

  let best = null;
  for (const brand of doc.brands) {
    const d = distance(domain, brand.domain, max);
    if (d < min || d > max) continue;
    if (!best || d < best.distance) {
      best = { distance: d, brand: brand.domain, label: brand.label, why: brand.why };
    }
  }
  return best;
}

module.exports = { distance, loadBrands, nearestBrand, BRANDS_FILE };
