// The two commitments layered over the weekly quota: a 30-day contract and a
// books-per-year goal.

import { db } from 'sdk';
import { and, desc, eq } from 'sdk/db';
import { contracts } from '../schema.js';
import { addDays, daysBetween, yearOf } from './time.js';
import { pagesByDay } from './progress.js';
import { finishedInYear } from './books.js';

export async function activeContract(userId) {
  return db
    .select()
    .from(contracts)
    .where(and(eq(contracts.userId, userId), eq(contracts.status, 'active')))
    .orderBy(desc(contracts.id))
    .get();
}

/**
 * Start a commitment. The terms are copied in, so later raising or lowering the
 * goal cannot retroactively rewrite how well this contract was kept.
 */
export async function startContract(user, today, days = 30) {
  const [row] = await db
    .insert(contracts)
    .values({
      userId: user.id,
      startDay: today,
      endDay: addDays(today, days - 1),
      days,
      dailyMinPages: user.dailyMinPages,
      weeklyGoalPages: user.weeklyGoalPages,
      status: 'active',
    })
    .returning();
  return row;
}

export async function cancelContract(contract) {
  await db
    .update(contracts)
    .set({ status: 'cancelled', closedAt: new Date() })
    .where(eq(contracts.id, contract.id));
}

/** How the contract is going as of `today`. */
export async function contractProgress(contract, today) {
  const lastCounted = today < contract.endDay ? today : contract.endDay;
  const elapsed = Math.max(0, daysBetween(contract.startDay, lastCounted) + 1);
  const map = await pagesByDay(contract.userId, contract.startDay, lastCounted);

  let met = 0;
  let pages = 0;
  for (let i = 0; i < elapsed; i++) {
    const p = map.get(addDays(contract.startDay, i)) ?? 0;
    pages += p;
    if (p >= contract.dailyMinPages) met++;
  }

  return {
    elapsed,
    met,
    missed: elapsed - met,
    pages,
    daysLeft: Math.max(0, daysBetween(today, contract.endDay)),
    adherence: elapsed > 0 ? Math.round((met / elapsed) * 100) : 0,
    done: today > contract.endDay,
  };
}

/** Close any contract whose term has run out; returns the closed ones. */
export async function closeDueContracts(user, today) {
  const closed = [];
  const contract = await activeContract(user.id);
  if (contract && today > contract.endDay) {
    const progress = await contractProgress(contract, today);
    await db
      .update(contracts)
      .set({ status: 'completed', adherence: progress.adherence, closedAt: new Date() })
      .where(eq(contracts.id, contract.id));
    closed.push({ contract, progress });
  }
  return closed;
}

export async function yearProgress(user, today) {
  const year = yearOf(today);
  const finished = await finishedInYear(user.id, year);
  return {
    year,
    done: finished.length,
    goal: user.yearGoalBooks,
    books: finished,
  };
}
