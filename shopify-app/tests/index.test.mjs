// index.test.mjs
// Full router wiring (worker/src/index.js) with real Request/Response
// objects, same style as the parent product's tests/index.test.mjs: this is
// the level that actually proves the routes are wired to the right
// handlers, not just that each module works in isolation.
//
// Network calls inside the OAuth callback / tenant provisioning path
// (token exchange, the products.json probe, POST /v1/tenants) all go
// through each module's injectable `fetchImpl` default, which defaults to
// the global `fetch` - so these tests temporarily replace `globalThis.fetch`
// for the duration of one test and always restore it in a `finally`, the
// same technique used for testing any code that calls the platform fetch
// directly rather than accepting it as a parameter at every call site.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import worker from '../shopify-worker/src/index.js';
import { STATE_COOKIE_NAME } from '../shopify-worker/src/oauth.js';
import { getShopByDomain, upsertShopOnInstall, setShopTenant, setShopFeedCache } from '../shopify-worker/src/shops.js';
import { createMockD1 } from './helpers/mock-d1.mjs';

const SHOP = 'my-shop.myshopify.com';
const API_KEY = 'test-api-key';
const API_SECRET = 'test-client-secret-fixed';

function makeEnv(overrides = {}) {
  return {
    DB: createMockD1(),
    APP_URL: 'https://shopify-app.arling.workers.dev',
    ARLING_API_BASE: 'https://arling-asistent.arling.workers.dev',
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SCOPES: 'read_products',
    BILLING_TEST_MODE: 'true',
    ...overrides,
  };
}

async function withPatchedFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildSessionToken({ apiKey = API_KEY, secret = API_SECRET, shop = SHOP } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: apiKey, sub: '1', exp: now + 60, nbf: now - 10, iat: now, jti: 'abc', sid: 's1' };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${headerB64}.${payloadB64}.${sig}`;
}

function signedCallbackUrl({ shop = SHOP, state = 'nonce1', code = 'authcode1' } = {}) {
  const params = { code, shop, state, timestamp: '1700000000' };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const hmac = createHmac('sha256', API_SECRET).update(message).digest('hex');
  const url = new URL('https://x/auth/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('hmac', hmac);
  return url;
}

function signedWebhookRequest(path, bodyObj, topic) {
  const rawBody = JSON.stringify(bodyObj);
  const hmac = createHmac('sha256', API_SECRET).update(rawBody).digest('base64');
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac };
  if (topic) headers['X-Shopify-Topic'] = topic;
  return new Request(`https://x${path}`, { method: 'POST', headers, body: rawBody });
}

function signedProxyUrl(params) {
  const pairs = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const signature = createHmac('sha256', API_SECRET).update(pairs).digest('hex');
  const url = new URL('https://x/proxy/settings.json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('signature', signature);
  return url;
}

test('GET /health returns a static ok', async () => {
  const res = await worker.fetch(new Request('https://x/health'), makeEnv(), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('GET /auth redirects to Shopify with a state cookie', async () => {
  const res = await worker.fetch(new Request(`https://x/auth?shop=${SHOP}`), makeEnv(), {});
  assert.equal(res.status, 302);
  assert.match(res.headers.get('Location'), new RegExp(`^https://${SHOP}/admin/oauth/authorize`));
  assert.match(res.headers.get('Set-Cookie'), new RegExp(STATE_COOKIE_NAME));
});

test('GET /auth/callback completes install, provisions a tenant via the public products.json path, and redirects to /app', async () => {
  const env = makeEnv();
  const url = signedCallbackUrl({});

  await withPatchedFetch(async (input, options) => {
    const u = String(input);
    if (u.endsWith('/admin/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'shpat_abc', scope: 'read_products' }) };
    }
    if (u.includes('/products.json')) {
      return { ok: true, json: async () => ({ products: [{ id: 1, title: 'X', variants: [{ price: '9.99', available: true }], images: [] }] }) };
    }
    if (u.endsWith('/v1/tenants')) {
      return { status: 201, json: async () => ({ id: 'tenant_1', domain: SHOP, status: 'pending', plan: 'free', monthly_quota: 100 }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const request = new Request(url, { headers: { Cookie: `${STATE_COOKIE_NAME}=nonce1` } });
    const res = await worker.fetch(request, env, {});
    assert.equal(res.status, 302);
    assert.match(res.headers.get('Location'), new RegExp(`^https://shopify-app\\.arling\\.workers\\.dev/app\\?shop=`));
  });

  const shop = await getShopByDomain(env.DB, SHOP);
  assert.equal(shop.access_token, 'shpat_abc');
  assert.equal(shop.tenant_id, 'tenant_1');
  assert.equal(shop.feed_mode, 'public');
});

test('GET /auth/callback rejects a bad state/HMAC before making any network call', async () => {
  const env = makeEnv();
  const url = signedCallbackUrl({});
  await withPatchedFetch(async () => { throw new Error('should not be called'); }, async () => {
    const request = new Request(url, { headers: { Cookie: `${STATE_COOKIE_NAME}=wrong-nonce` } });
    const res = await worker.fetch(request, env, {});
    assert.equal(res.status, 400);
  });
});

test('GET /app renders the embedded admin page with App Bridge and the shop in scope', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request(`https://x/app?shop=${SHOP}&host=aG9zdA==`), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /cdn\.shopify\.com\/shopifycloud\/app-bridge\.js/);
  assert.match(html, new RegExp(`content="${API_KEY}"`));
  assert.match(html, new RegExp(SHOP));
});

test('GET /app/api/status requires a session token (401 without one) and returns shop/plan/tenant with one', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  await setShopTenant(env.DB, SHOP, 'tenant_1', 'a@b.com', 'public');

  const unauthed = await worker.fetch(new Request('https://x/app/api/status'), env, {});
  assert.equal(unauthed.status, 401);

  await withPatchedFetch(async (input) => {
    assert.match(String(input), /\/v1\/tenants\/tenant_1\/status$/);
    return { status: 200, json: async () => ({ id: 'tenant_1', domain: SHOP, status: 'ready', plan: 'free', monthly_quota: 100, used_this_month: 2, product_count: 5, last_ingested_at: null }) };
  }, async () => {
    const token = buildSessionToken();
    const res = await worker.fetch(new Request('https://x/app/api/status', { headers: { Authorization: `Bearer ${token}` } }), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.shop, SHOP);
    assert.equal(body.tenant.product_count, 5);
  });
});

test('POST /app/api/settings saves language/color/position for the authenticated shop', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  const token = buildSessionToken();

  const res = await worker.fetch(new Request('https://x/app/api/settings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: 'de', color: 'dark', position: 'left' }),
  }), env, {});
  assert.equal(res.status, 200);

  const shop = await getShopByDomain(env.DB, SHOP);
  assert.equal(shop.language, 'de');
  assert.equal(shop.color, 'dark');
  assert.equal(shop.position, 'left');
});

test('POST /app/api/billing with plan:free sets the plan with no external charge call', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  const token = buildSessionToken();

  await withPatchedFetch(async () => { throw new Error('free plan must not call out to Shopify billing'); }, async () => {
    const res = await worker.fetch(new Request('https://x/app/api/billing', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'free' }),
    }), env, {});
    assert.equal(res.status, 200);
  });

  const shop = await getShopByDomain(env.DB, SHOP);
  assert.equal(shop.plan, 'free');
});

