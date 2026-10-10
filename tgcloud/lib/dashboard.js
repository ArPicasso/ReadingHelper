// The dashboard payload: one object with everything the Mini App draws, so the
// front-end needs a single round trip and no client-side arithmetic.

import { db } from 'sdk';
import { desc, eq } from 'sdk/db';
import { books as booksTable, quotes as quotesTable } from '../schema.js';
import { bookStats, getActiveBook } from './books.js';
import { dailySeries, pagesByDay, pace, readingSpeed, totals, weekSummary } from './progress.js';
import { activeContract, contractProgress, yearProgress } from './goals.js';
import { addDays, localNow, weekStart } from './time.js';
import { etaDays } from './format.js';

const WEEKS_BACK = 8;
const DAYS_BACK = 28;

export async function buildDashboard(user) {
  const now = localNow(Date.now(), user.tzOffset);
  const day = now.day;

  const week = await weekSummary(user, day);
  const paceValue = await pace(user.id, day);
  const book = await getActiveBook(user);
  const contract = await activeContract(user.id);

  const left = book?.totalPages ? Math.max(0, book.totalPages - book.currentPage) : null;
  const eta = left != null ? etaDays(left, paceValue) : null;

  const allBooks = await db
    .select()
    .from(booksTable)
    .where(eq(booksTable.userId, user.id))
    .orderBy(desc(booksTable.lastProgressAt), desc(booksTable.createdAt))
    .all();

  const quotes = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.userId, user.id))
    .orderBy(desc(quotesTable.id))
    .limit(20)
    .all();

  return {
    now: { day, year: now.year },
    user: {
      firstName: user.firstName,
      weeklyGoalPages: user.weeklyGoalPages,
      dailyMinPages: user.dailyMinPages,
      yearGoalBooks: user.yearGoalBooks,
      remindAt: user.remindAt,
      tzOffset: user.tzOffset,
    },
    today: {
      day,
      pages: week.days.find((d) => d.day === day)?.pages ?? 0,
      min: user.dailyMinPages,
    },
    week: {
      start: week.start,
      end: week.end,
      pages: week.pages,
      goal: week.goal,
      left: week.left,
      daysLeft: week.daysLeft,
      daysMet: week.daysMet,
      elapsed: week.elapsed,
      days: week.days,
    },
    pace: paceValue,
    speed: await readingSpeed(user.id, day),
    days: await dailySeries(user.id, day, DAYS_BACK),
    weeks: await weeklySeries(user, day),
    activeBook: book ? await describeBook(book, paceValue) : null,
    books: await Promise.all(allBooks.map((b) => describeBook(b, paceValue))),
    year: await yearProgress(user, day).then((y) => ({ year: y.year, done: y.done, goal: y.goal })),
    contract: contract
      ? { ...pickContract(contract), progress: await contractProgress(contract, day) }
      : null,
    totals: await totals(user.id),
    quotes: quotes.map((q) => ({
      id: q.id,
      bookId: q.bookId,
      page: q.page,
      text: q.text,
    })),
    eta: eta != null ? { days: eta, day: addDays(day, eta) } : null,
  };
}

/** Weekly totals for the last `WEEKS_BACK` weeks, oldest first. */
async function weeklySeries(user, today) {
  const thisWeek = weekStart(today);
  const first = addDays(thisWeek, -7 * (WEEKS_BACK - 1));
  const map = await pagesByDay(user.id, first, addDays(thisWeek, 6));

  const out = [];
  for (let w = 0; w < WEEKS_BACK; w++) {
    const start = addDays(first, w * 7);
    let pages = 0;
    for (let d = 0; d < 7; d++) pages += map.get(addDays(start, d)) ?? 0;
    out.push({ start, end: addDays(start, 6), pages, goal: user.weeklyGoalPages });
  }
  return out;
}

async function describeBook(book, paceValue) {
  const stats = await bookStats(book.id);
  const left = book.totalPages ? Math.max(0, book.totalPages - book.currentPage) : null;
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    status: book.status,
    currentPage: book.currentPage,
    totalPages: book.totalPages,
    rating: book.rating,
    hasFile: !!book.fileId,
    startedAt: book.startedAt ? new Date(book.startedAt).toISOString() : null,
    finishedAt: book.finishedAt ? new Date(book.finishedAt).toISOString() : null,
    lastProgressAt: book.lastProgressAt ? new Date(book.lastProgressAt).toISOString() : null,
    pagesLeft: left,
    etaDays: left != null ? etaDays(left, paceValue) : null,
    stats,
  };
}

function pickContract(contract) {
  return {
    id: contract.id,
    startDay: contract.startDay,
    endDay: contract.endDay,
    days: contract.days,
    dailyMinPages: contract.dailyMinPages,
    weeklyGoalPages: contract.weeklyGoalPages,
  };
}
