import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflate, inflateRaw, hasZlibHeader } from '../tgcloud/lib/inflate.js';

// Node's zlib is the oracle: whatever it compresses, our decoder must restore
// byte for byte. (zlib exists in tests only — never at runtime on the platform.)
const roundTrip = (buf, opts) => {
  const deflated = new Uint8Array(zlib.deflateSync(Buffer.from(buf), opts));
  return inflate(deflated);
};

test('round-trips text', () => {
  const src = new TextEncoder().encode('<< /Type /Pages /Count 244 /Kids [3 0 R] >>');
  assert.deepEqual(roundTrip(src), src);
});

test('round-trips highly repetitive data (long matches)', () => {
  const src = new TextEncoder().encode('/Type /Page /Parent 2 0 R\n'.repeat(5000));
  assert.deepEqual(roundTrip(src), src);
});

test('round-trips incompressible data (stored blocks)', () => {
  const src = new Uint8Array(70000);
  let seed = 12345;
  for (let i = 0; i < src.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    src[i] = seed & 0xff;
  }
  assert.deepEqual(roundTrip(src, { level: 0 }), src); // level 0 = stored blocks
  assert.deepEqual(roundTrip(src), src);
});

test('round-trips at every compression level', () => {
  const src = new TextEncoder().encode(
    Array.from({ length: 2000 }, (_, i) => `${i} 0 obj << /Length ${i * 7} >> endobj\n`).join('')
  );
  for (let level = 0; level <= 9; level++) {
    assert.deepEqual(roundTrip(src, { level }), src, `level ${level}`);
  }
});

test('round-trips an empty payload and a single byte', () => {
  assert.deepEqual(roundTrip(new Uint8Array(0)), new Uint8Array(0));
  assert.deepEqual(roundTrip(new Uint8Array([65])), new Uint8Array([65]));
});

test('handles raw deflate without a zlib wrapper', () => {
  const src = new TextEncoder().encode('raw deflate stream, no header');
  const raw = new Uint8Array(zlib.deflateRawSync(Buffer.from(src)));
  assert.equal(hasZlibHeader(raw), false);
  assert.deepEqual(inflateRaw(raw), src);
  assert.deepEqual(inflate(raw), src);
});

test('detects the zlib header', () => {
  assert.equal(hasZlibHeader(new Uint8Array(zlib.deflateSync(Buffer.from('x')))), true);
  assert.equal(hasZlibHeader(new Uint8Array([0, 0])), false);
  assert.equal(hasZlibHeader(new Uint8Array([])), false);
});

test('large payloads survive (1 MB of structure)', () => {
  const src = new TextEncoder().encode(
    Array.from({ length: 20000 }, (_, i) => `<< /Type /Page /MediaBox [0 0 612 792] /N ${i} >>\n`).join('')
  );
  assert.ok(src.length > 1_000_000);
  const got = roundTrip(src);
  assert.equal(got.length, src.length);
  assert.deepEqual(got, src);
});

test('refuses to be a decompression bomb', () => {
  const src = new Uint8Array(1_000_000); // a megabyte of zeros compresses to nothing
  const deflated = new Uint8Array(zlib.deflateSync(Buffer.from(src)));
  assert.throws(() => inflate(deflated, 1000), /output limit/);
});

test('rejects garbage instead of looping', () => {
  const junk = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x01, 0x02, 0x03]);
  assert.throws(() => inflateRaw(junk));
});
