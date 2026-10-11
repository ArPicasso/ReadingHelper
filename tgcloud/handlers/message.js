// Every incoming `message` update. The router is deliberately flat: a document
// is a new book, a slash is a command, a pending question gets its answer, and
// anything else is read as progress.

import * as app from '../lib/app.js';
import * as view from '../lib/view.js';
import * as kb from '../lib/keyboards.js';
import { clearState, ensureUser, setState, updateUser } from '../lib/users.js';
import {
  createBook, getActiveBook, getBook, setActiveBook, updateBook, DROPPED,
} from '../lib/books.js';
import { lastSession, undoSession } from '../lib/progress.js';
import { activeContract, contractProgress, startContract } from '../lib/goals.js';
import {
  parseCommand, parseIntArg, parseProgress, parseQuote, parseTimeArg,
  parseTitleAuthor, parseTzOffset,
} from '../lib/parse.js';
import { CONTRACT_DAYS, MINIAPP_URL } from '../lib/config.js';

export default async function (message) {
  if (!message?.from || message.from.is_bot) return;
  const chatId = message.chat?.id;
  if (!chatId) return;

  const user = await ensureUser(message.from);

  if (message.document) return app.intakeDocument(user, message);

  const text = (message.text ?? message.caption ?? '').trim();
  if (!text) return;

  const command = parseCommand(text);
  if (command) return handleCommand(user, chatId, command);

  // A pending question comes before free-form parsing, but only claims input it
  // can actually use — '/stats' or '147' still work while a question is open.
  if (user.state && (await handleState(user, chatId, text))) return;

  const parsed = parseProgress(text);
  if (!parsed) {
    return app.send(chatId, [
      'Не понял. Чтобы отметить прогресс, пришли:',
      '<code>147</code> — страница, на которой ты сейчас',
      '<code>+20</code> — сколько прочитал',
      '<code>147 25м</code> — страница и время',
      '',
      'Все команды: /help',
    ].join('\n'));
  }

  const book = await getActiveBook(user);
  if (!book) {
    return app.send(chatId, [
      'Сначала нужна книга. Пришли PDF — я добавлю её и определю число страниц,',
      'или добавь бумажную: <code>/add Война и мир</code>',
    ].join('\n'));
  }

  if (parsed.kind === 'finish') return app.finishFlow(user, book, chatId);
  return app.applyProgress(user, book, chatId, parsed);
}

/** @returns true when the text was consumed as an answer to a pending question. */
async function handleState(user, chatId, text) {
  const state = user.state;

  if (state.kind === 'await_pages') {
    const pages = parseIntArg(text);
    // Only a bare number answers "how many pages?" — anything else falls through.
    if (!pages || !/^\s*\d{1,5}\s*$/.test(text)) return false;
    const book = await getBook(user.id, state.bookId);
    await clearState(user.id);
    if (!book) return false;
    await updateBook(book.id, { totalPages: pages, pagesSource: 'manual' });
    await app.send(chatId, view.pagesSetMessage({ ...book, totalPages: pages }));
    return true;
  }

  if (state.kind === 'await_title') {
    const { title, author } = parseTitleAuthor(text);
    await clearState(user.id);
    const book = await createBook(user.id, { title, author, pagesSource: null });
    await setActiveBook(user.id, book.id);
    await setState(user.id, { kind: 'await_pages', bookId: book.id });
    await app.send(chatId, `📚 Добавил: <b>${title}</b>\nСколько в ней страниц? Пришли число.`);
    return true;
  }

  if (state.kind === 'await_rename') {
    const { title, author } = parseTitleAuthor(text);
    await clearState(user.id);
    const book = await getBook(user.id, state.bookId);
    if (!book) return false;
    await updateBook(book.id, { title, author: author ?? book.author });
    await app.send(chatId, `Переименовал в <b>${title}</b>.`);
    return true;
  }

  return false;
}