test('POST /app/api/billing with plan:starter calls the Billing GraphQL API and returns a confirmationUrl', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  const token = buildSessionToken();

  await withPatchedFetch(async (input, options) => {
    assert.match(String(input), new RegExp(`^https://${SHOP}/admin/api/`));
    const body = JSON.parse(options.body);
    assert.match(body.query, /appSubscriptionCreate/);
    assert.equal(body.variables.name, 'ARLing Asistent Starter');
    return { ok: true, json: async () => ({ data: { appSubscriptionCreate: { appSubscription: { id: 'gid://1' }, confirmationUrl: 'https://my-shop.myshopify.com/admin/charges/1', userErrors: [] } } }) };
  }, async () => {
    const res = await worker.fetch(new Request('https://x/app/api/billing', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'starter' }),
    }), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.confirmationUrl, 'https://my-shop.myshopify.com/admin/charges/1');
  });
});

test('POST /webhooks/app/uninstalled marks the shop uninstalled', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  const res = await worker.fetch(signedWebhookRequest('/webhooks/app/uninstalled', { domain: SHOP }), env, {});
  assert.equal(res.status, 200);
  const shop = await getShopByDomain(env.DB, SHOP);
  assert.equal(shop.status, 'uninstalled');
});

test('POST /webhooks/compliance dispatches shop/redact by the X-Shopify-Topic header and purges the shop row', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  const res = await worker.fetch(signedWebhookRequest('/webhooks/compliance', { shop_domain: SHOP }, 'shop/redact'), env, {});
  assert.equal(res.status, 200);
  assert.equal(await getShopByDomain(env.DB, SHOP), null);
});

test('GET /proxy/settings.json returns tenant + settings for a signed request against a configured shop', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  await setShopTenant(env.DB, SHOP, 'tenant_1', 'a@b.com', 'public');

  const url = signedProxyUrl({ shop: SHOP });
  const res = await worker.fetch(new Request(url), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tenant, 'tenant_1');
  assert.equal(body.endpoint, env.ARLING_API_BASE);
});

test('GET /feed/:shop.json serves the cached GraphQL-derived feed for a shop in graphql mode', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_abc', 'read_products');
  await setShopFeedCache(env.DB, SHOP, 'graphql', JSON.stringify({ products: [{ id: '1', title: 'X' }] }));

  const res = await worker.fetch(new Request(`https://x/feed/${encodeURIComponent(SHOP)}.json`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.products.length, 1);
});

test('an unknown route returns 404', async () => {
  const res = await worker.fetch(new Request('https://x/nope'), makeEnv(), {});
  assert.equal(res.status, 404);
});
