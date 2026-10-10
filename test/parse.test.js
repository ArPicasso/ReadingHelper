import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProgress, parseCommand, parseTzOffset, parseTimeArg,
  parseIntArg, parseQuote, parseTitleAuthor, titleFromFileName,
} from '../tgcloud/lib/parse.js';

test('a bare number is the page you are on', () => {
  assert.deepEqual(parseProgress('147'), { kind: 'absolute', page: 147, minutes: null, note: null });
  assert.deepEqual(parseProgress(' 147 '), { kind: 'absolute', page: 147, minutes: null, note: null });
  assert.deepEqual(parseProgress('стр 147'), { kind: 'absolute', page: 147, minutes: null, note: null });
  assert.deepEqual(parseProgress('page 147'), { kind: 'absolute', page: 147, minutes: null, note: null });
  assert.deepEqual(parseProgress('на 147'), { kind: 'absolute', page: 147, minutes: null, note: null });
  assert.deepEqual(parseProgress('147-я'), { kind: 'absolute', page: 147, minutes: null, note: null });
});

test('+N is pages read from the current position', () => {
  assert.deepEqual(parseProgress('+20'), { kind: 'delta', pages: 20, minutes: null, note: null });
  assert.deepEqual(parseProgress('+ 20'), { kind: 'delta', pages: 20, minutes: null, note: null });
});

test('ranges, with or without words', () => {
  assert.deepEqual(parseProgress('100-140'), { kind: 'range', from: 100, to: 140, minutes: null, note: null });
  assert.deepEqual(parseProgress('100–140'), { kind: 'range', from: 100, to: 140, minutes: null, note: null });
  assert.deepEqual(parseProgress('с 100 до 140'), { kind: 'range', from: 100, to: 140, minutes: null, note: null });
  assert.deepEqual(parseProgress('from 100 to 140'), { kind: 'range', from: 100, to: 140, minutes: null, note: null });
});

test('time comes along in any shape', () => {
  assert.deepEqual(parseProgress('147 25м'), { kind: 'absolute', page: 147, minutes: 25, note: null });
  assert.deepEqual(parseProgress('147 25 мин'), { kind: 'absolute', page: 147, minutes: 25, note: null });
  assert.deepEqual(parseProgress('147 25 минут'), { kind: 'absolute', page: 147, minutes: 25, note: null });
  assert.deepEqual(parseProgress('+20 15m'), { kind: 'delta', pages: 20, minutes: 15, note: null });
  assert.deepEqual(parseProgress('1ч20м 147'), { kind: 'absolute', page: 147, minutes: 80, note: null });
  assert.deepEqual(parseProgress('2ч 147'), { kind: 'absolute', page: 147, minutes: 120, note: null });
});

test('time on its own is a minutes-only entry', () => {
  assert.deepEqual(parseProgress('30 мин'), { kind: 'minutes', minutes: 30, note: null });
  assert.deepEqual(parseProgress('45м'), { kind: 'minutes', minutes: 45, note: null });
});

test('leftover prose becomes the note', () => {
  assert.deepEqual(parseProgress('147 25м отличная глава'), {
    kind: 'absolute', page: 147, minutes: 25, note: 'отличная глава',
  });
  assert.deepEqual(parseProgress('+30 скучно'), { kind: 'delta', pages: 30, minutes: null, note: 'скучно' });
  // 'стр' is decoration, not a note
  assert.equal(parseProgress('147 стр').note, null);
});

test('finishing words', () => {
  for (const w of ['готово', 'дочитал', 'дочитала', 'закончил', 'done', 'finished']) {
    assert.deepEqual(parseProgress(w), { kind: 'finish' }, w);
  }
});

test('nonsense is rejected rather than guessed', () => {
  assert.equal(parseProgress('привет'), null);
  assert.equal(parseProgress(''), null);
  assert.equal(parseProgress('   '), null);
  assert.equal(parseProgress(null), null);
  assert.equal(parseProgress('как дела?'), null);
});

test('commands, with or without a bot suffix', () => {
  assert.deepEqual(parseCommand('/stats'), { cmd: 'stats', args: '' });
  assert.deepEqual(parseCommand('/goal 200'), { cmd: 'goal', args: '200' });
  assert.deepEqual(parseCommand('/goal@reading_bot 200'), { cmd: 'goal', args: '200' });
  assert.deepEqual(parseCommand('/QUOTE 42 текст'), { cmd: 'quote', args: '42 текст' });
  assert.equal(parseCommand('не команда'), null);
  assert.equal(parseCommand('147'), null);
});

test('timezone offsets', () => {
  assert.equal(parseTzOffset('+3'), 180);
  assert.equal(parseTzOffset('3'), 180);
  assert.equal(parseTzOffset('-5'), -300);
  assert.equal(parseTzOffset('UTC+3'), 180);
  assert.equal(parseTzOffset('+05:30'), 330);
  assert.equal(parseTzOffset('-3:30'), -210);
  assert.equal(parseTzOffset('+20'), null);
  assert.equal(parseTzOffset('abc'), null);
});

test('reminder times', () => {
  assert.equal(parseTimeArg('21'), '21:00');
  assert.equal(parseTimeArg('21:00'), '21:00');
  assert.equal(parseTimeArg('9:05'), '09:05');
  assert.equal(parseTimeArg('9.30'), '09:30');
  assert.equal(parseTimeArg('выкл'), 'off');
  assert.equal(parseTimeArg('off'), 'off');
  assert.equal(parseTimeArg('33:00'), null);
});

test('integers and quotes', () => {
  assert.equal(parseIntArg('200'), 200);
  assert.equal(parseIntArg('цель 200 страниц'), 200);
  assert.equal(parseIntArg('нет чисел'), null);
  assert.deepEqual(parseQuote('42 мысль дня'), { page: 42, text: 'мысль дня' });
  assert.deepEqual(parseQuote('просто мысль'), { page: null, text: 'просто мысль' });
  assert.equal(parseQuote('   '), null);
});

test('title and author split on a dash, author is the shorter side', () => {
  assert.deepEqual(parseTitleAuthor('Война и мир — Лев Толстой'), { title: 'Война и мир', author: 'Лев Толстой' });
  assert.deepEqual(parseTitleAuthor('Толстой - Война и мир навсегда'), { title: 'Война и мир навсегда', author: 'Толстой' });
  assert.deepEqual(parseTitleAuthor('Просто название'), { title: 'Просто название', author: null });
});

test('file names make serviceable titles', () => {
  assert.equal(titleFromFileName('Thinking_Fast_and_Slow.pdf'), 'Thinking Fast and Slow');
  assert.equal(titleFromFileName('Clean Code (z-lib.org).pdf'), 'Clean Code');
  assert.equal(titleFromFileName('Чистый_код_[libgen].pdf'), 'Чистый код');
  assert.equal(titleFromFileName(''), 'Без названия');
});
