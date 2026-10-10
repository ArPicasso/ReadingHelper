// The library. Books are rows; the PDF itself never leaves Telegram's storage —
// we keep its file_id, which is enough to send the book back to any device of
// the user's, for free, forever.

import { db } from 'sdk';
import { and, desc, eq, inArray, sql } from 'sdk/db';
import { books, sessions, users } from '../schema.js';

export const READING = 'reading';
export const QUEUED = 'queued';
export const FINISHED = 'finished';
export const DROPPED = 'dropped';

export async function getBook(userId, bookId) {
  return db
    .select()
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.userId, userId)))
    .get();
}

export async function getActiveBook(user) {
  if (!user.activeBookId) return null;
  const book = await getBook(user.id, user.activeBookId);
  // The pointer can outlive the row (a dropped book, a deleted one); heal it.
  if (!book) {
    await db.update(users).set({ activeBookId: null }).where(eq(users.id, user.id));
    return null;
  }
  return book;
}

export async function listBooks(userId, statuses = [READING, QUEUED]) {
  return db
    .select()
    .from(books)
    .where(and(eq(books.userId, userId), inArray(books.status, statuses)))
    .orderBy(desc(books.lastProgressAt), desc(books.createdAt))
    .all();
}

export async function findByFileUniqueId(userId, fileUniqueId) {
  if (!fileUniqueId) return null;
  return db
    .select()
    .from(books)
    .where(and(eq(books.userId, userId), eq(books.fileUniqueId, fileUniqueId)))
    .get();
}

export async function createBook(userId, fields) {
  const [created] = await db
    .insert(books)
    .values({ userId, status: READING, currentPage: 0, ...fields })
    .returning();
  return created;
}

export async function updateBook(bookId, fields) {
  await db.update(books).set(fields).where(eq(books.id, bookId));
}

export async function setActiveBook(userId, bookId) {
  await db.update(users).set({ activeBookId: bookId }).where(eq(users.id, userId));
}

/**
 * Mark a book finished. Anything that is left of it is still a real position,
 * so the current page is snapped to the end for honest statistics.
 */
export async function finishBook(user, book) {
  await updateBook(book.id, {
    status: FINISHED,
    finishedAt: new Date(),
    currentPage: book.totalPages ?? book.currentPage,
  });
  if (user.activeBookId === book.id) await pickNextActive(user, book.id);
}

export async function setBookStatus(user, book, status) {
  await updateBook(book.id, { status });
  if (status !== READING && user.activeBookId === book.id) await pickNextActive(user, book.id);
}

/** After a book leaves the rotation, promote the most recently touched one. */
async function pickNextActive(user, excludeId) {
  const rest = (await listBooks(user.id)).filter((b) => b.id !== excludeId);
  await setActiveBook(user.id, rest.length ? rest[0].id : null);
  return rest[0] ?? null;
}

/** Per-book totals, used by the finish card and the Mini App. */
export async function bookStats(bookId) {
  const row = await db
    .select({
      pages: sql`coalesce(sum(${sessions.pages}), 0)`,
      minutes: sql`coalesce(sum(${sessions.minutes}), 0)`,
      days: sql`count(distinct ${sessions.day})`,
      sessionCount: sql`count(*)`,
    })
    .from(sessions)
    .where(eq(sessions.bookId, bookId))
    .get();
  return {
    pages: Number(row?.pages ?? 0),
    minutes: Number(row?.minutes ?? 0),
    days: Number(row?.days ?? 0),
    sessions: Number(row?.sessionCount ?? 0),
  };
}

/** Books finished in a calendar year — the year goal's numerator. */
export async function finishedInYear(userId, year) {
  const rows = await db
    .select()
    .from(books)
    .where(and(eq(books.userId, userId), eq(books.status, FINISHED)))
    .all();
  return rows.filter((b) => b.finishedAt && new Date(b.finishedAt).getUTCFullYear() === year);
}

/**
 * Books in the rotation that have gone quiet: the input for the quarantine
 * prompt, which exists so that abandoned books stop generating guilt.
 */
export async function staleBooks(userId, now, idleDays, askCooldownDays = 14) {
  const cutoff = now - idleDays * 86400000;
  const askCutoff = now - askCooldownDays * 86400000;
  const rows = await listBooks(userId, [READING]);
  return rows.filter((b) => {
    const touched = new Date(b.lastProgressAt ?? b.createdAt ?? now).getTime();
    if (touched > cutoff) return false;
    if (b.quarantineAskedAt && new Date(b.quarantineAskedAt).getTime() > askCutoff) return false;
    return true;
  });
}
