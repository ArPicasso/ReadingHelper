// Button presses. Callback data is `verb:arg[:arg]`, built in lib/keyboards.js.
// Every branch answers the query so the client stops spinning.

import { api } from 'sdk';
import * as app from '../lib/app.js';
import * as view from '../lib/view.js';
import * as kb from '../lib/keyboards.js';
import { clearState, ensureUser, setState, updateUser } from '../lib/users.js';
import {
  DROPPED, READING, getActiveBook, getBook, setActiveBook, updateBook,
} from '../lib/books.js';
import { undoSession } from '../lib/progress.js';
import { activeContract, cancelContract } from '../lib/goals.js';
import { bookLine } from '../lib/format.js';
import { db } from 'sdk';
import { and, eq } from 'sdk/db';
import { sessions } from '../schema.js';

export default async function (query) {
  const chatId = query.message?.chat?.id ?? query.from.id;
  const user = await ensureUser(query.from);
  const { verb, args } = kb.parseCallback(query.data);

  const answer = (text, alert = false) =>
    api.answerCallbackQuery({ callback_query_id: query.id, text, show_alert: alert })
      .catch((e) => console.warn('answerCallbackQuery failed', e?.description ?? e));

  switch (verb) {
    case 'log': {
      const pages = Number(args[0]);
      const book = await getActiveBook(user);
      if (!book) {
        await answer('Нет активной книги');
        return app.send(chatId, 'Сначала добавь книгу: пришли PDF или /add Название');
      }
      await answer(`+${pages}`);
      return app.applyProgress(user, book, chatId, { kind: 'delta', pages, minutes: null, note: null });
    }

    case 'abs': {
      const page = Number(args[0]);
      const book = await getActiveBook(user);
      if (!book) return answer('Нет активной книги');
      await answer();
      // The user confirmed the number is a position, even though it moves back.
      const delta = page - book.currentPage;
      return app.logAndReply(user, book, chatId, {
        pages: Math.max(0, delta), fromPage: book.currentPage, toPage: page,
      });
    }

    case 'undo': {
      const id = Number(args[0]);
      const session = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.userId, user.id)))
        .get();
      if (!session) return answer('Эта запись уже отменена', true);
      await undoSession(session);
      await answer('Отменил');
      return app.send(chatId, `↩️ Отменил +${session.pages} стр за ${session.day}.`);
    }

    case 'stats':
      await answer();
      return app.sendStats(user, chatId);

    case 'books':
      await answer();
      return app.sendBooks(user, chatId);

    case 'file':
      await answer('Отправляю файл');
      return app.sendBookFile(user, chatId, Number(args[0]));

    case 'switch': {
      const book = await getBook(user.id, Number(args[0]));
      if (!book) return answer('Книга не найдена', true);
      await setActiveBook(user.id, book.id);
      if (book.status !== READING) await updateBook(book.id, { status: READING });
      await answer('Переключил');
      return app.send(chatId, `▶️ Активная книга: <b>${bookLine(book)}</b>`);
    }

    case 'finish': {
      const book = await getBook(user.id, Number(args[0]));
      if (!book) return answer('Книга не найдена', true);
      await answer();
      return app.finishFlow(user, book, chatId);
    }

    case 'drop': {
      const book = await getBook(user.id, Number(args[0]));
      if (!book) return answer('Книга не найдена', true);
      await answer('В архив');
      return app.setStatusAndReply(user, book, chatId, DROPPED,
        `Убрал «<b>${bookLine(book)}</b>» в архив. Вернуть можно через /books.`);
    }

    case 'keep': {
      const book = await getBook(user.id, Number(args[0]));
      if (!book) return answer('Книга не найдена', true);
      // Remember that we asked, so the question does not come back tomorrow.
      await updateBook(book.id, { quarantineAskedAt: new Date(), status: READING });
      await setActiveBook(user.id, book.id);
      await answer('Договорились');
      return app.send(chatId, `▶️ Снова в работе: <b>${bookLine(book)}</b>\nОтметить прогресс — просто пришли номер страницы.`);
    }

    case 'pages': {
      const [bookId, pages] = args.map(Number);
      const book = await getBook(user.id, bookId);
      if (!book) return answer('Книга не найдена', true);
      await updateBook(book.id, { totalPages: pages, pagesSource: 'pdf' });
      await clearState(user.id);
      await answer('Записал');
      return app.send(chatId, view.pagesSetMessage({ ...book, totalPages: pages }));
    }

    case 'pages_ask': {
      const bookId = Number(args[0]);
      await setState(user.id, { kind: 'await_pages', bookId });
      await answer();
      return app.send(chatId, 'Сколько всего страниц? Пришли число.');
    }

    case 'rate': {
      const [bookId, rating] = args.map(Number);
      const book = await getBook(user.id, bookId);
      if (!book) return answer('Книга не найдена', true);
      if (rating > 0) {
        await updateBook(book.id, { rating });
        await answer('★'.repeat(rating));
        return app.send(chatId, view.ratedMessage(book, rating));
      }
      await answer('Без оценки');
      return undefined;
    }

    case 'onb': {
      // 'onb:21:00' — the time itself contains a colon.
      const value = args.join(':');
      if (value === 'off') {
        await updateUser(user.id, { remindAt: null, onboarded: true });
        await answer('Без напоминаний');
        return app.send(chatId, [
          'Хорошо, напоминать не буду.',
          '',
          'Пришли PDF — и начнём. Если книга бумажная: <code>/add Название</code>',
        ].join('\n'));
      }
      await updateUser(user.id, { remindAt: value, onboarded: true });
      await answer(value);
      return app.send(chatId, [
        `Буду писать в ${value}, но только если за день ноль страниц — без спама.`,
        '',
        'Теперь пришли PDF книги. Или бумажную: <code>/add Название</code>',
      ].join('\n'));
    }

    case 'skip_today':
      await answer('До завтра');
      return app.send(chatId, 'Ок. Дневной минимум маленький именно для таких дней — но пропустить тоже нормально.');

    case 'contract_cancel': {
      const contract = await activeContract(user.id);
      if (!contract) return answer('Контракта нет');
      await cancelContract(contract);
      await answer('Расторгнут');
      return app.send(chatId, 'Контракт расторгнут. Новый — /commit');
    }

    case 'noop':
      return answer();

    default:
      return answer();
  }
}
