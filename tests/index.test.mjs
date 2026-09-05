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
  // fetchImpl doubles as the feed fetcher (onboarding.js) and the quota
  // ping transport (notify.js), so no test here ever touches the network;
  // every outgoing call is recorded in env.outbound for assertions.
  const outbound = [];
  const env = {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ answer: 'Mame to skladom.', products: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: 'test-admin-token',
    outbound,
    fetchImpl: async (url, opts) => {
      outbound.push({ url: String(url), opts });
      return { ok: true, status: 200, text: async () => '<products></products>' };
    },
  };
  return env;
}

function chatRequest(tenant, { session, message = 'Mate to skladom?', ip = '9.9.9.9' } = {}) {
  const body = { tenant: tenant.id, messages: [{ role: 'user', content: message }], lang: 'sk' };
  if (session !== undefined) body.session = session;
  return new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `https://${tenant.domain}`, 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

async function conversationsUsed(env, tenant) {
  const res = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/status`), env, {});
  return (await res.json()).conversations_used;
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

test('POST /v1/chat reports Workers AI daily neuron exhaustion as 503 quota_exceeded, not a generic 500', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'shop6.sk');
  env.AI = {
    async run() {
      // Matches the real Cloudflare Workers AI error observed in production
      // (AiError code 4006) closely enough for the router's detection to
      // recognise it: account-wide daily free allocation exhausted, not a
      // bug in this worker.
      const err = new Error("4006: you have used up your daily free allocation of 10000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.");
      err.name = 'AiError';
      throw err;
    },
  };
  const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://shop6.sk', 'CF-Connecting-IP': '6.6.6.6' },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: 'hi' }] }),
  }), env, {});
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
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

// ---------------------------------------------------------------------------
// Session-based counting, public status contract and quota pings, end to end
// ---------------------------------------------------------------------------

test('POST /v1/chat twice with the same session grows conversations_used by exactly 1; a new session grows it by 1 more', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'session.sk');
  assert.equal(await conversationsUsed(env, tenant), 0);

  const first = await worker.fetch(chatRequest(tenant, { session: 'a1b2c3d4e5f60718' }), env, {});
  assert.equal(first.status, 200);
  const second = await worker.fetch(chatRequest(tenant, { session: 'a1b2c3d4e5f60718', message: 'A v inej farbe?' }), env, {});
  assert.equal(second.status, 200);
  assert.equal(await conversationsUsed(env, tenant), 1);

  const third = await worker.fetch(chatRequest(tenant, { session: '0000ffff0000ffff' }), env, {});
  assert.equal(third.status, 200);
  assert.equal(await conversationsUsed(env, tenant), 2);

  // An embed that predates sessions (no session field) still counts per request.
  await worker.fetch(chatRequest(tenant), env, {});
  await worker.fetch(chatRequest(tenant), env, {});
  assert.equal(await conversationsUsed(env, tenant), 4);
});

test('POST /v1/chat still succeeds and still counts when the KV session dedupe throws (fails open)', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'session-kv.sk');
  env.ASISTENT_CACHE = {
    async get() { throw new Error('simulated KV outage'); },
    async put() { throw new Error('simulated KV outage'); },
  };
  const a = await worker.fetch(chatRequest(tenant, { session: 'a1b2c3d4e5f60718' }), env, {});
  const b = await worker.fetch(chatRequest(tenant, { session: 'a1b2c3d4e5f60718' }), env, {});
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(await conversationsUsed(env, tenant), 2); // no dedupe possible, counted per request, never refused
});

test('GET /v1/tenants/:id/status returns the public contract fields and neither billing_ref nor contact_email', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'status-contract.sk');
  await worker.fetch(chatRequest(tenant, { session: 'a1b2c3d4e5f60718' }), env, {});
  const res = await worker.fetch(new Request(`https://asistent.arling.sk/v1/tenants/${tenant.id}/status`), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  for (const field of ['id', 'domain', 'plan', 'status', 'monthly_quota', 'conversations_used', 'usage_percent', 'period_start', 'period_end', 'product_count', 'valid_until', 'last_ingest']) {
    assert.ok(field in body, `missing ${field}`);
  }
  assert.equal(body.plan, 'free');
  assert.equal(body.conversations_used, 1);
  assert.equal(body.usage_percent, 1);
  assert.match(body.period_start, /^\d{4}-\d{2}-01$/);
  assert.match(body.period_end, /^\d{4}-\d{2}-01$/);
  assert.equal(text.includes('billing_ref'), false);
  assert.equal(text.includes('contact_email'), false);
  assert.equal(text.includes('a@status-contract.sk'), false);
});

test('POST /v1/chat pings the homelab at 80 % and 100 % of the monthly quota, each once per month, via ctx.waitUntil', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'ping.sk');
  env.DB._tenants.get(tenant.id).monthly_quota = 5;
  const background = [];
  const ctx = { waitUntil: (p) => background.push(p) };
  const sessions = ['s1s1s1s1s1s1s1s1', 's2s2s2s2s2s2s2s2', 's3s3s3s3s3s3s3s3', 's4s4s4s4s4s4s4s4', 's5s5s5s5s5s5s5s5'];
  const month = new Date().toISOString().slice(0, 7);

  for (const session of sessions.slice(0, 3)) {
    assert.equal((await worker.fetch(chatRequest(tenant, { session }), env, ctx)).status, 200);
  }
  await Promise.all(background);
  assert.equal(env.outbound.length, 0); // 60 %: nothing yet

  assert.equal((await worker.fetch(chatRequest(tenant, { session: sessions[3] }), env, ctx)).status, 200);
  await Promise.all(background);
  assert.equal(env.outbound.length, 1);
  assert.equal(env.outbound[0].url, `https://homelab.tailbf8f27.ts.net/subscribe/api/ping?e=quota_80&t=${tenant.id}&p=80`);

  // A follow-up in an already-counted session moves nothing and pings nothing.
  assert.equal((await worker.fetch(chatRequest(tenant, { session: sessions[3] }), env, ctx)).status, 200);
  await Promise.all(background);
  assert.equal(env.outbound.length, 1);

  assert.equal((await worker.fetch(chatRequest(tenant, { session: sessions[4] }), env, ctx)).status, 200);
  await Promise.all(background);
  assert.equal(env.outbound.length, 2);
  assert.equal(env.outbound[1].url, `https://homelab.tailbf8f27.ts.net/subscribe/api/ping?e=quota_100&t=${tenant.id}&p=100`);

  // Quota is now full: a new session gets the calm 429, and no third ping goes out.
  const refused = await worker.fetch(chatRequest(tenant, { session: 'ffffffffffffffff' }), env, ctx);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'quota_exceeded' });
  await Promise.all(background);
  assert.equal(env.outbound.length, 2);
  assert.ok(env.ASISTENT_CACHE._store.has(`quota-notified:${tenant.id}:${month}:80`));
  assert.ok(env.ASISTENT_CACHE._store.has(`quota-notified:${tenant.id}:${month}:100`));
});

test('GET /widget.js serves the session-aware widget: sessionStorage session id sent as "session", calm quota message, UTM footer link', async () => {
  const res = await worker.fetch(new Request('https://asistent.arling.sk/widget.js'), makeEnv(), {});
  const body = await res.text();
  assert.match(body, /arling_asistent_session/);
  assert.match(body, /sessionStorage/);
  assert.match(body, /session: SESSION_ID/);
  assert.match(body, /The assistant is resting today\. Please use the shop\\'s contact page\./);
  assert.match(body, /utm_source=widget&utm_medium=referral/);
});
