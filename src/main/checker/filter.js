'use strict';

// Builds the lookup structure from the lists already on disk, and answers
// questions against it.
//
// THIS IS BUILT ON THE USER'S MACHINE, FROM THE USER'S OWN CACHED COPY, AND IS
// NEVER SHIPPED. Two of the three sources are copyleft — GPL-3.0 and
// CC BY-SA 4.0 — so a filter we built and distributed would be a derivative
// work owing both licences at once, inside an MIT application. Building it
// here means we distribute nothing derived from them. Do not add a build step
// that emits one of these into dist/. See DECISIONS.md and CLAUDE.md.
//
// One filter PER SOURCE rather than one over the union. A single filter can
// only answer "is this in any of them"; three can answer "which ones", which
// is what lets a verdict cite its evidence instead of asserting itself. The
// cost is the overlap between lists, stored twice — about 1.5 MB in total,
// which is not a consideration.

const fsp = require('node:fs/promises');
const path = require('node:path');

const { BloomFilter, optimalParams } = require('./bloom');
const { parseList } = require('./parse');
const fetcher = require('./fetch');

// THE FALSE-POSITIVE RATE, chosen rather than defaulted.
//
// 0.1% — one in a thousand clean domains will be reported as possibly listed.
//
// Why not 1%: this app's whole posture is that it does not invent threats. A
// false positive here is the app telling someone a legitimate site might be a
// scam, which is the exact failure the no-scareware rule exists to prevent. 1%
// is one wrong flag per hundred sites, which a person browsing normally would
// meet within a day, and each one teaches them to ignore the next warning.
//
// Why not 0.01%: it costs 33% more memory (1.5 MB against 1.1 MB) to move a
// number that is already below the rate at which people notice. The gain is
// unobservable; the cost is real on a machine that is short of space, which is
// the machine this app is running on.
//
// 0.1% at 665k entries is ~1.2 MB and 10-11 hash probes. That is small enough
// to hold in memory permanently and rebuild in seconds, which is what makes
// the once-a-day rebuild affordable.
//
// THE RATE IS THE COMBINED ONE, and that distinction is not pedantic. A lookup
// consults one filter per source, so a clean domain is flagged if ANY of them
// is wrong about it. Sizing each filter at 0.1% would give a user-facing rate
// of 1-(1-0.001)^3 = 0.3%, three times the number this constant appears to
// promise. Measured before this was fixed: 599 false positives in 200,000
// probes, 0.2995%.
//
// So each filter is sized at the per-source rate that makes the COMBINED rate
// come out at the target. It costs about 130 KB across all three.
const FALSE_POSITIVE_RATE = 0.001;

// p_each such that 1 - (1 - p_each)^n = p_combined.
function perSourceRate(combined, sourceCount) {
  const n = Math.max(1, sourceCount);
  return 1 - Math.pow(1 - combined, 1 / n);
}

const META_FILE = 'filter.meta.json';
const FILTER_VERSION = 1;

const cacheDirFor = (options) => {
  if (options.cacheDir) return options.cacheDir;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'blocklists');
};

const metaPath = (dir) => path.join(dir, META_FILE);
const filterPath = (dir, id) => path.join(dir, `${id}.bloom`);
const bodyPath = (dir, id) => path.join(dir, `${id}.txt`);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------- Is a rebuild needed? ----------

// A filter is current when it was built from exactly the bytes now cached.
// The comparison is on the SHA-256 that fetch.js recorded when it wrote each
// list, so a refresh that happens to produce identical content does NOT
// trigger a rebuild, and a changed list always does. Comparing timestamps
// would rebuild on every refresh whether or not anything changed.
function staleSources(meta, index) {
  const cached = (index && index.sources) || {};
  const built = (meta && meta.sources) || {};
  const stale = [];

  for (const id of Object.keys(cached)) {
    const b = built[id];
    if (!b || b.sha256 !== cached[id].sha256) stale.push(id);
  }
  // A source that has been removed from the cache should not keep a filter.
  for (const id of Object.keys(built)) {
    if (!cached[id]) stale.push(id);
  }
  return [...new Set(stale)];
}

// ---------- build ----------

