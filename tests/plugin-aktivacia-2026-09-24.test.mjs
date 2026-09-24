// plugin-aktivacia-2026-09-24.test.mjs
//
// Prečo ľudia WordPress plugin stiahli, ale nenechali aktívny (0.2.1, 186
// stiahnutí, 0 aktívnych inštalácií podľa api.wordpress.org 24. 9. 2026).
// Tieto testy držia serverovú časť opráv pre plugin 0.3.0:
//   1. obchod s „jednoduchými“ trvalými odkazmi (?rest_route=) sa načíta
//      celý, so stránkovaním,
//   2. prázdny obchod nie je „ready“ s asistentom, ktorý nič nevie,
//   3. zlyhané načítanie má dôvod (last_error), ktorý plugin preloží,
//   4. „Try again“ prepne obchod v chybe hneď na pending,
//   5. chybové odpovede /v1/chat a /v1/gift sa dajú v prehliadači prečítať
//      (inak sa vyčerpaný limit tváril ako sieťová chyba).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTenantFromRequest,
  ingestFeedForTenant,
  tenantStatusResponse,
  classifyFeedError,
  ingestErrorKey,
  INGEST_ERRORS,
  TENANT_STATUS,
} from '../worker/src/onboarding.js';
import { createTenant, getTenantById, setTenantStatus } from '../worker/src/tenants.js';
import { fetchFeed, isWooCommerceStoreApiUrl, FeedUrlNotAllowedError, WOOCOMMERCE_STORE_API_PAGE_SIZE } from '../worker/src/feed.js';
import { handleChatRoute } from '../worker/src/chat.js';
import { handleGiftRoute } from '../worker/src/gift.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const GENERIC_XML = `<products><item><id>1</id><name>Test product</name><price>9.99</price><url>https://shop.sk/p/1</url><description>Popis produktu.</description></item></products>`;

function makeEnv({ fetchImpl } = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: 'test-admin-token',
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, text: async () => GENERIC_XML })),
  };
}

function wooProduct(i) {
  return {
    id: i,
    name: `Produkt ${i}`,
    permalink: `https://shop.sk/p/${i}`,
    prices: { price: '1990', currency_code: 'EUR', currency_minor_unit: 2 },
    is_in_stock: true,
  };
}

// ---------------------------------------------------------------------------
// 1. Store API URL in all three shapes the plugin can send
// ---------------------------------------------------------------------------

test('isWooCommerceStoreApiUrl recognises plain permalinks (?rest_route=) and a custom REST prefix', () => {
  assert.equal(isWooCommerceStoreApiUrl('https://shop.sk/?rest_route=/wc/store/v1/products&per_page=100'), true);
  assert.equal(isWooCommerceStoreApiUrl('https://shop.sk/index.php?rest_route=%2Fwc%2Fstore%2Fv1%2Fproducts'), true);
  assert.equal(isWooCommerceStoreApiUrl('https://shop.sk/api/wc/store/v1/products?per_page=100'), true);
  assert.equal(isWooCommerceStoreApiUrl('https://shop.sk/?rest_route=/wc/store/v1/products/15'), false);
  assert.equal(isWooCommerceStoreApiUrl('https://shop.sk/?rest_route=/wp/v2/posts'), false);
});

test('fetchFeed pages through a ?rest_route= Store API URL and keeps rest_route on every page', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const count = page === 1 ? WOOCOMMERCE_STORE_API_PAGE_SIZE : 7;
    const items = Array.from({ length: count }, (_, i) => wooProduct((page - 1) * WOOCOMMERCE_STORE_API_PAGE_SIZE + i + 1));
    return { ok: true, status: 200, text: async () => JSON.stringify(items) };
  };
  const { products, type } = await fetchFeed('https://shop.sk/?rest_route=/wc/store/v1/products&per_page=100', { fetchImpl });
  assert.equal(type, 'woocommerce');
  assert.equal(products.length, WOOCOMMERCE_STORE_API_PAGE_SIZE + 7);
  assert.equal(seen.length, 2);
  for (const url of seen) assert.equal(new URL(url).searchParams.get('rest_route'), '/wc/store/v1/products');
});

// ---------------------------------------------------------------------------
// 2. and 3. Empty shop, failed reads, and the reason in the status
// ---------------------------------------------------------------------------

