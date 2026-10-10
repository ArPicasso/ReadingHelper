// Everything the bot says. Kept free of `sdk` imports so the wording and the
// numbers can be tested directly (test/view.test.js) — the messages are the
// product, so they deserve the same coverage as the parser.
//
// All messages are HTML (parse_mode: 'HTML'); user-supplied text goes through
// esc() in format.js.

import {
  bookLine, daysLabel, esc, fmtDuration, minutesLabel, pagesLabel, paceLabel,
  pct, progressBar, sparkline, weekTable, STATUS_ICON, STATUS_LABEL,
} from './format.js';
import { fmtDay, fmtDayRange } from './time.js';

export function startMessage(name) {
  const hi = name ? `Привет, ${esc(name)}.` : 'Привет.';
  return [
    `${hi} Я держу твой ритм чтения: что читаешь, сколько прочитал и не выпал ли ты из графика.`,
    '',
    '<b>Как записывать прогресс</b>',
    '📄 Пришли PDF — добавлю книгу и сам определю число страниц',
    '🔢 Напиши <b>147</b> — это страница, на которой ты сейчас',
    '➕ Или <b>+20</b> — столько страниц прочитал от последней отметки',
    '⏱ Можно со временем: <b>147 25м</b> — тогда я узнаю твою скорость',
    '',
    '<b>Цель</b> — недельная, чтобы занятый вторник можно было нагнать в субботу,',
    'плюс дневной минимум, чтобы совсем не выпадать: по умолчанию 150 стр в неделю и 10 стр в день.',
    'Поменять: /goal 200 и /min 15',
    '',
    'Во сколько напоминать, если за день ноль страниц?',
  ].join('\n');
}

export function helpMessage() {
  return [
    '<b>Прогресс</b>',
    '<code>147</code> — я на 147-й странице',
    '<code>+20</code> — прочитал 20 страниц',
    '<code>100-140</code> — прочитал с 100-й по 140-ю',
    '<code>147 25м</code> — страница и время',
    '<code>30 мин</code> — только время',
    '/undo — отменить последнюю запись',
    '',
    '<b>Книги</b>',
    '/books — библиотека и переключение книги',
    '/add Название — книга без файла (бумажная)',
    '/pages 420 — сколько всего страниц',
    '/rename Новое название',
    '/file — пришли мне PDF обратно',
    '/finish — дочитал · /drop — бросаю',
    '',
    '<b>Цели и дисциплина</b>',
    '/goal 150 — страниц в неделю',
    '/min 10 — минимум в день',
    '/year 12 — книг за год',
    '/commit — контракт на 30 дней',
    '',
    '<b>Статистика</b>',
    '/stats — сводка · /week — неделя',
    '/quote 42 текст — сохранить цитату · /quotes',
    '/app — дашборд с графиками',
    '',
    '<b>Настройки</b>',
    '/remind 21:00 или /remind off',
    '/tz +3 — часовой пояс',
  ].join('\n');
}

/** The line every book gets: bar, percent, position. */
function bookProgressLines(book) {
  const out = [];
  if (book.totalPages) {
    out.push(
      `${progressBar(book.currentPage, book.totalPages)} ${pct(book.currentPage, book.totalPages)}% · ` +
      `${book.currentPage} / ${book.totalPages}`
    );
  } else {
    out.push(`Прочитано ${pagesLabel(book.currentPage)} · всего страниц не знаю — /pages 420`);
  }
  return out;
}

/**
 * The reply to a logged session — the message the user sees most often, so it
 * answers the three questions that actually drive the next session: did I make
 * today's floor, where is the week, and when does this book end.
 */
