// Database schema. Tables are named exports; `tgcloud push` registers this file
// and `tgcloud migrate` applies the diff to the database.
//
// Two conventions used throughout:
//   * "day" columns are TEXT 'YYYY-MM-DD' in the *user's* local day (see lib/time.js).
//     Everything the user perceives as "today" or "this week" is keyed off these,
//     so no query ever has to do timezone math.
//   * There are no foreign keys (the platform runs with them off and the DSL
//     rejects them), so `userId` / `bookId` are plain integers and integrity is
//     kept in lib/books.js.

import { table, integer, text, boolean, json, index, sql } from 'sdk/db';

export const users = table('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tgId: integer('tg_id').notNull().unique(),
  firstName: text('first_name'),

  // Local time. Telegram never tells us the user's zone, so it is a setting.
  tzOffset: integer('tz_offset').notNull().default(180), // minutes east of UTC
  remindAt: text('remind_at').default('21:00'), // local HH:MM, null = reminders off
  digestDow: integer('digest_dow').notNull().default(1), // 1 = Monday

  // The goal: a weekly page quota you can catch up on, plus a daily floor that
  // keeps the habit alive on bad days.
  weeklyGoalPages: integer('weekly_goal_pages').notNull().default(150),
  dailyMinPages: integer('daily_min_pages').notNull().default(10),
  yearGoalBooks: integer('year_goal_books').notNull().default(12),

  activeBookId: integer('active_book_id'),

  // Pending dialog state, e.g. { kind: 'await_pages', bookId: 7 }.
  state: json('state'),

  // Cron bookkeeping, so a tick that runs twice never sends twice.
  lastRemindDay: text('last_remind_day'),
  lastDigestDay: text('last_digest_day'),

  onboarded: boolean('onboarded').notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
});

export const books = table('books', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),

  title: text('title').notNull(),
  author: text('author'),
  totalPages: integer('total_pages'),
  currentPage: integer('current_page').notNull().default(0),

  // 'reading' | 'queued' | 'finished' | 'dropped'
  status: text('status').notNull().default('reading'),

  // The PDF itself stays in Telegram's storage: a file_id is enough to send the
  // book back to any of the user's devices, forever, for free.
  fileId: text('file_id'),
  fileUniqueId: text('file_unique_id'),
  fileName: text('file_name'),
  fileSize: integer('file_size'),
  // How totalPages was determined: 'pdf' | 'manual' | null
  pagesSource: text('pages_source'),

  rating: integer('rating'), // 1..5, asked on finish
  verdict: text('verdict'), // one-line review, asked on finish

  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  lastProgressAt: integer('last_progress_at', { mode: 'timestamp' }),
  // Set when the quarantine prompt fires, so an ignored book is not nagged weekly.
  quarantineAskedAt: integer('quarantine_asked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  userStatusIdx: index('idx_books_user_status').on(t.userId, t.status),
  uniqueFileIdx: index('idx_books_user_file').on(t.userId, t.fileUniqueId),
}));

export const sessions = table('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  bookId: integer('book_id').notNull(),

  day: text('day').notNull(), // local YYYY-MM-DD
  fromPage: integer('from_page'),
  toPage: integer('to_page'),
  pages: integer('pages').notNull(),
  minutes: integer('minutes'),
  note: text('note'),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  userDayIdx: index('idx_sessions_user_day').on(t.userId, t.day),
  bookIdx: index('idx_sessions_book').on(t.bookId),
}));

export const quotes = table('quotes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  bookId: integer('book_id'),
  page: integer('page'),
  text: text('text').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  userIdx: index('idx_quotes_user').on(t.userId, t.createdAt),
}));

// A 30-day commitment. The terms are snapshotted so that changing the goal
// mid-contract cannot retroactively rewrite how well it was kept.
export const contracts = table('contracts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),

  startDay: text('start_day').notNull(),
  endDay: text('end_day').notNull(),
  days: integer('days').notNull().default(30),
  dailyMinPages: integer('daily_min_pages').notNull(),
  weeklyGoalPages: integer('weekly_goal_pages').notNull(),

  // 'active' | 'completed' | 'cancelled'
  status: text('status').notNull().default('active'),
  // Share of days that met the daily floor, 0..100, written when it closes.
  adherence: integer('adherence'),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
}, (t) => ({
  userStatusIdx: index('idx_contracts_user_status').on(t.userId, t.status),
}));
