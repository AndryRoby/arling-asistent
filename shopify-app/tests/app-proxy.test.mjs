// app-proxy.test.mjs
// GET /proxy/settings.json: the endpoint the theme app extension calls
// (through Shopify's signed app proxy) for the tenant id and widget
// settings. Covers signature verification and both the configured and
// not-yet-configured shop cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { handleProxySettings } from '../shopify-worker/src/app-proxy.js';
import { upsertShopOnInstall, setShopTenant, setShopSettings } from '../shopify-worker/src/shops.js';
import { createMockD1 } from './helpers/mock-d1.mjs';

const SECRET = 'test-client-secret-fixed';
const SHOP = 'my-shop.myshopify.com';

function makeEnv() {
  return { DB: createMockD1(), SHOPIFY_API_SECRET: SECRET, ARLING_API_BASE: 'https://arling-asistent.arling.workers.dev' };
}

function signedProxyUrl(params) {
  const pairs = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const signature = createHmac('sha256', SECRET).update(pairs).digest('hex');
  const url = new URL('https://x/proxy/settings.json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('signature', signature);
  return url;
}

test('handleProxySettings returns tenant + settings for a configured shop with a valid signature', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_live', 'read_products');
  await setShopTenant(env.DB, SHOP, 'tenant_123', 'merchant@example.com', 'public');
  await setShopSettings(env.DB, SHOP, { language: 'de', color: 'dark', position: 'left' });

  const url = signedProxyUrl({ shop: SHOP, timestamp: '1700000000' });
  const res = await handleProxySettings(new Request(url), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tenant, 'tenant_123');
  assert.equal(body.lang, 'de');
  assert.equal(body.color, 'dark');
  assert.equal(body.position, 'left');
  assert.equal(body.endpoint, env.ARLING_API_BASE);
});

test('handleProxySettings returns 401 for an invalid or tampered signature', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_live', 'read_products');
  await setShopTenant(env.DB, SHOP, 'tenant_123', 'merchant@example.com', 'public');

  const url = signedProxyUrl({ shop: SHOP, timestamp: '1700000000' });
  url.searchParams.set('shop', 'attacker.myshopify.com'); // tampered after signing
  const res = await handleProxySettings(new Request(url), env);
  assert.equal(res.status, 401);
});

test('handleProxySettings returns 404 for a shop with no tenant yet (still provisioning) or an unknown shop', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_live', 'read_products'); // installed, but provisionTenant has not finished

  const url = signedProxyUrl({ shop: SHOP });
  const res = await handleProxySettings(new Request(url), env);
  assert.equal(res.status, 404);

  const unknownUrl = signedProxyUrl({ shop: 'unknown.myshopify.com' });
  const unknownRes = await handleProxySettings(new Request(unknownUrl), env);
  assert.equal(unknownRes.status, 404);
});

test('handleProxySettings defaults language/color/position when a configured shop never customised them', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_live', 'read_products');
  await setShopTenant(env.DB, SHOP, 'tenant_456', 'merchant@example.com', 'public');

  const url = signedProxyUrl({ shop: SHOP });
  const res = await handleProxySettings(new Request(url), env);
  const body = await res.json();
  assert.equal(body.lang, 'auto'); // 'auto' matches the widget's own default, see widget/widget.js resolveAutoLang
  assert.equal(body.color, 'auto');
  assert.equal(body.position, 'right');
});