export function progressReply({ book, delta, minutes, day, week, pace, etaDay, etaDays, note }) {
  const head = delta > 0
    ? `✅ +${delta} ${delta === 1 ? 'страница' : 'стр'} · <b>${bookLine(book)}</b>`
    : `✅ Отмечено · <b>${bookLine(book)}</b>`;

  const lines = [head, ...bookProgressLines(book), ''];

  const dayBits = [`Сегодня ${day.pages} из ${day.min} стр`];
  if (minutes) dayBits.push(fmtDuration(minutes));
  lines.push(`${day.pages >= day.min ? '✅' : '⬜'} ${dayBits.join(' · ')}${day.pages >= day.min ? ' — минимум взят' : ''}`);

  const weekBar = progressBar(week.pages, week.goal, 10);
  const weekTail = week.left > 0
    ? `осталось ${week.left} за ${daysLabel(Math.max(1, week.daysLeft))}`
    : 'недельная цель закрыта 🎯';
  lines.push(`📅 Неделя ${week.pages} / ${week.goal} ${weekBar} · ${weekTail}`);

  if (book.totalPages && etaDays != null) {
    lines.push(`⏳ Темп ${paceLabel(pace)} → финиш ≈ ${fmtDay(etaDay)}`);
  } else if (book.totalPages && pace <= 0) {
    lines.push('⏳ Темп посчитаю, когда наберётся пара дней');
  }

  if (note) lines.push('', `📝 ${esc(note)}`);
  return lines.join('\n');
}

/** Asked when an absolute page would move the bookmark backwards. */
export function ambiguityMessage(book, page) {
  return [
    `Сейчас ты на ${book.currentPage}-й странице «${bookLine(book)}».`,
    `Число <b>${page}</b> — это страница, на которой ты теперь, или столько страниц прочитано?`,
  ].join('\n');
}

export function bookAddedMessage(book, detection) {
  const lines = [`📚 Добавил: <b>${bookLine(book)}</b>`];
  if (book.totalPages && detection?.confidence === 'high') {
    lines.push(`Страниц: ${book.totalPages} — взял из файла.`);
  } else if (book.totalPages) {
    lines.push(`Похоже, страниц ${book.totalPages}. Верно?`);
  } else {
    const why = {
      compressed_objects: 'в этом файле оглавление зашифровано, число страниц не вытащить',
      too_big: 'файл больше 20 МБ — Телеграм не даёт боту его скачать',
      not_pdf: 'это не PDF',
      unrecognized: 'не смог разобрать структуру файла',
    }[detection?.reason] ?? 'не смог определить';
    lines.push(`Сколько в ней страниц? (${why})`, 'Пришли число — например <code>420</code>.');
  }
  return lines.join('\n');
}

export function pagesSetMessage(book) {
  return `Записал: в «${bookLine(book)}» ${pagesLabel(book.totalPages)}.`;
}

export function booksMessage(books, activeId) {
  if (!books.length) {
    return 'Библиотека пуста. Пришли PDF или добавь бумажную книгу: <code>/add Название</code>';
  }
  const lines = ['<b>Твои книги</b>', ''];
  for (const b of books) {
    const mark = b.id === activeId ? '▶️' : STATUS_ICON[b.status] ?? '📖';
    const where = b.totalPages
      ? `${pct(b.currentPage, b.totalPages)}% · ${b.currentPage}/${b.totalPages}`
      : `${b.currentPage} стр`;
    lines.push(`${mark} <b>${bookLine(b)}</b>`, `    ${where}`);
  }
  lines.push('', 'Кнопками ниже можно переключить активную книгу.');
  return lines.join('\n');
}

export function statsMessage({ book, day, week, series, pace, speed, year, contract, contractProgress, totals }) {
  const lines = [];

  if (book) {
    lines.push(`📖 <b>${bookLine(book)}</b>`, ...bookProgressLines(book));
    if (book.totalPages) {
      const left = Math.max(0, book.totalPages - book.currentPage);
      const eta = pace > 0 ? `≈ ${daysLabel(Math.max(1, Math.ceil(left / pace)))}` : 'темпа пока нет';
      lines.push(`Осталось ${pagesLabel(left)} — ${eta}`);
    }
    lines.push('');
  }

  lines.push(
    `🎯 <b>Неделя</b> ${week.pages} / ${week.goal} ${progressBar(week.pages, week.goal)}`,
    `Минимум взят ${week.daysMet} из ${daysLabel(week.elapsed)}`,
    weekTable(week.days),
    ''
  );

  lines.push(
    `📈 <b>Две недели</b> ${sparkline(series.map((d) => d.pages))}`,
    `Темп ${paceLabel(pace)}${speed ? ` · скорость ${Math.round(speed)} стр/час` : ''}`,
    ''
  );

  if (contract && contractProgress) {
    lines.push(
      `🤝 <b>Контракт</b> ${contractProgress.adherence}% — минимум взят ${contractProgress.met} из ${daysLabel(contractProgress.elapsed)}`,
      `Осталось ${daysLabel(contractProgress.daysLeft)} до ${fmtDay(contract.endDay)}`,
      ''
    );
  }

  lines.push(
    `🏆 <b>${year.year} год</b> ${year.done} из ${year.goal} ${progressBar(year.done, year.goal)}`,
    `Всего: ${pagesLabel(totals.pages)}${totals.minutes ? ` · ${fmtDuration(totals.minutes)}` : ''} за ${daysLabel(totals.days)} чтения`
  );

  return lines.join('\n');
}