async function handleCommand(user, chatId, { cmd, args }) {
  switch (cmd) {
    case 'start': {
      await updateUser(user.id, { onboarded: true, firstName: user.firstName ?? null });
      return app.send(chatId, view.startMessage(user.firstName), {
        reply_markup: kb.onboardingKeyboard(),
      });
    }

    case 'help':
      return app.send(chatId, view.helpMessage());

    case 'stats':
      return app.sendStats(user, chatId);

    case 'week':
      return app.sendWeek(user, chatId);

    case 'books':
    case 'library':
      return app.sendBooks(user, chatId);

    case 'add': {
      if (!args) {
        await setState(user.id, { kind: 'await_title' });
        return app.send(chatId, 'Как называется книга? (можно «Название — Автор»)');
      }
      const { title, author } = parseTitleAuthor(args);
      const book = await createBook(user.id, { title, author });
      await setActiveBook(user.id, book.id);
      await setState(user.id, { kind: 'await_pages', bookId: book.id });
      return app.send(chatId, `📚 Добавил: <b>${title}</b>\nСколько в ней страниц? Пришли число.`);
    }

    case 'pages': {
      const book = await getActiveBook(user);
      if (!book) return app.send(chatId, 'Нет активной книги. /books');
      const pages = parseIntArg(args);
      if (!pages) return app.send(chatId, `Сколько всего страниц? <code>/pages 420</code>`);
      if (pages < book.currentPage) {
        return app.send(chatId, `Ты уже на ${book.currentPage}-й странице — всего не может быть ${pages}.`);
      }
      await updateBook(book.id, { totalPages: pages, pagesSource: 'manual' });
      await clearState(user.id);
      return app.send(chatId, view.pagesSetMessage({ ...book, totalPages: pages }));
    }

    case 'rename': {
      const book = await getActiveBook(user);
      if (!book) return app.send(chatId, 'Нет активной книги. /books');
      if (!args) {
        await setState(user.id, { kind: 'await_rename', bookId: book.id });
        return app.send(chatId, 'Новое название?');
      }
      const { title, author } = parseTitleAuthor(args);
      await updateBook(book.id, { title, author: author ?? book.author });
      return app.send(chatId, `Переименовал в <b>${title}</b>.`);
    }

    case 'file':
      return app.sendBookFile(user, chatId, user.activeBookId);

    case 'finish': {
      const book = await getActiveBook(user);
      if (!book) return app.send(chatId, 'Нет активной книги. /books');
      return app.finishFlow(user, book, chatId);
    }

    case 'drop': {
      const book = await getActiveBook(user);
      if (!book) return app.send(chatId, 'Нет активной книги. /books');
      return app.setStatusAndReply(user, book, chatId, DROPPED,
        `Убрал «<b>${book.title}</b>» в архив. Вернуть: /books`);
    }

    case 'undo': {
      const session = await lastSession(user.id);
      if (!session) return app.send(chatId, 'Нечего отменять.');
      await undoSession(session);
      return app.send(chatId, `↩️ Отменил запись: ${session.pages > 0 ? `+${session.pages} стр` : 'сессия'} за ${session.day}.`);
    }

    case 'goal': {
      const pages = parseIntArg(args);
      if (!pages) {
        return app.send(chatId,
          `Цель на неделю сейчас ${user.weeklyGoalPages} стр. Поменять: <code>/goal 200</code>`);
      }
      await updateUser(user.id, { weeklyGoalPages: pages });
      return app.send(chatId, `Цель на неделю: ${pages} стр (${Math.round(pages / 7)} стр в день).`);
    }

    case 'min': {
      const pages = parseIntArg(args);
      if (!pages) {
        return app.send(chatId,
          `Дневной минимум сейчас ${user.dailyMinPages} стр. Поменять: <code>/min 15</code>`);
      }
      await updateUser(user.id, { dailyMinPages: pages });
      return app.send(chatId, `Дневной минимум: ${pages} стр. Его задача — не дать выпасть совсем, так что пусть он будет маленьким.`);
    }

    case 'year': {
      const count = parseIntArg(args);
      if (!count) {
        return app.send(chatId, `Цель на год сейчас ${user.yearGoalBooks} книг. Поменять: <code>/year 24</code>`);
      }
      await updateUser(user.id, { yearGoalBooks: count });
      return app.send(chatId, `Цель на год: ${count} книг.`);
    }

    case 'remind': {
      const value = parseTimeArg(args);
      if (!value) {
        return app.send(chatId,
          `Напоминание сейчас: ${user.remindAt ?? 'выключено'}.\nПоменять: <code>/remind 21:00</code> или <code>/remind off</code>`);
      }
      if (value === 'off') {
        await updateUser(user.id, { remindAt: null });
        return app.send(chatId, 'Напоминания выключил. Недельный дайджест по понедельникам останется.');
      }
      await updateUser(user.id, { remindAt: value });
      return app.send(chatId, `Буду напоминать в ${value}, только если за день ноль страниц.`);
    }

    case 'tz': {
      const offset = parseTzOffset(args);
      if (offset == null) {
        const hours = user.tzOffset / 60;
        return app.send(chatId,
          `Часовой пояс сейчас UTC${hours >= 0 ? '+' : ''}${hours}.\nПоменять: <code>/tz +3</code>`);
      }
      await updateUser(user.id, { tzOffset: offset });
      const hours = offset / 60;
      return app.send(chatId, `Часовой пояс: UTC${hours >= 0 ? '+' : ''}${hours}. От него зависят «сегодня» и «эта неделя».`);
    }

    case 'commit': {
      const { day } = app.nowFor(user);
      const existing = await activeContract(user.id);
      if (existing) {
        const progress = await contractProgress(existing, day);
        return app.send(chatId, view.contractStatusMessage(existing, progress), {
          reply_markup: { inline_keyboard: [[{ text: 'Расторгнуть', callback_data: `contract_cancel:${existing.id}` }]] },
        });
      }
      const contract = await startContract(user, day, CONTRACT_DAYS);
      return app.send(chatId, view.contractStartMessage(contract));
    }

    case 'quote': {
      const quote = parseQuote(args);
      if (!quote) return app.send(chatId, 'Что сохранить? <code>/quote 42 текст цитаты</code>');
      return app.saveQuote(user, chatId, quote);
    }

    case 'quotes':
      return app.sendQuotes(user, chatId);

    case 'settings':
      return app.send(chatId, view.settingsMessage(user));

    case 'app': {
      if (!MINIAPP_URL) {
        return app.send(chatId, [
          'Дашборд пока не подключён.',
          'После <code>npx tgcloud push</code> впиши напечатанный адрес в <code>tgcloud/lib/config.js</code> и запушь снова.',
        ].join('\n'));
      }
      return app.send(chatId, '📊 Дашборд: графики, полка и история сессий.', {
        reply_markup: kb.appKeyboard(MINIAPP_URL),
      });
    }

    case 'cancel':
      await clearState(user.id);
      return app.send(chatId, 'Отменил.');

    default:
      return app.send(chatId, 'Не знаю такой команды. Что я умею: /help');
  }
}
