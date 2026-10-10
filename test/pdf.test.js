import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { detectPageCount, looksLikePdf } from '../tgcloud/lib/pdf.js';

/** Latin-1 string → bytes, the way a PDF's structural part really looks. */
const bytes = (s) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0) & 0xff));

const CLASSIC = bytes(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
5 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`);

test('page tree /Count corroborated by page objects is high confidence', () => {
  const r = detectPageCount(CLASSIC);
  assert.deepEqual(r, { pages: 3, method: 'page_tree', confidence: 'high' });
});

test('no whitespace between names still parses', () => {
  const r = detectPageCount(bytes('%PDF-1.4\n2 0 obj\n<</Type/Pages/Count 7/Kids[]>>\nendobj\n%%EOF'));
  assert.equal(r.pages, 7);
  assert.equal(r.method, 'page_tree');
});

test('a missing /Count falls back to counting page objects', () => {
  const r = detectPageCount(bytes(`%PDF-1.3
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R] >>
endobj
3 0 obj
<< /Type /Page >>
endobj
4 0 obj
<< /Type /Page >>
endobj
%%EOF`));
  assert.deepEqual(r, { pages: 2, method: 'page_objects', confidence: 'medium' });
});

test('a nested page tree reports the root count, not a node count', () => {
  const r = detectPageCount(bytes(`%PDF-1.4
2 0 obj
<< /Type /Pages /Count 10 /Kids [6 0 R 7 0 R] >>
endobj
6 0 obj
<< /Type /Pages /Parent 2 0 R /Count 5 >>
endobj
7 0 obj
<< /Type /Pages /Parent 2 0 R /Count 5 >>
endobj
%%EOF`));
  assert.equal(r.pages, 10);
  assert.equal(r.method, 'page_tree');
});

test('/Count on an outline and /PageLabels do not inflate the count', () => {
  const r = detectPageCount(bytes(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R /PageLabels 9 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>
endobj
3 0 obj
<< /Type /Page >>
endobj
4 0 obj
<< /Type /Page >>
endobj
9 0 obj
<< /Type /Outlines /Count 17 /First 10 0 R >>
endobj
%%EOF`));
  assert.deepEqual(r, { pages: 2, method: 'page_tree', confidence: 'high' });
});

test('a linearized file with compressed objects is read from /N', () => {
  // This is the realistic modern case: the page tree lives inside a Flate
  // stream we cannot inflate, but the linearization dictionary is in the clear.
  const r = detectPageCount(bytes(`%PDF-1.7
1 0 obj
<< /Linearized 1 /L 918273 /O 4 /E 5123 /N 250 /T 918000 /H [ 600 200 ] >>
endobj
5 0 obj
<< /Type /ObjStm /N 40 /First 210 /Filter /FlateDecode /Length 1200 >>
stream
\x78\x9c\x01\x02\x03binary-garbage
endstream
endobj
%%EOF`));
  assert.deepEqual(r, { pages: 250, method: 'linearized', confidence: 'high' });
});

test('compressed objects with no linearization dictionary are admitted as unknown', () => {
  const r = detectPageCount(bytes(`%PDF-1.5
3 0 obj
<< /Type /ObjStm /N 12 /First 50 /Length 60 /Filter /FlateDecode >>
stream
\x78\x9cgarbage
endstream
endobj
%%EOF`));
  assert.equal(r.pages, null);
  assert.equal(r.confidence, 'none');
  assert.equal(r.reason, 'compressed_objects');
});

test('non-PDF input is rejected outright', () => {
  assert.equal(looksLikePdf(CLASSIC), true);
  assert.equal(looksLikePdf(bytes('PK\x03\x04 this is a zip')), false);
  const r = detectPageCount(bytes('PK\x03\x04 this is a zip'));
  assert.equal(r.pages, null);
  assert.equal(r.reason, 'not_pdf');
  assert.equal(detectPageCount(new Uint8Array(0)).reason, 'not_pdf');
  assert.equal(detectPageCount(null).reason, 'not_pdf');
});

test('absurd counts are ignored rather than trusted', () => {
  const r = detectPageCount(bytes('%PDF-1.4\n2 0 obj\n<< /Type /Pages /Count 999999 >>\nendobj\n%%EOF'));
  assert.equal(r.pages, null);
});

test('a realistic 400-page file is detected quickly', () => {
  let src = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  src += '2 0 obj\n<< /Type /Pages /Count 400 /Kids [' +
    Array.from({ length: 400 }, (_, i) => `${i + 3} 0 R`).join(' ') + '] >>\nendobj\n';
  for (let i = 0; i < 400; i++) {
    src += `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${1000 + i} 0 R >>\nendobj\n`;
    src += `${1000 + i} 0 obj\n<< /Length 400 >>\nstream\n${'x'.repeat(400)}\nendstream\nendobj\n`;
  }
  src += '%%EOF';
  const buf = bytes(src);
  const started = Date.now();
  const r = detectPageCount(buf);
  const ms = Date.now() - started;
  assert.deepEqual(r, { pages: 400, method: 'page_tree', confidence: 'high' });
  assert.ok(ms < 1500, `detection took ${ms}ms on ${(buf.length / 1024).toFixed(0)}KB`);
});

test('the page tree is found inside a compressed object stream', () => {
  // The modern default: pdfTeX/InDesign/Word hide the page tree in a Flate
  // stream, so the count is invisible until inflated. (zlib is used here only
  // to *build* the fixture; the detector inflates it with our own decoder.)
  const objstm = Buffer.from(
    '4 0 61 0 63 0\n' +
    '<< /Type /Catalog /Pages 5 0 R >>' +
    '<< /Type /Pages /Count 244 /Kids [7 0 R 8 0 R] >>' +
    '<< /Type /Outlines /Count 31 >>',
    'latin1'
  );
  const deflated = zlib.deflateSync(objstm);
  const head = Buffer.from(
    '%PDF-1.5\n' +
    '3 0 obj\n' +
    `<< /Type /ObjStm /N 3 /First 14 /Filter /FlateDecode /Length ${deflated.length} >>\n` +
    'stream\n',
    'latin1'
  );
  const tail = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1');
  const r = detectPageCount(new Uint8Array(Buffer.concat([head, deflated, tail])));
  assert.deepEqual(r, { pages: 244, method: 'object_stream', confidence: 'medium' });
});

test('an indirect /Length still yields the stream', () => {
  const objstm = Buffer.from('<< /Type /Pages /Count 12 >>', 'latin1');
  const deflated = zlib.deflateSync(objstm);
  const buf = Buffer.concat([
    Buffer.from('%PDF-1.5\n3 0 obj\n<< /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode /Length 9 0 R >>\nstream\n', 'latin1'),
    deflated,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
  assert.equal(detectPageCount(new Uint8Array(buf)).pages, 12);
});

test('an encrypted or predictor-encoded stream is skipped, not guessed at', () => {
  const buf = Buffer.concat([
    Buffer.from('%PDF-1.5\n3 0 obj\n<< /Type /ObjStm /N 5 /First 20 /Filter /FlateDecode /Length 24 >>\nstream\n', 'latin1'),
    Buffer.from([0x78, 0x9c, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01, 0x02]),
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
  const r = detectPageCount(new Uint8Array(buf));
  assert.equal(r.pages, null);
  assert.equal(r.reason, 'compressed_objects');
});
