/*
 * session-token.js
 *
 * Verifies the App Bridge session (ID) token embedded admin API calls carry
 * in their `Authorization: Bearer <token>` header. This is the mechanism
 * shopify.dev requires embedded apps to use instead of cookies/localStorage
 * (see shopify.dev "Session tokens" and the App Store review requirement
 * "use session tokens for authenticating admin requests").
 *
 * The signature/claims check itself lives in crypto-utils.js
 * (verifySessionToken) so it can be unit-tested with a hand-built JWT and no
 * Shopify runtime at all; this module only adds the HTTP-layer glue (header
 * extraction, shop-domain derivation from `dest`, a uniform 401 response).
 */

import { verifySessionToken } from './crypto-utils.js';

export function extractBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

/** Derive the shop's *.myshopify.com domain from a verified token's `dest` claim (a full origin, e.g. "https://my-shop.myshopify.com"). */
export function shopDomainFromPayload(payload) {
  const dest = String((payload && payload.dest) || '');
  return dest.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Require a valid session token on an /app/api/* request. Returns
 * `{ ok: true, shop, payload }` or `{ ok: false, response }` where
 * `response` is a ready-to-return 401 Response, so route handlers can do:
 *
 *   const auth = await requireSessionToken(request, env);
 *   if (!auth.ok) return auth.response;
 */
export async function requireSessionToken(request, env) {
  const token = extractBearerToken(request);
  const result = await verifySessionToken(token, { apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET });
  if (!result.valid) {
    return { ok: false, response: new Response(JSON.stringify({ error: 'invalid_session_token', reason: result.error }), { status: 401, headers: { 'content-type': 'application/json' } }) };
  }
  return { ok: true, shop: shopDomainFromPayload(result.payload), payload: result.payload };
}
