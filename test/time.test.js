import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey, localNow, addDays, daysBetween, dowOf, weekStart, rangeDays,
  lastDays, hhmmToMinutes, fmtDay, dowLabel, yearOf,
} from '../tgcloud/lib/time.js';

const MSK = 180;

test('dayKey uses the user local day, not UTC', () => {
  // 22:30 UTC is already tomorrow in Moscow.
  const ms = Date.UTC(2026, 9, 10, 22, 30);
  assert.equal(dayKey(ms, 0), '2026-10-10');
  assert.equal(dayKey(ms, MSK), '2026-10-11');
  // …and still yesterday in Los Angeles.
  assert.equal(dayKey(Date.UTC(2026, 9, 10, 3, 0), -420), '2026-10-09');
});

test('localNow reports wall clock and ISO weekday', () => {
  const now = localNow(Date.UTC(2026, 9, 10, 18, 5), MSK); // 21:05 Moscow, Saturday
  assert.equal(now.day, '2026-10-10');
  assert.equal(now.hours, 21);
  assert.equal(now.minutes, 5);
  assert.equal(now.minuteOfDay, 21 * 60 + 5);
  assert.equal(now.dow, 6);
  assert.equal(now.year, 2026);
});

test('localNow maps Sunday to 7', () => {
  assert.equal(localNow(Date.UTC(2026, 9, 11, 9, 0), MSK).dow, 7);
});

test('day arithmetic crosses months and years', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-10-01', '2026-10-10'), 9);
  assert.equal(daysBetween('2026-10-10', '2026-10-01'), -9);
  assert.equal(daysBetween('2026-10-10', '2026-10-10'), 0);
});

test('weeks start on Monday', () => {
  assert.equal(dowOf('2026-10-10'), 6); // Saturday
  assert.equal(dowOf('2026-10-12'), 1); // Monday
  assert.equal(weekStart('2026-10-10'), '2026-10-05');
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(weekStart('2026-10-11'), '2026-10-05'); // Sunday belongs to the week before
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
});

test('rangeDays and lastDays are inclusive', () => {
  assert.deepEqual(rangeDays('2026-10-08', '2026-10-10'), ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.deepEqual(lastDays('2026-10-10', 3), ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.deepEqual(lastDays('2026-10-10', 1), ['2026-10-10']);
  assert.equal(lastDays('2026-10-10', 14).length, 14);
});

test('hhmmToMinutes validates the clock', () => {
  assert.equal(hhmmToMinutes('21:00'), 1260);
  assert.equal(hhmmToMinutes('00:00'), 0);
  assert.equal(hhmmToMinutes('9:05'), 545);
  assert.equal(hhmmToMinutes('25:00'), null);
  assert.equal(hhmmToMinutes('21:70'), null);
  assert.equal(hhmmToMinutes('nope'), null);
  assert.equal(hhmmToMinutes(null), null);
});

test('labels', () => {
  assert.equal(fmtDay('2026-10-10'), '10 окт');
  assert.equal(fmtDay('2026-01-01'), '1 янв');
  assert.equal(dowLabel('2026-10-12'), 'Пн');
  assert.equal(yearOf('2026-10-10'), 2026);
});
