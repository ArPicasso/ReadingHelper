// A raw DEFLATE (RFC 1951) decoder in plain JavaScript.
//
// Why this exists: PDFs built by modern toolchains (pdfTeX, InDesign, Word)
// keep their page tree inside Flate-compressed object streams, so the page
// count is simply not visible in the file's bytes. The runtime has no zlib and
// no npm packages, so without this the bot would have to ask the user for the
// page count of roughly every second book.
//
// The implementation is the classic canonical-Huffman decoder (counts + sorted
// symbols), which is small enough to audit and fast enough for the few hundred
// kilobytes of a PDF's object streams.
//
// This module imports nothing — it is covered by test/inflate.test.js.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Hitting the output cap is a policy decision, not a corrupt stream. */
export class InflateLimitError extends Error {}

/** Canonical Huffman table: how many codes per length, and symbols in code order. */
function buildTree(lengths, offset, count) {
  const counts = new Int32Array(16);
  const symbols = new Int32Array(count);
  for (let i = 0; i < count; i++) counts[lengths[offset + i]]++;
  counts[0] = 0;
  const offs = new Int32Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < count; i++) {
    const len = lengths[offset + i];
    if (len) symbols[offs[len]++] = i;
  }
  return { counts, symbols };
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  return buildTree(l, 0, 288);
})();

const FIXED_DIST = buildTree(new Uint8Array(30).fill(5), 0, 30);

class Reader {
  constructor(data, start) {
    this.data = data;
    this.pos = start;
    this.tag = 0;
    this.bitcount = 0;
  }

  bit() {
    if (this.bitcount-- === 0) {
      if (this.pos >= this.data.length) throw new Error('inflate: out of input');
      this.tag = this.data[this.pos++];
      this.bitcount = 7;
    }
    const b = this.tag & 1;
    this.tag >>>= 1;
    return b;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v;
  }

  symbol(tree) {
    let sum = 0;
    let cur = 0;
    let len = 0;
    do {
      cur = 2 * cur + this.bit();
      if (++len >= 16) throw new Error('inflate: bad code');
      sum += tree.counts[len];
      cur -= tree.counts[len];
    } while (cur >= 0);
    const sym = tree.symbols[sum + cur];
    if (sym === undefined) throw new Error('inflate: bad symbol');
    return sym;
  }
}

class Out {
  constructor(limit) {
    this.buf = new Uint8Array(Math.min(limit, 1 << 16));
    this.len = 0;
    this.limit = limit;
  }

  need(n) {
    if (this.len + n <= this.buf.length) return;
    if (this.len + n > this.limit) throw new InflateLimitError('inflate: output limit exceeded');
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(Math.min(size, this.limit));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  push(b) {
    this.need(1);
    this.buf[this.len++] = b;
  }

  copy(dist, length) {
    if (dist > this.len) throw new Error('inflate: bad distance');
    this.need(length);
    let from = this.len - dist;
    for (let i = 0; i < length; i++) this.buf[this.len++] = this.buf[from++];
  }

  done() {
    return this.buf.subarray(0, this.len);
  }
}

function inflateBlockData(r, out, lit, dist) {
  for (;;) {
    const sym = r.symbol(lit);
    if (sym === 256) return;
    if (sym < 256) {
      out.push(sym);
      continue;
    }
    const li = sym - 257;
    if (li >= LENGTH_BASE.length) throw new Error('inflate: bad length symbol');
    const length = LENGTH_BASE[li] + r.bits(LENGTH_EXTRA[li]);
    const ds = r.symbol(dist);
    if (ds >= DIST_BASE.length) throw new Error('inflate: bad distance symbol');
    out.copy(DIST_BASE[ds] + r.bits(DIST_EXTRA[ds]), length);
  }
}

function inflateDynamicTrees(r) {
  const hlit = r.bits(5) + 257;
  const hdist = r.bits(5) + 1;
  const hclen = r.bits(4) + 4;

  const clens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = r.bits(3);
  const clTree = buildTree(clens, 0, 19);

  const lengths = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < lengths.length) {
    const sym = r.symbol(clTree);
    if (sym === 16) {
      const prev = i === 0 ? 0 : lengths[i - 1];
      for (let n = 3 + r.bits(2); n > 0 && i < lengths.length; n--) lengths[i++] = prev;
    } else if (sym === 17) {
      for (let n = 3 + r.bits(3); n > 0 && i < lengths.length; n--) lengths[i++] = 0;
    } else if (sym === 18) {
      for (let n = 11 + r.bits(7); n > 0 && i < lengths.length; n--) lengths[i++] = 0;
    } else {
      lengths[i++] = sym;
    }
  }

  return {
    lit: buildTree(lengths, 0, hlit),
    dist: buildTree(lengths, hlit, hdist),
  };
}

function inflateStored(r, out) {
  r.bitcount = 0; // stored blocks are byte-aligned
  const len = r.data[r.pos] | (r.data[r.pos + 1] << 8);
  r.pos += 4; // LEN + NLEN
  if (r.pos + len > r.data.length) throw new Error('inflate: truncated stored block');
  out.need(len);
  for (let i = 0; i < len; i++) out.push(r.data[r.pos++]);
}

/**
 * Decompress a raw DEFLATE stream.
 * @param {Uint8Array} data
 * @param {number} limit  maximum output bytes (guards against decompression bombs)
 */
export function inflateRaw(data, limit = 32 * 1024 * 1024) {
  const r = new Reader(data, 0);
  const out = new Out(limit);
  for (;;) {
    const last = r.bit();
    const type = r.bits(2);
    if (type === 0) inflateStored(r, out);
    else if (type === 1) inflateBlockData(r, out, FIXED_LIT, FIXED_DIST);
    else if (type === 2) {
      const { lit, dist } = inflateDynamicTrees(r);
      inflateBlockData(r, out, lit, dist);
    } else throw new Error('inflate: reserved block type');
    if (last) break;
  }
  return out.done();
}

/** True when the bytes start with a zlib (RFC 1950) header. */
export function hasZlibHeader(data) {
  if (!data || data.length < 2) return false;
  const cmf = data[0];
  const flg = data[1];
  return (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
}

/** Decompress zlib-wrapped or raw DEFLATE data, whichever it turns out to be. */
export function inflate(data, limit) {
  if (hasZlibHeader(data)) {
    const body = data.subarray(2);
    try {
      return inflateRaw(body, limit);
    } catch (e) {
      // A capped stream is not a malformed one — never retry past the cap.
      if (e instanceof InflateLimitError) throw e;
      // A few writers emit a bogus header; fall through to a raw attempt.
      return inflateRaw(data, limit);
    }
  }
  return inflateRaw(data, limit);
}
