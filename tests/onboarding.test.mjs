// onboarding.test.mjs
// Tenant self-serve creation (POST /v1/tenants) end to end: validation,
// background ingestion, and the status endpoint, including the HTTP route
// handlers using real (Node-native) Request/Response objects.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTenantFromRequest, ingestFeedForTenant, tenantStatusResponse, handleCreateTenantRoute, handleTenantStatusRoute, handleReingestRoute, handleSetPlanRoute, TENANT_STATUS } from '../worker/src/onboarding.js';
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

// ---------------------------------------------------------------------------
// Admin: set plan (PATCH/POST /v1/tenants/:id/plan), the actual billing
// fix: a paid Stripe plan must change monthly_quota, not just plan.
// ---------------------------------------------------------------------------

function planRequest(body, { method = 'PATCH', token = ADMIN_TOKEN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Admin-Token'] = token;
  return new Request('https://x/', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('handleSetPlanRoute rejects a missing or wrong X-Admin-Token with 401', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan1.sk', email: 'a@plan1.sk' });

  const noToken = await handleSetPlanRoute(planRequest({ plan: 'starter' }, { token: null }), env, tenant.id);
  assert.equal(noToken.status, 401);

  const wrongToken = await handleSetPlanRoute(planRequest({ plan: 'starter' }, { token: 'nope' }), env, tenant.id);
  assert.equal(wrongToken.status, 401);
});

test('handleSetPlanRoute refuses every request when ADMIN_TOKEN is not configured', async () => {
  const env = makeEnv();
  delete env.ADMIN_TOKEN;
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan2.sk', email: 'a@plan2.sk' });
  const res = await handleSetPlanRoute(planRequest({ plan: 'starter' }, { token: 'anything' }), env, tenant.id);
  assert.equal(res.status, 401);
});

test('handleSetPlanRoute rejects an invalid plan value with 400 validation_failed', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan3.sk', email: 'a@plan3.sk' });
  const res = await handleSetPlanRoute(planRequest({ plan: 'ultra' }), env, tenant.id);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'validation_failed');
});

test('handleSetPlanRoute returns 404 for an unknown tenant even with a correct token', async () => {
  const env = makeEnv();
  const res = await handleSetPlanRoute(planRequest({ plan: 'starter' }), env, 'ghost');
  assert.equal(res.status, 404);
});

test('handleSetPlanRoute sets plan and defaults monthly_quota from the plan when not given, and GET status reflects it', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan4.sk', email: 'a@plan4.sk' });
  const res = await handleSetPlanRoute(planRequest({ plan: 'starter' }), env, tenant.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan, 'starter');
  assert.equal(body.monthly_quota, 1000);

  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.plan, 'starter');
  assert.equal(status.monthly_quota, 1000);
});

test('handleSetPlanRoute defaults pro to 3000 and free to 100', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan5.sk', email: 'a@plan5.sk' });
  const proRes = await handleSetPlanRoute(planRequest({ plan: 'pro' }), env, tenant.id);
  const proBody = await proRes.json();
  assert.equal(proBody.monthly_quota, 3000);

  const freeRes = await handleSetPlanRoute(planRequest({ plan: 'free' }), env, tenant.id);
  const freeBody = await freeRes.json();
  assert.equal(freeBody.monthly_quota, 100);
});

test('handleSetPlanRoute accepts an explicit monthly_quota override instead of the plan default', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan6.sk', email: 'a@plan6.sk' });
  const res = await handleSetPlanRoute(planRequest({ plan: 'starter', monthly_quota: 2500 }), env, tenant.id);
  const body = await res.json();
  assert.equal(body.monthly_quota, 2500);
});

test('handleSetPlanRoute stores billing_ref and valid_until: the admin PATCH response echoes both, the public GET status shows valid_until only', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan7.sk', email: 'a@plan7.sk' });
  const res = await handleSetPlanRoute(planRequest({ plan: 'pro', billing_ref: 'sub_123', valid_until: '2026-11-01' }), env, tenant.id);
  const body = await res.json();
  assert.equal(body.billing_ref, 'sub_123');
  assert.equal(body.valid_until, '2026-11-01');

  // The tenant id is public (it sits in every shop page's embed script), so
  // the public status must never carry the Stripe subscription id.
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.valid_until, '2026-11-01');
  assert.equal('billing_ref' in status, false);
  assert.equal('contact_email' in status, false);

  const adminView = await tenantStatusResponse(env, tenant.id, { includeBilling: true });
  assert.equal(adminView.billing_ref, 'sub_123');
});

