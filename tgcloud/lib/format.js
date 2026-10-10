// Message formatting: Russian pluralization, progress bars, sparklines, ETA.
// Bot messages use parse_mode 'HTML', so anything that came from a user (book
// titles, notes, quotes) must go through `esc()`.
//
// This module imports nothing — it is covered by test/format.test.js.

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Russian plural: plural(2, ['страница','страницы','страниц']) → 'страницы'. */
export function plural(n, forms) {
  const a = Math.abs(Math.round(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export const pagesWord = (n) => plural(n, ['страница', 'страницы', 'страниц']);
export const daysWord = (n) => plural(n, ['день', 'дня', 'дней']);
export const minutesWord = (n) => plural(n, ['минута', 'минуты', 'минут']);
export const booksWord = (n) => plural(n, ['книга', 'книги', 'книг']);

export const pagesLabel = (n) => `${n} ${pagesWord(n)}`;
export const daysLabel = (n) => `${n} ${daysWord(n)}`;
export const minutesLabel = (n) => `${n} ${minutesWord(n)}`;
export const booksLabel = (n) => `${n} ${booksWord(n)}`;

export function pct(done, total) {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** '▰▰▰▰▱▱▱▱▱▱' — a bar that reads the same way on every platform. */
export function progressBar(done, total, width = 10) {
  const p = pct(done, total);
  const filled = p == null ? 0 : Math.round((p / 100) * width);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, width - filled));
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Compact column chart for a series of daily values. */
export function sparkline(values) {
  if (!values.length) return '';
  const max = Math.max(...values);
  if (max <= 0) return '·'.repeat(values.length);
  return values
    .map((v) => (v <= 0 ? '·' : SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.ceil((v / max) * SPARK.length) - 1))]))
    .join('');
}

/** Right-align into a fixed cell so <code> rows line up. */
function cell(s, w = 3) {
  const t = String(s);
  return t.length >= w ? t : ' '.repeat(w - t.length) + t;
}

/**
 * A week as two aligned rows inside <code>.
 * @param {{label: string, pages: number|null}[]} days  pages = null → day not reached yet
 */
export function weekTable(days) {
  const head = days.map((d) => cell(d.label)).join(' ');
  const body = days.map((d) => cell(d.pages == null ? '–' : d.pages)).join(' ');
  return `<code>${head}\n${body}</code>`;
}

/** Whole days to finish `pagesLeft` at `pace` pages/day. */
export function etaDays(pagesLeft, pace) {
  if (!pagesLeft || pagesLeft <= 0) return 0;
  if (!pace || pace <= 0) return null;
  return Math.max(1, Math.ceil(pagesLeft / pace));
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

/** '23 стр/день' with one decimal only when it matters. */
export function paceLabel(pace) {
  if (!pace || pace <= 0) return '—';
  return pace >= 10 ? `${Math.round(pace)} стр/день` : `${round1(pace)} стр/день`;
}

export function bookLine(book) {
  const title = esc(book.title);
  return book.author ? `${title} — ${esc(book.author)}` : title;
}

export const STATUS_LABEL = {
  reading: 'читаю',
  queued: 'в очереди',
  finished: 'дочитана',
  dropped: 'брошена',
};

export const STATUS_ICON = {
  reading: '📖',
  queued: '📋',
  finished: '✅',
  dropped: '🗑',
};

/** 750 → '12 ч 30 м'; 45 → '45 м'. */
export function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(minutes || 0));
  if (m < 60) return `${m} м`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ч ${rest} м` : `${h} ч`;
}
