'use strict';

// The three local checks, run together, reported separately.
//
// THE FRAMING RULE: these are signals, not verdicts. Nothing in this file
// decides whether a domain is a scam, scores it, ranks it, or uses the word.
// It reports observations with their evidence and stops.
//
// That is not squeamishness. A heuristic that renders a verdict on its own is
// how false accusations ship: each of these fires on legitimate domains.
// paypay.com is a real payment company one edit from PayPal. Every domain on
// earth was registered recently once. Plenty of internationalised domains are
// exactly what they claim to be. Individually each signal is weak; the value
// is in how they stack, and stacking them is a presentation decision made
// where the user's words are chosen, not here.
//
// So there is deliberately no `score`, no `risk`, no `malicious`, and no
// `verdict` field below. A caller that wants one has to write it itself, in
// full view.

const { analyse } = require('./homograph');
const { loadBrands, nearestBrand } = require('./similarity');
const rdap = require('./rdap');
const { normalise } = require('./parse');

let brandsCache = null;

async function brands(options = {}) {
  if (options.brands) return options.brands;
  if (!brandsCache) brandsCache = await loadBrands(options.brandsFile);
  return brandsCache;
}

function forget() {
  brandsCache = null;
}

// Each check returns the same shape so a caller can iterate them without
// knowing which is which: what was looked at, whether the thing was observed,
// how sure we are of the OBSERVATION, and the evidence behind it.
async function check(domain, options = {}) {
  const name = normalise(typeof domain === 'string' ? domain : '', 'domains');
  if (!name) {
    return { domain: null, checked: false, reason: 'not-a-domain', signals: [] };
  }

  const signals = [];

  // 1. Age. The only one that needs the network, and the only one that can
  //    come back unknown. Unknown is reported as its own state rather than as
  //    "no signal", because "we could not find out" and "we found out it is
  //    old" are different facts and collapsing them would flatter the domain.
  let ageResult = { known: false, reason: 'skipped' };
  if (options.skipNetwork !== true) {
    ageResult = await rdap.age(name, options);
  }
  signals.push({
    id: 'domain-age',
    present: ageResult.known ? ageResult.signal : false,
    known: ageResult.known,
    confidence: ageResult.known ? 'certain' : 'unknown',
    detail: ageResult.known
      ? {
          registeredAt: ageResult.registeredAt,
          ageDays: ageResult.ageDays,
          band: ageResult.band,
        }
      : { reason: ageResult.reason, note: 'the age could not be determined' },
  });

  // 2. Mixed script.
  const homo = analyse(name);
  signals.push({
    id: 'mixed-script',
    present: homo.signal === true,
    known: true,
    confidence: homo.confidence,
    detail: {
      ascii: homo.ascii,
      unicode: homo.unicode,
      isIdn: homo.isIdn,
      scripts: homo.scripts,
      mixedLabels: homo.mixedLabels,
      confusables: homo.confusables,
    },
  });

  // 3. Distance to a frequently-impersonated name.
  const doc = await brands(options);
  const near = nearestBrand(name, doc);
  signals.push({
    id: 'brand-similarity',
    present: near !== null,
    known: true,
    // Distance 1 on a long name is a stronger observation than distance 2 on a
    // short one, and this is as far as the ranking goes.
    confidence: near ? (near.distance === 1 ? 'high' : 'medium') : 'none',
    detail: near
      ? { distance: near.distance, brand: near.brand, label: near.label, why: near.why }
      : { note: 'not within editing distance of any name on the impersonation list' },
  });

  return {
    domain: name,
    checked: true,
    signals,
    // A count, not a score. Three signals is a fact about how many things were
    // observed; what it MEANS is not decided here.
    present: signals.filter((s) => s.present).length,
    unknown: signals.filter((s) => !s.known).length,
  };
}

module.exports = { check, forget };
