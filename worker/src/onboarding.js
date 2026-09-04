/*
 * onboarding.js
 *
 * Self-serve tenant creation: POST /v1/tenants {feed_url, domain, email}
 * validates the input, creates a 'pending' tenant row, and kicks off feed
 * ingestion (download, normalise, embed, upsert to Vectorize) in the
 * background via ctx.waitUntil so the HTTP response does not wait for the
 * whole feed to be embedded. GET /v1/tenants/:id/status lets the demo page
 * poll until ingestion finishes.
 */

import { createTenant, setTenantStatus, getTenantById, ValidationError } from './tenants.js';
import { fetchFeed } from './feed.js';
import { embedAndUpsertProducts } from './embed.js';

export const TENANT_STATUS = {
  PENDING: 'pending',
  READY: 'ready',
  ERROR: 'error',
};

/** Download the tenant's feed, embed every product, and flip status to ready/error. Safe to call again (re-ingestion on cron). */
export async function ingestFeedForTenant(env, tenant) {
  try {
    const { products, type, truncated } = await fetchFeed(tenant.feed_url, { fetchImpl: env.fetchImpl || fetch });
    const summary = await embedAndUpsertProducts(env, tenant.id, products);
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.READY);
    return { ok: true, feedType: type, truncated, ...summary };
  } catch (err) {
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** POST /v1/tenants handler logic. `waitUntil` is Workers' ctx.waitUntil (or a synchronous test stub). */
export async function createTenantFromRequest(env, { feedUrl, domain, email }, { waitUntil } = {}) {
  const tenant = await createTenant(env.DB, { domain, feedUrl, contactEmail: email });
  const ingestion = ingestFeedForTenant(env, tenant);
  if (typeof waitUntil === 'function') {
    waitUntil(ingestion);
  } else {
    await ingestion; // no ctx available (e.g. tests): just await inline
  }
  return tenant;
}

export async function tenantStatusResponse(env, tenantId) {
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return null;
  return {
    id: tenant.id,
    domain: tenant.domain,
    status: tenant.status,
    plan: tenant.plan,
    monthly_quota: tenant.monthly_quota,
    used_this_month: tenant.used_this_month,
    last_ingested_at: tenant.last_ingested_at,
  };
}

// ---------------------------------------------------------------------------
// HTTP route glue
// ---------------------------------------------------------------------------

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function handleCreateTenantRoute(request, env, ctx) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  try {
    const tenant = await createTenantFromRequest(
      env,
      { feedUrl: body && body.feed_url, domain: body && body.domain, email: body && body.email },
      { waitUntil: ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : undefined }
    );
    return jsonResponse({ id: tenant.id, domain: tenant.domain, status: tenant.status, plan: tenant.plan, monthly_quota: tenant.monthly_quota }, 201);
  } catch (err) {
    if (err instanceof ValidationError) {
      return jsonResponse({ error: 'validation_failed', issues: err.issues }, 400);
    }
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

export async function handleTenantStatusRoute(request, env, tenantId) {
  const status = await tenantStatusResponse(env, tenantId);
  if (!status) return jsonResponse({ error: 'not_found' }, 404);
  return jsonResponse(status, 200);
}
