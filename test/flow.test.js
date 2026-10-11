// End-to-end flows: a real update goes into the real handler, and we check both
// what the user was told and what ended up in the database.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import onMessage from '../tgcloud/handlers/message.js';
import onCallback from '../tgcloud/handlers/callback_query.js';
import * as h from '../test/helpers/harness.js';

beforeEach(() => h.setup());
after(() => h.unfreeze());

const send = (text) => onMessage(h.message(text));
const press = (data) => onCallback(h.callback(data));

/** The usual starting point: an onboarded user with a 420-page PDF loaded. */
async function withBook({ pages = 420 } = {}) {
  await send('/start');
  await press('onb:21:00');
  h.setFileContent('FILE_1', h.pdfWithPages(pages));
  await onMessage(h.document({ file_name: 'Thinking_Fast_and_Slow.pdf' }));
}

test('/start onboards and the reminder button sets the time', async () => {
  await send('/start');
  assert.match(h.lastText(), /Привет, Паша/);
  assert.match(h.lastText(), /147/); // the cheat sheet shows how to log
  assert.equal((await h.user()).onboarded, true);

  await press('onb:21:00');
  const u = await h.user();
  assert.equal(u.remindAt, '21:00');
  assert.match(h.lastText(), /21:00/);
});

test('a PDF becomes the active book with its page count read from the file', async () => {
  await withBook({ pages: 420 });

  const book = await h.activeBook();
  assert.equal(book.title, 'Thinking Fast and Slow');
  assert.equal(book.totalPages, 420);
  assert.equal(book.pagesSource, 'pdf');
  assert.equal(book.fileId, 'FILE_1');
  assert.equal(book.status, 'reading');
  assert.match(h.lastText(), /Страниц: 420 — взял из файла/);
});

test('the same file sent twice does not create a second book', async () => {
  await withBook();
  await onMessage(h.document({ file_name: 'Thinking_Fast_and_Slow.pdf' }));
  assert.equal((await h.books()).length, 1);
  assert.match(h.lastText(), /уже есть/);
});

test('a bare number is the page you are on, and the reply shows the whole picture', async () => {
  await withBook({ pages: 420 });
  await send('147');

  const book = await h.activeBook();
  assert.equal(book.currentPage, 147);

  const [session] = await h.sessions();
  assert.equal(session.pages, 147);
  assert.equal(session.fromPage, 0);
  assert.equal(session.toPage, 147);
  assert.equal(session.day, '2026-10-10'); // local day, UTC+3

  const reply = h.lastText();
  assert.match(reply, /\+147/);
  assert.match(reply, /147 \/ 420/);
  assert.match(reply, /35%/);
  assert.match(reply, /минимум взят/);
  assert.match(reply, /Неделя 147 \/ 150/);
  assert.match(reply, /финиш ≈/);
});

test('+N adds pages from the bookmark, with time when given', async () => {
  await withBook();
  await send('147');
  await send('+20 25м');

  assert.equal((await h.activeBook()).currentPage, 167);
  const last = (await h.sessions()).at(-1);
  assert.equal(last.pages, 20);
  assert.equal(last.minutes, 25);
  assert.match(h.lastText(), /\+20/);
});

test('a range logs exactly the span', async () => {
  await withBook();
  await send('с 200 до 250');
  const last = (await h.sessions()).at(-1);
  assert.equal(last.fromPage, 200);
  assert.equal(last.toPage, 250);
  assert.equal(last.pages, 50);
  assert.equal((await h.activeBook()).currentPage, 250);
});

test('time alone is kept as a session with no pages', async () => {
  await withBook();
  await send('147');
  await send('30 мин');
  const last = (await h.sessions()).at(-1);
  assert.equal(last.pages, 0);
  assert.equal(last.minutes, 30);
  assert.equal((await h.activeBook()).currentPage, 147);
});

test('a number below the bookmark is asked about, not guessed', async () => {
  await withBook();
  await send('200');
  const before = (await h.sessions()).length;

  await send('100');
  assert.equal((await h.sessions()).length, before, 'nothing is written while ambiguous');
  assert.match(h.lastText(), /это страница, на которой ты теперь, или столько страниц прочитано/);

  await press('abs:100');
  assert.equal((await h.activeBook()).currentPage, 100);
});

test('the same ambiguous number can instead be read as +N', async () => {
  await withBook();
  await send('200');
  await send('100');
  await press('log:100');
  assert.equal((await h.activeBook()).currentPage, 300);
});

test('a page beyond the end is refused with a way to fix it', async () => {
  await withBook({ pages: 420 });
  await send('500');
  assert.equal((await h.sessions()).length, 0);
  assert.match(h.lastText(), /всего 420 стр/);
  assert.match(h.lastText(), /\/pages 500/);
});

test('reaching the last page offers to close the book', async () => {
  await withBook({ pages: 420 });
  await send('420');
  assert.match(h.lastText(), /Это последняя страница/);
  assert.equal((await h.activeBook()).status, 'reading', 'not closed behind the user’s back');
});

