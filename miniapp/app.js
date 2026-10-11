// Mini App front-end. Talks to the bot only through endpoints (tgcloud/endpoints),
// which is where the database and the Bot API live; this file just draws.

import { columnChart, chartTable } from './charts.js';
import { DEMO } from './demo.js';

const tg = window.Telegram?.WebApp;
const $ = (id) => document.getElementById(id);

/**
 * Outside Telegram the SDK still loads and reports colorScheme 'light', so the
 * presence of init data — not of the SDK — is what says we are really inside a
 * Mini App. Everything that follows Telegram's lead is gated on this.
 */
const inTelegram = !!(tg && (tg.initData || Object.keys(tg.initDataUnsafe ?? {}).length));

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

let state = null;
let busy = false;

/* ------------------------------------------------------------- utilities */

const plural = (n, forms) => {
  const a = Math.abs(Math.round(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};

const pagesWord = (n) => plural(n, ['страница', 'страницы', 'страниц']);
const daysWord = (n) => plural(n, ['день', 'дня', 'дней']);
const booksWord = (n) => plural(n, ['книга', 'книги', 'книг']);

const fmtDay = (day) => {
  const [, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

const fmtRange = (from, to) =>
  from.slice(0, 7) === to.slice(0, 7)
    ? `${Number(from.slice(8, 10))} – ${fmtDay(to)}`
    : `${fmtDay(from)} – ${fmtDay(to)}`;

const pct = (done, total) => (total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0);

function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2200);
}

/** Call an endpoint. The SDK signs the request with the verified init data. */
function call(name, input = {}) {
  return new Promise((resolve, reject) => {
    if (!tg?.Serverless) {
      reject(Object.assign(new Error('Mini App API недоступен'), { type: 'NO_SDK' }));
      return;
    }
    tg.Serverless.call(name, input, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

/* ----------------------------------------------------------------- render */

function render(data) {
  state = data;
  const { user, today, week, year, pace, speed, activeBook, contract } = data;

  $('greeting').textContent = user.firstName ? `Дневник чтения, ${user.firstName}` : 'Дневник чтения';
  $('subtitle').textContent = `${fmtDay(today.day)} · всего ${data.totals.pages} ${pagesWord(data.totals.pages)}`;

  // Stat tiles.
  $('today-value').textContent = today.pages;
  const met = today.pages >= today.min;
  $('today-note').textContent = met ? `минимум ${today.min} взят` : `минимум ${today.min}`;
  $('today-note').classList.toggle('ok', met);

  $('pace-value').textContent = pace >= 10 ? Math.round(pace) : Math.round(pace * 10) / 10;
  $('pace-note').textContent = speed ? `${Math.round(speed)} стр/час` : 'стр в день';

  $('year-value').textContent = `${year.done}/${year.goal}`;
  $('year-note').textContent = 'книг за год';

  // Week.
  $('week-range').textContent = fmtRange(week.start, week.end);
  $('week-figure').textContent = `${week.pages} / ${week.goal} стр`;
  $('week-left').textContent = week.left > 0
    ? `осталось ${week.left} за ${week.daysLeft} ${daysWord(week.daysLeft)}`
    : 'цель закрыта';
  $('week-meter').style.width = `${pct(week.pages, week.goal)}%`;
  $('week-days').replaceChildren(...week.days.map((d, i) => {
    const cell = document.createElement('div');
    cell.className = 'weekday';
    if (d.pages == null) cell.classList.add('future');
    else if (!d.met) cell.classList.add('miss');
    cell.textContent = DOW[i];
    const value = document.createElement('b');
    value.textContent = d.pages == null ? '·' : d.pages;
    cell.append(value);
    cell.title = d.pages == null ? 'ещё не наступил' : `${d.pages} ${pagesWord(d.pages)}`;
    return cell;
  }));

  renderBook(activeBook);
  renderCharts(data);
  renderContract(contract);
  renderYear(data);
  renderLibrary(data.books);
  renderQuotes(data);
  fillSettings(user);

  $('loading').hidden = true;
  $('app').hidden = false;
}

function renderBook(book) {
  const card = $('book-card');
  if (!book) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('book-title').textContent = book.author ? `${book.title} — ${book.author}` : book.title;
  $('book-meta').textContent = book.totalPages
    ? `${book.currentPage} / ${book.totalPages} · ${pct(book.currentPage, book.totalPages)}%`
    : `${book.currentPage} ${pagesWord(book.currentPage)} · всего страниц не знаю`;
  $('book-meter').style.width = `${pct(book.currentPage, book.totalPages ?? 0)}%`;
  $('book-eta').textContent = book.etaDays
    ? `Осталось ${book.pagesLeft} ${pagesWord(book.pagesLeft)} — примерно ${book.etaDays} ${daysWord(book.etaDays)}`
    : '';
  $('page-input').placeholder = String(book.currentPage || 0);
}

function renderCharts(data) {
  const days = data.days;
  columnChart($('days-chart'), {
    data: days,
    value: (d) => d.pages,
    // One label a week keeps the axis readable at 28 bars.
    label: (d, i) => ((days.length - 1 - i) % 7 === 0 ? fmtDay(d.day) : ''),
    tooltip: (d) => `${fmtDay(d.day)}: ${d.pages} ${pagesWord(d.pages)}`,
    reference: data.user.dailyMinPages,
    referenceLabel: `мин ${data.user.dailyMinPages}`,
  });
  chartTable($('days-table'), {
    data: [...days].reverse(),
    columns: [
      { title: 'День', value: (d) => fmtDay(d.day) },
      { title: 'Страниц', value: (d) => String(d.pages) },
    ],
  });

  const weeks = data.weeks;
  columnChart($('weeks-chart'), {
    data: weeks,
    value: (w) => w.pages,
    label: (w, i) => (i % 2 === 0 ? fmtDay(w.start) : ''),
    tooltip: (w) => `${fmtRange(w.start, w.end)}: ${w.pages} из ${w.goal}`,
    reference: data.user.weeklyGoalPages,
    referenceLabel: `цель ${data.user.weeklyGoalPages}`,
  });
  chartTable($('weeks-table'), {
    data: [...weeks].reverse(),
    columns: [
      { title: 'Неделя', value: (w) => fmtRange(w.start, w.end) },
      { title: 'Страниц', value: (w) => String(w.pages) },
      { title: 'Цель', value: (w) => String(w.goal) },
    ],
  });
}

function renderContract(contract) {
  const card = $('contract-card');
  if (!contract) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const p = contract.progress;
  $('contract-figure').textContent = `${p.adherence}%`;
  $('contract-left').textContent = `осталось ${p.daysLeft} ${daysWord(p.daysLeft)}`;
  $('contract-meter').style.width = `${p.adherence}%`;
  $('contract-terms').textContent =
    `Минимум взят ${p.met} из ${p.elapsed} ${daysWord(p.elapsed)} · ` +
    `${fmtRange(contract.startDay, contract.endDay)} · не меньше ${contract.dailyMinPages} стр в день`;
}

function renderYear(data) {
  const { year, books } = data;
  $('year-figure').textContent = `${year.done} из ${year.goal} ${booksWord(year.goal)}`;
  $('year-left').textContent = year.done >= year.goal
    ? 'цель закрыта'
    : `ещё ${year.goal - year.done}`;
  $('year-meter').style.width = `${pct(year.done, year.goal)}%`;

  const finished = books
    .filter((b) => b.status === 'finished' && b.finishedAt?.slice(0, 4) === String(year.year))
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  $('year-chips').replaceChildren(...finished.map((b) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = b.rating ? `${b.title} ${'★'.repeat(b.rating)}` : b.title;
    return chip;
  }));
}

const STATUS = { reading: 'читаю', queued: 'в очереди', finished: 'дочитана', dropped: 'в архиве' };

function renderLibrary(books) {
  const host = $('library');
  if (!books.length) {
    host.innerHTML = '<p class="sub">Пришли боту PDF — книга появится здесь.</p>';
    return;
  }
  const activeId = state.activeBook?.id ?? null;
  host.replaceChildren(...books.map((book) => {
    const node = document.createElement('div');
    node.className = 'book';

    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = book.author ? `${book.title} — ${book.author}` : book.title;
    if (book.id === activeId) title.textContent = `▶ ${title.textContent}`;

    const meta = document.createElement('div');
    meta.className = 'book-meta num';
    const where = book.totalPages
      ? `${book.currentPage} / ${book.totalPages} · ${pct(book.currentPage, book.totalPages)}%`
      : `${book.currentPage} стр`;
    meta.textContent = `${STATUS[book.status] ?? book.status} · ${where}`;
    if (book.rating) meta.textContent += ` · ${'★'.repeat(book.rating)}`;

    const actions = document.createElement('div');
    actions.className = 'book-actions';
    if (book.id !== activeId && book.status !== 'finished') {
      actions.append(button('Читать', () => act(book.id, 'switch')));
    }
    if (book.status === 'reading' || book.status === 'queued') {
      actions.append(button('Дочитал', () => act(book.id, 'finish')));
      actions.append(button('В архив', () => act(book.id, 'drop')));
    }
    if (book.status === 'finished' && !book.rating) {
      for (const n of [3, 4, 5]) {
        actions.append(button('★'.repeat(n), () => act(book.id, 'rate', { rating: n })));
      }
    }

    node.append(title, meta, actions);
    return node;
  }));
}

function renderQuotes(data) {
  const card = $('quotes-card');
  if (!data.quotes.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const byId = new Map(data.books.map((b) => [b.id, b]));
  $('quotes').replaceChildren(...data.quotes.slice(0, 10).map((q) => {
    const node = document.createElement('div');
    node.className = 'quote';
    node.textContent = `«${q.text}»`;
    const cite = document.createElement('cite');
    const book = byId.get(q.bookId);
    cite.textContent = [book?.title, q.page ? `стр. ${q.page}` : null].filter(Boolean).join(', ');
    node.append(cite);
    return node;
  }));
}

function fillSettings(user) {
  $('goal-input').value = user.weeklyGoalPages;
  $('min-input').value = user.dailyMinPages;
  $('books-input').value = user.yearGoalBooks;
  $('remind-input').value = user.remindAt ?? '';
}

function button(text, onClick) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = text;
  node.addEventListener('click', onClick);
  return node;
}

/* ----------------------------------------------------------------- actions */

async function guard(fn, okText) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const data = await fn();
    if (data) render(data);
    if (okText) toast(okText);
    tg?.HapticFeedback?.notificationOccurred?.('success');
  } catch (e) {
    toast(e?.message ?? 'Не получилось');
    tg?.HapticFeedback?.notificationOccurred?.('error');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

const act = (bookId, action, extra = {}) =>
  guard(() => call('bookAction', { bookId, action, ...extra }), 'Готово');

function readMinutes() {
  const raw = $('minutes-input').value;
  $('minutes-input').value = '';
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function wire() {
  for (const node of document.querySelectorAll('[data-log-pages]')) {
    node.addEventListener('click', () => {
      const pages = Number(node.dataset.logPages);
      guard(() => call('logProgress', { pages, minutes: readMinutes() }), `+${pages} стр`);
    });
  }

  $('page-save').addEventListener('click', () => {
    const raw = $('page-input').value;
    if (raw === '') return toast('Введи номер страницы');
    $('page-input').value = '';
    return guard(() => call('logProgress', { page: Number(raw), minutes: readMinutes() }), 'Записал');
  });

  $('settings-save').addEventListener('click', () => guard(() => call('saveSettings', {
    weeklyGoalPages: Number($('goal-input').value),
    dailyMinPages: Number($('min-input').value),
    yearGoalBooks: Number($('books-input').value),
    remindAt: $('remind-input').value || 'off',
  }), 'Сохранил'));

  $('remind-off').addEventListener('click', () =>
    guard(() => call('saveSettings', { remindAt: 'off' }), 'Напоминания выключены'));

  // Charts are sized from the container, so a rotation needs a redraw.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state && renderCharts(state), 150);
  });
}

function applyTheme() {
  // Inside Telegram its theme wins; in a plain browser the OS setting decides.
  if (inTelegram && tg?.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
}

async function boot() {
  wire();
  applyTheme();
  tg?.ready?.();
  tg?.expand?.();
  tg?.onEvent?.('themeChanged', () => {
    applyTheme();
    if (state) renderCharts(state);
  });

  // Opened in a plain browser (no init data): show the layout on sample numbers
  // rather than an error, so the page can be checked outside Telegram.
  if (!inTelegram) {
    render(DEMO);
    toast('Демо-данные: открой через бота');
    return;
  }

  try {
    render(await call('getDashboard'));
  } catch (e) {
    $('loading').hidden = true;
    const box = $('error');
    box.hidden = false;
    box.textContent = e?.parameters?.code === 'NOT_REGISTERED'
      ? 'Открой чат с ботом и нажми /start — после этого дашборд заработает.'
      : `Не удалось загрузить данные: ${e?.message ?? 'неизвестная ошибка'}`;
  }
}

boot();
