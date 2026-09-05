// oauth.test.mjs
// OAuth install flow: /auth redirect + state cookie, /auth/callback
// verification (state, HMAC, shop domain shape), and the code-for-token
// exchange call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  isValidShopDomain,
  buildAuthorizeUrl,
  handleAuthStart,
  readCookie,
  verifyCallback,
  exchangeCodeForToken,
  STATE_COOKIE_NAME,
} from '../shopify-worker/src/oauth.js';

const SECRET = 'test-client-secret-fixed';
const SHOP = 'my-shop.myshopify.com';

function makeEnv(overrides = {}) {
  return {
    APP_URL: 'https://shopify-app.arling.workers.dev',
    SHOPIFY_API_KEY: 'test-api-key',
    SHOPIFY_API_SECRET: SECRET,
    SCOPES: 'read_products',
    ...overrides,
  };
}

test('isValidShopDomain accepts *.myshopify.com and rejects anything else', () => {
  assert.equal(isValidShopDomain('my-shop.myshopify.com'), true);
  assert.equal(isValidShopDomain('my-shop.myshopify.com.evil.com'), false);
  assert.equal(isValidShopDomain('not-myshopify.com'), false);
  assert.equal(isValidShopDomain(''), false);
  assert.equal(isValidShopDomain(null), false);
});

test('buildAuthorizeUrl builds the expected Shopify OAuth authorize URL', () => {
  const url = buildAuthorizeUrl({ shop: SHOP, apiKey: 'key1', scopes: ['read_products'], redirectUri: 'https://app/auth/callback', state: 'nonce1' });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, `https://${SHOP}/admin/oauth/authorize`);
  assert.equal(parsed.searchParams.get('client_id'), 'key1');
  assert.equal(parsed.searchParams.get('scope'), 'read_products');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app/auth/callback');
  assert.equal(parsed.searchParams.get('state'), 'nonce1');
});

test('handleAuthStart redirects to the authorize URL and sets an HttpOnly state cookie, and rejects a bad shop param', () => {
  const env = makeEnv();
  const res = handleAuthStart(new Request(`https://x/auth?shop=${SHOP}`), env);
  assert.equal(res.status, 302);
  const location = res.headers.get('Location');
  assert.match(location, new RegExp(`^https://${SHOP}/admin/oauth/authorize`));
  const setCookie = res.headers.get('Set-Cookie');
  assert.match(setCookie, new RegExp(`^${STATE_COOKIE_NAME}=`));
  assert.match(setCookie, /HttpOnly/);

  const badRes = handleAuthStart(new Request('https://x/auth?shop=not-a-shopify-domain.com'), env);
  assert.equal(badRes.status, 400);
});

test('readCookie extracts one cookie value out of a Cookie header', () => {
  assert.equal(readCookie('a=1; b=2; c=3', 'b'), '2');
  assert.equal(readCookie('a=1', 'missing'), '');
  assert.equal(readCookie('', 'a'), '');
  assert.equal(readCookie(null, 'a'), '');
});

function signedCallbackUrl({ shop = SHOP, state = 'nonce1', code = 'authcode1', secret = SECRET, corruptAfterSigning = false } = {}) {
  const params = { code, shop, state, timestamp: '1700000000' };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const hmac = createHmac('sha256', secret).update(message).digest('hex');
  const url = new URL('https://x/auth/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('hmac', hmac);
  if (corruptAfterSigning) url.searchParams.set('code', 'tampered-code');
  return url;
}

test('verifyCallback accepts a request with matching state cookie and a valid HMAC', async () => {
  const env = makeEnv();
  const url = signedCallbackUrl({});
  const request = new Request(url, { headers: { Cookie: `${STATE_COOKIE_NAME}=nonce1` } });
  const result = await verifyCallback(request, env);
  assert.equal(result.ok, true);
  assert.equal(result.shop, SHOP);
  assert.equal(result.code, 'authcode1');
});

test('verifyCallback rejects a state cookie mismatch (CSRF protection)', async () => {
  const env = makeEnv();
  const url = signedCallbackUrl({});
  const request = new Request(url, { headers: { Cookie: `${STATE_COOKIE_NAME}=different-nonce` } });
  const result = await verifyCallback(request, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'state_mismatch');
});

test('verifyCallback rejects a tampered query string even with a matching state cookie', async () => {
  const env = makeEnv();
  const url = signedCallbackUrl({ corruptAfterSigning: true });
  const request = new Request(url, { headers: { Cookie: `${STATE_COOKIE_NAME}=nonce1` } });
  const result = await verifyCallback(request, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_hmac');
});

test('verifyCallback rejects a shop parameter that is not a valid myshopify.com domain', async () => {
  const env = makeEnv();
  const url = signedCallbackUrl({ shop: 'not-a-real-shop.com' });
  const request = new Request(url, { headers: { Cookie: `${STATE_COOKIE_NAME}=nonce1` } });
  const result = await verifyCallback(request, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_shop');
});

test('exchangeCodeForToken posts client credentials and the code, returns the access token and scope', async () => {
  const env = makeEnv();
  let capturedUrl;
  let capturedBody;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ access_token: 'shpat_abc', scope: 'read_products' }) };
  };
  const result = await exchangeCodeForToken(SHOP, 'authcode1', env, { fetchImpl });
  assert.equal(capturedUrl, `https://${SHOP}/admin/oauth/access_token`);
  assert.equal(capturedBody.client_id, env.SHOPIFY_API_KEY);
  assert.equal(capturedBody.client_secret, env.SHOPIFY_API_SECRET);
  assert.equal(capturedBody.code, 'authcode1');
  assert.equal(result.accessToken, 'shpat_abc');
  assert.equal(result.scope, 'read_products');
});

test('exchangeCodeForToken throws on a non-ok response or a response missing access_token', async () => {
  const env = makeEnv();
  await assert.rejects(
    exchangeCodeForToken(SHOP, 'x', env, { fetchImpl: async () => ({ ok: false, status: 400 }) }),
    /token_exchange_failed_400/
  );
  await assert.rejects(
    exchangeCodeForToken(SHOP, 'x', env, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
    /token_exchange_missing_access_token/
  );
});
