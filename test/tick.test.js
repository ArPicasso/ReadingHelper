// The scheduler. These tests matter more than most: the tick is the one thing
// nobody watches, it runs every 15 minutes, and its whole job is to send a
// message at the right moment and exactly once.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import onMessage from '../tgcloud/handlers/message.js';
import onCallback from '../tgcloud/handlers/callback_query.js';
import tick from '../tgcloud/lib/tick.js';
import * as h from '../test/helpers/harness.js';

const send = (text) => onMessage(h.message(text));
const press = (data) => onCallback(h.callback(data));

beforeEach(() => h.setup({ now: '2026-10-06T09:00:00Z' })); // Tue 6 Oct, 12:00 MSK
after(() => h.unfreeze());

/** Onboarded user, 21:00 reminder, one 420-page book. */
async function reader() {
  await send('/start');
  await press('onb:21:00');
  h.setFileContent('FILE_1', h.pdfWithPages(420));
  await onMessage(h.document({ file_name: 'Книга.pdf' }));
}

const countReminders = () => h.texts().filter((t) => t.includes('За сегодня ноль страниц')).length;
const countDigests = () => h.texts().filter((t) => t.startsWith('📊')).length;

test('the reminder goes out at the chosen time on an empty day', async () => {
  await reader();
  h.freeze('2026-10-06T18:05:00Z'); // 21:05 MSK

  const report = await tick();
  assert.equal(report.reminders, 1);
  const text = h.lastText();
  assert.match(text, /За сегодня ноль страниц/);
  assert.match(text, /Книга/);
  assert.match(text, /Минимум на день — 10 страниц/);
  assert.match(text, /примерно 15 минут/);
  assert.equal((await h.user()).lastRemindDay, '2026-10-06');
});

test('a second tick in the same evening stays quiet', async () => {
  await reader();
  h.freeze('2026-10-06T18:05:00Z');
  await tick();
  await tick();
  h.freeze('2026-10-06T18:40:00Z');
  await tick();
  assert.equal(countReminders(), 1);
});

test('nothing is sent before the time or long after it', async () => {
  await reader();
  h.freeze('2026-10-06T16:00:00Z'); // 19:00 MSK — too early
  assert.equal((await tick()).reminders, 0);

  h.freeze('2026-10-06T21:00:00Z'); // 00:00 MSK next day — past the grace window
  assert.equal((await tick()).reminders, 0);
  assert.equal(countReminders(), 0);
});

test('a day with pages read gets no nudge', async () => {
  await reader();
  await send('+30');
  h.freeze('2026-10-06T18:05:00Z');
  assert.equal((await tick()).reminders, 0);
  assert.equal(countReminders(), 0);
});

test('/remind off silences the nudge but not the digest', async () => {
  await reader();
  await send('/remind off');
  h.freeze('2026-10-06T18:05:00Z');
  assert.equal((await tick()).reminders, 0);

  h.freeze('2026-10-12T07:05:00Z'); // Mon 12 Oct, 10:05 MSK
  assert.equal((await tick()).digests, 1);
});

test('the reminder buttons log progress in one tap', async () => {
  await reader();
  h.freeze('2026-10-06T18:05:00Z');
  await tick();
  await press('log:10');
  assert.equal((await h.activeBook()).currentPage, 10);
  assert.match(h.lastText(), /минимум взят/);
});

test('the Monday digest reports the week that just ended, once', async () => {
  await reader();
  await send('/remind off');
  await send('+40');                      // Tue 6 Oct
  h.freeze('2026-10-08T15:00:00Z');       // Thu 8 Oct, 18:00 MSK
  await send('+60');

  h.freeze('2026-10-12T07:05:00Z');       // Mon 12 Oct, 10:05 MSK
  const report = await tick();
  assert.equal(report.digests, 1);

  const digest = h.lastText();
  assert.match(digest, /Неделя 5 – 11 окт/);
  assert.match(digest, /100 \/ 150/);
  assert.match(digest, /минимум взят 2 из 7/);
  assert.match(digest, /Пн  Вт  Ср  Чт  Пт  Сб  Вс/);
  assert.match(digest, /Прошлая неделя: 0 стр → \+100/);
  assert.match(digest, /2026: 0 из 12/);

  await tick();
  h.freeze('2026-10-12T09:00:00Z');
  await tick();
  assert.equal(countDigests(), 1);
});

