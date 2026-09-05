/*
 * notify.js
 *
 * Owner-facing quota notifications. When a tenant's monthly usage crosses
 * 80 % and then 100 % of monthly_quota, the worker pings the homelab
 * subscribe service (products/subscribe-service/app.py, events quota_80 and
 * quota_100 in PING_EVENTS), which turns it into an ntfy line for the owner:
 *
 *   GET {QUOTA_PING_URL}?e=quota_80|quota_100&t={tenantId}&p={usage_percent}
 *
 * Each threshold fires once per tenant per calendar month, remembered in
 * the KV key quota-notified:{tenant}:{YYYY-MM}:{80|100} (ASISTENT_CACHE).
 * Nothing here can fail the chat request: chat.js schedules it with
 * ctx.waitUntil, every error is swallowed, and a KV read failure errs on the
 * side of pinging (a duplicate line in ntfy beats a missed warning).
 *
 * E-mail to the tenant is deliberately out of scope here.
 */

import { monthKey, usagePercent } from './tenants.js';

export const DEFAULT_QUOTA_PING_URL = 'https://homelab.tailbf8f27.ts.net/subscribe/api/ping';
export const QUOTA_THRESHOLDS = [80, 100];
// KV reminder lives a little longer than the longest month, so the "already
// notified" marker cannot expire mid-month; the key name carries the month,
// so a stale marker from last month never suppresses this month's ping.
export const QUOTA_NOTIFIED_TTL_SECONDS = 40 * 24 * 60 * 60;

export function quotaNotifiedKey(tenantId, month, threshold) {
  return `quota-notified:${tenantId}:${month}:${threshold}`;
}

/**
 * Which of QUOTA_THRESHOLDS did the counter cross when it moved from
 * `usedBefore` to `usedAfter` out of `quota`? A threshold counts as crossed
 * when the percentage was below it before and at or above it after, so a
 * single jump (e.g. an admin lowering the quota under the current usage)
 * can return both 80 and 100 at once, in ascending order.
 */
export function thresholdsCrossed(usedBefore, usedAfter, quota) {
  const before = usagePercent(usedBefore, quota);
  const after = usagePercent(usedAfter, quota);
  return QUOTA_THRESHOLDS.filter((t) => before < t && after >= t);
}

export function buildQuotaPingUrl(baseUrl, { event, tenantId, percent }) {
  const url = new URL(baseUrl);
  url.searchParams.set('e', event);
  url.searchParams.set('t', tenantId);
  url.searchParams.set('p', String(percent));
  return url.toString();
}

/**
 * Fire the quota_80 / quota_100 pings that `usedBefore` -> `usedAfter` just
 * crossed, once per tenant per month. Resolves to the list of events that
 * were actually sent (for logging and tests); never rejects.
 *
 * `env` needs ASISTENT_CACHE (KV) and may carry QUOTA_PING_URL (an empty
 * string disables pinging entirely) and fetchImpl (tests). Threshold
 * markers are written before the ping goes out, so two concurrent requests
 * crossing the same threshold at the same moment race only on KV, the same
 * best-effort behaviour as the rate limiter, never on the counter itself.
 */
export async function maybeNotifyQuota(env, { tenantId, usedBefore, usedAfter, quota, now = new Date() } = {}) {
  const sent = [];
  try {
    const baseUrl = env && env.QUOTA_PING_URL !== undefined ? env.QUOTA_PING_URL : DEFAULT_QUOTA_PING_URL;
    if (!baseUrl || !tenantId) return sent;

    const crossed = thresholdsCrossed(usedBefore, usedAfter, quota);
    if (crossed.length === 0) return sent;

    const kv = env.ASISTENT_CACHE;
    const fetchImpl = env.fetchImpl || fetch;
    const month = monthKey(now);
    const percent = usagePercent(usedAfter, quota);

    for (const threshold of crossed) {
      const key = quotaNotifiedKey(tenantId, month, threshold);
      let alreadyNotified = false;
      if (kv) {
        try {
          alreadyNotified = (await kv.get(key)) != null;
        } catch (err) {
          console.warn('[arling-asistent] quota-notified KV get failed, pinging anyway:', (err && err.message) || err);
        }
      }
      if (alreadyNotified) continue;

      if (kv) {
        try {
          await kv.put(key, now.toISOString(), { expirationTtl: QUOTA_NOTIFIED_TTL_SECONDS });
        } catch (err) {
          console.warn('[arling-asistent] quota-notified KV put failed:', (err && err.message) || err);
        }
      }

      const event = `quota_${threshold}`;
      try {
        const res = await fetchImpl(buildQuotaPingUrl(baseUrl, { event, tenantId, percent }), { method: 'GET' });
        if (res && res.ok === false) {
          console.warn(`[arling-asistent] quota ping ${event} for ${tenantId} returned HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(`[arling-asistent] quota ping ${event} for ${tenantId} failed:`, (err && err.message) || err);
      }
      sent.push(event);
    }
  } catch (err) {
    console.warn('[arling-asistent] quota notification failed:', (err && err.message) || err);
  }
  return sent;
}
