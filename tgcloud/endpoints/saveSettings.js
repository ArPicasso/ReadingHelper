// POST /api/saveSettings — goals, reminder time and timezone from the Mini App.

import { EndpointError } from 'sdk';
import { requireUser, updateUser } from '../lib/users.js';
import { buildDashboard } from '../lib/dashboard.js';
import { hhmmToMinutes } from '../lib/time.js';

export default async function (input, ctx) {
  const user = await requireUser(ctx);
  const patch = {};

  const ints = {
    weeklyGoalPages: [1, 10000],
    dailyMinPages: [1, 1000],
    yearGoalBooks: [1, 365],
  };
  for (const [key, [min, max]] of Object.entries(ints)) {
    if (input?.[key] == null) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new EndpointError(`Недопустимое значение: ${key}`, { code: 'BAD_VALUE', field: key });
    }
    patch[key] = Math.round(n);
  }

  if ('remindAt' in (input ?? {})) {
    const value = input.remindAt;
    if (value === null || value === '' || value === 'off') patch.remindAt = null;
    else if (hhmmToMinutes(value) != null) patch.remindAt = value;
    else throw new EndpointError('Время в формате 21:00', { code: 'BAD_TIME', field: 'remindAt' });
  }

  if (input?.tzOffset != null) {
    const n = Number(input.tzOffset);
    if (!Number.isInteger(n) || n < -840 || n > 840) {
      throw new EndpointError('Недопустимый часовой пояс', { code: 'BAD_VALUE', field: 'tzOffset' });
    }
    patch.tzOffset = n;
  }

  if (Object.keys(patch).length) await updateUser(user.id, patch);
  return buildDashboard({ ...user, ...patch });
}