test('a new shop whose product list is empty ends in error with last_error no_products, not in ready', async () => {
  const env = makeEnv({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }) });
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://empty.sk/wp-json/wc/store/v1/products?per_page=100', domain: 'empty.sk', email: 'a@empty.sk' });
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.status, TENANT_STATUS.ERROR);
  assert.equal(status.last_error, INGEST_ERRORS.NO_PRODUCTS);
  assert.equal(status.product_count, 0);
});

test('the daily refresh of a shop that is already ready does not switch it off over one empty answer', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'keep.sk', email: 'a@keep.sk' });
  assert.equal((await getTenantById(env.DB, tenant.id)).status, TENANT_STATUS.READY);

  env.fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<products></products>' });
  const result = await ingestFeedForTenant(env, await getTenantById(env.DB, tenant.id));
  assert.equal(result.ok, true);
  assert.equal((await getTenantById(env.DB, tenant.id)).status, TENANT_STATUS.READY);
});

test('a firewall answer (HTTP 403) is reported as last_error feed_http_403', async () => {
  const env = makeEnv({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }) });
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://locked.sk/wp-json/wc/store/v1/products', domain: 'locked.sk', email: 'a@locked.sk' });
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.status, TENANT_STATUS.ERROR);
  assert.equal(status.last_error, 'feed_http_403');
});

test('an HTML page instead of the product list (coming soon, login wall) is reported as feed_not_readable', async () => {
  const env = makeEnv({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html><body>Coming soon</body></html>' }) });
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://soon.sk/wp-json/wc/store/v1/products', domain: 'soon.sk', email: 'a@soon.sk' });
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.last_error, INGEST_ERRORS.NOT_READABLE);
});

test('classifyFeedError maps every feed failure to a stable code', () => {
  assert.equal(classifyFeedError(new Error('feed_fetch_failed_404')), 'feed_http_404');
  assert.equal(classifyFeedError(new Error('unrecognised_feed_format')), 'feed_not_readable');
  assert.equal(classifyFeedError(new SyntaxError('Unexpected token <')), 'feed_not_readable');
  assert.equal(classifyFeedError(new TypeError('fetch failed')), 'feed_unreachable');
  assert.equal(classifyFeedError(new FeedUrlNotAllowedError('feed_url_private_host')), 'feed_url_private_host');
});

test('last_error is null while the shop is ready, and a successful read clears the stored reason', async () => {
  const env = makeEnv({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) });
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://flaky.sk/feed.xml', domain: 'flaky.sk', email: 'a@flaky.sk' });
  assert.equal((await tenantStatusResponse(env, tenant.id)).last_error, 'feed_http_500');

  env.fetchImpl = async () => ({ ok: true, status: 200, text: async () => GENERIC_XML });
  await createTenantFromRequest(env, { feedUrl: 'https://flaky.sk/feed.xml', domain: 'flaky.sk', email: 'a@flaky.sk' });
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.status, TENANT_STATUS.READY);
  assert.equal(status.last_error, null);
  assert.equal(env.ASISTENT_CACHE._store.has(ingestErrorKey(tenant.id)), false);
});

test('status still answers without KV: last_error is null, never an exception', async () => {
  const env = makeEnv({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) });
  delete env.ASISTENT_CACHE;
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://nokv.sk/feed.xml', domain: 'nokv.sk', email: 'a@nokv.sk' });
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.status, TENANT_STATUS.ERROR);
  assert.equal(status.last_error, null);
});

// ---------------------------------------------------------------------------
// 4. "Try again"
// ---------------------------------------------------------------------------

test('Try again from the owner flips a shop in error to pending right away, then to ready', async () => {
  const env = makeEnv({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) });
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://retry.sk/feed.xml', domain: 'retry.sk', email: 'owner@retry.sk' });
  assert.equal((await getTenantById(env.DB, tenant.id)).status, TENANT_STATUS.ERROR);

  env.fetchImpl = async () => ({ ok: true, status: 200, text: async () => GENERIC_XML });
  const waited = [];
  const again = await createTenantFromRequest(
    env,
    { feedUrl: 'https://retry.sk/feed.xml', domain: 'retry.sk', email: 'owner@retry.sk' },
    { waitUntil: (p) => waited.push(p) }
  );
  assert.equal(again.status, TENANT_STATUS.PENDING);
  assert.equal((await getTenantById(env.DB, tenant.id)).status, TENANT_STATUS.PENDING);
  await waited[0];
  assert.equal((await getTenantById(env.DB, tenant.id)).status, TENANT_STATUS.READY);
});

