// tenants.test.mjs
// Tenant creation validation, quota check-and-increment, monthly reset, and
// counters, against the narrow in-memory D1 mock.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTenantInput,
  normaliseDomain,
  createTenant,
  getTenantById,
  getTenantByDomain,
  listTenants,
  setTenantStatus,
  checkAndRecordConversation,
  recordProductClick,
  monthKey,
  ValidationError,
  PLANS,
  DEFAULT_TRIAL_QUOTA,
} from '../worker/src/tenants.js';
import { createMockD1 } from './helpers/mock-d1.mjs';

test('normaliseDomain accepts a bare domain or a full URL and lowercases it', () => {
  assert.equal(normaliseDomain('Shop.Example.SK'), 'shop.example.sk');
  assert.equal(normaliseDomain('https://shop.example.sk/path'), 'shop.example.sk');
  assert.equal(normaliseDomain(''), '');
});

test('validateTenantInput accepts a well-formed submission', () => {
  const clean = validateTenantInput({ domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'Owner@Shop.sk' });
  assert.equal(clean.domain, 'shop.sk');
  assert.equal(clean.feedUrl, 'https://shop.sk/feed.xml');
  assert.equal(clean.contactEmail, 'owner@shop.sk');
});

test('validateTenantInput rejects a missing/invalid domain, feed_url, or email with a ValidationError listing all issues', () => {
  assert.throws(() => validateTenantInput({ domain: '', feedUrl: 'not-a-url', contactEmail: 'nope' }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.issues.length, 3);
    return true;
  });
});

test('validateTenantInput rejects a non-http(s) feed_url scheme', () => {
  assert.throws(() => validateTenantInput({ domain: 'shop.sk', feedUrl: 'ftp://shop.sk/feed.xml', contactEmail: 'a@b.sk' }), ValidationError);
});

test('createTenant inserts a row with trial defaults and returns it', async () => {
  const db = createMockD1();
  const now = new Date('2026-09-04T10:00:00Z');
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' }, { now });
  assert.equal(tenant.domain, 'shop.sk');
  assert.equal(tenant.plan, PLANS.TRIAL);
  assert.equal(tenant.status, 'pending');
  assert.equal(tenant.monthly_quota, DEFAULT_TRIAL_QUOTA);
  assert.equal(tenant.used_this_month, 0);
  assert.equal(tenant.quota_month, monthKey(now));
  assert.ok(tenant.id);

  const fetched = await getTenantById(db, tenant.id);
  assert.equal(fetched.domain, 'shop.sk');
  const byDomain = await getTenantByDomain(db, 'shop.sk');
  assert.equal(byDomain.id, tenant.id);
});

test('createTenant propagates ValidationError and never inserts a row on bad input', async () => {
  const db = createMockD1();
  await assert.rejects(() => createTenant(db, { domain: '', feedUrl: '', contactEmail: '' }), ValidationError);
  assert.equal(db._tenants.size, 0);
});

test('getTenantById / getTenantByDomain return null for an unknown tenant', async () => {
  const db = createMockD1();
  assert.equal(await getTenantById(db, 'nope'), null);
  assert.equal(await getTenantByDomain(db, 'nope.sk'), null);
});

test('listTenants returns every created tenant', async () => {
  const db = createMockD1();
  await createTenant(db, { domain: 'a.sk', feedUrl: 'https://a.sk/f.xml', contactEmail: 'a@a.sk' });
  await createTenant(db, { domain: 'b.sk', feedUrl: 'https://b.sk/f.xml', contactEmail: 'a@b.sk' });
  const all = await listTenants(db);
  assert.equal(all.length, 2);
});

test('setTenantStatus updates status and last_ingested_at', async () => {
  const db = createMockD1();
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' });
  await setTenantStatus(db, tenant.id, 'ready', { now: new Date('2026-09-05T00:00:00Z') });
  const fetched = await getTenantById(db, tenant.id);
  assert.equal(fetched.status, 'ready');
  assert.equal(fetched.last_ingested_at, '2026-09-05T00:00:00.000Z');
});

test('checkAndRecordConversation allows requests under quota and increments used_this_month exactly once per call', async () => {
  const db = createMockD1();
  const now = new Date('2026-09-04T10:00:00Z');
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' }, { now, monthlyQuota: 2 });

  const first = await checkAndRecordConversation(db, tenant.id, { now });
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);

  const second = await checkAndRecordConversation(db, tenant.id, { now });
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);

  const third = await checkAndRecordConversation(db, tenant.id, { now });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'quota_exceeded');

  const fetched = await getTenantById(db, tenant.id);
  assert.equal(fetched.used_this_month, 2);
});

test('checkAndRecordConversation returns unknown_tenant for a nonexistent id', async () => {
  const db = createMockD1();
  const result = await checkAndRecordConversation(db, 'ghost');
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'unknown_tenant');
});

test('checkAndRecordConversation resets used_this_month when the calendar month rolls over', async () => {
  const db = createMockD1();
  const september = new Date('2026-09-30T23:00:00Z');
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' }, { now: september, monthlyQuota: 1 });
  await checkAndRecordConversation(db, tenant.id, { now: september }); // uses up the September quota
  const exhausted = await checkAndRecordConversation(db, tenant.id, { now: september });
  assert.equal(exhausted.allowed, false);

  const october = new Date('2026-10-01T00:30:00Z');
  const afterReset = await checkAndRecordConversation(db, tenant.id, { now: october });
  assert.equal(afterReset.allowed, true);
  const fetched = await getTenantById(db, tenant.id);
  assert.equal(fetched.quota_month, monthKey(october));
  assert.equal(fetched.used_this_month, 1);
});

test('checkAndRecordConversation writes a daily counters row alongside the quota increment', async () => {
  const db = createMockD1();
  const now = new Date('2026-09-04T10:00:00Z');
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' }, { now });
  await checkAndRecordConversation(db, tenant.id, { now });
  await checkAndRecordConversation(db, tenant.id, { now });
  const counterRow = db._counters.get(`${tenant.id}::2026-09-04`);
  assert.equal(counterRow.conversations, 2);
  assert.equal(counterRow.product_clicks, 0);
});

test('recordProductClick increments the click counter independently of conversations', async () => {
  const db = createMockD1();
  const now = new Date('2026-09-04T10:00:00Z');
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' }, { now });
  await recordProductClick(db, tenant.id, { now });
  await recordProductClick(db, tenant.id, { now });
  const counterRow = db._counters.get(`${tenant.id}::2026-09-04`);
  assert.equal(counterRow.product_clicks, 2);
  assert.equal(counterRow.conversations, 0);
});
