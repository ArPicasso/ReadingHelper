// Page-count detection straight from PDF bytes.
//
// The runtime has no npm packages and no Node Buffer, so this is a deliberately
// small byte-level scanner rather than a PDF parser, paired with our own
// DEFLATE decoder (lib/inflate.js) for the compressed parts. It reads what it
// can and *admits when it cannot tell* — a wrong page count would poison every
// percentage and ETA the bot ever shows, so an honest "ask the user" is the
// better failure.
//
// Four probes, best first:
//   1. /Count in the page-tree root (/Type /Pages) — authoritative when visible.
//   2. /N in the linearization dictionary — present in most web-optimized files.
//   3. The same /Count inside inflated object streams — the modern default
//      (pdfTeX, InDesign, Word all hide the page tree in a Flate stream).
//   4. Counting /Type /Page objects — the last resort, exact when the file is
//      uncompressed and not incremental.
//
// Validated against real books (pdfTeX, Ghostscript, OpenOffice, Designer) with
// pdfinfo as the oracle; see test/pdf.test.js for the cases this guarantees.

import { inflate } from './inflate.js';

const MAX_SANE_PAGES = 30000;
// Budget for probe 3. Pure-JS inflate is fast but not free, and a handler has a
// person waiting on the other end. Object streams only ever hold non-stream
// objects, so they are small and numerous — a real 250-page book keeps its page
// tree in the 43rd of 47 streams, which is why the cap is on total inflated
// bytes rather than on a handful of streams.
const MAX_STREAMS = 512;
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

function isWs(c) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** True when `needle` (ASCII) sits at `at`. */
function matchAt(bytes, at, needle) {
  if (at < 0 || at + needle.length > bytes.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (bytes[at + i] !== needle.charCodeAt(i)) return false;
  }
  return true;
}

function indexOfBytes(bytes, needle, from = 0, until = bytes.length) {
  const first = needle.charCodeAt(0);
  const last = Math.min(until, bytes.length) - needle.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (bytes[i] !== first) continue;
    if (matchAt(bytes, i, needle)) return i;
  }
  return -1;
}

/** Skip whitespace, then read a non-negative integer. */
function readIntAfter(bytes, at, until = bytes.length) {
  let i = at;
  while (i < until && isWs(bytes[i])) i++;
  if (i >= until || !isDigit(bytes[i])) return null;
  let v = 0;
  let seen = 0;
  while (i < until && isDigit(bytes[i]) && seen < 9) {
    v = v * 10 + (bytes[i] - 48);
    i++;
    seen++;
  }
  return { value: v, end: i };
}

/** Index just after `/Name`, allowing `/Type/Pages` and `/Type  /Pages`. */
function matchNameAfter(bytes, at, name, until = bytes.length) {
  let i = at;
  while (i < until && isWs(bytes[i])) i++;
  return matchAt(bytes, i, name) ? i + name.length : -1;
}

const LT = 0x3c; // '<'
const GT = 0x3e; // '>'

/**
 * The `<< … >>` dictionary containing `pos`, nesting-aware. Dictionary bounds
 * (rather than `obj … endobj` bounds) are what make the same scan work both in
 * the file body and inside an inflated object stream, where objects carry no
 * `obj` keyword at all.
 */
function enclosingDict(bytes, pos) {
  let depth = 0;
  let start = -1;
  for (let i = pos - 1; i >= 1; i--) {
    if (bytes[i] === GT && bytes[i - 1] === GT) {
      depth++;
      i--;
    } else if (bytes[i] === LT && bytes[i - 1] === LT) {
      if (depth === 0) {
        start = i - 1;
        break;
      }
      depth--;
      i--;
    }
  }
  if (start === -1) return null;

  depth = 0;
  for (let i = pos; i < bytes.length - 1; i++) {
    if (bytes[i] === LT && bytes[i + 1] === LT) {
      depth++;
      i++;
    } else if (bytes[i] === GT && bytes[i + 1] === GT) {
      if (depth === 0) return { start, end: i + 2 };
      depth--;
      i++;
    }
  }
  return { start, end: bytes.length };
}

export function looksLikePdf(bytes) {
  return !!bytes && bytes.length > 4 && matchAt(bytes, 0, '%PDF-');
}

/** Largest /Count among page-tree nodes — that is the root of the tree. */
function countFromPageTree(bytes) {
  let best = null;
  let at = 0;
  for (;;) {
    const typeAt = indexOfBytes(bytes, '/Type', at);
    if (typeAt === -1) break;
    at = typeAt + 5;

    const after = matchNameAfter(bytes, at, '/Pages');
    if (after === -1 || isAlpha(bytes[after])) continue; // '/Pages', not '/PagesFoo'

    const dict = enclosingDict(bytes, typeAt);
    if (!dict) continue;
    const countAt = indexOfBytes(bytes, '/Count', dict.start, dict.end);
    if (countAt === -1) continue;
    const n = readIntAfter(bytes, countAt + 6, dict.end);
    if (!n || n.value < 1 || n.value > MAX_SANE_PAGES) continue;
    if (best === null || n.value > best) best = n.value;
  }
  return best;
}

