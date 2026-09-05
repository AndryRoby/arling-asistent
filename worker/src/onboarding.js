/*
 * onboarding.js
 *
 * Self-serve tenant creation: POST /v1/tenants {feed_url, domain, email}
 * validates the input, creates a 'pending' tenant row, and kicks off feed
 * ingestion (download, normalise, embed, upsert to Vectorize) in the
 * background via ctx.waitUntil so the HTTP response does not wait for the
 * whole feed to be embedded. GET /v1/tenants/:id/status lets the demo page
 * poll until ingestion finishes, and gives the shop's dashboard its monthly
 * usage (see tenantStatusResponse for the public contract).
 */

import {
  createTenant,
  setTenantStatus,
  setProductCount,
  setFeedUrl,
  setTenantPlan,
  getTenantById,
  getTenantByDomain,
  ValidationError,
  DuplicateDomainError,
  D1ConstraintError,
  PLANS,
  conversationsUsedThisMonth,
  monthPeriod,
  usagePercent,
  publicPlanName,
} from './tenants.js';
import { fetchFeed } from './feed.js';
import { embedAndUpsertProducts } from './embed.js';
import { parseAllowedOrigins, corsHeaders } from './security.js';

export const TENANT_STATUS = {
  PENDING: 'pending',
  READY: 'ready',
  ERROR: 'error',
};

// How long a tenant can go without a successful ingestion before a repeat
// POST /v1/tenants for its domain (see createTenantFromRequest) triggers a
// fresh one on its own, even if the feed URL did not change.
const REINGEST_IF_STALE_MS = 24 * 60 * 60 * 1000;

function isIngestionStale(tenant, now) {
  // A tenant stuck on 'error' (e.g. the feed URL was briefly broken) is
  // always worth retrying on resubmission, regardless of the 24h window:
  // setTenantStatus stamps last_ingested_at on a failed attempt too (see
  // ingestFeedForTenant's catch branch), so relying on that timestamp alone
  // would treat a just-failed tenant as "fresh" and never retry it.
  if (tenant.status === TENANT_STATUS.ERROR) return true;
  if (!tenant.last_ingested_at) return true;
  return now.getTime() - new Date(tenant.last_ingested_at).getTime() > REINGEST_IF_STALE_MS;
}