export function weekMessage(week) {
  const tail = week.left > 0
    ? `Осталось ${week.left} стр за ${daysLabel(Math.max(1, week.daysLeft))} — это ${Math.ceil(week.left / Math.max(1, week.daysLeft))} стр в день.`
    : 'Недельная цель закрыта 🎯';
  return [
    `📅 <b>Неделя ${fmtDayRange(week.start, week.end)}</b>`,
    `${week.pages} / ${week.goal} ${progressBar(week.pages, week.goal)}`,
    weekTable(week.days),
    `Минимум взят ${week.daysMet} из ${daysLabel(week.elapsed)}.`,
    tail,
  ].join('\n');
}

export function finishMessage({ book, stats, year, days }) {
  const lines = [`🎉 Дочитано: <b>${bookLine(book)}</b>`];
  const bits = [pagesLabel(book.totalPages ?? stats.pages)];
  if (days > 0) bits.push(`за ${daysLabel(days)}`);
  if (stats.minutes) bits.push(fmtDuration(stats.minutes));
  lines.push(bits.join(' · '));
  if (days > 0 && stats.pages > 0) {
    lines.push(`Средний темп ${paceLabel(stats.pages / days)}`);
  }
  lines.push('', `Это ${year.done}-я книга в ${year.year} году из ${year.goal} 🎯`);
  if (year.done >= year.goal) lines.push('Годовая цель закрыта. Можно поднять планку: /year 24');
  lines.push('', 'Как тебе книга?');
  return lines.join('\n');
}

export function ratedMessage(book, rating) {
  return `Поставил «${bookLine(book)}» ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}.`;
}

/** The evening nudge. Only ever sent on a day with zero pages. */
export function reminderMessage({ book, week, day, minutesHint }) {
  const lines = ['⏰ За сегодня ноль страниц.'];
  if (book) {
    lines.push(`<b>${bookLine(book)}</b> — ${book.totalPages ? `${book.currentPage} / ${book.totalPages}` : `${book.currentPage} стр`}`);
  }
  lines.push(
    `Минимум на день — ${pagesLabel(day.min)}${minutesHint ? `, это примерно ${minutesLabel(minutesHint)}` : ''}.`
  );
  if (week.left > 0 && week.daysLeft > 0) {
    lines.push(`Неделя: ${week.pages} / ${week.goal}, осталось ${week.left} стр за ${daysLabel(week.daysLeft)}.`);
  }
  return lines.join('\n');
}

export function digestMessage({ week, prevPages, series, year, contract, contractProgress, booksFinished }) {
  const lines = [
    `📊 <b>Неделя ${fmtDayRange(week.start, week.end)}</b>`,
    `${week.pages} / ${week.goal} ${progressBar(week.pages, week.goal)} · минимум взят ${week.daysMet} из 7`,
    weekTable(week.days),
  ];

  if (prevPages != null) {
    const diff = week.pages - prevPages;
    const sign = diff > 0 ? '+' : '';
    const share = prevPages > 0 ? ` (${sign}${Math.round((diff / prevPages) * 100)}%)` : '';
    lines.push(`Прошлая неделя: ${prevPages} стр → ${sign}${diff}${share}`);
  }

  if (series?.length) lines.push(`Месяц: ${sparkline(series.map((d) => d.pages))}`);

  if (booksFinished?.length) {
    lines.push('', `Дочитано за неделю: ${booksFinished.map((b) => `«${bookLine(b)}»`).join(', ')}`);
  }

  if (contract && contractProgress) {
    lines.push('', `🤝 Контракт: ${contractProgress.adherence}%, осталось ${daysLabel(contractProgress.daysLeft)}`);
  }

  lines.push('', `🏆 ${year.year}: ${year.done} из ${year.goal} ${progressBar(year.done, year.goal)}`);
  return lines.join('\n');
}

