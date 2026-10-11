import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, plural, pagesLabel, daysLabel, booksLabel, pct, progressBar,
  sparkline, weekTable, etaDays, paceLabel, bookLine,
} from '../tgcloud/lib/format.js';

test('HTML from users is escaped', () => {
  assert.equal(esc('<b>Код</b> & co'), '&lt;b&gt;Код&lt;/b&gt; &amp; co');
  assert.equal(esc(null), '');
});

test('Russian plurals', () => {
  assert.equal(pagesLabel(1), '1 страница');
  assert.equal(pagesLabel(2), '2 страницы');
  assert.equal(pagesLabel(5), '5 страниц');
  assert.equal(pagesLabel(11), '11 страниц');
  assert.equal(pagesLabel(21), '21 страница');
  assert.equal(pagesLabel(0), '0 страниц');
  assert.equal(pagesLabel(112), '112 страниц');
  assert.equal(daysLabel(1), '1 день');
  assert.equal(daysLabel(3), '3 дня');
  assert.equal(daysLabel(9), '9 дней');
  assert.equal(booksLabel(7), '7 книг');
  assert.equal(plural(1, ['a', 'b', 'c']), 'a');
});

test('percentages tolerate a missing total', () => {
  assert.equal(pct(218, 420), 52);
  assert.equal(pct(420, 420), 100);
  assert.equal(pct(0, 420), 0);
  assert.equal(pct(500, 420), 100); // overshoot is clamped, never 119%
  assert.equal(pct(10, null), null);
  assert.equal(pct(10, 0), null);
});

test('progress bars are fixed width', () => {
  assert.equal(progressBar(218, 420, 10), '▰▰▰▰▰▱▱▱▱▱');
  assert.equal(progressBar(420, 420, 10), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(progressBar(0, 420, 10), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(progressBar(10, null, 10), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal([...progressBar(100, 300, 12)].length, 12);
});

test('ETA is honest about an unknown pace', () => {
  assert.equal(etaDays(202, 23), 9);
  assert.equal(etaDays(10, 100), 1); // less than a day still reads as one day
  assert.equal(etaDays(0, 23), 0);
  assert.equal(etaDays(202, 0), null);
  assert.equal(etaDays(202, null), null);
  assert.equal(paceLabel(23.4), '23 стр/день');
  assert.equal(paceLabel(4.25), '4.3 стр/день');
  assert.equal(paceLabel(0), '—');
});

test('sparklines scale to their own maximum', () => {
  assert.equal(sparkline([0, 0, 0]), '···');
  assert.equal(sparkline([]), '');
  const s = sparkline([1, 20, 40]);
  assert.equal([...s].length, 3);
  assert.equal([...s][0], '▁');
  assert.equal([...s][2], '█');
  assert.equal([...sparkline([5, 0, 5])][1], '·'); // a zero day is visibly empty
});

test('week table rows line up', () => {
  const t = weekTable([
    { label: 'Пн', pages: 24 },
    { label: 'Вт', pages: 0 },
    { label: 'Ср', pages: 132 },
    { label: 'Чт', pages: null },
  ]);
  const [head, body] = t.replace('<code>', '').replace('</code>', '').split('\n');
  assert.equal(head, ' Пн  Вт  Ср  Чт');
  assert.equal(body, ' 24   0 132   –');
  assert.equal(head.length, body.length);
});

test('book lines escape the title and keep the author optional', () => {
  assert.equal(bookLine({ title: 'Война и мир', author: 'Толстой' }), 'Война и мир — Толстой');
  assert.equal(bookLine({ title: 'Война и мир', author: null }), 'Война и мир');
  assert.equal(bookLine({ title: '<script>' }), '&lt;script&gt;');
});