// Parses the cached lists and writes one filter per source. Returns what each
// source contributed, before and after deduplication against the others.
async function build(options = {}) {
  const dir = cacheDirFor(options);
  const doc = options.doc || (await fetcher.loadDocument(options.file));
  const { sources } = fetcher.validate(doc);
  const index = await readJson(path.join(dir, 'index.json'), { sources: {} });
  const rate = options.rate || FALSE_POSITIVE_RATE;

  const report = [];
  const seen = new Set(); // union across sources, in allowlist order

  // Sized so that the chance of ANY filter flagging a clean domain is `rate`.
  const each = perSourceRate(rate, sources.length);

  const meta = {
    version: FILTER_VERSION,
    builtAt: new Date(options.now || Date.now()).toISOString(),
    rate,
    perSourceRate: each,
    sources: {},
  };

  for (const src of sources) {
    const cached = (index.sources || {})[src.id];
    let text;
    try {
      text = await fsp.readFile(bodyPath(dir, src.id), 'utf8');
    } catch {
      report.push({ id: src.id, cached: false, parsed: 0, unique: 0, note: 'not cached yet' });
      continue;
    }

    const { domains, lines, skipped } = parseList(text, src.format);

    // What this source added that no earlier source had. Order-dependent by
    // definition, so the allowlist order is the reported order — stated rather
    // than hidden, because "unique" is otherwise a number nobody can reproduce.
    let unique = 0;
    for (const d of domains) {
      if (!seen.has(d)) {
        seen.add(d);
        unique += 1;
      }
    }

    const filter = BloomFilter.sized(domains.size, each);
    for (const d of domains) filter.add(d);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filterPath(dir, src.id), filter.serialize());

    meta.sources[src.id] = {
      sha256: cached ? cached.sha256 : null,
      domains: domains.size,
      bits: filter.bits,
      hashes: filter.hashes,
      bytes: Math.ceil(filter.bits / 8),
      falsePositiveRate: filter.falsePositiveRate(),
      licence: src.licence,
      attribution: src.attribution,
    };

    report.push({
      id: src.id,
      cached: true,
      lines,
      skipped,
      parsed: domains.size,
      unique,
      overlap: domains.size - unique,
      bytes: Math.ceil(filter.bits / 8),
      falsePositiveRate: filter.falsePositiveRate(),
    });
  }

  meta.union = seen.size;
  await fsp.writeFile(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`);

  return {
    cacheDir: dir,
    rate,
    sources: report,
    totals: {
      union: seen.size,
      parsed: report.reduce((a, r) => a + (r.parsed || 0), 0),
      bytes: report.reduce((a, r) => a + (r.bytes || 0), 0),
    },
  };
}

// Builds only if something actually changed. This is what makes "rebuild only
// when a source refreshes" true across launches rather than aspirational.
async function ensure(options = {}) {
  const dir = cacheDirFor(options);
  const meta = await readJson(metaPath(dir), null);
  const index = await readJson(path.join(dir, 'index.json'), { sources: {} });

  const stale = staleSources(meta, index);
  if (meta && meta.version === FILTER_VERSION && stale.length === 0) {
    return { rebuilt: false, reason: 'current', union: meta.union || 0 };
  }
  const result = await build(options);
  return {
    rebuilt: true,
    reason: meta ? `sources changed: ${stale.join(', ')}` : 'no filter built yet',
    union: result.totals.union,
    result,
  };
}

// ---------- lookup ----------

// Filters are loaded once and held. They are ~1.5 MB in total and are consulted
// per link checked, so re-reading them from disk each time would be the only
// slow part of an otherwise instant answer.
const loaded = new Map();

async function load(options = {}) {
  const dir = cacheDirFor(options);
  const meta = await readJson(metaPath(dir), null);
  if (!meta) return { meta: null, filters: new Map() };

  const key = `${dir}|${meta.builtAt}`;
  if (loaded.has(key)) return loaded.get(key);

  const filters = new Map();
  for (const id of Object.keys(meta.sources || {})) {
    try {
      filters.set(id, BloomFilter.deserialize(await fsp.readFile(filterPath(dir, id))));
    } catch {
      // A filter that will not load is simply one this lookup cannot consult.
      // Not fatal: the others still answer, and ensure() will rebuild it.
    }
  }
  const entry = { meta, filters };
  loaded.clear(); // only ever one build is current
  loaded.set(key, entry);
  return entry;
}

function forget() {
  loaded.clear();
}

// present === false is CERTAIN. present === true is PROBABLE, and the caller
// is handed the numbers to say so honestly rather than a bare boolean it might
// render as a verdict.
async function lookup(domain, options = {}) {
  const { normalise } = require('./parse');
  const name = typeof domain === 'string' ? normalise(domain, 'domains') : null;
  if (!name) {
    return { domain: null, present: false, certain: true, sources: [], reason: 'not-a-domain' };
  }

  const { meta, filters } = await load(options);
  if (!meta || filters.size === 0) {
    return { domain: name, present: false, certain: false, sources: [], reason: 'no-filter-built' };
  }

  const hits = [];
  for (const [id, filter] of filters) {
    if (!filter.has(name)) continue;
    const m = meta.sources[id] || {};
    hits.push({
      id,
      licence: m.licence,
      attribution: m.attribution,
      falsePositiveRate: m.falsePositiveRate,
    });
  }

  // Independent filters, so the chance that EVERY one of them is wrong at once
  // is the product — which is why a domain claimed by two sources is far more
  // likely to be real than one claimed by a single source.
  const combined = hits.reduce((a, h) => a * (h.falsePositiveRate || 0), 1);

  return {
    domain: name,
    present: hits.length > 0,
    // Absent is proof. Present never is.
    certain: hits.length === 0,
    sources: hits,
    falsePositiveRate: hits.length > 0 ? combined : 0,
    checkedSources: filters.size,
  };
}

module.exports = {
  perSourceRate,
  build,
  ensure,
  lookup,
  load,
  forget,
  staleSources,
  optimalParams,
  FALSE_POSITIVE_RATE,
  META_FILE,
};
