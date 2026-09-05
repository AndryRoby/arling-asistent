/*
 * oauth.js
 *
 * Standard Shopify OAuth authorization-code flow for a non-embedded install
 * redirect (the embedded admin page itself authenticates with session
 * tokens, see session-token.js; this file only runs once, at install time,
 * to obtain the *offline* access token the worker uses for background work
 * like billing and Admin GraphQL product fetches).
 *
 *   GET /auth?shop=my-shop.myshopify.com
 *     -> 302 to https://{shop}/admin/oauth/authorize?client_id=...&scope=...
 *        &redirect_uri=...&state=NONCE, with NONCE also set as an HttpOnly
 *        cookie so the callback can confirm it round-tripped unmodified
 *        (CSRF protection; Shopify's own docs call this the "state" check).
 *
 *   GET /auth/callback?shop=&code=&state=&hmac=&timestamp=...
 *     -> verify state cookie matches, verify the HMAC (crypto-utils.js),
 *        exchange the code for an offline access token, hand the caller
 *        {shop, accessToken, scope} to store (see shops.js) and continue
 *        onboarding.
 */

import { verifyOAuthHmac } from './crypto-utils.js';

export const STATE_COOKIE_NAME = 'arling_shopify_oauth_state';

/** Loosely validates a Shopify shop domain (used both for input validation and to stop open-redirect via a crafted `shop` param). */
export function isValidShopDomain(shop) {
  return typeof shop === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

function genNonce() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Build the Shopify-hosted authorization URL a merchant is redirected to on /auth. */
export function buildAuthorizeUrl({ shop, apiKey, scopes, redirectUri, state }) {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', apiKey);
  url.searchParams.set('scope', Array.isArray(scopes) ? scopes.join(',') : String(scopes));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/** GET /auth: redirect to Shopify's authorize screen, with a fresh nonce stored in a short-lived cookie. */
export function handleAuthStart(request, env) {
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop') || '';
  if (!isValidShopDomain(shop)) {
    return new Response(JSON.stringify({ error: 'invalid_shop' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const state = genNonce();
  const redirectUri = `${env.APP_URL.replace(/\/$/, '')}/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    apiKey: env.SHOPIFY_API_KEY,
    scopes: env.SCOPES || 'read_products',
    redirectUri,
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      'Set-Cookie': `${STATE_COOKIE_NAME}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/** Extract one cookie's value from a Cookie request header. */
export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return '';
  const match = String(cookieHeader)
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : '';
}

/**
 * Verify an inbound /auth/callback request: shop domain shape, HMAC over
 * the query string, and the state cookie matching the state query param.
 * Pure/synchronous-input function (besides the HMAC's crypto.subtle await)
 * so it is unit-testable without a network call.
 */
export async function verifyCallback(request, env) {
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop') || '';
  const state = url.searchParams.get('state') || '';

  if (!isValidShopDomain(shop)) return { ok: false, error: 'invalid_shop' };

  const cookieState = readCookie(request.headers.get('Cookie'), STATE_COOKIE_NAME);
  if (!cookieState || cookieState !== state) return { ok: false, error: 'state_mismatch' };

  const hmacOk = await verifyOAuthHmac(url.searchParams, env.SHOPIFY_API_SECRET);
  if (!hmacOk) return { ok: false, error: 'invalid_hmac' };

  return { ok: true, shop, code: url.searchParams.get('code') || '' };
}

/** Exchange an authorization code for an offline access token (POST https://{shop}/admin/oauth/access_token). */
export async function exchangeCodeForToken(shop, code, env, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code,
    }),
  });
  if (!res.ok) {
    throw new Error(`token_exchange_failed_${res.status}`);
  }
  const body = await res.json();
  if (!body || !body.access_token) {
    throw new Error('token_exchange_missing_access_token');
  }
  return { accessToken: body.access_token, scope: body.scope || '' };
}
