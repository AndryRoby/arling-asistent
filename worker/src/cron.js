/*
 * cron.js
 *
 * Scheduled handler (wrangler.toml [triggers] crons), two schedules:
 *
 *   "0 3 * * *"     Refreshes every tenant's product feed once a day:
 *                   re-downloads the feed, re-embeds, and re-upserts into
 *                   Vectorize (Vectorize upsert overwrites vectors with the
 *                   same id, so this naturally handles price/availability/
 *                   description changes without needing a separate delete
 *                   pass for unchanged products). Then the daily lifecycle
 *                   upkeep (zivotny-cyklus.js dennaUdrzba: old events, and
 *                   only with ASISTENT_MAZANIE = "zapnute" unused free accounts).
 *   "*\/10 * * * *" Lifecycle catch-up every 10 minutes (zivotny-cyklus.js
 *                   dobeh): unsent e-mails, delayed E0 and WordPress E1, E2,
 *                   the 72-hour E3, and the "aktivny" event.
 */

import { listTenants } from './tenants.js';
import { ingestFeedForTenant } from './onboarding.js';
import { dobeh, dennaUdrzba } from './zivotny-cyklus.js';

export const CRON_DENNY = '0 3 * * *';
export const CRON_DOBEH = '*/10 * * * *';

/** Refresh every tenant's feed. Returns a per-tenant outcome array (used in logs/tests). */
export async function refreshAllFeeds(env) {
  const tenants = await listTenants(env.DB);
  const outcomes = [];
  for (const tenant of tenants) {
    try {
      const result = await ingestFeedForTenant(env, tenant);
      outcomes.push({ tenantId: tenant.id, ...result });
    } catch (err) {
      outcomes.push({ tenantId: tenant.id, ok: false, error: String((err && err.message) || err) });
    }
  }
  return outcomes;
}

async function dennyBeh(env) {
  const outcomes = await refreshAllFeeds(env);
  await dennaUdrzba(env);
  return outcomes;
}

export default {
  async scheduled(event, env, ctx) {
    // Starý jediný spúšťač nemal event.cron porovnávaný vôbec; čokoľvek iné
    // než 10-minútový beh je preto denný beh, ako doteraz.
    if (event && event.cron === CRON_DOBEH) {
      ctx.waitUntil(dobeh(env));
      return;
    }
    ctx.waitUntil(dennyBeh(env));
  },
};
