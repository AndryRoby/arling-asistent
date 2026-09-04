// index.test.mjs
// Router-level wiring check using real (Node-native) Request/Response
// objects against the actual default.fetch handler, so the glue between
// index.js, chat.js, security.js and tenants.js is exercised at least once
// end to end, not just at the level of individual pure functions.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import { createTenant, setTenantStatus } from '../worker/src/tenants.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

function makeEnv() {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ answer: 'Mame to skladom.', products: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
  };
}

async function readyTenant(env, domain = 'shop.sk') {
  const tenant = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/feed.xml`, contactEmail: `a@${domain}` });
  await setTenantStatus(env.DB, tenant.id, 'ready');
  await env.VECTORIZE.upsert([{ id: `${tenant.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: tenant.id, productId: 'p1', title: 'Test produkt', url: `https://${domain}/p/1`, availability: 'in_stock' } }]);
  return tenant;
}

test('GET /health returns a static ok payload', async () => {
  const res = await worker.fetch(new Request('https://asistent.arling.sk/health'), makeEnv(), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: 'ok', service: 'arling-asistent' });
});

test('unknown route returns 404', async () => {
  const res = await worker.fetch(new Request('https://asistent.arling.sk/nope'), makeEnv(), {});
  assert.equal(res.status, 404);
});

test('OPTIONS preflight returns CORS headers for an allowed origin and 403 for a disallowed one', async () => {
  const env = makeEnv();
  const allowed = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', { method: 'OPTIONS', headers: { Origin: 'https://arling.sk' } }), env, {});
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');

  const blocked = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', { method: 'OPTIONS', headers: { Origin: 'https://attacker.com' } }), env, {});
  assert.equal(blocked.status, 403);
});

test('POST /v1/chat end to end: known ready tenant, allowed origin, returns a grounded answer', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shop.sk', 'CF-Connecting-IP': '9.9.9.9' },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: 'Mate to skladom?' }], lang: 'sk' }),
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.answer, /skladom/);
  assert.ok(Array.isArray(body.products));
});

test('POST /v1/chat rejects an unknown tenant with 404', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: 'ghost', messages: [{ role: 'user', content: 'hi' }] }),
  }), env, {});
  assert.equal(res.status, 404);
});

test('POST /v1/chat rejects a request from a disallowed origin with 403', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop2.sk');
  const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.com' },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: 'hi' }] }),
  }), env, {});
  assert.equal(res.status, 403);
});

test('POST /v1/chat enforces the per-tenant monthly quota (429 once exhausted)', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop3.sk');
  // Exhaust the trial quota directly via the mock D1 row rather than looping 1000 requests.
  env.DB._tenants.get(tenant.id).monthly_quota = 1;
  const send = () => worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shop3.sk', 'CF-Connecting-IP': '1.1.1.1' },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: 'hi' }] }),
  }), env, {});
  const first = await send();
  assert.equal(first.status, 200);
  const second = await send();
  assert.equal(second.status, 429);
  const body = await second.json();
  assert.equal(body.error, 'quota_exceeded');
});
