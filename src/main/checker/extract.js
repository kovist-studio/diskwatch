'use strict';

// Pulling checkable domains out of whatever someone pasted.
//
// The realistic input is not a URL. It is a whole text message or email,
// pasted entire, because that is how a scam link arrives — wrapped in a
// pretext, usually with the link somewhere in the middle. Asking a worried
// person to isolate the URL first is asking them to do the one bit of handling
// that gets people phished.

const { normalise } = require('./parse');

// Links that have been deliberately broken so they cannot be clicked by
// accident. Anyone forwarding a suspicious message to be checked is quite
// likely to have defanged it first, or to have received it that way from
// someone who did. Refusing to understand the convention would reject exactly
// the input that arrives from the most careful users.
function refang(text) {
  return text
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}/g, '.')
    .replace(/\[\s*:\s*\]|\(\s*:\s*\)/g, ':')
    .replace(/\bh(?:xx|__)p(s?)\b/gi, 'http$1')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\bwww\s*\[\s*\.\s*\]\s*/gi, 'www.');
}

// A host is what is left after the scheme, credentials, port, path, query and
// fragment are taken off. Unicode is allowed through here and canonicalised to
// punycode by normalise() afterwards — stripping it at this stage would
// discard homograph domains, which are the ones most worth examining.
const CANDIDATE = /(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^\s/@]+@)?((?:[^\s/?#:.@]+\.)+[^\s/?#:.@]{2,})(?::\d{1,5})?(?:[/?#][^\s]*)?/giu;

// Words that look like domains because they contain a dot. A sentence ending
// "…in the morning.Then" produces "morning.then", and "file.txt" is not a
// place. Excluded by TLD rather than by guesswork about the whole string.
const NOT_TLDS = new Set([
  'txt', 'pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'gif', 'zip', 'exe', 'dmg',
  'js', 'json', 'html', 'css', 'md', 'csv', 'xls', 'xlsx', 'ppt', 'pptx', 'mp4',
  'mp3', 'svg', 'ico', 'log', 'tmp', 'bak', 'sh', 'py', 'rb', 'go', 'rs',
]);

// Every distinct domain in the text, in the order it first appears.
//
// Order matters: the first link in a message is usually the one being pushed,
// and a person scanning results should meet them in the order they met them in
// the message.
function extract(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const limit = options.limit || 25;

  const refanged = refang(text);
  const seen = new Map();

  for (const match of refanged.matchAll(CANDIDATE)) {
    const host = match[1];
    if (!host) continue;

    const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    if (NOT_TLDS.has(tld)) continue;

    let domain = normalise(host, 'domains');
    if (!domain) continue;

    // A leading www. is a universal convention rather than a meaningful
    // subdomain, and keeping it breaks both checks that follow: blocklists
    // list the bare name, and www.paypal.com is four edits from paypal.com
    // where paypal.com is zero. Deeper subdomains are NOT stripped — in
    // paypal.com.evil.example the subdomain is the whole trick.
    if (domain.startsWith('www.') && domain.split('.').length > 2) {
      domain = domain.slice(4);
    }
    if (seen.has(domain)) continue;

    seen.set(domain, {
      domain,
      // What the person actually saw, kept so a result can be shown against
      // the text they pasted rather than against a canonicalised form they
      // will not recognise.
      raw: match[0].trim(),
    });
    if (seen.size >= limit) break;
  }

  return [...seen.values()];
}

module.exports = { extract, refang, CANDIDATE, NOT_TLDS };
