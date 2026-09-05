// tenant-client.test.mjs
// Thin HTTP client for the existing ARLing Asistent tenant API
// (POST /v1/tenants, GET /v1/tenants/:id/status). Covers the request shape
// sent, and both response shapes the live worker can return: 201 for a
// brand-new tenant, and 200 with `existing: true` for a repeat submission
// against an already-known domain (see worker/src/onboarding.js
// createTenantFromRequest in the parent product), plus error passthrough.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTenant, getTenantStatus } from '../shopify-worker/src/tenant-client.js';

function makeEnv() {
  return { ARLING_API_BASE: 'https://arling-asistent.arling.workers.dev' };
}

test('createTenant posts feed_url/domain/email to POST /v1/tenants and returns ok:true on 201 (new tenant)', async () => {
  const env = makeEnv();
  let capturedUrl;
  let capturedOptions;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { status: 201, json: async () => ({ id: 'tenant_1', domain: 'my-shop.myshopify.com', status: 'pending', plan: 'free', monthly_quota: 100 }) };
  };

  const result = await createTenant(env, { feedUrl: 'https://my-shop.myshopify.com/products.json', domain: 'my-shop.myshopify.com', email: 'a@b.com' }, { fetchImpl });

  assert.equal(capturedUrl, 'https://arling-asistent.arling.workers.dev/v1/tenants');
  assert.equal(capturedOptions.method, 'POST');
  const sentBody = JSON.parse(capturedOptions.body);
  assert.equal(sentBody.feed_url, 'https://my-shop.myshopify.com/products.json');
  assert.equal(sentBody.domain, 'my-shop.myshopify.com');
  assert.equal(sentBody.email, 'a@b.com');

  assert.equal(result.ok, true);
  assert.equal(result.data.id, 'tenant_1');
});

test('createTenant treats a 200 response with existing:true the same as a 201 (idempotent resubmission)', async () => {
  const env = makeEnv();
  const fetchImpl = async () => ({ status: 200, json: async () => ({ id: 'tenant_1', domain: 'my-shop.myshopify.com', status: 'ready', plan: 'free', monthly_quota: 100, existing: true }) });

  const result = await createTenant(env, { feedUrl: 'https://my-shop.myshopify.com/products.json', domain: 'my-shop.myshopify.com', email: 'a@b.com' }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.data.existing, true);
  assert.equal(result.data.id, 'tenant_1');
});

test('createTenant surfaces a validation_failed 400 as ok:false with issues', async () => {
  const env = makeEnv();
  const fetchImpl = async () => ({ status: 400, json: async () => ({ error: 'validation_failed', issues: ['domain is missing or not a valid hostname'] }) });

  const result = await createTenant(env, { feedUrl: 'not-a-url', domain: '', email: 'nope' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'validation_failed');
  assert.deepEqual(result.issues, ['domain is missing or not a valid hostname']);
});

test('getTenantStatus returns ok:true with the status payload (including product_count) on 200, and ok:false on 404', async () => {
  const env = makeEnv();
  const okFetch = async (url) => {
    assert.equal(url, 'https://arling-asistent.arling.workers.dev/v1/tenants/tenant_1/status');
    return { status: 200, json: async () => ({ id: 'tenant_1', domain: 'my-shop.myshopify.com', status: 'ready', plan: 'free', monthly_quota: 100, used_this_month: 3, product_count: 42, last_ingested_at: '2026-09-01T00:00:00.000Z' }) };
  };
  const okResult = await getTenantStatus(env, 'tenant_1', { fetchImpl: okFetch });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.data.product_count, 42);

  const notFoundFetch = async () => ({ status: 404, json: async () => ({ error: 'not_found' }) });
  const notFoundResult = await getTenantStatus(env, 'ghost', { fetchImpl: notFoundFetch });
  assert.equal(notFoundResult.ok, false);
  assert.equal(notFoundResult.status, 404);
});
