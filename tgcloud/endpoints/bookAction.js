// POST /api/bookAction — switch, finish or archive a book from the Mini App.

import { EndpointError } from 'sdk';
import { requireUser } from '../lib/users.js';
import {
  DROPPED, READING, finishBook, getBook, setActiveBook, setBookStatus, updateBook,
} from '../lib/books.js';
import { logSession } from '../lib/progress.js';
import { buildDashboard } from '../lib/dashboard.js';
import { localNow } from '../lib/time.js';

export default async function (input, ctx) {
  const user = await requireUser(ctx);
  const book = await getBook(user.id, Number(input?.bookId));
  if (!book) throw new EndpointError('Книга не найдена', { code: 'NOT_FOUND' });

  switch (input?.action) {
    case 'switch':
      await updateBook(book.id, { status: READING });
      await setActiveBook(user.id, book.id);
      break;

    case 'finish': {
      // Same rule as in the chat: finishing means the rest was read.
      if (book.totalPages && book.currentPage < book.totalPages) {
        const { day } = localNow(Date.now(), user.tzOffset);
        await logSession(user, book, {
          day,
          pages: book.totalPages - book.currentPage,
          fromPage: book.currentPage,
          toPage: book.totalPages,
        });
        book.currentPage = book.totalPages;
      }
      await finishBook(user, book);
      break;
    }

    case 'drop':
      await setBookStatus(user, book, DROPPED);
      break;

    case 'rate': {
      const rating = Number(input?.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new EndpointError('Оценка от 1 до 5', { code: 'BAD_VALUE', field: 'rating' });
      }
      await updateBook(book.id, { rating });
      break;
    }

    default:
      throw new EndpointError('Неизвестное действие', { code: 'BAD_ACTION' });
  }

  const fresh = await getBook(user.id, book.id);
  const refreshed = await requireUser(ctx);
  return { book: fresh ? { id: fresh.id, status: fresh.status } : null, ...(await buildDashboard(refreshed)) };
}
