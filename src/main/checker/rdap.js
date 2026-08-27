'use strict';

// Domain age via RDAP — the IETF successor to WHOIS, which answers in JSON
// instead of freeform text nobody can parse reliably.
//
// A newly registered domain is the strongest single signal in this whole
// phase. Phishing infrastructure is disposable: registered days before a
// campaign, burned when it is blocked. A domain registered nine years ago is
// not proof of anything good, but a domain registered on Tuesday is worth
// saying out loud.
//
// It is still a SIGNAL. Every legitimate domain was also new once.
//
// This is the second and last network access in the application. It differs
// from fetch.js in one way that matters: the endpoints cannot all be written
// down, because there is one RDAP server per registry. The BOOTSTRAP endpoint
// is written down, in rdap.json, and every server is discovered from it. See
// the note in that file and in DECISIONS.md.

const fsp = require('node:fs/promises');
const path = require('node:path');

const { httpsGet } = require('./fetch');

const CONFIG_FILE = path.join(__dirname, 'rdap.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const REASONS = Object.freeze({
  NO_TLD: 'no-tld',
  NO_SERVER: 'no-registry-server',
  BOOTSTRAP_FAILED: 'bootstrap-failed',
  QUERY_FAILED: 'query-failed',
  NOT_JSON: 'not-json',
  NO_REGISTRATION_DATE: 'no-registration-date',
  NOT_HTTPS: 'not-https',
});

const cacheDirFor = (options) => {
  if (options.cacheDir) return options.cacheDir;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'blocklists');
};

const bootstrapPath = (dir) => path.join(dir, 'rdap-bootstrap.json');
const cachePath = (dir) => path.join(dir, 'rdap-cache.json');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const loadConfig = async (file) => JSON.parse(await fsp.readFile(file || CONFIG_FILE, 'utf8'));

// ---------- Bootstrap ----------

// IANA's map is a list of [ [tlds...], [rdap base urls...] ] pairs. Cached for
// a week: registries move, but not often, and a lookup must never depend on
// this being reachable right now.
async function bootstrap(options = {}) {
  const config = options.config || (await loadConfig(options.file));
  const dir = cacheDirFor(options);
  const now = options.now || Date.now();
  const file = bootstrapPath(dir);

  const cached = await readJson(file, null);
  const ttl = (config.bootstrap.cacheHours || 168) * 3600 * 1000;
  if (cached && cached.fetchedAt && now - Date.parse(cached.fetchedAt) < ttl) {
    return { ok: true, services: cached.services, cached: true };
  }

  const request = options.request || httpsGet;
  const res = await request(config.bootstrap.url, config.query.timeoutMs || 8000);
  if (!res.ok) {
    // A stale map beats no map: registries rarely move, and refusing to answer
    // because IANA is briefly unreachable would be worse than a slightly old
    // server list.
    if (cached && cached.services) return { ok: true, services: cached.services, cached: true, stale: true };
    return { ok: false, reason: REASONS.BOOTSTRAP_FAILED, detail: res.detail };
  }

  let doc;
  try {
    doc = JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    return { ok: false, reason: REASONS.NOT_JSON, detail: err.message };
  }

  await writeJson(file, { fetchedAt: new Date(now).toISOString(), services: doc.services || [] });
  return { ok: true, services: doc.services || [], cached: false };
}

// The RDAP base URL for a TLD, or null. https only — a registry publishing an
// http endpoint gets no query rather than an unencrypted one.
function serverFor(tld, services) {
  for (const [tlds, urls] of services || []) {
    if (!tlds.some((t) => t.toLowerCase() === tld)) continue;
    for (const url of urls) {
      if (url.startsWith('https://')) return url.endsWith('/') ? url : `${url}/`;
    }
    return null;
  }
  return null;
}

// ---------- The registration date ----------

// RDAP returns an events array; the one we want has eventAction
// "registration". Its absence is reported as unknown rather than guessed at
// from whatever other date happens to be present.
function registrationDate(doc) {
  const events = (doc && doc.events) || [];
  const reg = events.find((e) => e.eventAction === 'registration');
  if (!reg || !reg.eventDate) return null;
  const ms = Date.parse(reg.eventDate);
  return Number.isFinite(ms) ? ms : null;
}

