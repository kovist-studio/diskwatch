'use strict';

// One checkable answer for one pasted thing.
//
// This is where the blocklist result and the three heuristics are gathered.
// It is NOT where they are combined: no score, no verdict, no ranking. Each
// comes back as its own line with its own evidence and its own timestamp, and
// the caller renders them separately.
//
// The cache age travels with the answer, because "not found in 3 blocklists"
// means something different depending on when those lists were last fetched.
// A result from a six-day-old cache is a weaker claim than one from this
// morning and must be able to say so.

const path = require('node:path');
const fsp = require('node:fs/promises');

const { extract } = require('./extract');
const filter = require('./filter');
const heuristics = require('./heuristics');
const fetcher = require('./fetch');
const suffix = require('./suffix');

// A blocklist may list a parent domain and mean everything under it, so a
// subdomain is checked against its ancestors too — stopping at the registrable
// domain and never below it.
//
// This used to stop at two labels, which was wrong for every multi-label
// suffix: barclays.co.uk would have had co.uk queried against the blocklists.
// It was harmless only because no list currently contains a public suffix,
// which is a fact about today's data rather than anything the design
// guaranteed. The Public Suffix List makes it a property of the code.
async function candidates(domain, options = {}) {
  const rules = await suffix.load(options);
  return suffix.lookupNames(domain, rules);
}

async function cacheState(options = {}) {
  const status = await fetcher.status(options);
  const now = options.now || Date.now();

  const sources = status.sources.map((s) => ({
    id: s.id,
    label: s.label,
    licence: s.licence,
    attribution: s.attribution,
    cached: s.cached,
    fetchedAt: s.fetchedAt,
    entries: s.entries,
    ageHours: s.fetchedAt ? Math.floor((now - Date.parse(s.fetchedAt)) / 3600000) : null,
  }));

  const times = sources.filter((s) => s.fetchedAt).map((s) => Date.parse(s.fetchedAt));
  return {
    cacheDir: status.cacheDir,
    sources,
    ready: sources.some((s) => s.cached),
    // The OLDEST source is what the claim is worth. A set of lists is only as
    // current as its stalest member, and reporting the newest would flatter it.
    oldestFetchedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    oldestAgeHours: times.length ? Math.floor((now - Math.min(...times)) / 3600000) : null,
    listCount: sources.filter((s) => s.cached).length,
  };
}

async function checkDomain(domain, options = {}) {
  const names = await candidates(domain, options);

  let blocklist = { present: false, certain: true, sources: [], matched: null, checkedSources: 0 };
  for (const name of names) {
    const hit = await filter.lookup(name, options);
    blocklist.checkedSources = hit.checkedSources || blocklist.checkedSources;
    if (hit.present) {
      blocklist = { ...hit, matched: name };
      break;
    }
    // Preserve "we could not check" rather than letting a later miss overwrite it.
    if (hit.certain === false) blocklist.certain = false;
  }

  const signals = await heuristics.check(domain, options);

  const rules = await suffix.load(options);

  return {
    domain,
    // The part somebody actually registered. Shown so a person can see that
    // login.secure.evil.example and evil.example are the same owner, which is
    // the whole point of the subdomain in a phishing link.
    registrable: suffix.registrableDomain(domain, rules),
    // What the lists say, with attribution attached to each claim.
    blocklist: {
      listed: blocklist.present,
      certain: blocklist.certain,
      matchedAs: blocklist.matched,
      sources: blocklist.sources,
      checkedSources: blocklist.checkedSources,
      // Independent filters, so the chance that every one claiming this domain
      // is simultaneously wrong is the product of their rates. Two lists
      // agreeing is not twice as good as one, it is thousands of times better.
      falsePositiveRate: blocklist.falsePositiveRate || 0,
    },
    signals: signals.signals || [],
    signalsPresent: signals.present || 0,
    signalsUnknown: signals.unknown || 0,
  };
}

// The whole job: pull domains out of whatever was pasted, check each, and
// report the state of the cache the answer came from.
async function check(input, options = {}) {
  const found = extract(input || '', options);
  const cache = await cacheState(options);

  if (found.length === 0) {
    return { ok: true, input: input || '', found: [], results: [], cache };
  }

  const results = [];
  for (const item of found) {
    const result = await checkDomain(item.domain, options);
    results.push({ ...result, raw: item.raw });
  }

  return { ok: true, input: input || '', found, results, cache };
}

module.exports = { check, checkDomain, cacheState, candidates };