/** Download the tenant's feed, embed every product, and flip status to ready/error. Safe to call again (re-ingestion on cron). */
export async function ingestFeedForTenant(env, tenant) {
  try {
    const { products, type, truncated } = await fetchFeed(tenant.feed_url, { fetchImpl: env.fetchImpl || fetch });
    const summary = await embedAndUpsertProducts(env, tenant.id, products);
    await setProductCount(env.DB, tenant.id, summary.productCount);
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.READY);
    return { ok: true, feedType: type, truncated, ...summary };
  } catch (err) {
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** Kick off ingestion via ctx.waitUntil when available; otherwise await it inline (e.g. in tests, with no Workers ctx). */
async function startIngestion(env, tenant, waitUntil) {
  const ingestion = ingestFeedForTenant(env, tenant);
  if (typeof waitUntil === 'function') {
    waitUntil(ingestion);
  } else {
    await ingestion;
  }
}

/**
 * POST /v1/tenants handler logic. `waitUntil` is Workers' ctx.waitUntil (or
 * a synchronous test stub).
 *
 * Idempotent on domain: `domain` is UNIQUE in schema.sql, so a second
 * self-serve submission for a domain that already has a tenant (a shop
 * owner re-running the onboarding form, for example) must not surface as a
 * hard failure. Instead this looks up the existing tenant and returns it
 * (flagged `existing: true`), refreshing it in the background when the
 * submitted feed_url differs from what is stored, or the last successful
 * ingestion is more than 24h old (or never happened), either way using the
 * same ingestFeedForTenant() the cron and admin re-ingest endpoint use, not
 * a separate code path. The stored contact_email of the existing tenant is
 * never part of the return value, since the caller resubmitting the form is
 * not necessarily the shop's original owner.
 */
export async function createTenantFromRequest(env, { feedUrl, domain, email }, { waitUntil, now = new Date() } = {}) {
  let tenant;
  try {
    tenant = await createTenant(env.DB, { domain, feedUrl, contactEmail: email });
  } catch (err) {
    if (!(err instanceof DuplicateDomainError)) throw err;

    const existing = await getTenantByDomain(env.DB, domain);
    if (!existing) throw err; // should not happen (the row that caused the conflict must exist), but never swallow silently

    const cleanFeedUrl = String(feedUrl || '').trim();
    const feedUrlChanged = cleanFeedUrl && cleanFeedUrl !== existing.feed_url;
    if (feedUrlChanged) {
      await setFeedUrl(env.DB, existing.id, cleanFeedUrl);
      existing.feed_url = cleanFeedUrl;
    }
    if (feedUrlChanged || isIngestionStale(existing, now)) {
      await startIngestion(env, existing, waitUntil);
    }

    return {
      id: existing.id,
      domain: existing.domain,
      status: existing.status,
      plan: existing.plan,
      monthly_quota: existing.monthly_quota,
      existing: true,
    };
  }

  await startIngestion(env, tenant, waitUntil);
  return tenant;
}

/**
 * The public GET /v1/tenants/:id/status body. The tenant id sits in the
 * embed script of every shop page, so this is a public capability: it
 * carries usage and plan facts the shop's own dashboard needs, and never
 * contact_email or billing_ref (the Stripe subscription id). Those stay
 * available to the admin-token routes only (`includeBilling`, used by
 * handleSetPlanRoute below).
 *
 * Contract (shared with the arling.sk dashboard page):
 *   { id, domain, plan ("free"|"starter"|"pro"), status, monthly_quota,
 *     conversations_used (current UTC calendar month), usage_percent
 *     (integer 0..100), period_start ("YYYY-MM-01"), period_end (first day
 *     of next month), product_count, valid_until (or null), last_ingest
 *     (ISO or null) }
 * `used_this_month` and `last_ingested_at` are kept as aliases of
 * conversations_used / last_ingest for the WordPress plugin and the Shopify
 * admin page, which still read the older names.
 */
export async function tenantStatusResponse(env, tenantId, { now = new Date(), includeBilling = false } = {}) {
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return null;
  const conversationsUsed = conversationsUsedThisMonth(tenant, now);
  const period = monthPeriod(now);
  const lastIngest = tenant.last_ingested_at || null;
  const body = {
    id: tenant.id,
    domain: tenant.domain,
    plan: publicPlanName(tenant.plan),
    status: tenant.status,
    monthly_quota: tenant.monthly_quota,
    conversations_used: conversationsUsed,
    usage_percent: usagePercent(conversationsUsed, tenant.monthly_quota),
    period_start: period.period_start,
    period_end: period.period_end,
    product_count: tenant.product_count || 0,
    // Null until a PATCH /v1/tenants/:id/plan call sets it (see
    // handleSetPlanRoute below): a free/never-upgraded tenant has no expiry.
    valid_until: tenant.valid_until || null,
    last_ingest: lastIngest,
    used_this_month: conversationsUsed,
    last_ingested_at: lastIngest,
  };
  if (includeBilling) {
    body.billing_ref = tenant.billing_ref || null;
  }
  return body;
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
    // A repeat submission for an already-known domain (see
    // createTenantFromRequest's DuplicateDomainError handling) is not an
    // error: it comes back here as the existing tenant with `existing: true`
    // set, and gets 200 instead of 201, same shape otherwise.
    if (tenant.existing) {
      return jsonResponse({ id: tenant.id, domain: tenant.domain, status: tenant.status, plan: tenant.plan, monthly_quota: tenant.monthly_quota, existing: true }, 200, headers);
    }
    return jsonResponse({ id: tenant.id, domain: tenant.domain, status: tenant.status, plan: tenant.plan, monthly_quota: tenant.monthly_quota }, 201, headers);
  } catch (err) {
    const headers = corsHeadersForRequest(request, env);
    if (err instanceof ValidationError) {
      return jsonResponse({ error: 'validation_failed', issues: err.issues }, 400, headers);
    }
    // Any D1 constraint violation that is not the domain-uniqueness case
    // above (which createTenantFromRequest already turns into a 200/201, not
    // an error at all) is the caller's fault in some other way, not ours:
    // 409, not a generic 500.
    if (err instanceof D1ConstraintError) {
      return jsonResponse({ error: 'conflict' }, 409, headers);
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

// ---------------------------------------------------------------------------
// Admin: set plan / quota (PATCH or POST /v1/tenants/:id/plan)
// ---------------------------------------------------------------------------

const VALID_PLANS = new Set([PLANS.FREE, PLANS.STARTER, PLANS.PRO]);

/**
 * The one place a paid plan actually changes what a tenant is allowed to
 * use. Body: {plan: "free"|"starter"|"pro", monthly_quota?, billing_ref?,
 * valid_until?}. `monthly_quota` defaults to the plan's normal quota (see
 * DEFAULT_QUOTAS in tenants.js) when omitted; `billing_ref` and
 * `valid_until` are stored as-is (or cleared to null when omitted, e.g. a
 * downgrade to `free` clears a stale subscription id/expiry).
 *
 * This is what licence-service/app.py's Stripe webhook calls (with its own
 * ASISTENT_ADMIN_TOKEN, matching this worker's ADMIN_TOKEN) whenever a
 * checkout or renewal for an "asistent-*" plan arrives, and what the daily
 * expire_asistent_plans() cron there calls (with plan: "free") once
 * valid_until has passed. Same admin-token protection as
 * handleReingestRoute above: without ADMIN_TOKEN configured, every request
 * is refused, never silently allowed through.
 */
export async function handleSetPlanRoute(request, env, tenantId) {
  const headers = corsHeadersForRequest(request, env);
  const providedToken = request.headers.get('X-Admin-Token') || '';
  if (!env.ADMIN_TOKEN || providedToken !== env.ADMIN_TOKEN) {
    return jsonResponse({ error: 'unauthorized' }, 401, headers);
  }

  let body;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400, headers);
  }

  const plan = body && body.plan;
  if (!VALID_PLANS.has(plan)) {
    return jsonResponse({ error: 'validation_failed', issues: ['plan must be one of free, starter, pro'] }, 400, headers);
  }

  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return jsonResponse({ error: 'not_found' }, 404, headers);

  const rawQuota = body && body.monthly_quota;
  const monthlyQuota = typeof rawQuota === 'number' && Number.isFinite(rawQuota) && rawQuota > 0 ? rawQuota : undefined;
  const billingRef = body && body.billing_ref != null ? String(body.billing_ref) : null;
  const validUntil = body && body.valid_until != null ? String(body.valid_until) : null;

  await setTenantPlan(env.DB, tenantId, { plan, monthlyQuota, billingRef, validUntil });

  // Admin caller (licence-service webhook): echo billing_ref back so it can
  // confirm what was stored. The public status route never includes it.
  const updated = await tenantStatusResponse(env, tenantId, { includeBilling: true });
  return jsonResponse(updated, 200, headers);
}
