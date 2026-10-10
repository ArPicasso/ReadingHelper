// Inline keyboards. Callback data is capped at 64 bytes by Telegram, so every
// action is a short `verb:arg` pair parsed by handlers/callback_query.js.

const btn = (text, data) => ({ text, callback_data: data });

export function parseCallback(data) {
  const [verb, ...rest] = String(data ?? '').split(':');
  return { verb, args: rest };
}

/** Shown under every logged session: the next session is one tap away. */
export function afterLogKeyboard(book, sessionId) {
  const rows = [[btn('+10', 'log:10'), btn('+20', 'log:20'), btn('+30', 'log:30')]];
  const second = [btn('📊 Сводка', 'stats'), btn('📚 Книги', 'books')];
  if (sessionId) second.push(btn('↩️', `undo:${sessionId}`));
  rows.push(second);
  return { inline_keyboard: rows };
}

/** Offered when the bookmark reaches the last page. */
export function finishPromptKeyboard(book) {
  return {
    inline_keyboard: [[btn('🏁 Дочитал', `finish:${book.id}`), btn('Ещё нет', 'noop')]],
  };
}

export function remindKeyboard(book) {
  const rows = [[btn('+10 стр', 'log:10'), btn('+20 стр', 'log:20')]];
  if (book?.fileId) rows.push([btn('📄 Открыть книгу', `file:${book.id}`)]);
  rows.push([btn('Сегодня не читаю', 'skip_today')]);
  return { inline_keyboard: rows };
}

export function onboardingKeyboard() {
  return {
    inline_keyboard: [
      [btn('20:00', 'onb:20:00'), btn('21:00', 'onb:21:00'), btn('22:00', 'onb:22:00')],
      [btn('Без напоминаний', 'onb:off')],
    ],
  };
}

/** Confirm (or correct) a page count read out of the PDF. */
export function pagesConfirmKeyboard(book, pages) {
  return {
    inline_keyboard: [
      [btn(`✅ ${pages} страниц`, `pages:${book.id}:${pages}`), btn('✏️ Другое число', `pages_ask:${book.id}`)],
    ],
  };
}

export function booksKeyboard(books, activeId) {
  const rows = books.slice(0, 10).map((b) => {
    const row = [];
    if (b.id !== activeId) row.push(btn(`▶️ ${trim(b.title)}`, `switch:${b.id}`));
    else row.push(btn(`✅ ${trim(b.title)}`, 'noop'));
    return row;
  });
  if (activeId) {
    rows.push([btn('🏁 Дочитал', `finish:${activeId}`), btn('🗑 Бросаю', `drop:${activeId}`)]);
  }
  return { inline_keyboard: rows };
}

export function finishKeyboard(book) {
  return {
    inline_keyboard: [
      [1, 2, 3, 4, 5].map((n) => btn('★'.repeat(n), `rate:${book.id}:${n}`)),
      [btn('Без оценки', `rate:${book.id}:0`)],
    ],
  };
}

export function quarantineKeyboard(book) {
  return {
    inline_keyboard: [
      [btn('📖 Дочитываю', `keep:${book.id}`), btn('🗑 В архив', `drop:${book.id}`)],
    ],
  };
}

/** Resolve '147' when it would move the bookmark backwards. */
export function ambiguityKeyboard(page) {
  return {
    inline_keyboard: [
      [btn(`Я на ${page}-й странице`, `abs:${page}`), btn(`Прочитал +${page}`, `log:${page}`)],
    ],
  };
}

export function undoKeyboard(sessionId) {
  return { inline_keyboard: [[btn('↩️ Отменить запись', `undo:${sessionId}`)]] };
}

/** The Mini App button. `url` comes from the deployed static site. */
export function appKeyboard(url) {
  return { inline_keyboard: [[{ text: '📊 Открыть дашборд', web_app: { url } }]] };
}

function trim(title, max = 28) {
  const s = String(title ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
