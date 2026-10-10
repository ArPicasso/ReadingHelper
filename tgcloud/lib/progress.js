// Reading sessions and the numbers derived from them.
//
// Every function takes the user's local day as a string, because "today" and
// "this week" are properties of the reader, not of the server (see lib/time.js).

import { db } from 'sdk';
import { and, between, desc, eq, sql } from 'sdk/db';
import { books, sessions } from '../schema.js';
import { addDays, dowLabel, lastDays, rangeDays, weekStart } from './time.js';

/**
 * Record a reading session and move the book's bookmark.
 * `pages` may be 0 — time spent without turning a page is still a session kept.
 */
export async function logSession(user, book, { day, pages, fromPage, toPage, minutes, note }) {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      bookId: book.id,
      day,
      pages,
      fromPage: fromPage ?? null,
      toPage: toPage ?? null,
      minutes: minutes ?? null,
      note: note ?? null,
    })
    .returning();

  const patch = { lastProgressAt: new Date() };
  if (toPage != null) patch.currentPage = toPage;
  if (!book.startedAt) patch.startedAt = new Date();
  await db.update(books).set(patch).where(eq(books.id, book.id));

  return row;
}

/** The last session, for /undo. */
export async function lastSession(userId) {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.id))
    .limit(1)
    .get();
}

/**
 * Undo a session and rewind the bookmark to where it pointed before. Deleting a
 * session without this would leave the book's `currentPage` ahead of its own
 * history, which then shows up as a phantom 0-page day.
 */
export async function undoSession(session) {
  await db.delete(sessions).where(eq(sessions.id, session.id));
  if (session.fromPage != null) {
    await db.update(books).set({ currentPage: session.fromPage }).where(eq(books.id, session.bookId));
  }
  return session;
}

/** { 'YYYY-MM-DD': pages } for an inclusive day range. */
export async function pagesByDay(userId, from, to) {
  const rows = await db
    .select({ day: sessions.day, pages: sql`sum(${sessions.pages})` })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), between(sessions.day, from, to)))
    .groupBy(sessions.day)
    .all();
  const out = new Map();
  for (const r of rows) out.set(r.day, Number(r.pages ?? 0));
  return out;
}

export async function dayPages(userId, day) {
  const map = await pagesByDay(userId, day, day);
  return map.get(day) ?? 0;
}

/**
 * Monday-to-Sunday view of the week containing `refDay`. The quota is weekly so
 * that a busy Tuesday can be made up on Saturday, while the daily floor still
 * has to be met. Days after `today` carry null rather than 0 — a day that has
 * not happened yet is not a day you missed.
 */
export async function weekSummary(user, refDay, today = refDay) {
  const start = weekStart(refDay);
  const end = addDays(start, 6);
  const map = await pagesByDay(user.id, start, end);

  const days = rangeDays(start, end).map((day) => ({
    day,
    label: dowLabel(day),
    // A day in the future has no number yet — not even a zero.
    pages: day <= today ? (map.get(day) ?? 0) : null,
    met: day <= today ? (map.get(day) ?? 0) >= user.dailyMinPages : null,
  }));

  const pages = days.reduce((sum, d) => sum + (d.pages ?? 0), 0);
  const elapsed = days.filter((d) => d.pages != null).length;
  const daysMet = days.filter((d) => d.met).length;

  return {
    start,
    end,
    days,
    pages,
    goal: user.weeklyGoalPages,
    left: Math.max(0, user.weeklyGoalPages - pages),
    elapsed,
    daysLeft: 7 - elapsed,
    daysMet,
  };
}

/**
 * Calendar pace: pages per day over a window, counting days off as zeros. This
 * is the pace an ETA should use — the optimistic "pages per day I actually read"
 * would promise a finish date that never arrives.
 */
export async function pace(userId, today, windowDays = 14) {
  const days = lastDays(today, windowDays);
  const map = await pagesByDay(userId, days[0], today);
  let total = 0;
  for (const d of days) total += map.get(d) ?? 0;
  return total / windowDays;
}

/** Pages per hour, from the sessions where the user bothered to log time. */
export async function readingSpeed(userId, today, windowDays = 60) {
  const from = addDays(today, -(windowDays - 1));
  const row = await db
    .select({
      pages: sql`coalesce(sum(${sessions.pages}), 0)`,
      minutes: sql`coalesce(sum(${sessions.minutes}), 0)`,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), between(sessions.day, from, today), sql`${sessions.minutes} > 0`))
    .get();
  const minutes = Number(row?.minutes ?? 0);
  const pages = Number(row?.pages ?? 0);
  if (minutes < 20) return null; // too little evidence to quote a number
  return (pages / minutes) * 60;
}

/** Daily totals for a window, oldest first — the input for sparklines/charts. */
export async function dailySeries(userId, today, windowDays = 14) {
  const days = lastDays(today, windowDays);
  const map = await pagesByDay(userId, days[0], today);
  return days.map((day) => ({ day, pages: map.get(day) ?? 0 }));
}

export async function totals(userId) {
  const row = await db
    .select({
      pages: sql`coalesce(sum(${sessions.pages}), 0)`,
      minutes: sql`coalesce(sum(${sessions.minutes}), 0)`,
      days: sql`count(distinct ${sessions.day})`,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .get();
  return {
    pages: Number(row?.pages ?? 0),
    minutes: Number(row?.minutes ?? 0),
    days: Number(row?.days ?? 0),
  };
}
