/*
 * webhooks.js
 *
 * HMAC-verified Shopify webhook handlers:
 *
 *   POST /webhooks/app/uninstalled          - app/uninstalled
 *   POST /webhooks/customers/data_request   - mandatory compliance topic
 *   POST /webhooks/customers/redact         - mandatory compliance topic
 *   POST /webhooks/shop/redact              - mandatory compliance topic
 *
 * Every handler here follows the same shape Shopify requires of all
 * webhook endpoints (see shopify.dev "Privacy law compliance" and
 * "Webhooks"): verify `X-Shopify-Hmac-Sha256` over the *raw* body first and
 * return 401 immediately if it does not match (crypto-utils.js
 * verifyWebhookHmac); otherwise acknowledge with a 200-series response as
 * fast as possible (Shopify retries on non-2xx and on timeout), and do any
 * slower cleanup work via `waitUntil` rather than blocking the response.
 *
 * Data-handling note for the two customer-data topics: this app never
 * stores conversation content or any customer-identifying data (same
 * architecture as the core ARLing Asistent product, see worker/src/tenants.js
 * in the parent product: only anonymous daily counters exist). So
 * customers/data_request has nothing to hand back beyond acknowledging the
 * request, and customers/redact has nothing to delete beyond acknowledging
 * it; both still must respond 200 within Shopify's window, which is what
 * they do below.
 */

import { verifyWebhookHmac } from './crypto-utils.js';
import { markShopUninstalled, purgeShop } from './shops.js';

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Shared entry point for every webhook route: verifies the HMAC over the
 * raw body, parses JSON only after that succeeds, and calls `handler(env,
 * payload, ctx)` which must return a Response. Centralising this means a
 * bad HMAC can never reach any handler's business logic.
 */
export async function withVerifiedWebhook(request, env, ctx, handler) {
  const rawBody = await request.text();
  const headerHmac = request.headers.get('X-Shopify-Hmac-Sha256') || request.headers.get('X-Shopify-Hmac-SHA256') || '';
  const ok = await verifyWebhookHmac(rawBody, headerHmac, env.SHOPIFY_API_SECRET);
  if (!ok) {
    return jsonResponse({ error: 'invalid_hmac' }, 401);
  }
  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  return handler(env, payload, ctx);
}

/** app/uninstalled: the offline token is already dead; drop it locally and stop billing for this shop. Runs on `waitUntil` friendly D1 write, but Shopify still gets its 200 immediately. */
export async function handleAppUninstalled(env, payload) {
  const domain = payload && payload.domain;
  if (domain) {
    await markShopUninstalled(env.DB, domain);
  }
  return jsonResponse({ ok: true }, 200);
}

/**
 * customers/data_request: Shopify asks the app to hand the store owner any
 * data it holds about one customer. This app holds none (no conversation
 * content, no per-visitor identifiers, see module doc above), so the only
 * correct response is to acknowledge with nothing to disclose.
 */
export async function handleCustomersDataRequest(env, payload) {
  return jsonResponse({ ok: true, data_held: false }, 200);
}

/**
 * customers/redact: Shopify asks the app to delete/redact one customer's
 * data. As above, this app never stored any customer-identifying data to
 * begin with, so there is nothing to redact; still acknowledge with 200
 * inside Shopify's 30-day window per shopify.dev "Privacy law compliance".
 */
export async function handleCustomersRedact(env, payload) {
  return jsonResponse({ ok: true, redacted: false, reason: 'no_customer_data_stored' }, 200);
}

/**
 * shop/redact: sent ~48 hours after uninstall. Purge this app's entire
 * local row for the shop (access token was already cleared by
 * app/uninstalled, but the row itself, cached feed, settings, tenant
 * mapping all go now). Known gap (see README): the ARLing Asistent tenant
 * API has no delete endpoint yet, so the tenant record and its Vectorize
 * embeddings on the ARLing side are not removed by this call.
 */
export async function handleShopRedact(env, payload) {
  const domain = payload && payload.shop_domain;
  if (domain) {
    await purgeShop(env.DB, domain);
  }
  return jsonResponse({ ok: true }, 200);
}

export const COMPLIANCE_HANDLERS = {
  'customers/data_request': handleCustomersDataRequest,
  'customers/redact': handleCustomersRedact,
  'shop/redact': handleShopRedact,
};

/**
 * All three mandatory compliance topics share one webhook subscription
 * (shopify.app.toml `[[webhooks.subscriptions]] compliance_topics = [...]`
 * with a single `uri`), so Shopify posts all of them to the same route and
 * identifies which one with the `X-Shopify-Topic` header. This looks that
 * header up in COMPLIANCE_HANDLERS and calls the matching handler, or
 * returns 404 for an unrecognised topic.
 */
export async function dispatchComplianceWebhook(request, env, ctx) {
  const topic = request.headers.get('X-Shopify-Topic') || '';
  const handler = COMPLIANCE_HANDLERS[topic];
  if (!handler) {
    return new Response(JSON.stringify({ error: 'unknown_topic' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  return withVerifiedWebhook(request, env, ctx, handler);
}
