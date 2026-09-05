// onboarding.test.mjs
// Tenant self-serve creation (POST /v1/tenants) end to end: validation,
// background ingestion, and the status endpoint, including the HTTP route
// handlers using real (Node-native) Request/Response objects.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTenantFromRequest, ingestFeedForTenant, tenantStatusResponse, handleCreateTenantRoute, handleTenantStatusRoute, handleReingestRoute, TENANT_STATUS } from '../worker/src/onboarding.js';
import { getTenantById, listTenants, SQL } from '../worker/src/tenants.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize } from './helpers/mock-cf.mjs';

const GENERIC_XML = `<products><item><id>1</id><name>Test product</name><price>9.99</price><url>https://shop.sk/p/1</url><description>Popis produktu.</description></item></products>`;

const ADMIN_TOKEN = 'test-admin-token';

function makeEnv({ feedText = GENERIC_XML, feedOk = true } = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN,
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

test('tenantStatusResponse reports product_count after ingestion, matching the number of products in the feed', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'productcount.sk', email: 'a@productcount.sk' });
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.product_count, 1); // GENERIC_XML fixture has exactly one <item>
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

test('handleCreateTenantRoute carries Access-Control-Allow-Origin for an allowed Origin (bug: only the OPTIONS preflight had it before)', async () => {
  const env = makeEnv();
  const request = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    headers: { Origin: 'https://arling.sk' },
    body: JSON.stringify({ feed_url: 'https://shop.sk/feed.xml', domain: 'cors.sk', email: 'a@cors.sk' }),
  });
  const res = await handleCreateTenantRoute(request, env, {});
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');
});

test('handleCreateTenantRoute carries CORS headers even on a validation failure', async () => {
  const env = makeEnv();
  const request = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    headers: { Origin: 'https://arling.sk' },
    body: JSON.stringify({ feed_url: 'not-a-url', domain: '', email: 'nope' }),
  });
  const res = await handleCreateTenantRoute(request, env, {});
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');
});

test('handleCreateTenantRoute omits the CORS header for a disallowed Origin', async () => {
  const env = makeEnv();
  const request = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    headers: { Origin: 'https://attacker.com' },
    body: JSON.stringify({ feed_url: 'https://shop.sk/feed.xml', domain: 'nocors.sk', email: 'a@nocors.sk' }),
  });
  const res = await handleCreateTenantRoute(request, env, {});
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

// ---------------------------------------------------------------------------
// Idempotent re-submission of an already-known domain (POST /v1/tenants)
// ---------------------------------------------------------------------------

test('createTenantFromRequest is idempotent for an existing domain: returns it with existing:true instead of throwing, and creates no second row', async () => {
  const env = makeEnv();
  const first = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'dup.sk', email: 'owner@dup.sk' });

  env.VECTORIZE._store.clear(); // so we can tell below whether a second ingestion actually ran

  const second = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'dup.sk', email: 'someone-else@dup.sk' });
  assert.equal(second.existing, true);
  assert.equal(second.id, first.id);
  assert.equal(second.domain, 'dup.sk');
  assert.equal(second.status, TENANT_STATUS.READY); // the tenant's real current status, not a fresh 'pending' snapshot
  assert.equal(second.contact_email, undefined); // never exposes the (possibly different) stored contact email

  const all = await listTenants(env.DB);
  assert.equal(all.filter((t) => t.domain === 'dup.sk').length, 1); // no second row was inserted

  // Same feed_url, ingestion just happened (not stale): no re-ingestion.
  assert.equal(env.VECTORIZE._store.size, 0);
});

test('createTenantFromRequest refreshes an existing tenant when the resubmitted feed_url differs, updating feed_url and re-ingesting via waitUntil', async () => {
  const env = makeEnv();
  const first = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed-old.xml', domain: 'refresh.sk', email: 'owner@refresh.sk' });

  env.VECTORIZE._store.clear();

  const waited = [];
  const second = await createTenantFromRequest(
    env,
    { feedUrl: 'https://shop.sk/feed-new.xml', domain: 'refresh.sk', email: 'owner@refresh.sk' },
    { waitUntil: (p) => waited.push(p) }
  );
  assert.equal(second.existing, true);
  assert.equal(second.id, first.id);
  assert.equal(waited.length, 1); // re-ingestion was handed to ctx.waitUntil, not blocking the response
  await waited[0];

  const after = await getTenantById(env.DB, first.id);
  assert.equal(after.feed_url, 'https://shop.sk/feed-new.xml');
  assert.ok(env.VECTORIZE._store.size > 0); // re-ingestion actually ran against the new feed
});

test('createTenantFromRequest re-ingests an existing tenant whose last successful ingestion is more than 24h old, even with an unchanged feed_url', async () => {
  const env = makeEnv();
  const created = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'stale.sk', email: 'owner@stale.sk' });

  env.DB._tenants.get(created.id).last_ingested_at = new Date('2020-01-01T00:00:00Z').toISOString();
  env.VECTORIZE._store.clear();

  const now = new Date('2026-09-05T00:00:00Z');
  const second = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'stale.sk', email: 'owner@stale.sk' }, { now });
  assert.equal(second.existing, true);
  assert.ok(env.VECTORIZE._store.size > 0); // re-ingested despite the unchanged feed_url, because it was stale
});

