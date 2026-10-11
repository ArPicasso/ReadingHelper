// Test harness: a fresh in-memory database, a recording Bot API, and a frozen
// clock, so a flow test can drive the real handlers and then inspect both what
// the user was told and what was written down.

import { __createTables, __reset as resetDb } from 'sdk/db';
import { __reset as resetApi, __calls, __setFileContent, __texts } from 'sdk/api';
import { db } from 'sdk';
import { eq } from 'sdk/db';
import * as schema from '../../tgcloud/schema.js';

export const TG_ID = 4242;
export const CHAT_ID = 4242;

/** Reset everything. `now` is UTC; the default user sits in UTC+3. */
export function setup({ now = '2026-10-10T18:00:00Z' } = {}) {
  resetDb();
  resetApi();
  __createTables(Object.values(schema).filter((t) => t && t.$columns));
  freeze(now);
}

const RealDate = globalThis.Date;

/**
 * Freeze the clock. Both `Date.now()` and `new Date()` have to move together:
 * the bot reads "today" from one and writes timestamps with the other.
 */
export function freeze(iso) {
  const fixed = new RealDate(iso).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  }
  globalThis.Date = FrozenDate;
}

export function unfreeze() {
  globalThis.Date = RealDate;
}

export const message = (text, extra = {}) => ({
  message_id: 1,
  from: { id: TG_ID, is_bot: false, first_name: 'Паша' },
  chat: { id: CHAT_ID, type: 'private' },
  date: Math.floor(Date.now() / 1000),
  text,
  ...extra,
});

export const document = (doc, extra = {}) => message(undefined, {
  text: undefined,
  document: {
    file_id: 'FILE_1',
    file_unique_id: 'UNIQ_1',
    file_name: 'book.pdf',
    mime_type: 'application/pdf',
    file_size: 1024,
    ...doc,
  },
  ...extra,
});

export const callback = (data, extra = {}) => ({
  id: 'cb-1',
  from: { id: TG_ID, is_bot: false, first_name: 'Паша' },
  message: { message_id: 10, chat: { id: CHAT_ID, type: 'private' }, date: 0 },
  data,
  ...extra,
});

export { __calls as calls, __texts as texts, __setFileContent as setFileContent };

export const lastText = () => {
  const all = __texts();
  return all[all.length - 1] ?? '';
};

export const allText = () => __texts().join('\n---\n');

export async function user() {
  return db.select().from(schema.users).where(eq(schema.users.tgId, TG_ID)).get();
}

export async function books() {
  return db.select().from(schema.books).all();
}

export async function activeBook() {
  const u = await user();
  if (!u?.activeBookId) return null;
  return db.select().from(schema.books).where(eq(schema.books.id, u.activeBookId)).get();
}

export async function sessions() {
  return db.select().from(schema.sessions).all();
}

export async function quotes() {
  return db.select().from(schema.quotes).all();
}

export async function contracts() {
  return db.select().from(schema.contracts).all();
}

/**
 * A PDF whose page tree says `pages` and which really carries that many page
 * objects — the shape of an ordinary file, where detection is high-confidence.
 */
export function pdfWithPages(pages) {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  let src = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  src += `2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [${kids}] >>\nendobj\n`;
  for (let i = 0; i < pages; i++) {
    src += `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`;
  }
  src += 'trailer\n<< /Root 1 0 R >>\n%%EOF';
  return new Uint8Array(Array.from(src, (c) => c.charCodeAt(0) & 0xff));
}

/** A PDF that only claims a count — detection works but stays unconfirmed. */
export function pdfWithUncorroboratedPages(pages) {
  const src = `%PDF-1.4\n2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n%%EOF`;
  return new Uint8Array(Array.from(src, (c) => c.charCodeAt(0) & 0xff));
}
