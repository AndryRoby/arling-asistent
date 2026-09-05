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
import { parseAllowedOrigins, corsHeaders } from './security.js';

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

function jsonResponse(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * CORS headers for one of this module's responses, using the same allowlist
 * (and the same security.js helpers) as chat.js: the ALLOWED_ORIGINS env var
 * plus, when known, the tenant's own domain. Every JSON response this module
 * returns must go through this so a browser can actually read the response
 * (previously only the router's OPTIONS preflight carried CORS headers, so
 * the real POST/GET responses were silently blocked by the browser even
 * though the preflight said they would be allowed).
 */
function corsHeadersForRequest(request, env, extraAllowedDomains = []) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  return corsHeaders(origin, [...extraAllowedDomains, ...allowed]) || {};
}

export async function handleCreateTenantRoute(request, env, ctx) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400, corsHeadersForRequest(request, env));
  }
  try {
    const tenant = await createTenantFromRequest(
      env,
      { feedUrl: body && body.feed_url, domain: body && body.domain, email: body && body.email },
      { waitUntil: ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : undefined }
    );
    const headers = corsHeadersForRequest(request, env, [tenant.domain]);
    return jsonResponse({ id: tenant.id, domain: tenant.domain, status: tenant.status, plan: tenant.plan, monthly_quota: tenant.monthly_quota }, 201, headers);
  } catch (err) {
    const headers = corsHeadersForRequest(request, env);
    if (err instanceof ValidationError) {
      return jsonResponse({ error: 'validation_failed', issues: err.issues }, 400, headers);
    }
    return jsonResponse({ error: 'internal_error' }, 500, headers);
  }
}

export async function handleTenantStatusRoute(request, env, tenantId) {
  const status = await tenantStatusResponse(env, tenantId);
  const headers = corsHeadersForRequest(request, env, status ? [status.domain] : []);
  if (!status) return jsonResponse({ error: 'not_found' }, 404, headers);
  return jsonResponse(status, 200, headers);
}

// ---------------------------------------------------------------------------
// Admin: manual re-ingestion (POST /v1/tenants/:id/reingest)
// ---------------------------------------------------------------------------

/**
 * Re-run feed ingestion for one tenant on demand, e.g. right after fixing a
 * feed URL, or after creating a Vectorize metadata index that did not exist
 * at the tenant's original onboarding time. Uses the exact same
 * ingestFeedForTenant() the daily cron calls (see cron.js), so this is not a
 * separate code path to keep in sync.
 *
 * Protected by a shared secret header (not tenant- or session-based auth,
 * since this MVP has no admin login yet): the caller must send
 * `X-Admin-Token` matching the `ADMIN_TOKEN` secret
 * (`wrangler secret put ADMIN_TOKEN`, see README). If that secret is not
 * configured at all, the route refuses every request rather than silently
 * allowing unauthenticated re-ingestion.
 */
export async function handleReingestRoute(request, env, tenantId) {
  const headers = corsHeadersForRequest(request, env);
  const providedToken = request.headers.get('X-Admin-Token') || '';
  if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
    return jsonResponse({ error: 'unauthorized' }, 401, headers);
  }

  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return jsonResponse({ error: 'not_found' }, 404, headers);

  const result = await ingestFeedForTenant(env, tenant);
  return jsonResponse(result, result.ok ? 200 : 502, headers);
}
