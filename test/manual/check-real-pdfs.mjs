// Manual validation of lib/pdf.js against real books, with `pdfinfo` (poppler)
// as the oracle. Not part of `npm test`: it needs the network and poppler.
//
//   node test/manual/check-real-pdfs.mjs
//
// The bar is not "always right" but "never wrong": a mismatch is a bug, while
// `ASK USER` is the designed fallback — the bot asks for the page count instead
// of inventing one.

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPageCount } from '../../tgcloud/lib/pdf.js';

const SOURCES = [
  // producer diversity matters more than count: each toolchain lays out the
  // page tree differently, and that is exactly what the probes key off.
  'https://arxiv.org/pdf/1706.03762',                        // pdfTeX, uncompressed tree
  'https://arxiv.org/pdf/2005.14165',                        // pdfTeX, 6.6 MB
  'https://greenteapress.com/thinkpython2/thinkpython2.pdf', // pdfTeX, tree inside object streams
  'https://web.stanford.edu/~boyd/cvxbook/bv_cvxbook.pdf',   // Ghostscript, 714 pages
  'https://www.irs.gov/pub/irs-pdf/f1040.pdf',               // Designer, linearized
  'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', // OpenOffice
];

const dir = mkdtempSync(join(tmpdir(), 'pdfcheck-'));
let matched = 0;
let wrong = 0;
let asked = 0;

for (const url of SOURCES) {
  const path = join(dir, `${Buffer.from(url).toString('hex').slice(-16)}.pdf`);
  let buf;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000) });
    buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, buf);
  } catch (e) {
    console.log(`  download failed, skipped: ${url} (${e.message})`);
    continue;
  }
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    console.log(`  not a PDF, skipped: ${url}`);
    continue;
  }

  let truth = null;
  let producer = '?';
  try {
    const info = execFileSync('pdfinfo', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    truth = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
    producer = (/^Producer:\s+(.*)$/m.exec(info)?.[1] ?? '?').trim();
  } catch {
    console.log('  pdfinfo unavailable — install poppler-utils for ground truth');
  }

  const started = process.hrtime.bigint();
  const got = detectPageCount(new Uint8Array(readFileSync(path)));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  let verdict;
  if (got.pages == null) { verdict = 'ASK USER'; asked++; }
  else if (got.pages === truth) { verdict = 'match'; matched++; }
  else { verdict = `MISMATCH (truth ${truth})`; wrong++; }

  console.log(
    `${(buf.length / 1024).toFixed(0).padStart(6)}KB  truth=${String(truth).padStart(4)}` +
    `  got=${String(got.pages).padStart(4)}  ${(got.method ?? got.reason) + '/' + got.confidence}`.padEnd(34) +
    `${ms.toFixed(0).padStart(4)}ms  ${verdict.padEnd(24)}${producer.slice(0, 40)}`
  );
}

console.log(`\nmatched ${matched}, wrong ${wrong}, asked the user ${asked}`);
process.exit(wrong === 0 ? 0 : 1);