/** The quarantine prompt: a book nobody has touched for two weeks. */
export function quarantineMessage(book, idleDays) {
  return [
    `🕸 «<b>${bookLine(book)}</b>» без движения ${daysLabel(idleDays)}.`,
    book.totalPages ? `Остановился на ${book.currentPage} / ${book.totalPages}.` : `Остановился на ${book.currentPage}-й странице.`,
    '',
    'Дочитываем или в архив? Непрочитанная гора книг давит сильнее, чем помогает.',
  ].join('\n');
}

export function contractStartMessage(contract) {
  return [
    `🤝 <b>Контракт на ${daysLabel(contract.days)}</b>`,
    fmtDayRange(contract.startDay, contract.endDay),
    '',
    `Условия: не меньше ${pagesLabel(contract.dailyMinPages)} в день и ${contract.weeklyGoalPages} стр в неделю.`,
    'Буду считать процент соблюдения и показывать его в каждой сводке.',
  ].join('\n');
}

export function contractStatusMessage(contract, progress) {
  return [
    `🤝 <b>Контракт</b> ${fmtDayRange(contract.startDay, contract.endDay)}`,
    `Соблюдение ${progress.adherence}% — ${progress.met} из ${daysLabel(progress.elapsed)}`,
    `Прочитано ${pagesLabel(progress.pages)} · осталось ${daysLabel(progress.daysLeft)}`,
    progress.missed > 0 ? `Пропущено дней: ${progress.missed}` : 'Ни одного пропуска 💪',
  ].join('\n');
}

export function contractClosedMessage(contract, progress) {
  const verdict = progress.adherence >= 90 ? 'Отличная дисциплина.'
    : progress.adherence >= 70 ? 'Хороший результат, есть куда расти.'
      : 'Планка оказалась высокой — может, снизить дневной минимум?';
  return [
    `🏁 <b>Контракт закрыт</b> (${fmtDayRange(contract.startDay, contract.endDay)})`,
    `Соблюдение ${progress.adherence}% — минимум взят ${progress.met} из ${daysLabel(progress.elapsed)}.`,
    `Прочитано ${pagesLabel(progress.pages)}.`,
    '',
    verdict,
    'Новый контракт: /commit',
  ].join('\n');
}

export function settingsMessage(user) {
  return [
    '<b>Настройки</b>',
    `Цель на неделю: ${pagesLabel(user.weeklyGoalPages)} — /goal`,
    `Минимум в день: ${pagesLabel(user.dailyMinPages)} — /min`,
    `Книг за год: ${user.yearGoalBooks} — /year`,
    `Напоминание: ${user.remindAt ?? 'выключено'} — /remind`,
    `Часовой пояс: UTC${user.tzOffset >= 0 ? '+' : ''}${user.tzOffset / 60} — /tz`,
  ].join('\n');
}

export function quotesMessage(rows, bookById) {
  if (!rows.length) return 'Цитат пока нет. Сохранить: <code>/quote 42 текст цитаты</code>';
  const lines = ['<b>Цитаты</b>', ''];
  for (const q of rows) {
    const book = bookById.get(q.bookId);
    const where = [book ? bookLine(book) : null, q.page ? `стр. ${q.page}` : null].filter(Boolean).join(', ');
    lines.push(`«${esc(q.text)}»`, where ? `<i>${where}</i>` : '', '');
  }
  return lines.join('\n').trim();
}

export function statusLabel(status) {
  return STATUS_LABEL[status] ?? status;
}
