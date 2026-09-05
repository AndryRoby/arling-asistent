// webhooks.test.mjs
// The mandatory compliance webhooks (customers/data_request,
// customers/redact, shop/redact) and app/uninstalled: HMAC gating,
// response shapes/status codes, and the actual side effects (D1 writes).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  withVerifiedWebhook,
  handleAppUninstalled,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  dispatchComplianceWebhook,
  COMPLIANCE_HANDLERS,
} from '../shopify-worker/src/webhooks.js';
import { upsertShopOnInstall, getShopByDomain } from '../shopify-worker/src/shops.js';
import { createMockD1 } from './helpers/mock-d1.mjs';

const SECRET = 'test-client-secret-fixed';
const SHOP = 'my-shop.myshopify.com';

function makeEnv() {
  return { DB: createMockD1(), SHOPIFY_API_SECRET: SECRET };
}

function signedRequest(url, bodyObj, { secret = SECRET, topic } = {}) {
  const rawBody = JSON.stringify(bodyObj);
  const hmac = createHmac('sha256', secret).update(rawBody).digest('base64');
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac };
  if (topic) headers['X-Shopify-Topic'] = topic;
  return new Request(url, { method: 'POST', headers, body: rawBody });
}

test('withVerifiedWebhook returns 401 for a missing/invalid HMAC and never calls the handler', async () => {
  const env = makeEnv();
  let called = false;
  const handler = async () => { called = true; return new Response('should not happen'); };

  const noHmac = new Request('https://x/webhooks/app/uninstalled', { method: 'POST', body: JSON.stringify({ domain: SHOP }) });
  const res1 = await withVerifiedWebhook(noHmac, env, {}, handler);
  assert.equal(res1.status, 401);
  assert.equal(called, false);

  const wrongHmac = new Request('https://x/webhooks/app/uninstalled', {
    method: 'POST',
    headers: { 'X-Shopify-Hmac-Sha256': 'bm90LXJlYWw=' },
    body: JSON.stringify({ domain: SHOP }),
  });
  const res2 = await withVerifiedWebhook(wrongHmac, env, {}, handler);
  assert.equal(res2.status, 401);
  assert.equal(called, false);
});

test('withVerifiedWebhook calls the handler with the parsed JSON payload once the HMAC checks out', async () => {
  const env = makeEnv();
  let receivedPayload;
  const handler = async (_env, payload) => { receivedPayload = payload; return new Response(JSON.stringify({ ok: true }), { status: 200 }); };

  const req = signedRequest('https://x/webhooks/app/uninstalled', { domain: SHOP, extra: 1 });
  const res = await withVerifiedWebhook(req, env, {}, handler);
  assert.equal(res.status, 200);
  assert.deepEqual(receivedPayload, { domain: SHOP, extra: 1 });
});

test('withVerifiedWebhook returns 400 for a validly signed but non-JSON body', async () => {
  const env = makeEnv();
  const rawBody = 'not json';
  const hmac = createHmac('sha256', SECRET).update(rawBody).digest('base64');
  const req = new Request('https://x/webhooks/app/uninstalled', { method: 'POST', headers: { 'X-Shopify-Hmac-Sha256': hmac }, body: rawBody });
  const res = await withVerifiedWebhook(req, env, {}, async () => new Response('unused'));
  assert.equal(res.status, 400);
});

test('handleAppUninstalled marks the shop uninstalled and clears its access token', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_live_token', 'read_products');

  const res = await handleAppUninstalled(env, { domain: SHOP });
  assert.equal(res.status, 200);

  const shop = await getShopByDomain(env.DB, SHOP);
  assert.equal(shop.status, 'uninstalled');
  assert.equal(shop.access_token, null);
});

test('handleCustomersDataRequest and handleCustomersRedact acknowledge with 200 and report no stored customer data', async () => {
  const env = makeEnv();
  const dataRes = await handleCustomersDataRequest(env, { shop_id: 1, customer: { id: 1 } });
  assert.equal(dataRes.status, 200);
  const dataBody = await dataRes.json();
  assert.equal(dataBody.ok, true);
  assert.equal(dataBody.data_held, false);

  const redactRes = await handleCustomersRedact(env, { shop_id: 1, customer: { id: 1 } });
  assert.equal(redactRes.status, 200);
  const redactBody = await redactRes.json();
  assert.equal(redactBody.ok, true);
  assert.equal(redactBody.redacted, false);
});

test('handleShopRedact purges the local shop row entirely', async () => {
  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_live_token', 'read_products');
  assert.ok(await getShopByDomain(env.DB, SHOP));

  const res = await handleShopRedact(env, { shop_id: 1, shop_domain: SHOP });
  assert.equal(res.status, 200);
  assert.equal(await getShopByDomain(env.DB, SHOP), null);
});

test('dispatchComplianceWebhook routes by X-Shopify-Topic to the matching handler, all three topics registered', async () => {
  assert.deepEqual(Object.keys(COMPLIANCE_HANDLERS).sort(), ['customers/data_request', 'customers/redact', 'shop/redact']);

  const env = makeEnv();
  await upsertShopOnInstall(env.DB, SHOP, 'shpat_live_token', 'read_products');

  const req = signedRequest('https://x/webhooks/compliance', { shop_domain: SHOP }, { topic: 'shop/redact' });
  const res = await dispatchComplianceWebhook(req, env, {});
  assert.equal(res.status, 200);
  assert.equal(await getShopByDomain(env.DB, SHOP), null); // shop/redact ran, not one of the other two
});

test('dispatchComplianceWebhook returns 404 for an unrecognised topic, without leaking whether the HMAC would have been valid', async () => {
  const env = makeEnv();
  const req = signedRequest('https://x/webhooks/compliance', { shop_domain: SHOP }, { topic: 'orders/create' });
  const res = await dispatchComplianceWebhook(req, env, {});
  assert.equal(res.status, 404);
});
