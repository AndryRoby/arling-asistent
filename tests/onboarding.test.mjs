// onboarding.test.mjs
// Tenant self-serve creation (POST /v1/tenants) end to end: validation,
// background ingestion, and the status endpoint, including the HTTP route
// handlers using real (Node-native) Request/Response objects.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTenantFromRequest, ingestFeedForTenant, tenantStatusResponse, handleCreateTenantRoute, handleTenantStatusRoute, TENANT_STATUS } from '../worker/src/onboarding.js';
import { getTenantById } from '../worker/src/tenants.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize } from './helpers/mock-cf.mjs';

const GENERIC_XML = `<products><item><id>1</id><name>Test product</name><price>9.99</price><url>https://shop.sk/p/1</url><description>Popis produktu.</description></item></products>`;

function makeEnv({ feedText = GENERIC_XML, feedOk = true } = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ALLOWED_ORIGINS: 'arling.sk',
    fetchImpl: async () => ({ ok: feedOk, status: feedOk ? 200 : 500, text: async () => feedText }),
  };
}

test('createTenantFromRequest creates a pending tenant then ingests the feed to ready', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'shop.sk', email: 'a@shop.sk' });
  assert.equal(tenant.status, 'pending'); // synchronous return, ingestion awaited separately below since no waitUntil given

  const after = await getTenantById(env.DB, tenant.id);
  assert.equal(after.status, TENANT_STATUS.READY);
  assert.ok(env.VECTORIZE._store.size > 0);
});

test('createTenantFromRequest uses ctx.waitUntil when provided instead of blocking the response', async () => {
  const env = makeEnv();
  const waited = [];
  const tenant = await createTenantFromRequest(
    env,
    { feedUrl: 'https://shop.sk/feed.xml', domain: 'shop2.sk', email: 'a@shop2.sk' },
    { waitUntil: (p) => waited.push(p) }
  );
  assert.equal(tenant.status, 'pending');
  assert.equal(waited.length, 1);
  await waited[0]; // let the background ingestion finish before asserting
  const after = await getTenantById(env.DB, tenant.id);
  assert.equal(after.status, TENANT_STATUS.READY);
});

test('ingestFeedForTenant flips status to error and does not throw when the feed fetch fails', async () => {
  const env = makeEnv({ feedOk: false });
  const { createTenant } = await import('../worker/src/tenants.js');
  const created = await createTenant(env.DB, { domain: 'broken.sk', feedUrl: 'https://shop.sk/broken.xml', contactEmail: 'a@broken.sk' });
  const result = await ingestFeedForTenant(env, created);
  assert.equal(result.ok, false);
  assert.match(result.error, /feed_fetch_failed/);
  const after = await getTenantById(env.DB, created.id);
  assert.equal(after.status, TENANT_STATUS.ERROR);
});

test('tenantStatusResponse returns a plain status summary, or null for an unknown id', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'shop3.sk', email: 'a@shop3.sk' });
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.domain, 'shop3.sk');
  assert.equal(status.status, TENANT_STATUS.READY);
  assert.equal(await tenantStatusResponse(env, 'missing'), null);
});

test('handleCreateTenantRoute returns 201 with the tenant id for a valid request', async () => {
  const env = makeEnv();
  const request = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    body: JSON.stringify({ feed_url: 'https://shop.sk/feed.xml', domain: 'routed.sk', email: 'a@routed.sk' }),
  });
  const res = await handleCreateTenantRoute(request, env, {});
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
  assert.equal(body.domain, 'routed.sk');
  assert.equal(body.status, 'pending');
});

test('handleCreateTenantRoute returns 400 with validation issues for a bad request', async () => {
  const env = makeEnv();
  const request = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    body: JSON.stringify({ feed_url: 'not-a-url', domain: '', email: 'nope' }),
  });
  const res = await handleCreateTenantRoute(request, env, {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'validation_failed');
  assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
});

test('handleCreateTenantRoute returns 400 on invalid JSON', async () => {
  const env = makeEnv();
  const request = new Request('https://asistent.arling.sk/v1/tenants', { method: 'POST', body: '{not json' });
  const res = await handleCreateTenantRoute(request, env, {});
  assert.equal(res.status, 400);
});

test('handleTenantStatusRoute returns 404 for an unknown tenant and 200 with fields for a known one', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'status.sk', email: 'a@status.sk' });
  const okRes = await handleTenantStatusRoute(new Request('https://x/'), env, tenant.id);
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.status, TENANT_STATUS.READY);

  const notFoundRes = await handleTenantStatusRoute(new Request('https://x/'), env, 'ghost');
  assert.equal(notFoundRes.status, 404);
});
