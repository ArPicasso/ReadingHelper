// User records and the small dialog state machine.

import { db, EndpointError } from 'sdk';
import { eq } from 'sdk/db';
import { users } from '../schema.js';

/** Find or create the user behind an update. */
export async function ensureUser(from) {
  const found = await db.select().from(users).where(eq(users.tgId, from.id)).get();
  if (found) {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, found.id));
    return found;
  }
  const [created] = await db
    .insert(users)
    .values({
      tgId: from.id,
      firstName: from.first_name ?? null,
      lastSeenAt: new Date(),
    })
    .returning();
  return created;
}

export async function getUserByTgId(tgId) {
  return db.select().from(users).where(eq(users.tgId, tgId)).get();
}

export async function updateUser(userId, fields) {
  await db.update(users).set(fields).where(eq(users.id, userId));
}

/**
 * The bot is almost stateless: the only pending states are the few questions it
 * asks, e.g. { kind: 'await_pages', bookId }.
 */
export async function setState(userId, state) {
  await db.update(users).set({ state }).where(eq(users.id, userId));
}

export async function clearState(userId) {
  await db.update(users).set({ state: null }).where(eq(users.id, userId));
}

/** Everyone with reminders or digests switched on — the scheduler's working set. */
export async function usersForTick() {
  return db.select().from(users).where(eq(users.onboarded, true)).all();
}

/**
 * Resolve the Mini App caller. The platform has already verified `ctx.initData`,
 * so the user id can be trusted — but the person still has to exist here, which
 * only happens after /start in the chat.
 */
export async function requireUser(ctx) {
  const tg = ctx?.initData?.user;
  if (!tg?.id) throw new EndpointError('Не удалось определить пользователя', { code: 'NO_USER' });
  const found = await getUserByTgId(tg.id);
  if (!found) throw new EndpointError('Открой чат с ботом и нажми /start', { code: 'NOT_REGISTERED' });
  return found;
}