test('createTenantFromRequest retries ingestion on resubmission for a tenant stuck in error status, even right after the failed attempt (within the 24h window)', async () => {
  // ingestFeedForTenant's failure branch still stamps last_ingested_at (it
  // marks the last attempt, not the last success), so relying on the 24h
  // window alone would never retry a tenant whose feed was briefly broken;
  // status === 'error' must force a retry on the very next submission.
  const env = makeEnv({ feedOk: false });
  const created = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/broken.xml', domain: 'neverready.sk', email: 'owner@neverready.sk' });
  assert.equal((await getTenantById(env.DB, created.id)).status, TENANT_STATUS.ERROR);

  env.fetchImpl = async () => ({ ok: true, status: 200, text: async () => GENERIC_XML }); // the feed is fixed now
  const second = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/broken.xml', domain: 'neverready.sk', email: 'owner@neverready.sk' });
  assert.equal(second.existing, true);
  const after = await getTenantById(env.DB, created.id);
  assert.equal(after.status, TENANT_STATUS.READY);
});

test('handleCreateTenantRoute returns 200 with existing:true (not 201) and never leaks contact_email for a repeat submission of the same domain', async () => {
  const env = makeEnv();
  const firstRequest = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    body: JSON.stringify({ feed_url: 'https://shop.sk/feed.xml', domain: 'route-dup.sk', email: 'owner@route-dup.sk' }),
  });
  const firstRes = await handleCreateTenantRoute(firstRequest, env, {});
  assert.equal(firstRes.status, 201);
  const firstBody = await firstRes.json();
  assert.equal(firstBody.existing, undefined);

  const secondRequest = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    body: JSON.stringify({ feed_url: 'https://shop.sk/feed.xml', domain: 'route-dup.sk', email: 'someone-else@route-dup.sk' }),
  });
  const secondRes = await handleCreateTenantRoute(secondRequest, env, {});
  assert.equal(secondRes.status, 200);
  const secondBody = await secondRes.json();
  assert.equal(secondBody.id, firstBody.id);
  assert.equal(secondBody.existing, true);
  const rawBody = JSON.stringify(secondBody);
  assert.ok(!rawBody.includes('owner@route-dup.sk'));
  assert.ok(!rawBody.includes('someone-else@route-dup.sk'));
});

test('handleCreateTenantRoute maps a non-domain D1 constraint violation to 409 conflict instead of 500', async () => {
  const env = makeEnv();
  // A real id collision cannot be triggered through the public HTTP route
  // (ids are always server-generated, never client-supplied), so this stubs
  // the D1 binding directly to raise the same kind of error D1 itself raises
  // for a constraint violation that is not the domain-uniqueness case, to
  // exercise the createTenant -> D1ConstraintError -> 409 wiring end to end.
  env.DB = {
    prepare(sql) {
      if (sql === SQL.INSERT_TENANT) {
        return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: UNIQUE constraint failed: tenants.id: SQLITE_CONSTRAINT'); } }) };
      }
      throw new Error(`mock: unexpected statement for this test: ${sql}`);
    },
  };
  const request = new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    body: JSON.stringify({ feed_url: 'https://shop.sk/feed.xml', domain: 'conflict.sk', email: 'a@conflict.sk' }),
  });
  const res = await handleCreateTenantRoute(request, env, {});
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'conflict');
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

test('handleTenantStatusRoute carries Access-Control-Allow-Origin for an allowed Origin, for both the ready and not-found cases', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'status-cors.sk', email: 'a@status-cors.sk' });

  const okRes = await handleTenantStatusRoute(new Request('https://x/', { headers: { Origin: 'https://arling.sk' } }), env, tenant.id);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');

  const notFoundRes = await handleTenantStatusRoute(new Request('https://x/', { headers: { Origin: 'https://arling.sk' } }), env, 'ghost');
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');
});

// ---------------------------------------------------------------------------
// Admin re-ingestion (POST /v1/tenants/:id/reingest)
// ---------------------------------------------------------------------------

test('handleReingestRoute rejects a missing or wrong X-Admin-Token with 401', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'admin1.sk', email: 'a@admin1.sk' });

  const noToken = await handleReingestRoute(new Request('https://x/', { method: 'POST' }), env, tenant.id);
  assert.equal(noToken.status, 401);

  const wrongToken = await handleReingestRoute(new Request('https://x/', { method: 'POST', headers: { 'X-Admin-Token': 'nope' } }), env, tenant.id);
  assert.equal(wrongToken.status, 401);
});

test('handleReingestRoute refuses every request when ADMIN_TOKEN is not configured, rather than allowing unauthenticated re-ingestion', async () => {
  const env = makeEnv();
  delete env.ADMIN_TOKEN;
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'admin2.sk', email: 'a@admin2.sk' });
  const res = await handleReingestRoute(new Request('https://x/', { method: 'POST', headers: { 'X-Admin-Token': 'anything' } }), env, tenant.id);
  assert.equal(res.status, 401);
});

test('handleReingestRoute re-ingests a known tenant with a correct token, using the same ingestFeedForTenant the cron uses', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'admin3.sk', email: 'a@admin3.sk' });
  env.VECTORIZE._store.clear(); // pretend the metadata index was just created and vectors need re-embedding

  const res = await handleReingestRoute(new Request('https://x/', { method: 'POST', headers: { 'X-Admin-Token': ADMIN_TOKEN } }), env, tenant.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.upserted > 0);
  assert.equal(body.productCount, 1); // GENERIC_XML fixture has exactly one <item>
  assert.ok(env.VECTORIZE._store.size > 0);

  const after = await getTenantById(env.DB, tenant.id);
  assert.equal(after.status, TENANT_STATUS.READY);
  assert.equal(after.product_count, 1);
});

test('handleReingestRoute returns 404 for an unknown tenant even with a correct token', async () => {
  const env = makeEnv();
  const res = await handleReingestRoute(new Request('https://x/', { method: 'POST', headers: { 'X-Admin-Token': ADMIN_TOKEN } }), env, 'ghost');
  assert.equal(res.status, 404);
});
