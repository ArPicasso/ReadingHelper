// POST /api/getDashboard — everything the Mini App draws, in one round trip.

import { requireUser } from '../lib/users.js';
import { buildDashboard } from '../lib/dashboard.js';

export default async function (input, ctx) {
  const user = await requireUser(ctx);
  return buildDashboard(user);
}