test('/undo removes the last session and rewinds the bookmark', async () => {
  await withBook();
  await send('147');
  await send('+20');
  await send('/undo');

  assert.equal((await h.sessions()).length, 1);
  assert.equal((await h.activeBook()).currentPage, 147);
  assert.match(h.lastText(), /Отменил/);
});

test('the undo button under a reply undoes that session', async () => {
  await withBook();
  await send('147');
  const [session] = await h.sessions();
  await press(`undo:${session.id}`);
  assert.equal((await h.sessions()).length, 0);
  assert.equal((await h.activeBook()).currentPage, 0);
  // Pressing it twice is harmless.
  await press(`undo:${session.id}`);
  assert.equal((await h.sessions()).length, 0);
});

test('finishing a book logs the remaining pages and counts toward the year', async () => {
  await withBook({ pages: 420 });
  await send('400');
  await send('/finish');

  const book = (await h.books())[0];
  assert.equal(book.status, 'finished');
  assert.equal(book.currentPage, 420);
  assert.ok(book.finishedAt);

  const total = (await h.sessions()).reduce((s, x) => s + x.pages, 0);
  assert.equal(total, 420, 'the book’s pages and the logged pages agree');

  assert.match(h.allText(), /Дочитано/);
  assert.match(h.allText(), /1-я книга в 2026 году из 12/);
  assert.match(h.lastText(), /Книг в работе больше нет/);
  assert.equal((await h.user()).activeBookId, null);
});

test('a rating is stored from the stars under the finish card', async () => {
  await withBook();
  await send('/finish');
  const book = (await h.books())[0];
  await press(`rate:${book.id}:4`);
  assert.equal((await h.books())[0].rating, 4);
  assert.match(h.lastText(), /★★★★☆/);
});

test('a non-PDF is still a book — the bot just asks for the page count', async () => {
  await send('/start');
  await onMessage(h.document({
    file_name: 'Чистый_код.epub', mime_type: 'application/epub+zip', file_unique_id: 'U2', file_id: 'F2',
  }));
  assert.match(h.lastText(), /Сколько в ней страниц/);
  assert.equal((await h.activeBook()).totalPages, null);

  await send('320');
  const book = await h.activeBook();
  assert.equal(book.totalPages, 320);
  assert.equal(book.pagesSource, 'manual');
  assert.match(h.lastText(), /320 страниц/);
});

test('a file too big to download falls back to asking', async () => {
  await send('/start');
  await onMessage(h.document({ file_size: 40 * 1024 * 1024, file_unique_id: 'U3', file_id: 'F3' }));
  assert.match(h.lastText(), /больше 20 МБ/);
  assert.equal((await h.activeBook()).totalPages, null);
});

test('while the bot waits for a page count, commands and progress still work', async () => {
  await send('/start');
  await onMessage(h.document({ file_name: 'Книга.epub', mime_type: 'application/epub+zip' }));
  await send('/week');
  assert.match(h.lastText(), /Неделя/);
  // The pending question is still open afterwards.
  await send('250');
  assert.equal((await h.activeBook()).totalPages, 250);
});

test('/add creates a paper book and asks its length', async () => {
  await send('/start');
  await send('/add Война и мир — Толстой');
  const book = await h.activeBook();
  assert.equal(book.title, 'Война и мир');
  assert.equal(book.author, 'Толстой');
  assert.equal(book.fileId, null);
  assert.match(h.lastText(), /Сколько в ней страниц/);
  await send('1300');
  assert.equal((await h.activeBook()).totalPages, 1300);
});

test('goals are editable and are reflected in the reply', async () => {
  await withBook();
  await send('/goal 300');
  assert.equal((await h.user()).weeklyGoalPages, 300);
  await send('/min 25');
  assert.equal((await h.user()).dailyMinPages, 25);
  await send('/year 24');
  assert.equal((await h.user()).yearGoalBooks, 24);

  await send('10');
  assert.match(h.lastText(), /Сегодня 10 из 25 стр/);
  assert.doesNotMatch(h.lastText(), /минимум взят/);
  assert.match(h.lastText(), /Неделя 10 \/ 300/);
});

test('/tz changes which day a session lands on', async () => {
  await withBook();
  await send('/tz -8'); // 18:00 UTC is still the 10th in UTC+3, but 10:00 on the 10th in UTC-8
  await send('/remind off');
  assert.equal((await h.user()).tzOffset, -480);
  assert.equal((await h.user()).remindAt, null);

  h.freeze('2026-10-11T02:00:00Z'); // 05:00 MSK on the 11th, but 18:00 on the 10th in UTC-8
  await send('50');
  assert.equal((await h.sessions()).at(-1).day, '2026-10-10');
});

