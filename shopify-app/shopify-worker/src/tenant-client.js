/*
 * tenant-client.js
 *
 * Thin HTTP client for the existing ARLing Asistent tenant API (see
 * ../../../worker/src/onboarding.js and README.md in the parent product).
 * Nothing here is Shopify-specific: it is the same POST /v1/tenants /
 * GET /v1/tenants/:id/status contract every distribution channel (the
 * WordPress plugin, the demo page's trial form, and now this Shopify app)
 * calls the same way, pointed at `env.ARLING_API_BASE`.
 */

function normaliseResult(status, body) {
  if (status === 200 || status === 201) {
    return { ok: true, data: body };
  }
  return {
    ok: false,
    status,
    error: (body && body.error) || `http_${status}`,
    issues: (body && body.issues) || [],
  };
}

/**
 * POST /v1/tenants {feed_url, domain, email} -> {id, domain, status, plan, monthly_quota}.
 *
 * Idempotent on domain (see ../../../worker/src/onboarding.js
 * createTenantFromRequest): resubmitting for a shop that already has a
 * tenant returns 200 (not 201) with the existing tenant and `existing:
 * true` set, instead of a validation/conflict error, which is exactly what
 * this app needs for a shop that reinstalls or whose OAuth callback runs
 * twice - normaliseResult() below treats 200 and 201 identically, so
 * callers (see index.js provisionTenant) do not need to branch on which one
 * came back, only on `result.data.existing` if they care.
 */
export async function createTenant(env, { feedUrl, domain, email }, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${env.ARLING_API_BASE.replace(/\/$/, '')}/v1/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feed_url: feedUrl, domain, email }),
  });
  const body = await res.json().catch(() => ({}));
  return normaliseResult(res.status, body);
}

/** GET /v1/tenants/:id/status -> {id, domain, status, plan, monthly_quota, used_this_month, product_count, last_ingested_at}. */
export async function getTenantStatus(env, tenantId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${env.ARLING_API_BASE.replace(/\/$/, '')}/v1/tenants/${encodeURIComponent(tenantId)}/status`);
  const body = await res.json().catch(() => ({}));
  return normaliseResult(res.status, body);
}