test('handleSetPlanRoute clears billing_ref/valid_until to null when a later call omits them (e.g. downgrade to free)', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan8.sk', email: 'a@plan8.sk' });
  await handleSetPlanRoute(planRequest({ plan: 'starter', billing_ref: 'sub_456', valid_until: '2026-10-01' }), env, tenant.id);
  const res = await handleSetPlanRoute(planRequest({ plan: 'free' }), env, tenant.id);
  const body = await res.json();
  assert.equal(body.plan, 'free');
  assert.equal(body.billing_ref, null);
  assert.equal(body.valid_until, null);
});

test('handleSetPlanRoute accepts POST as an alias of PATCH, same result', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan9.sk', email: 'a@plan9.sk' });
  const res = await handleSetPlanRoute(planRequest({ plan: 'starter' }, { method: 'POST' }), env, tenant.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan, 'starter');
});

test('handleSetPlanRoute returns 400 on invalid JSON body', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'plan10.sk', email: 'a@plan10.sk' });
  const res = await handleSetPlanRoute(new Request('https://x/', { method: 'PATCH', headers: { 'X-Admin-Token': ADMIN_TOKEN }, body: '{not json' }), env, tenant.id);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Public status contract (GET /v1/tenants/:id/status)
// ---------------------------------------------------------------------------

test('tenantStatusResponse follows the public contract: usage fields, period bounds, last_ingest, no billing_ref and no contact_email', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'contract.sk', email: 'owner@contract.sk' });
  const now = new Date('2026-09-05T12:00:00Z');
  const row = env.DB._tenants.get(tenant.id);
  row.quota_month = '2026-09';
  row.used_this_month = 37;
  row.monthly_quota = 100;

  const status = await tenantStatusResponse(env, tenant.id, { now });
  assert.equal(status.id, tenant.id);
  assert.equal(status.domain, 'contract.sk');
  assert.equal(status.plan, 'free');
  assert.equal(status.status, TENANT_STATUS.READY);
  assert.equal(status.monthly_quota, 100);
  assert.equal(status.conversations_used, 37);
  assert.equal(status.usage_percent, 37);
  assert.equal(status.period_start, '2026-09-01');
  assert.equal(status.period_end, '2026-10-01');
  assert.equal(status.product_count, 1);
  assert.equal(status.valid_until, null);
  assert.equal(status.last_ingest, row.last_ingested_at);
  assert.match(status.last_ingest, /^2\d{3}-\d{2}-\d{2}T/); // ISO timestamp stamped by ingestion
  assert.equal('billing_ref' in status, false);
  assert.equal('contact_email' in status, false);
  assert.equal(JSON.stringify(status).includes('owner@contract.sk'), false);
  // Older consumers (WordPress plugin, Shopify admin page) still read these names.
  assert.equal(status.used_this_month, 37);
  assert.equal(status.last_ingested_at, row.last_ingested_at);
});

test('tenantStatusResponse reports conversations_used 0 and usage_percent 0 once the month has rolled over past the stored quota_month', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'rollover.sk', email: 'a@rollover.sk' });
  const row = env.DB._tenants.get(tenant.id);
  row.quota_month = '2026-08';
  row.used_this_month = 90;
  const status = await tenantStatusResponse(env, tenant.id, { now: new Date('2026-09-02T00:00:00Z') });
  assert.equal(status.conversations_used, 0);
  assert.equal(status.usage_percent, 0);
  assert.equal(status.period_start, '2026-09-01');
});

test('tenantStatusResponse reports a legacy "trial" plan as "free" (the public contract knows only free/starter/pro) and last_ingest null before any ingestion', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'legacy-trial.sk', email: 'a@legacy-trial.sk' });
  const row = env.DB._tenants.get(tenant.id);
  row.plan = 'trial';
  row.last_ingested_at = null;
  const status = await tenantStatusResponse(env, tenant.id);
  assert.equal(status.plan, 'free');
  assert.equal(status.last_ingest, null);
  assert.equal(status.last_ingested_at, null);
});

test('handleTenantStatusRoute (public GET) never returns billing_ref even after a plan with one was set', async () => {
  const env = makeEnv();
  const tenant = await createTenantFromRequest(env, { feedUrl: 'https://shop.sk/feed.xml', domain: 'public-status.sk', email: 'a@public-status.sk' });
  await handleSetPlanRoute(planRequest({ plan: 'starter', billing_ref: 'sub_secret', valid_until: '2026-12-01' }), env, tenant.id);
  const res = await handleTenantStatusRoute(new Request('https://x/'), env, tenant.id);
  const text = await res.text();
  assert.equal(text.includes('sub_secret'), false);
  assert.equal(text.includes('billing_ref'), false);
  assert.equal(text.includes('contact_email'), false);
  const body = JSON.parse(text);
  assert.equal(body.plan, 'starter');
  assert.equal(body.valid_until, '2026-12-01');
  assert.equal(typeof body.usage_percent, 'number');
});
