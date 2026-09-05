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
    ADMIN_TOKEN: 'test-admin-token',
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

test('GET /health carries Access-Control-Allow-Origin for an allowed Origin', async () => {
  const res = await worker.fetch(new Request('https://asistent.arling.sk/health', { headers: { Origin: 'https://arling.sk' } }), makeEnv(), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');
});

test('GET /widget.js serves the widget source with a JS content-type, a cache header, and a wildcard CORS header', async () => {
  const res = await worker.fetch(new Request('https://asistent.arling.sk/widget.js'), makeEnv(), {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.text();
  assert.match(body, /arling-asistent/);
  assert.match(body, /data-arling-asistent/);
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

test('POST /v1/chat returns 413 payload_too_large (not a generic 500) for an oversized request body', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop4.sk');
  const huge = 'x'.repeat(20000); // MAX_BODY_BYTES is 8000
  const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shop4.sk', 'CF-Connecting-IP': '2.2.2.2' },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: huge }] }),
  }), env, {});
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, 'payload_too_large');
});

test('POST /v1/chat still succeeds (fails open) when the KV rate limiter throws instead of returning a 500', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop5.sk');
  env.ASISTENT_CACHE = {
    async get() { throw new Error('simulated KV race'); },
    async put() { throw new Error('simulated KV race'); },
  };
  const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shop5.sk', 'CF-Connecting-IP': '4.4.4.4' },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: 'hi' }] }),
  }), env, {});
  assert.equal(res.status, 200);
});

test('POST /v1/tenants carries Access-Control-Allow-Origin for an allowed Origin (router level)', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://arling.sk' },
    body: JSON.stringify({ feed_url: 'https://newshop.sk/feed.xml', domain: 'newshop.sk', email: 'a@newshop.sk' }),
  }), env, {});
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');
});

test('GET /v1/tenants/:id/status carries Access-Control-Allow-Origin for an allowed Origin (router level)', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop6.sk');
  const res = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/status`, {
    headers: { Origin: 'https://arling.sk' },
  }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');
});

test('POST /v1/tenants/:id/reingest is wired up end to end: unauthorized without the admin token, ok with it', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop7.sk');

  const unauthorized = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/reingest`, { method: 'POST' }), env, {});
  assert.equal(unauthorized.status, 401);

  env.fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<products></products>' });
  const ok = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/reingest`, {
    method: 'POST',
    headers: { 'X-Admin-Token': 'test-admin-token' },
  }), env, {});
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
});

test('PATCH /v1/tenants/:id/plan is wired up end to end: unauthorized without the admin token, changes plan and quota with it', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop8.sk');

  const unauthorized = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/plan`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'starter' }),
  }), env, {});
  assert.equal(unauthorized.status, 401);

  const ok = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/plan`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'test-admin-token' },
    body: JSON.stringify({ plan: 'pro', billing_ref: 'sub_789', valid_until: '2026-12-01' }),
  }), env, {});
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.plan, 'pro');
  assert.equal(body.monthly_quota, 5000);
  assert.equal(body.billing_ref, 'sub_789');

  const statusRes = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/status`), env, {});
  const statusBody = await statusRes.json();
  assert.equal(statusBody.plan, 'pro');
  assert.equal(statusBody.monthly_quota, 5000);
  assert.equal(statusBody.valid_until, '2026-12-01');
});

test('POST /v1/tenants/:id/plan is accepted as an alias of PATCH at the router level', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop9.sk');
  const res = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'test-admin-token' },
    body: JSON.stringify({ plan: 'starter' }),
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan, 'starter');
});
