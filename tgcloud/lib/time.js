// Local-time helpers. The platform runs in UTC and Telegram never reveals the
// user's timezone, so every user carries a `tzOffset` (minutes east of UTC) and
// all day boundaries are computed from it. Day keys are 'YYYY-MM-DD' strings:
// comparable with `<`, groupable in SQL, and free of timezone math at query time.
//
// This module imports nothing — it is covered by test/time.test.js.

const MS_DAY = 86400000;

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** Shift an absolute instant into the user's local wall clock. */
function shifted(ms, tzOffset) {
  return new Date(ms + tzOffset * 60000);
}

/** Local day key, e.g. '2026-10-10'. */
export function dayKey(ms, tzOffset) {
  const d = shifted(ms, tzOffset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Everything a scheduler needs about "now" for one user. */
export function localNow(ms, tzOffset) {
  const d = shifted(ms, tzOffset);
  const jsDow = d.getUTCDay(); // 0 = Sunday
  return {
    day: dayKey(ms, tzOffset),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: jsDow === 0 ? 7 : jsDow, // 1 = Monday … 7 = Sunday
    year: d.getUTCFullYear(),
  };
}

/** Midnight UTC of a day key, as epoch ms (used only for day arithmetic). */
function dayToMs(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(day, n) {
  const d = new Date(dayToMs(day) + n * MS_DAY);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Whole days from `a` to `b` (negative if b is earlier). */
export function daysBetween(a, b) {
  return Math.round((dayToMs(b) - dayToMs(a)) / MS_DAY);
}

/** Day of week for a day key, 1 = Monday … 7 = Sunday. */
export function dowOf(day) {
  const js = new Date(dayToMs(day)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Monday of the week containing `day`. */
export function weekStart(day) {
  return addDays(day, -(dowOf(day) - 1));
}

/** Inclusive list of day keys from `from` to `to`. */
export function rangeDays(from, to) {
  const out = [];
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

/** The last `n` day keys ending at `day` (oldest first). */
export function lastDays(day, n) {
  return rangeDays(addDays(day, -(n - 1)), day);
}

export function yearOf(day) {
  return Number(day.slice(0, 4));
}

/** 'HH:MM' → minutes since local midnight, or null. */
export function hhmmToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DOW_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** '2026-10-10' → '10 окт'. */
export function fmtDay(day) {
  const [, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

export function dowLabel(day) {
  return DOW_SHORT[dowOf(day) - 1];
}

/** '5 – 11 окт' within one month, '28 сен – 4 окт' across two. */
export function fmtDayRange(from, to) {
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const left = sameMonth ? String(Number(from.slice(8, 10))) : fmtDay(from);
  return `${left} – ${fmtDay(to)}`;
}
