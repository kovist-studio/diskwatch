'use strict';

// Turning three differently-shaped files into one kind of thing: a domain.
//
// The lists disagree about syntax because they were built for different
// consumers — a hosts file for the OS resolver, a plain list for scripting, an
// adblock list for a browser extension. None of that survives into the filter;
// what goes in is a bare lowercase domain, so that a lookup can be a single
// exact comparison rather than a guess about which dialect the answer came in.

// Hosts files point a domain at a null address. That address is routing, not
// data, and must never be mistaken for a domain to block.
const NULL_HOSTS = new Set([
  '0.0.0.0', '127.0.0.1', '::1', '::', 'localhost', 'localhost.localdomain',
  'broadcasthost', 'ip6-localhost', 'ip6-loopback', 'ip6-localnet',
  'ip6-mcastprefix', 'ip6-allnodes', 'ip6-allrouters',
]);

// Deliberately permissive on length and charset (IDN punycode is a-z0-9-),
// strict on shape: labels separated by dots, no empty labels, at least one dot,
// and a TLD that is not numeric. An IPv4 address must not survive as a domain.
// The TLD alternation matters: a punycode TLD such as xn--p1ai (.рф) contains
// digits, so an [a-z]-only pattern silently rejects every domain under every
// internationalised TLD — including the legitimate ones this check is careful
// not to flag.
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

const { domainToASCII } = require('node:url');

// One line to a domain, or null if the line carries none.
function normalise(rawLine, format) {
  let line = rawLine;

  // Comments. Adblock uses `!`, hosts and plain lists use `#`, and CyberHost
  // puts the source and date of every entry on its own `#` line — which is why
  // that file has roughly twice as many lines as domains.
  const hash = line.indexOf('#');
  if (hash !== -1) line = line.slice(0, hash);
  if (line.trimStart().startsWith('!')) return null;

  line = line.trim();
  if (line === '') return null;

  if (format === 'hosts') {
    // "0.0.0.0 evil.example" — the address is the first field.
    const parts = line.split(/\s+/);
    if (parts.length < 2) return null;
    line = parts[1];
  } else {
    // A plain list may still carry a leading address if it was converted from
    // a hosts file; take the last field either way.
    const parts = line.split(/\s+/);
    line = parts[parts.length - 1];
  }

  // Adblock syntax: ||evil.example^ or ||evil.example^$third-party
  if (line.startsWith('||')) line = line.slice(2);
  const caret = line.indexOf('^');
  if (caret !== -1) line = line.slice(0, caret);
  const dollar = line.indexOf('$');
  if (dollar !== -1) line = line.slice(0, dollar);

  line = line.toLowerCase();

  // A wildcard subdomain is the same registrable domain as far as we are
  // concerned: *.evil.example and evil.example both mean evil.example.
  if (line.startsWith('*.')) line = line.slice(2);
  while (line.startsWith('.')) line = line.slice(1);
  while (line.endsWith('.')) line = line.slice(0, -1);

  // A port or a path means this was a URL, not a domain. Keep the host.
  const slash = line.indexOf('/');
  if (slash !== -1) line = line.slice(0, slash);
  const colon = line.indexOf(':');
  if (colon !== -1) line = line.slice(0, colon);

  if (line === '' || NULL_HOSTS.has(line)) return null;

  // Internationalised names are canonicalised to their punycode form BEFORE
  // validation, for two reasons. The blocklists store xn-- ASCII, so a lookup
  // has to arrive in that shape to match. And without this the ASCII-only
  // pattern below rejects every Unicode domain — which would mean the one
  // input the homograph check exists to examine could never reach it. Getting
  // this wrong is silent: the domain simply comes back null and looks unknown.
  if (/[^\x00-\x7f]/.test(line)) {
    const ascii = domainToASCII(line);
    if (!ascii) return null;
    line = ascii;
  }

  if (!DOMAIN_RE.test(line)) return null;
  return line;
}

// Every domain in one list body, deduplicated within that list.
function parseList(text, format) {
  const domains = new Set();
  let lines = 0;
  let skipped = 0;

  for (const raw of text.split('\n')) {
    lines += 1;
    const domain = normalise(raw, format);
    if (domain === null) {
      skipped += 1;
      continue;
    }
    domains.add(domain);
  }
  return { domains, lines, skipped };
}

// The same domain appearing in a domain and in a subdomain of it is not a
// duplicate — evil.example and login.evil.example are different lookups — so
// deduplication here is exact-string only, deliberately.
module.exports = { normalise, parseList, DOMAIN_RE, NULL_HOSTS };
