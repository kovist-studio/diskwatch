'use strict';

// Where a domain stops being somebody's and starts being the registry's.
//
// You cannot tell by counting labels. barclays.co.uk is three labels and the
// registrable domain is all three; evil.example is two and the registrable
// domain is both. There is no rule derivable from the string — the answer is
// data, published by the registries, and the Public Suffix List is that data.
//
// The list is bundled verbatim as public_suffix_list.dat and parsed here at
// runtime. It stays unmodified on purpose: see suffix.json for the licensing
// reason, which is that an unmodified file creates no derivative work.

const fsp = require('node:fs/promises');
const path = require('node:path');

const LIST_FILE = path.join(__dirname, 'public_suffix_list.dat');

// Three kinds of rule, and they do not behave the same way:
//
//   com, co.uk        a normal rule. The suffix is exactly this.
//   *.ck              a wildcard. ANY single label under ck is a suffix, so
//                     foo.ck is a suffix and bar.foo.ck is registrable.
//   !www.ck           an exception. www.ck is NOT a suffix despite the
//                     wildcard above, so www.ck itself is registrable.
//
// Exceptions exist precisely because wildcards are too broad, and they win
// outright. Getting this wrong in the safe-looking direction — ignoring
// exceptions — would make a registrable domain look like a public suffix.
function parse(text) {
  const normal = new Set();
  const wildcards = new Set();
  const exceptions = new Set();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;

    if (line.startsWith('!')) {
      exceptions.add(line.slice(1).toLowerCase());
    } else if (line.startsWith('*.')) {
      wildcards.add(line.slice(2).toLowerCase());
    } else {
      normal.add(line.toLowerCase());
    }
  }
  return { normal, wildcards, exceptions };
}

let cached = null;

async function load(options = {}) {
  if (options.rules) return options.rules;
  if (!cached) cached = parse(await fsp.readFile(options.file || LIST_FILE, 'utf8'));
  return cached;
}

function forget() {
  cached = null;
}

// The longest matching rule wins, which is why this walks from the whole
// domain inwards and returns on the first hit rather than the last.
function publicSuffix(domain, rules) {
  const labels = String(domain || '').toLowerCase().split('.');

  // Exceptions first and unconditionally: an exception rule beats any wildcard
  // that would otherwise swallow it. The prevailing suffix is the exception
  // rule with its leftmost label removed.
  for (let i = 0; i < labels.length; i++) {
    if (rules.exceptions.has(labels.slice(i).join('.'))) {
      return labels.slice(i + 1).join('.');
    }
  }

  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (rules.normal.has(candidate)) return candidate;
    // A wildcard is stored by what follows the "*.", so this asks: is the
    // PARENT of this candidate a wildcard rule?
    const parent = labels.slice(i + 1).join('.');
    if (parent && rules.wildcards.has(parent)) return candidate;
  }

  // The implicit default rule is "*": an unknown TLD is itself the suffix.
  return labels[labels.length - 1] || '';
}

// The suffix plus one label — the part a person or a company actually
// registered. Returns null when the domain IS a public suffix, because nobody
// owns "co.uk" and treating it as a domain is the bug this file exists to fix.
function registrableDomain(domain, rules) {
  const name = String(domain || '').toLowerCase();
  const suffix = publicSuffix(name, rules);
  if (!suffix) return null;

  const labels = name.split('.');
  const suffixLabels = suffix.split('.').length;
  if (labels.length <= suffixLabels) return null;

  return labels.slice(labels.length - suffixLabels - 1).join('.');
}

// Every name worth checking a blocklist for: the full host, then each parent,
// stopping AT the registrable domain and never below it.
//
// Stopping matters. Querying a public suffix asks "is co.uk on a blocklist",
// which is a question with a 1-in-1000 chance of a wrong yes and no chance of
// a useful one.
function lookupNames(domain, rules) {
  const name = String(domain || '').toLowerCase();
  const registrable = registrableDomain(name, rules);
  if (!registrable) return [name];

  const labels = name.split('.');
  const depth = registrable.split('.').length;
  const out = [];
  for (let i = 0; i <= labels.length - depth; i++) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

module.exports = { load, parse, forget, publicSuffix, registrableDomain, lookupNames, LIST_FILE };
