'use strict';

// A Bloom filter. No dependencies, no I/O — it is a bit array and some
// arithmetic, kept separate from the code that reads files so the property
// that matters can be tested on its own.
//
// THE PROPERTY: no false negatives. If add(x) was called, has(x) is true,
// always, for every x, forever. The filter may say true for something never
// added (a false positive), and it may never say false for something that was.
// The whole design below exists to make that asymmetry structural rather than
// probable — see the note above `has`.

const crypto = require('node:crypto');

const LN2 = Math.log(2);
const LN2_SQ = LN2 * LN2;

// Bits per entry and hash count for a target false-positive rate. These are
// the standard optimal-sizing formulas:
//
//   m = -n·ln(p) / (ln2)²      bits
//   k = (m/n)·ln2              hashes
//
// n is the number of entries and p the false-positive rate at that n. Both are
// derived, never guessed, so changing the rate changes the size honestly.
function optimalParams(n, p) {
  const entries = Math.max(1, Math.floor(n));
  const rate = Math.min(0.5, Math.max(1e-9, p));
  const bits = Math.ceil((-entries * Math.log(rate)) / LN2_SQ);
  const hashes = Math.max(1, Math.round((bits / entries) * LN2));
  return { bits, hashes, entries, rate };
}

// The false-positive rate a filter of this shape ACTUALLY has once it holds
// this many entries: (1 - e^(-kn/m))^k. Reported rather than assumed, because
// a filter loaded with more than it was sized for degrades quietly, and a
// number that is computed from the real load cannot flatter itself.
function actualRate(bits, hashes, entries) {
  if (entries <= 0) return 0;
  return Math.pow(1 - Math.exp((-hashes * entries) / bits), hashes);
}

class BloomFilter {
  constructor({ bits, hashes, buffer, entries }) {
    this.bits = bits;
    this.hashes = hashes;
    this.entries = entries || 0;
    const bytes = Math.ceil(bits / 8);
    if (buffer) {
      if (buffer.length !== bytes) {
        throw new Error(`buffer is ${buffer.length} bytes, expected ${bytes} for ${bits} bits`);
      }
      this.buffer = buffer;
    } else {
      this.buffer = Buffer.alloc(bytes);
    }
  }

  static sized(n, p) {
    const { bits, hashes } = optimalParams(n, p);
    return new BloomFilter({ bits, hashes });
  }

  // k indices from ONE hash, by the Kirsch–Mitzenmacher trick: two independent
  // 32-bit values h1 and h2 taken from a single SHA-1 digest give the whole
  // family via h1 + i·h2. Computing k separate digests would cost k times as
  // much for no measurable gain in distribution.
  //
  // SHA-1 is used as a hash function, not as a signature. Its collision
  // weakness is irrelevant here: an attacker who forges a collision gains the
  // ability to make a domain look SUSPICIOUS, which is the harmless direction.
  _indices(key) {
    const d = crypto.createHash('sha1').update(key, 'utf8').digest();
    const h1 = d.readUInt32BE(0);
    const h2 = d.readUInt32BE(4) | 1; // odd, so it strides the whole array
    const out = new Array(this.hashes);
    for (let i = 0; i < this.hashes; i++) {
      // >>> 0 keeps it unsigned after the multiply wraps past 2^31.
      out[i] = ((h1 + Math.imul(i, h2)) >>> 0) % this.bits;
    }
    return out;
  }

  add(key) {
    const idx = this._indices(key);
    for (let i = 0; i < idx.length; i++) {
      const bit = idx[i];
      this.buffer[bit >>> 3] |= 1 << (bit & 7);
    }
    this.entries += 1;
    return this;
  }

  // Bits are only ever SET, never cleared. So every bit a key set when it was
  // added is still set now — nothing that was added can fail this test, and
  // that is why there are no false negatives. A `false` here means at least
  // one of this key's bits was never set by anything, which is proof the key
  // was never added. A `true` means all of them are set, which is consistent
  // with having been added but also with k other keys having set them between
  // them. Hence: absent is certain, present is probable.
  has(key) {
    const idx = this._indices(key);
    for (let i = 0; i < idx.length; i++) {
      const bit = idx[i];
      if ((this.buffer[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }

  falsePositiveRate() {
    return actualRate(this.bits, this.hashes, this.entries);
  }

  // 16-byte header then the bit array, so a filter on disk carries the shape
  // it was built with. Loading one with the wrong k or m would silently return
  // wrong answers, so the parameters travel with the bits rather than being
  // re-derived from a count that may have moved on.
  serialize() {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(0x424c4d31, 0); // "BLM1"
    header.writeUInt32BE(this.bits, 4);
    header.writeUInt32BE(this.hashes, 8);
    header.writeUInt32BE(this.entries, 12);
    return Buffer.concat([header, this.buffer]);
  }

  static deserialize(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16) throw new Error('not a filter: too short');
    if (buf.readUInt32BE(0) !== 0x424c4d31) throw new Error('not a filter: bad magic');
    const bits = buf.readUInt32BE(4);
    const hashes = buf.readUInt32BE(8);
    const entries = buf.readUInt32BE(12);
    return new BloomFilter({ bits, hashes, entries, buffer: buf.subarray(16) });
  }
}

module.exports = { BloomFilter, optimalParams, actualRate };
