// The scheduler.
//
// Telegram Serverless runs code only in response to updates: there is no cron,
// no timers and no background jobs. What it does have is `tgcloud run <module>`,
// which executes a module *on the platform* using the local files. So the clock
// lives outside, in .github/workflows/tick.yml, and every 15 minutes it calls:
//
//     npx tgcloud run lib/tick
//
// This module is therefore written to be run often and to decide for itself what
// is actually due. It is idempotent: `lastRemindDay` / `lastDigestDay` and
// `quarantineAskedAt` make a double run a no-op, which matters because GitHub's
// cron is approximate and occasionally fires twice.

import { usersForTick, updateUser } from './users.js';
import { getActiveBook, staleBooks, updateBook, finishedInYear } from './books.js';
import { dailySeries, dayPages, pagesByDay, weekSummary } from './progress.js';
import { activeContract, closeDueContracts, contractProgress, yearProgress } from './goals.js';
import { addDays, dayKey, hhmmToMinutes, localNow, weekStart } from './time.js';
import * as view from './view.js';
import * as kb from './keyboards.js';
import { send } from './app.js';
import { DIGEST_HOUR, QUARANTINE_IDLE_DAYS, REMINDER_GRACE_MINUTES } from './config.js';

export default async function tick() {
  const everyone = await usersForTick();
  const report = { users: everyone.length, reminders: 0, digests: 0, quarantine: 0, contracts: 0, errors: 0 };

  for (const user of everyone) {
    try {
      await tickUser(user, report);
    } catch (e) {
      // One broken user (blocked bot, deleted chat) must not stop the rest.
      report.errors++;
      console.error(`tick failed for user ${user.id}:`, e?.description ?? e?.message ?? e);
    }
  }

  console.log('tick', JSON.stringify(report));
  return report;
}

async function tickUser(user, report) {
  const now = localNow(Date.now(), user.tzOffset);
  const chatId = user.tgId;

  // 1. A contract whose term ran out is closed and reported once.
  for (const { contract, progress } of await closeDueContracts(user, now.day)) {
    await send(chatId, view.contractClosedMessage(contract, progress));
    report.contracts++;
  }

  // 2. The weekly digest, and with it the quarantine questions — weekly, because
  //    a daily "are you still reading this?" is nagging, not help.
  const digestDue = now.dow === user.digestDow
    && now.minuteOfDay >= DIGEST_HOUR * 60
    && user.lastDigestDay !== now.day;

  if (digestDue) {
    await sendDigest(user, now.day);
    await updateUser(user.id, { lastDigestDay: now.day });
    report.digests++;
    report.quarantine += await askQuarantine(user, chatId);
  }

  // 3. The evening nudge, only on a day with nothing read.
  const at = hhmmToMinutes(user.remindAt);
  if (at != null && user.lastRemindDay !== now.day) {
    const due = now.minuteOfDay >= at && now.minuteOfDay <= at + REMINDER_GRACE_MINUTES;
    if (due) {
      const pages = await dayPages(user.id, now.day);
      if (pages === 0) {
        await sendReminder(user, chatId, now.day);
        report.reminders++;
      }
      // Marked either way: the question has been settled for today.
      await updateUser(user.id, { lastRemindDay: now.day });
    }
  }
}

async function sendReminder(user, chatId, day) {
  const book = await getActiveBook(user);
  const week = await weekSummary(user, day);
  // Translate the page floor into minutes, which is what the reader actually
  // has to find. Falls back to a conservative 40 pages/hour.
  const speedPagesPerHour = 40;
  const minutesHint = Math.max(5, Math.round((user.dailyMinPages / speedPagesPerHour) * 60));

  await send(chatId, view.reminderMessage({
    book,
    week,
    day: { min: user.dailyMinPages },
    minutesHint,
  }), { reply_markup: kb.remindKeyboard(book) });
}

async function sendDigest(user, today) {
  // The digest is about the week that just ended, not the one three hours old.
  const lastWeekDay = addDays(weekStart(today), -1);
  const week = await weekSummary(user, lastWeekDay, today);

  const prevStart = addDays(week.start, -7);
  const prevMap = await pagesByDay(user.id, prevStart, addDays(prevStart, 6));
  let prevPages = 0;
  for (const value of prevMap.values()) prevPages += value;

  const finished = (await finishedInYear(user.id, Number(today.slice(0, 4))))
    .filter((b) => {
      const d = dayKey(new Date(b.finishedAt).getTime(), user.tzOffset);
      return d >= week.start && d <= week.end;
    });

  const contract = await activeContract(user.id);

  await send(user.tgId, view.digestMessage({
    week,
    prevPages,
    series: await dailySeries(user.id, today, 28),
    year: await yearProgress(user, today),
    contract,
    contractProgress: contract ? await contractProgress(contract, today) : null,
    booksFinished: finished,
  }));
}

/** Ask about at most two forgotten books, so the digest does not turn into a list. */
async function askQuarantine(user, chatId) {
  const stale = (await staleBooks(user.id, Date.now(), QUARANTINE_IDLE_DAYS)).slice(0, 2);
  for (const book of stale) {
    const touched = new Date(book.lastProgressAt ?? book.createdAt ?? Date.now()).getTime();
    // Rounded, not floored: 19.9 days is '20 дней' to a reader.
    const idleDays = Math.max(QUARANTINE_IDLE_DAYS, Math.round((Date.now() - touched) / 86400000));
    await send(chatId, view.quarantineMessage(book, idleDays), {
      reply_markup: kb.quarantineKeyboard(book),
    });
    await updateBook(book.id, { quarantineAskedAt: new Date() });
  }
  return stale.length;
}

/** Exposed for tests and for `tgcloud run lib/tick single <tgId>` style debugging. */
export { tickUser };
