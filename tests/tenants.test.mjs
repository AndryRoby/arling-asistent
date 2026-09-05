// tenants.test.mjs
// Tenant creation validation, quota check-and-increment, monthly reset, and
// counters, against the narrow in-memory D1 mock.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateHost,
  validateTenantInput,
  normaliseDomain,
  createTenant,
  getTenantById,
  getTenantByDomain,
  listTenants,
  setTenantStatus,
  checkAndRecordConversation,
  recordProductClick,
  ensureProductCountColumn,
  setProductCount,
  setFeedUrl,
  monthKey,
  ValidationError,
  DuplicateDomainError,
  D1ConstraintError,
  PLANS,
  DEFAULT_FREE_QUOTA,
  SQL,
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

test('createTenant inserts a row with free-plan defaults and returns it', async () => {
  const db = createMockD1();
  const now = new Date('2026-09-04T10:00:00Z');
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' }, { now });
  assert.equal(tenant.domain, 'shop.sk');
  assert.equal(tenant.plan, PLANS.FREE);
  assert.equal(tenant.status, 'pending');
  assert.equal(tenant.monthly_quota, DEFAULT_FREE_QUOTA);
  assert.equal(tenant.used_this_month, 0);
  assert.equal(tenant.product_count, 0);
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

test('createTenant throws DuplicateDomainError (not a generic 500-shaped error) when the domain is already taken, and does not insert a second row', async () => {
  const db = createMockD1();
  await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' });
  await assert.rejects(
    () => createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed2.xml', contactEmail: 'b@shop.sk' }),
    (err) => {
      assert.ok(err instanceof DuplicateDomainError);
      assert.equal(err.domain, 'shop.sk');
      return true;
    }
  );
  assert.equal(db._tenants.size, 1);
});

test('createTenant throws D1ConstraintError (not DuplicateDomainError) for a constraint violation unrelated to domain, e.g. a colliding explicit id', async () => {
  const db = createMockD1();
  await createTenant(db, { domain: 'a.sk', feedUrl: 'https://a.sk/feed.xml', contactEmail: 'a@a.sk' }, { id: 'fixed-id' });
  await assert.rejects(
    () => createTenant(db, { domain: 'b.sk', feedUrl: 'https://b.sk/feed.xml', contactEmail: 'b@b.sk' }, { id: 'fixed-id' }),
    D1ConstraintError
  );
  assert.equal(db._tenants.size, 1);
});

test('setFeedUrl updates only the feed_url column', async () => {
  const db = createMockD1();
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/old.xml', contactEmail: 'a@shop.sk' });
  await setFeedUrl(db, tenant.id, 'https://shop.sk/new.xml');
  const fetched = await getTenantById(db, tenant.id);
  assert.equal(fetched.feed_url, 'https://shop.sk/new.xml');
  assert.equal(fetched.domain, 'shop.sk'); // untouched
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

// ---------------------------------------------------------------------------
// product_count (added to an already-existing tenants table at runtime)
// ---------------------------------------------------------------------------

test('setProductCount stores the count and it is readable back on the tenant row', async () => {
  const db = createMockD1();
  const tenant = await createTenant(db, { domain: 'shop.sk', feedUrl: 'https://shop.sk/feed.xml', contactEmail: 'a@shop.sk' });
  await setProductCount(db, tenant.id, 42);
  const fetched = await getTenantById(db, tenant.id);
  assert.equal(fetched.product_count, 42);
});

test('setProductCount adds the product_count column on demand for a database created before it existed', async () => {
  const db = createMockD1();
  // Simulate a tenant row created before product_count was ever introduced:
  // the mock only sets product_count on INSERT once its ALTER TABLE case has
  // run, so a tenant created against a fresh mock never has the field yet.
  const tenant = await createTenant(db, { domain: 'legacy.sk', feedUrl: 'https://legacy.sk/feed.xml', contactEmail: 'a@legacy.sk' });
  assert.equal(db._tenants.get(tenant.id).product_count, undefined);

  await setProductCount(db, tenant.id, 7);

  const fetched = await getTenantById(db, tenant.id);
  assert.equal(fetched.product_count, 7);
});

test('ensureProductCountColumn is guarded: tolerates a column that was already added (e.g. by a previous deploy/isolate)', async () => {
  const db = createMockD1();
  await db.prepare(SQL.ADD_PRODUCT_COUNT_COLUMN).run(); // pre-migrate, as if a previous call already ran this
  await assert.doesNotReject(() => ensureProductCountColumn(db));
});

test('ensureProductCountColumn only runs the ALTER TABLE once per db binding (cached), even across many calls', async () => {
  const db = createMockD1();
  await ensureProductCountColumn(db);
  await ensureProductCountColumn(db);
  await ensureProductCountColumn(db);
  // A second raw ALTER TABLE against the same mock would now throw
  // (duplicate column): proves the column was only actually added once.
  await assert.rejects(() => db.prepare(SQL.ADD_PRODUCT_COUNT_COLUMN).run(), /duplicate column/i);
});

test('validateTenantInput rejects feeds on localhost and private networks', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.20', '172.20.3.4', '169.254.1.1', '[::1]', 'shop.local', 'nas.lan']) {
    assert.equal(isPrivateHost(h.replace(/^\[|\]$/g, '')), true, h);
    assert.throws(() => validateTenantInput({ domain: 'example.com', feedUrl: 'http://' + h + ':8300/wp-json/wc/store/v1/products', contactEmail: 'a@example.com' }), /publicly reachable/, 'issue for ' + h);
  }
  for (const h of ['www.allbirds.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', 'shop.example.co.uk']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});
