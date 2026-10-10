// Parsing of free-form user input. The whole point of the bot is that logging
// progress costs one short message, so this module is deliberately forgiving:
// '147', '+20', '100-140', 'с 100 до 140', '147 25м', '30 мин' all work, in
// Russian or English, with any leftover text kept as a note.
//
// This module imports nothing — it is covered by test/parse.test.js.

/** Lowercase, unify dashes and 'ё', collapse whitespace. */
function normalize(text) {
  return String(text)
    .replace(/[‐-―]/g, '-') // ‐ ‑ ‒ – —
    .replace(/ /g, ' ')
    .replace(/ё/gi, (c) => (c === 'Ё' ? 'Е' : 'е'))
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// JS word boundaries are ASCII-only, so Cyrillic needs explicit lookarounds.
const NOT_WORD = '(?<![a-zа-я0-9])';
const NOT_WORD_AFTER = '(?![a-zа-я0-9])';
const PAGE_WORD = /(?:страниц[аыуе]?|стр|с\.|pages?|pg|p)\.?/;
const MIN_UNIT = /(?:минут[аыуе]*|мин\.?|м|min|m)/;
const HOUR_UNIT = /(?:час[аов]*|ч\.?|hours?|hrs?|h)/;

const FINISH_WORDS = /^(?:готово|дочитал[а]?|закончил[а]?|прочитал[а]? до конца|finished?|done)$/;

/**
 * Parse a progress message.
 * @returns {null | {kind: 'absolute'|'delta'|'range'|'minutes'|'finish',
 *                   page?: number, pages?: number, from?: number, to?: number,
 *                   minutes?: number|null, note?: string|null}}
 */
export function parseProgress(text) {
  if (text == null) return null;
  let s = normalize(text);
  if (!s) return null;

  if (FINISH_WORDS.test(s)) return { kind: 'finish' };

  // Pull the time out first, wherever it sits: '147 25м', '25 мин 147', '1ч20м'.
  let minutes = null;
  const hm = new RegExp(`(\\d{1,2})\\s*${HOUR_UNIT.source}(?:\\s*(\\d{1,2})\\s*${MIN_UNIT.source})?(?![a-zа-я0-9])`).exec(s);
  if (hm) {
    minutes = Number(hm[1]) * 60 + (hm[2] ? Number(hm[2]) : 0);
    s = (s.slice(0, hm.index) + ' ' + s.slice(hm.index + hm[0].length)).trim();
  } else {
    const mm = new RegExp(`(\\d{1,4})\\s*${MIN_UNIT.source}(?![a-zа-я0-9])`).exec(s);
    if (mm) {
      minutes = Number(mm[1]);
      s = (s.slice(0, mm.index) + ' ' + s.slice(mm.index + mm[0].length)).trim();
    }
  }

  // Drop page words — they are decoration, the position is in the digits.
  s = s.replace(new RegExp(`${NOT_WORD}${PAGE_WORD.source}${NOT_WORD_AFTER}`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const take = (re) => {
    const m = re.exec(s);
    if (!m) return null;
    const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim();
    return { m, note: cleanNote(rest) };
  };

  // '100-140' / 'с 100 до 140' — an explicit span.
  const range = take(/(?:^|\s)(?:с\s*|from\s*)?(\d{1,5})\s*(?:-|до\s+|to\s+)\s*(\d{1,5})(?=\s|$)/);
  if (range) {
    const from = Number(range.m[1]);
    const to = Number(range.m[2]);
    if (to >= from) return { kind: 'range', from, to, minutes, note: range.note };
  }

  // '+20' — pages read from wherever I was.
  const delta = take(/(?:^|\s)\+\s*(\d{1,5})(?=\s|$)/);
  if (delta) return { kind: 'delta', pages: Number(delta.m[1]), minutes, note: delta.note };

  // 'до 300' / '147' — the page I am on now.
  const abs = take(/(?:^|\s)(?:до\s*|на\s*)?(\d{1,5})(?:-?[ия]|th|st|nd|rd)?(?=\s|$)/);
  if (abs) return { kind: 'absolute', page: Number(abs.m[1]), minutes, note: abs.note };

  if (minutes != null) return { kind: 'minutes', minutes, note: cleanNote(s) };

  return null;
}

/** Keep a leftover fragment only if it looks like a human note. */
function cleanNote(rest) {
  const n = rest.replace(/^[\s,.;:—-]+|[\s,.;:]+$/g, '').trim();
  if (n.length < 2) return null;
  if (/^[\d\s+\-]+$/.test(n)) return null; // stray digits, not prose
  return n.slice(0, 500);
}

/** '/goal@my_bot 200' → { cmd: 'goal', args: '200' }; null when not a command. */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const m = /^\/([a-z_0-9]+)(?:@[\w_]+)?\s*([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: m[2].trim() };
}

/** '+3', '3', '-5:30', 'utc+3', 'МСК+1' → minutes east of UTC. */
export function parseTzOffset(text) {
  if (text == null) return null;
  const s = normalize(text).replace(/(?:utc|gmt|мск|msk)/g, '');
  const m = /^([+-])?\s*(\d{1,2})(?:[:.](\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const h = Number(m[2]);
  const min = m[3] ? Number(m[3]) : 0;
  if (h > 14 || min > 59) return null;
  return sign * (h * 60 + min);
}

/** '21', '21:00', '9.30', '21 00' → 'HH:MM'. */
export function parseTimeArg(text) {
  if (text == null) return null;
  const s = normalize(text);
  if (/^(?:off|нет|выкл|никогда)$/.test(s)) return 'off';
  const m = /^(\d{1,2})(?:[:. ](\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return `${h < 10 ? '0' : ''}${h}:${min < 10 ? '0' : ''}${min}`;
}

/** First positive integer in the string, or null. */
export function parseIntArg(text) {
  if (text == null) return null;
  const m = /(\d{1,6})/.exec(String(text));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** '/quote 42 текст' → { page: 42, text: 'текст' }; page may be null. */
export function parseQuote(args) {
  const s = String(args ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,5})\s+([\s\S]+)$/.exec(s);
  if (m) return { page: Number(m[1]), text: m[2].trim().slice(0, 2000) };
  return { page: null, text: s.slice(0, 2000) };
}

/** 'Война и мир — Толстой' / 'Толстой - Война и мир' → { title, author }. */
export function parseTitleAuthor(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s);
  if (!m) return { title: s.slice(0, 200), author: null };
  const left = m[1].trim();
  const right = m[2].trim();
  // The shorter side is almost always the author.
  if (right.length <= left.length) return { title: left.slice(0, 200), author: right.slice(0, 120) };
  return { title: right.slice(0, 200), author: left.slice(0, 120) };
}

/**
 * A PDF file name is the only title we get for free. Strip the extension and
 * the usual library-dump noise.
 */
export function titleFromFileName(name) {
  let s = String(name ?? '').trim();
  s = s.replace(/\.(pdf|epub|djvu|fb2|mobi)$/i, '');
  s = s.replace(/[_]+/g, ' ');
  s = s.replace(/\s*\((?:z-?lib(?:\.org)?|libgen|annas?[- ]archive)[^)]*\)\s*/gi, ' ');
  s = s.replace(/\s*\[[^\]]*\]\s*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'Без названия';
}