test('a resubmission with a different e-mail neither retries nor flips the shop to pending', async () => {
  const env = makeEnv({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) });
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://other.sk/feed.xml', domain: 'other.sk', email: 'owner@other.sk' });
  env.fetchImpl = async () => ({ ok: true, status: 200, text: async () => GENERIC_XML });
  const again = await createTenantFromRequest(env, { feedUrl: 'https://other.sk/feed.xml', domain: 'other.sk', email: 'stranger@example.com' });
  assert.equal(again.status, TENANT_STATUS.ERROR);
  assert.equal((await getTenantById(env.DB, tenant.id)).status, TENANT_STATUS.ERROR);
});

test('Try again on a shop that is already ready never flips it to pending (the chat keeps answering)', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://live.sk/feed.xml', domain: 'live.sk', email: 'owner@live.sk' });
  env.DB._tenants.get(tenant.id).last_ingested_at = new Date('2020-01-01T00:00:00Z').toISOString();
  const waited = [];
  const again = await createTenantFromRequest(
    env,
    { feedUrl: 'https://live.sk/feed.xml', domain: 'live.sk', email: 'owner@live.sk' },
    { waitUntil: (p) => waited.push(p) }
  );
  assert.equal(again.status, TENANT_STATUS.READY);
  assert.equal((await getTenantById(env.DB, tenant.id)).status, TENANT_STATUS.READY);
  await waited[0];
});

// ---------------------------------------------------------------------------
// 5. Error responses of the public widget routes are readable in a browser
// ---------------------------------------------------------------------------

async function readyTenantAtQuota(env, domain) {
  const tenant = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/feed.xml`, contactEmail: `a@${domain}` }, { monthlyQuota: 1 });
  await setTenantStatus(env.DB, tenant.id, 'ready');
  const row = env.DB._tenants.get(tenant.id);
  row.used_this_month = 1; // the one free conversation is already used
  return tenant;
}

test('POST /v1/chat quota_exceeded (429) carries Access-Control-Allow-Origin for the shop, so the widget can say so', async () => {
  const env = makeEnv();
  const tenant = await readyTenantAtQuota(env, 'full.sk');
  const res = await handleChatRoute(
    new Request('https://asistent.arling.sk/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://full.sk', 'CF-Connecting-IP': '1.1.1.1' },
      body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: 'Máte hrnce?' }], lang: 'sk', session: 'abcdef0123456789' }),
    }),
    env,
    {}
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'quota_exceeded');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://full.sk');
});

test('POST /v1/chat for a shop that is not ready yet answers 404 with a readable CORS header', async () => {
  const env = makeEnv();
  const tenant = await createTenant(env.DB, { domain: 'wait.sk', feedUrl: 'https://wait.sk/feed.xml', contactEmail: 'a@wait.sk' });
  const res = await handleChatRoute(
    new Request('https://asistent.arling.sk/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://wait.sk' },
      body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: 'Ahoj' }] }),
    }),
    env,
    {}
  );
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('POST /v1/chat without an Origin (server to server) gets no CORS header on errors', async () => {
  const env = makeEnv();
  const res = await handleChatRoute(
    new Request('https://asistent.arling.sk/v1/chat', { method: 'POST', body: JSON.stringify({ tenant: 'ghost', messages: [] }) }),
    env,
    {}
  );
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('POST /v1/gift quota_exceeded (429) carries Access-Control-Allow-Origin for the shop too', async () => {
  const env = makeEnv();
  const tenant = await readyTenantAtQuota(env, 'giftfull.sk');
  const res = await handleGiftRoute(
    new Request('https://asistent.arling.sk/v1/gift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.giftfull.sk', 'CF-Connecting-IP': '2.2.2.2' },
      body: JSON.stringify({ tenant: tenant.id, recipient: 'mama', budget_max: 50, interests: 'kava', session: 'abcdef0123456789' }),
    }),
    env,
    {}
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://www.giftfull.sk');
});
