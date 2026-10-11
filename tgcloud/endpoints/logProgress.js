// POST /api/logProgress — log a session from the Mini App.
//
// Deliberately quiet: the app re-renders from the returned dashboard, so the
// bot does not also send a chat message the user is not looking at.

import { EndpointError } from 'sdk';
import { requireUser } from '../lib/users.js';
import { getActiveBook, getBook } from '../lib/books.js';
import { logSession } from '../lib/progress.js';
import { buildDashboard } from '../lib/dashboard.js';
import { localNow } from '../lib/time.js';

export default async function (input, ctx) {
  const user = await requireUser(ctx);
  const book = input?.bookId ? await getBook(user.id, Number(input.bookId)) : await getActiveBook(user);
  if (!book) throw new EndpointError('Нет активной книги', { code: 'NO_BOOK' });

  const { day } = localNow(Date.now(), user.tzOffset);
  const minutes = clampInt(input?.minutes, 0, 24 * 60);

  let fromPage = book.currentPage;
  let toPage = book.currentPage;

  if (input?.page != null) {
    const page = clampInt(input.page, 0, book.totalPages ?? 100000);
    if (page == null) throw new EndpointError('Неверный номер страницы', { code: 'BAD_PAGE' });
    toPage = page;
  } else if (input?.pages != null) {
    const delta = clampInt(input.pages, 0, 10000);
    if (delta == null) throw new EndpointError('Неверное число страниц', { code: 'BAD_PAGES' });
    toPage = book.totalPages ? Math.min(book.totalPages, fromPage + delta) : fromPage + delta;
  } else if (minutes == null) {
    throw new EndpointError('Нечего записывать', { code: 'EMPTY' });
  }

  await logSession(user, book, {
    day,
    pages: Math.max(0, toPage - fromPage),
    fromPage,
    toPage,
    minutes,
    note: typeof input?.note === 'string' ? input.note.slice(0, 500) : null,
  });

  return buildDashboard(user);
}

function clampInt(value, min, max) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n);
}