// ---------- age() ----------

// Never throws and never blocks a check: every failure below returns
// { known: false } with a reason. A link checker that stalls because a
// registry is slow is worse than one that says "age unknown".
async function age(domain, options = {}) {
  const name = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  const now = options.now || Date.now();
  const unknown = (reason, detail) => ({ domain: name || null, known: false, reason, detail: detail || null });

  if (!name || !name.includes('.')) return unknown(REASONS.NO_TLD);

  const config = options.config || (await loadConfig(options.file));
  const dir = cacheDirFor(options);
  const cacheFile = cachePath(dir);
  const cache = await readJson(cacheFile, {});
  const hit = cache[name];

  // A registration date is immutable, so a successful answer is kept and the
  // AGE is recomputed from it — storing the age would make the cache wrong
  // the day after it was written.
  if (hit && hit.registeredAt) {
    const okFor = (config.query.cacheDays || 30) * DAY_MS;
    if (now - Date.parse(hit.fetchedAt) < okFor) {
      return describe(name, Date.parse(hit.registeredAt), now, true);
    }
  } else if (hit && hit.failedAt) {
    const retryAfter = (config.query.failureCacheHours || 6) * 3600 * 1000;
    if (now - Date.parse(hit.failedAt) < retryAfter) {
      return { ...unknown(hit.reason, hit.detail), cached: true };
    }
  }

  const remember = async (entry) => {
    cache[name] = entry;
    await writeJson(cacheFile, cache);
  };

  const boot = await bootstrap({ ...options, config, now });
  if (!boot.ok) return unknown(boot.reason, boot.detail);

  const tld = name.slice(name.lastIndexOf('.') + 1);
  const base = serverFor(tld, boot.services);
  if (!base) {
    await remember({ failedAt: new Date(now).toISOString(), reason: REASONS.NO_SERVER, detail: `.${tld}` });
    return unknown(REASONS.NO_SERVER, `no RDAP server published for .${tld}`);
  }

  const request = options.request || httpsGet;
  const res = await request(`${base}domain/${encodeURIComponent(name)}`, config.query.timeoutMs || 8000);
  if (!res.ok) {
    await remember({ failedAt: new Date(now).toISOString(), reason: REASONS.QUERY_FAILED, detail: res.detail });
    return unknown(REASONS.QUERY_FAILED, res.detail);
  }

  let doc;
  try {
    doc = JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    await remember({ failedAt: new Date(now).toISOString(), reason: REASONS.NOT_JSON, detail: err.message });
    return unknown(REASONS.NOT_JSON, err.message);
  }

  const registeredAt = registrationDate(doc);
  if (registeredAt === null) {
    await remember({ failedAt: new Date(now).toISOString(), reason: REASONS.NO_REGISTRATION_DATE });
    return unknown(REASONS.NO_REGISTRATION_DATE, 'the registry did not publish a registration event');
  }

  await remember({
    fetchedAt: new Date(now).toISOString(),
    registeredAt: new Date(registeredAt).toISOString(),
    registry: base,
  });
  return describe(name, registeredAt, now, false);
}

// Bands, not a score. The caller is given the date and the day count and can
// ignore the band entirely; it exists so a UI does not have to invent its own
// thresholds and get different ones on every screen.
function describe(name, registeredAt, now, cached) {
  const days = Math.floor((now - registeredAt) / DAY_MS);
  let band = 'established';
  if (days < 30) band = 'very-new';
  else if (days < 90) band = 'new';
  else if (days < 365) band = 'recent';

  return {
    domain: name,
    known: true,
    registeredAt: new Date(registeredAt).toISOString(),
    ageDays: days,
    band,
    // The observation is certain when it is known — this is not a probability,
    // it is a date a registry published.
    signal: days < 90,
    cached,
  };
}

module.exports = { age, bootstrap, serverFor, registrationDate, describe, loadConfig, REASONS, CONFIG_FILE };
