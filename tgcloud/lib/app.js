// The flows shared by text messages, button presses and the scheduler.
// Handlers stay thin: they parse an update and call in here.

import { api, db } from 'sdk';
import { desc, eq } from 'sdk/db';
import { books as booksTable, quotes } from '../schema.js';
import {
  FINISHED, bookStats, createBook, findByFileUniqueId, getActiveBook, getBook,
  listBooks, setActiveBook, setBookStatus, updateBook, finishBook,
} from './books.js';
import {
  dailySeries, dayPages, logSession, pace, readingSpeed, totals, weekSummary,
} from './progress.js';
import { activeContract, contractProgress, yearProgress } from './goals.js';
import { clearState, setState } from './users.js';
import { detectPageCount } from './pdf.js';
import { parseTitleAuthor, titleFromFileName } from './parse.js';
import { addDays, daysBetween, localNow } from './time.js';
import { bookLine, etaDays as etaDaysOf } from './format.js';
import * as view from './view.js';
import * as kb from './keyboards.js';
import { MAX_DOWNLOAD_BYTES, MINIAPP_URL } from './config.js';

/** Every outgoing message is HTML and never unfurls links. */
export async function send(chatId, text, extra = {}) {
  return api.sendMessage({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export function nowFor(user) {
  return localNow(Date.now(), user.tzOffset);
}

/** The user's day, week, pace and ETA in one shot — the basis of most replies. */
export async function snapshot(user, book, day) {
  const week = await weekSummary(user, day);
  const dayPagesCount = await dayPages(user.id, day);
  const paceValue = await pace(user.id, day);
  const left = book?.totalPages ? Math.max(0, book.totalPages - book.currentPage) : null;
  const eta = left != null ? etaDaysOf(left, paceValue) : null;
  return {
    week,
    day: { pages: dayPagesCount, min: user.dailyMinPages },
    pace: paceValue,
    etaDays: eta,
    etaDay: eta != null ? addDays(day, eta) : null,
  };
}

/**
 * Record a session and answer with the message the user sees most: where the
 * book is, whether today's floor is met, where the week stands, when the book ends.
 */
export async function logAndReply(user, book, chatId, entry) {
  const { day } = nowFor(user);
  const session = await logSession(user, book, { day, ...entry });
  const fresh = (await getBook(user.id, book.id)) ?? book;
  const snap = await snapshot(user, fresh, day);

  await send(chatId, view.progressReply({
    book: fresh,
    delta: entry.pages,
    minutes: entry.minutes,
    note: entry.note,
    ...snap,
  }), { reply_markup: kb.afterLogKeyboard(fresh, session.id) });

  // Reaching the last page is the natural moment to ask, not a day later.
  if (fresh.totalPages && fresh.currentPage >= fresh.totalPages && fresh.status !== FINISHED) {
    await send(chatId, 'Это последняя страница. Закрываем книгу?', {
      reply_markup: kb.finishPromptKeyboard(fresh),
    });
  }
  return session;
}

/** Translate parsed input into a session, asking rather than guessing when unsure. */
export async function applyProgress(user, book, chatId, parsed) {
  if (parsed.kind === 'delta') {
    const from = book.currentPage;
    const to = book.totalPages ? Math.min(book.totalPages, from + parsed.pages) : from + parsed.pages;
    return logAndReply(user, book, chatId, {
      pages: to - from, fromPage: from, toPage: to, minutes: parsed.minutes, note: parsed.note,
    });
  }

  if (parsed.kind === 'range') {
    return logAndReply(user, book, chatId, {
      pages: parsed.to - parsed.from,
      fromPage: parsed.from,
      toPage: parsed.to,
      minutes: parsed.minutes,
      note: parsed.note,
    });
  }

  if (parsed.kind === 'minutes') {
    return logAndReply(user, book, chatId, {
      pages: 0, fromPage: book.currentPage, toPage: book.currentPage,
      minutes: parsed.minutes, note: parsed.note,
    });
  }

  // Absolute page.
  const page = parsed.page;
  if (book.totalPages && page > book.totalPages) {
    await send(chatId,
      `В «${bookLine(book)}» всего ${book.totalPages} стр, а ты пишешь ${page}. ` +
      `Если страниц на самом деле больше — поправь: <code>/pages ${page}</code>`);
    return null;
  }
  if (page < book.currentPage) {
    // Going backwards is either a correction or a '+N' the user forgot to sign.
    await send(chatId, view.ambiguityMessage(book, page), {
      reply_markup: kb.ambiguityKeyboard(page),
    });
    return null;
  }
  return logAndReply(user, book, chatId, {
    pages: page - book.currentPage,
    fromPage: book.currentPage,
    toPage: page,
    minutes: parsed.minutes,
    note: parsed.note,
  });
}

/** A PDF arrives: register the book, read its page count, make it active. */
export async function intakeDocument(user, message) {
  const doc = message.document;
  const chatId = message.chat.id;
  const name = doc.file_name ?? 'book.pdf';
  const isPdf = doc.mime_type === 'application/pdf' || /\.pdf$/i.test(name);

  const existing = await findByFileUniqueId(user.id, doc.file_unique_id);
  if (existing) {
    await setActiveBook(user.id, existing.id);
    if (existing.status !== 'reading') await updateBook(existing.id, { status: 'reading' });
    await send(chatId, `Эта книга уже есть — сделал её активной.\n📖 <b>${bookLine(existing)}</b>`);
    return;
  }

  const { title, author } = parseTitleAuthor(titleFromFileName(name));
  const book = await createBook(user.id, {
    title,
    author,
    fileId: doc.file_id,
    fileUniqueId: doc.file_unique_id,
    fileName: name,
    fileSize: doc.file_size ?? null,
  });
  await setActiveBook(user.id, book.id);

  let detection = { pages: null, reason: 'not_pdf', confidence: 'none' };
  if (isPdf && (doc.file_size ?? 0) <= MAX_DOWNLOAD_BYTES) {
    try {
      await api.sendChatAction({ chat_id: chatId, action: 'typing' });
      const bytes = await api.getFileContent(doc.file_id);
      detection = detectPageCount(bytes);
    } catch (e) {
      console.error('page detection failed', e);
      detection = { pages: null, reason: 'unrecognized', confidence: 'none' };
    }
  } else if (isPdf) {
    detection = { pages: null, reason: 'too_big', confidence: 'none' };
  }

  if (detection.pages) {
    await updateBook(book.id, { totalPages: detection.pages, pagesSource: 'pdf' });
    book.totalPages = detection.pages;
  }

  const text = view.bookAddedMessage(book, detection);
  await clearState(user.id);
  if (detection.pages && detection.confidence === 'high') {
    await send(chatId, text);
  } else if (detection.pages) {
    // A number to confirm goes on buttons, NOT into a pending question: the next
    // thing the user types is far more likely to be the page they are on.
    await send(chatId, text, { reply_markup: kb.pagesConfirmKeyboard(book, detection.pages) });
  } else {
    await send(chatId, text);
    await setState(user.id, { kind: 'await_pages', bookId: book.id });
  }
}

export async function sendStats(user, chatId) {
  const { day } = nowFor(user);
  const book = await getActiveBook(user);
  const snap = await snapshot(user, book, day);
  const contract = await activeContract(user.id);
  await send(chatId, view.statsMessage({
    book,
    week: snap.week,
    day: snap.day,
    pace: snap.pace,
    speed: await readingSpeed(user.id, day),
    series: await dailySeries(user.id, day, 14),
    year: await yearProgress(user, day),
    contract,
    contractProgress: contract ? await contractProgress(contract, day) : null,
    totals: await totals(user.id),
  }), { reply_markup: appMarkup() });
}

export async function sendWeek(user, chatId) {
  const { day } = nowFor(user);
  await send(chatId, view.weekMessage(await weekSummary(user, day)));
}

export async function sendBooks(user, chatId) {
  const list = await listBooks(user.id);
  await send(chatId, view.booksMessage(list, user.activeBookId), {
    reply_markup: list.length ? kb.booksKeyboard(list, user.activeBookId) : undefined,
  });
}

/** Send the stored PDF back — the library follows the user to any device. */
export async function sendBookFile(user, chatId, bookId) {
  const book = await getBook(user.id, bookId ?? user.activeBookId);
  if (!book) return send(chatId, 'Книга не найдена.');
  if (!book.fileId) {
    return send(chatId, `У «${bookLine(book)}» нет файла — она добавлена вручную.`);
  }
  try {
    await api.sendDocument({
      chat_id: chatId,
      document: book.fileId,
      caption: `📖 ${bookLine(book)} · ${book.currentPage}${book.totalPages ? `/${book.totalPages}` : ''}`,
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.error('sendDocument failed', e);
    await send(chatId, 'Телеграм не отдал файл. Пришли книгу заново, и я обновлю ссылку.');
  }
}

export async function finishFlow(user, book, chatId) {
  const { day } = nowFor(user);

  // Finishing implies the remaining pages were read; log them so the stats and
  // the year total agree with the book's own page count.
  if (book.totalPages && book.currentPage < book.totalPages) {
    await logSession(user, book, {
      day,
      pages: book.totalPages - book.currentPage,
      fromPage: book.currentPage,
      toPage: book.totalPages,
    });
    book.currentPage = book.totalPages;
  }

  await finishBook(user, book);
  const stats = await bookStats(book.id);
  const year = await yearProgress(user, day);
  const started = book.startedAt ? new Date(book.startedAt) : null;
  const days = started ? Math.max(1, daysBetween(isoDay(started, user.tzOffset), day) + 1) : 0;

  await send(chatId, view.finishMessage({ book, stats, year, days }), {
    reply_markup: kb.finishKeyboard(book),
  });

  // finishBook() already promoted the next book; tell the user which one it is.
  const list = await listBooks(user.id);
  if (list.length) {
    await send(chatId, `Следующая активная книга: <b>${bookLine(list[0])}</b>`);
    return list[0];
  }
  await send(chatId, 'Книг в работе больше нет — пришли новый PDF или добавь бумажную: /add Название');
  return null;
}

function isoDay(date, tzOffset) {
  const shifted = new Date(date.getTime() + tzOffset * 60000);
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`;
}

export async function saveQuote(user, chatId, { page, text }) {
  const book = await getActiveBook(user);
  await db.insert(quotes).values({
    userId: user.id,
    bookId: book?.id ?? null,
    page: page ?? book?.currentPage ?? null,
    text,
  });
  await send(chatId, '📝 Сохранил цитату. Все цитаты: /quotes');
}

export async function sendQuotes(user, chatId) {
  const rows = await db
    .select()
    .from(quotes)
    .where(eq(quotes.userId, user.id))
    .orderBy(desc(quotes.id))
    .limit(10)
    .all();
  const bookRows = await db
    .select()
    .from(booksTable)
    .where(eq(booksTable.userId, user.id))
    .all();
  await send(chatId, view.quotesMessage(rows, new Map(bookRows.map((b) => [b.id, b]))));
}

export function appMarkup() {
  return MINIAPP_URL ? kb.appKeyboard(MINIAPP_URL) : undefined;
}

export async function setStatusAndReply(user, book, chatId, status, text) {
  await setBookStatus(user, book, status);
  await send(chatId, text);
  const list = await listBooks(user.id);
  if (list.length) await setActiveBook(user.id, list[0].id);
}