test('the digest is not sent on other days', async () => {
  await reader();
  await send('/remind off');
  h.freeze('2026-10-13T07:05:00Z'); // Tuesday
  assert.equal((await tick()).digests, 0);
});

test('a forgotten book gets one quarantine question, then is left alone', async () => {
  await reader();
  await send('/remind off');
  await send('+40'); // last touched Tue 6 Oct

  h.freeze('2026-10-26T07:05:00Z'); // Mon 26 Oct — 20 days idle
  const report = await tick();
  assert.equal(report.quarantine, 1);

  const asked = h.texts().find((t) => t.includes('без движения'));
  assert.match(asked, /Книга/);
  assert.match(asked, /без движения 20 дней/);
  assert.match(asked, /Дочитываем или в архив/);
  assert.ok((await h.books())[0].quarantineAskedAt);

  // The next weekly digest does not ask again.
  h.freeze('2026-11-02T07:05:00Z');
  assert.equal((await tick()).quarantine, 0);
});

test('"Дочитываю" puts the book back in the rotation', async () => {
  await reader();
  await send('/remind off');
  await send('+40');
  h.freeze('2026-10-26T07:05:00Z');
  await tick();

  const book = (await h.books())[0];
  await press(`keep:${book.id}`);
  assert.equal((await h.books())[0].status, 'reading');
  assert.equal((await h.user()).activeBookId, book.id);
  assert.match(h.lastText(), /Снова в работе/);
});

test('"В архив" ends the question for good', async () => {
  await reader();
  await send('/remind off');
  await send('+40');
  h.freeze('2026-10-26T07:05:00Z');
  await tick();

  const book = (await h.books())[0];
  await press(`drop:${book.id}`);
  assert.equal((await h.books())[0].status, 'dropped');

  h.freeze('2026-11-02T07:05:00Z');
  assert.equal((await tick()).quarantine, 0, 'an archived book is not in the rotation');
});

test('a fresh book is never quarantined', async () => {
  await reader();
  await send('/remind off');
  await send('+40');
  h.freeze('2026-10-12T07:05:00Z'); // 6 days later
  assert.equal((await tick()).quarantine, 0);
});

test('a finished contract is closed and reported with its adherence', async () => {
  await reader();
  await send('/remind off');
  await send('/commit');
  const [contract] = await h.contracts();
  assert.equal(contract.endDay, '2026-11-04');

  // Three days over the floor out of thirty.
  await send('+40');
  h.freeze('2026-10-07T15:00:00Z');
  await send('+40');
  h.freeze('2026-10-08T15:00:00Z');
  await send('+40');

  h.freeze('2026-11-05T07:05:00Z'); // the day after the term ends
  const report = await tick();
  assert.equal(report.contracts, 1);

  const closed = (await h.contracts())[0];
  assert.equal(closed.status, 'completed');
  assert.equal(closed.adherence, 10); // 3 of 30 days
  assert.ok(closed.closedAt);

  const text = h.texts().find((t) => t.includes('Контракт закрыт'));
  assert.match(text, /Соблюдение 10%/);
  assert.match(text, /минимум взят 3 из 30 дней/);
  assert.match(text, /снизить дневной минимум/);

  await tick();
  assert.equal(h.texts().filter((t) => t.includes('Контракт закрыт')).length, 1);
});

test('an active contract shows up in /stats', async () => {
  await reader();
  await send('/commit');
  await send('+40');
  await send('/stats');
  assert.match(h.lastText(), /Контракт<\/b> 100%/);
});

test('one broken chat does not stop the other users', async () => {
  await reader();
  h.freeze('2026-10-06T18:05:00Z');
  const { __failNext } = await import('sdk/api');
  __failNext('sendMessage', 403, 'Forbidden: bot was blocked by the user');

  const report = await tick();
  assert.equal(report.errors, 1);
  assert.equal(report.reminders, 0);
  // The user is not marked as reminded, so the next tick can try again.
  assert.equal((await h.user()).lastRemindDay, null);
});

test('users who never pressed /start are not touched', async () => {
  h.freeze('2026-10-06T18:05:00Z');
  const report = await tick();
  assert.equal(report.users, 0);
  assert.equal(report.reminders, 0);
});
