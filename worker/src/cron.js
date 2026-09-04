/*
 * cron.js
 *
 * Scheduled handler (wrangler.toml [triggers] crons) that refreshes every
 * tenant's product feed once a day: re-downloads the feed, re-embeds, and
 * re-upserts into Vectorize (Vectorize upsert overwrites vectors with the
 * same id, so this naturally handles price/availability/description
 * changes without needing a separate delete pass for unchanged products).
 */

import { listTenants } from './tenants.js';
import { ingestFeedForTenant } from './onboarding.js';

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAllFeeds(env));
  },
};
