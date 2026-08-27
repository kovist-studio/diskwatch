'use strict';

// Mixed-script detection: characters from different writing systems spliced
// into one label so the result LOOKS like a familiar name.
//
// The signal is mixing, not the presence of a non-Latin script. A wholly
// Cyrillic domain is an ordinary Russian domain and says nothing at all. Latin
// with three Cyrillic characters dropped in is not a language, it is a costume.
// Treating any non-Latin script as suspicious would flag most of the internet
// outside the anglosphere, which is both useless and offensive.
//
// A SIGNAL, never a verdict. Mixed script is unusual; it is not proof.

const { domainToUnicode, domainToASCII } = require('node:url');

// Tested in order. Scripts a domain might plausibly be written in, plus the
// ones actually used in homograph attacks.
const SCRIPTS = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Armenian', /\p{Script=Armenian}/u],
];

// Digits, hyphens and combining marks belong to no script for this purpose:
// they appear in every language and mixing them proves nothing.
const NEUTRAL = /[\p{Nd}\p{Pd}_.​-‏‪-‮]/u;

// The characters that actually do the work in these attacks: non-Latin glyphs
// that render as a Latin letter in most fonts. Not exhaustive — it exists to
// name what was found, not to be the detector. The detector is script mixing,
// which catches substitutions this table has never heard of.
const CONFUSABLE = new Map(Object.entries({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y',
  'і': 'i', 'ѕ': 's', 'ј': 'j', 'һ': 'h', 'ԁ': 'd', 'ց': 'g', 'ᴏ': 'o',
  'ο': 'o', 'ρ': 'p', 'α': 'a', 'ν': 'v', 'κ': 'k', 'τ': 't', 'ι': 'i',
  'ɡ': 'g', 'ł': 'l', 'ᴜ': 'u', 'ѡ': 'w', 'ᖯ': 'b', 'ⅼ': 'l', 'ǀ': 'l',
}));

function scriptOf(ch) {
  if (NEUTRAL.test(ch)) return null;
  for (const [name, re] of SCRIPTS) {
    if (re.test(ch)) return name;
  }
  return null;
}

function analyseLabel(label) {
  const scripts = new Set();
  const confusables = [];

  for (const ch of label) {
    const script = scriptOf(ch);
    if (script) scripts.add(script);
    const looksLike = CONFUSABLE.get(ch);
    if (looksLike) {
      confusables.push({
        char: ch,
        codePoint: `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        script: script || 'unknown',
        looksLike,
      });
    }
  }

  return {
    label,
    scripts: [...scripts],
    // The signal: more than one writing system inside a single label.
    mixed: scripts.size > 1,
    confusables,
  };
}

// Both forms are reported because they are the whole point: the ASCII form is
// what the machine resolves and what a careful person can inspect; the Unicode
// form is what the person actually saw and was fooled by. Showing one without
// the other hides half of the attack.
function analyse(domain) {
  if (typeof domain !== 'string' || domain.trim() === '') {
    return { signal: false, reason: 'not-a-domain' };
  }

  const input = domain.trim().toLowerCase();
  const ascii = domainToASCII(input) || input;
  const unicode = domainToUnicode(ascii) || input;

  // xn-- is the marker that this name is not what it appears to be. Its
  // presence is not itself suspicious — plenty of legitimate names are
  // internationalised — but it is the precondition for this whole class.
  const isIdn = ascii.split('.').some((l) => l.startsWith('xn--'));

  const labels = unicode.split('.').map(analyseLabel);
  const mixedLabels = labels.filter((l) => l.mixed);
  const confusables = labels.flatMap((l) => l.confusables);

  return {
    ascii,
    unicode,
    isIdn,
    labels,
    signal: mixedLabels.length > 0,
    mixedLabels: mixedLabels.map((l) => l.label),
    scripts: [...new Set(labels.flatMap((l) => l.scripts))],
    confusables,
    // Confidence is about how sure we are the OBSERVATION is real, not about
    // how likely the domain is to be a scam. Nothing here decides that.
    confidence: mixedLabels.length > 0 && confusables.length > 0 ? 'high' : mixedLabels.length > 0 ? 'medium' : 'none',
  };
}

module.exports = { analyse, analyseLabel, scriptOf, CONFUSABLE, SCRIPTS };