test('quotes are saved against the active book and listed back', async () => {
  await withBook();
  await send('147');
  await send('/quote 42 Мысль, которую стоит запомнить');
  const [q] = await h.quotes();
  assert.equal(q.page, 42);
  assert.equal(q.text, 'Мысль, которую стоит запомнить');

  await send('/quote без страницы');
  assert.equal((await h.quotes()).at(-1).page, 147, 'falls back to where the reader is');

  await send('/quotes');
  assert.match(h.lastText(), /Мысль, которую стоит запомнить/);
  assert.match(h.lastText(), /стр. 42/);
});

test('/books lists the library and the buttons switch the active book', async () => {
  await withBook();
  await send('/add Вторая книга');
  await send('300');
  const all = await h.books();
  assert.equal(all.length, 2);

  await send('/books');
  assert.match(h.lastText(), /Thinking Fast and Slow/);
  assert.match(h.lastText(), /Вторая книга/);

  const first = all.find((b) => b.title === 'Thinking Fast and Slow');
  await press(`switch:${first.id}`);
  assert.equal((await h.user()).activeBookId, first.id);
  assert.match(h.lastText(), /Активная книга/);
});

test('dropping a book promotes the next one', async () => {
  await withBook();
  await send('/add Вторая книга');
  await send('300');
  const second = (await h.books()).find((b) => b.title === 'Вторая книга');
  await send('/drop');
  assert.equal((await h.books()).find((b) => b.id === second.id).status, 'dropped');
  assert.equal((await h.activeBook()).title, 'Thinking Fast and Slow');
});

test('the file is sent back on request', async () => {
  await withBook();
  await send('/file');
  const call = h.calls.filter((c) => c.method === 'sendDocument').at(-1);
  assert.equal(call.params.document, 'FILE_1');
});

test('/stats draws the full dashboard', async () => {
  await withBook({ pages: 420 });
  await send('147 30м');
  await send('/stats');
  const out = h.lastText();
  assert.match(out, /Thinking Fast and Slow/);
  assert.match(out, /Неделя/);
  assert.match(out, /Две недели/);
  assert.match(out, /Темп/);
  assert.match(out, /скорость \d+ стр\/час/);
  assert.match(out, /2026 год/);
  assert.match(out, /Осталось 273 страницы/);
});

test('/commit opens a 30-day contract and reports adherence', async () => {
  await withBook();
  await send('/min 10');
  await send('/commit');
  const [contract] = await h.contracts();
  assert.equal(contract.status, 'active');
  assert.equal(contract.startDay, '2026-10-10');
  assert.equal(contract.endDay, '2026-11-08');
  assert.equal(contract.dailyMinPages, 10);
  assert.match(h.lastText(), /Контракт на 30 дней/);

  await send('50');
  await send('/commit');
  assert.match(h.lastText(), /Соблюдение 100%/);

  await press(`contract_cancel:${contract.id}`);
  assert.equal((await h.contracts())[0].status, 'cancelled');
});

test('nonsense gets a short lesson, not a shrug', async () => {
  await withBook();
  await send('как дела?');
  assert.match(h.lastText(), /Не понял/);
  assert.match(h.lastText(), /\+20/);
  await send('/wat');
  assert.match(h.lastText(), /Не знаю такой команды/);
  // Telegram commands are ASCII-only, so a Cyrillic slash-word is just text.
  await send('/флуд');
  assert.match(h.lastText(), /Не понял/);
});

test('progress without a book explains what to do first', async () => {
  await send('/start');
  await send('147');
  assert.match(h.lastText(), /Сначала нужна книга/);
  assert.equal((await h.sessions()).length, 0);
});

test('a week spanning Monday rolls over cleanly', async () => {
  await withBook();
  await send('100');                       // Saturday 10 Oct
  h.freeze('2026-10-12T09:00:00Z');        // Monday 12 Oct, a new week
  await send('+30');

  const reply = h.lastText();
  assert.match(reply, /Неделя 30 \/ 150/, 'the new week starts from zero');
  const sessionDays = (await h.sessions()).map((s) => s.day);
  assert.deepEqual(sessionDays, ['2026-10-10', '2026-10-12']);
});

test('an unconfirmed page count is settled by the button, never by the next number', async () => {
  await send('/start');
  await press('onb:21:00');
  // This file only claims a count, so the bot asks for confirmation…
  h.setFileContent('FILE_1', h.pdfWithUncorroboratedPages(300));
  await onMessage(h.document({ file_name: 'Сомнительная.pdf' }));
  assert.match(h.lastText(), /Похоже, страниц 300. Верно\?/);

  // …and a number typed now is progress, not a correction of the total.
  await send('120');
  const book = await h.activeBook();
  assert.equal(book.currentPage, 120, 'read as a page, not as the book length');
  assert.equal(book.totalPages, 300, 'the proposed total survives');

  await press(`pages:${book.id}:300`);
  assert.equal((await h.activeBook()).totalPages, 300);
});

test('"Другое число" re-opens the question explicitly', async () => {
  await withBook({ pages: 420 });
  const book = await h.activeBook();
  await press(`pages_ask:${book.id}`);
  assert.match(h.lastText(), /Сколько всего страниц/);
  await send('500');
  assert.equal((await h.activeBook()).totalPages, 500);
});