/** /N in the linearization dictionary is the page count of the whole document. */
function countFromLinearized(bytes) {
  const lin = indexOfBytes(bytes, '/Linearized', 0, Math.min(bytes.length, 4096));
  if (lin === -1) return null;
  const dict = enclosingDict(bytes, lin);
  if (!dict) return null;
  let at = lin;
  for (;;) {
    const nAt = indexOfBytes(bytes, '/N', at, dict.end);
    if (nAt === -1) return null;
    at = nAt + 2;
    if (isAlpha(bytes[nAt + 2])) continue; // /Names, /Numbered…
    const n = readIntAfter(bytes, nAt + 2, dict.end);
    if (n && n.value >= 1 && n.value <= MAX_SANE_PAGES) return n.value;
  }
}

/** Count `/Type /Page` objects (excluding `/Pages`). */
function countPageObjects(bytes) {
  let n = 0;
  let at = 0;
  for (;;) {
    const typeAt = indexOfBytes(bytes, '/Type', at);
    if (typeAt === -1) break;
    at = typeAt + 5;
    const after = matchNameAfter(bytes, at, '/Page');
    if (after === -1) continue;
    if (isAlpha(bytes[after]) || isDigit(bytes[after])) continue; // /Pages, /PageLabels…
    n++;
  }
  return n > 0 && n <= MAX_SANE_PAGES ? n : null;
}

/** The raw bytes between `stream` and `endstream` for the dict at [start,end). */
function streamSpan(bytes, dictStart, dictEnd) {
  const kw = indexOfBytes(bytes, 'stream', dictEnd);
  if (kw === -1) return null;
  let s = kw + 6;
  if (bytes[s] === 13) s++; // CR
  if (bytes[s] === 10) s++; // LF

  // A direct /Length is exact; an indirect one (`/Length 12 0 R`) is not
  // resolvable without the xref, so fall back to locating `endstream`.
  const lenAt = indexOfBytes(bytes, '/Length', dictStart, dictEnd);
  if (lenAt !== -1) {
    const n = readIntAfter(bytes, lenAt + 7, dictEnd);
    if (n && n.value > 0 && s + n.value <= bytes.length) {
      let probe = s + n.value;
      while (probe < bytes.length && isWs(bytes[probe])) probe++;
      if (matchAt(bytes, probe, 'endstream')) return { start: s, end: s + n.value };
    }
  }

  const end = indexOfBytes(bytes, 'endstream', s);
  if (end === -1) return null;
  let e = end;
  while (e > s && isWs(bytes[e - 1])) e--;
  return { start: s, end: e };
}

/** Inflate object streams and look for the page tree inside them. */
function countFromObjectStreams(bytes) {
  let best = null;
  let streams = 0;
  let budget = MAX_INFLATED_BYTES;
  let at = 0;

  for (;;) {
    const hit = indexOfBytes(bytes, '/ObjStm', at);
    if (hit === -1) break;
    at = hit + 7;
    if (streams >= MAX_STREAMS || budget <= 0) break;

    const dict = enclosingDict(bytes, hit);
    if (!dict) continue;
    const span = streamSpan(bytes, dict.start, dict.end);
    if (!span || span.end <= span.start) continue;
    if (span.end - span.start > MAX_STREAM_BYTES) continue;

    streams++;
    let data;
    try {
      data = inflate(bytes.subarray(span.start, span.end), budget);
    } catch {
      continue; // encrypted, predictor-encoded or simply not Flate — skip it
    }
    budget -= data.length;

    const n = countFromPageTree(data);
    if (n != null && (best === null || n > best)) best = n;
  }
  return best;
}

/**
 * @returns {{pages: number|null, method: string|null,
 *            confidence: 'high'|'medium'|'low'|'none', reason?: string}}
 */
export function detectPageCount(bytes) {
  if (!looksLikePdf(bytes)) {
    return { pages: null, method: null, confidence: 'none', reason: 'not_pdf' };
  }

  const tree = countFromPageTree(bytes);
  const linear = countFromLinearized(bytes);
  const objects = countPageObjects(bytes);

  if (tree != null) {
    // Two independent probes agreeing is as sure as this gets.
    const corroborated = tree === linear || tree === objects;
    return { pages: tree, method: 'page_tree', confidence: corroborated ? 'high' : 'medium' };
  }
  if (linear != null) return { pages: linear, method: 'linearized', confidence: 'high' };

  const compressed = indexOfBytes(bytes, '/ObjStm') !== -1;
  if (compressed) {
    const inStream = countFromObjectStreams(bytes);
    if (inStream != null) {
      return {
        pages: inStream,
        method: 'object_stream',
        confidence: inStream === objects ? 'high' : 'medium',
      };
    }
  }

  if (objects != null) return { pages: objects, method: 'page_objects', confidence: 'medium' };

  return {
    pages: null,
    method: null,
    confidence: 'none',
    reason: compressed ? 'compressed_objects' : 'unrecognized',
  };
}
