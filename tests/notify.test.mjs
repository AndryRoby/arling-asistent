// notify.test.mjs
// Owner quota notifications (worker/src/notify.js): the 80 % and 100 %
// thresholds fire exactly once per tenant per month via the homelab ping
// endpoint, remembered in KV, and never throw into the chat request.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  thresholdsCrossed,
  buildQuotaPingUrl,
  quotaNotifiedKey,
  maybeNotifyQuota,
  DEFAULT_QUOTA_PING_URL,
  QUOTA_NOTIFIED_TTL_SECONDS,
} from '../worker/src/notify.js';
import { createMockKV } from './helpers/mock-cf.mjs';

function makeEnv(overrides = {}) {
  const calls = [];
  const env = {
    ASISTENT_CACHE: createMockKV(),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    },
    ...overrides,
  };
  return { env, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

test('thresholdsCrossed reports 80 when the counter moves from 79 to 80 of 100, 100 at the last one, both on a jump, nothing otherwise', () => {
  assert.deepEqual(thresholdsCrossed(79, 80, 100), [80]);
  assert.deepEqual(thresholdsCrossed(99, 100, 100), [100]);
  assert.deepEqual(thresholdsCrossed(0, 100, 100), [80, 100]);
  assert.deepEqual(thresholdsCrossed(80, 81, 100), []);
  assert.deepEqual(thresholdsCrossed(10, 11, 100), []);
  assert.deepEqual(thresholdsCrossed(0, 1, 1), [80, 100]); // a quota of 1: the first conversation is 100 %
  assert.deepEqual(thresholdsCrossed(799, 800, 1000), [80]);
});

test('buildQuotaPingUrl matches the contract: ?e=quota_80|quota_100&t={tenantId}&p={usage_percent}', () => {
  const url = buildQuotaPingUrl(DEFAULT_QUOTA_PING_URL, { event: 'quota_80', tenantId: '8d9a6783-7ef9-4790-a63b-c52752face6b', percent: 80 });
  assert.equal(url, 'https://homelab.tailbf8f27.ts.net/subscribe/api/ping?e=quota_80&t=8d9a6783-7ef9-4790-a63b-c52752face6b&p=80');
});

test('quotaNotifiedKey is quota-notified:{tenant}:{YYYY-MM}:{threshold}', () => {
  assert.equal(quotaNotifiedKey('t1', '2026-09', 80), 'quota-notified:t1:2026-09:80');
});

test('maybeNotifyQuota pings quota_80 once when 80 % is crossed and remembers it in KV for the month', async () => {
  const { env, calls } = makeEnv();
  const sent = await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  assert.deepEqual(sent, ['quota_80']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_QUOTA_PING_URL}?e=quota_80&t=t1&p=80`);
  assert.equal(calls[0].opts.method, 'GET');
  assert.ok(env.ASISTENT_CACHE._store.has('quota-notified:t1:2026-09:80'));
  assert.equal(env.ASISTENT_CACHE._puts[0].options.expirationTtl, QUOTA_NOTIFIED_TTL_SECONDS);
});

test('maybeNotifyQuota does not ping the same threshold twice in the same month, but does ping 100 % later', async () => {
  const { env, calls } = makeEnv();
  await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  // Simulate a second request that also believes it crossed 80 (e.g. the
  // quota was lowered and raised, or a KV/D1 race): must stay silent.
  const again = await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  assert.deepEqual(again, []);
  assert.equal(calls.length, 1);

  const full = await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 99, usedAfter: 100, quota: 100, now: NOW });
  assert.deepEqual(full, ['quota_100']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${DEFAULT_QUOTA_PING_URL}?e=quota_100&t=t1&p=100`);
});

test('maybeNotifyQuota fires again in a new month (the KV marker carries the month)', async () => {
  const { env, calls } = makeEnv();
  await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  const october = await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: new Date('2026-10-03T08:00:00Z') });
  assert.deepEqual(october, ['quota_80']);
  assert.equal(calls.length, 2);
  assert.ok(env.ASISTENT_CACHE._store.has('quota-notified:t1:2026-10:80'));
});

test('maybeNotifyQuota sends both events, in order, when one increment jumps past both thresholds', async () => {
  const { env, calls } = makeEnv();
  const sent = await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 0, usedAfter: 1, quota: 1, now: NOW });
  assert.deepEqual(sent, ['quota_80', 'quota_100']);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /e=quota_80&t=t1&p=100/);
  assert.match(calls[1].url, /e=quota_100&t=t1&p=100/);
});

test('maybeNotifyQuota does nothing when no threshold was crossed, and never pings for the same tenant twice via different tenants', async () => {
  const { env, calls } = makeEnv();
  assert.deepEqual(await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 10, usedAfter: 11, quota: 100, now: NOW }), []);
  assert.equal(calls.length, 0);
  await maybeNotifyQuota(env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  await maybeNotifyQuota(env, { tenantId: 't2', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  assert.equal(calls.length, 2); // t1 and t2 are independent
});

test('maybeNotifyQuota never throws: a failing ping, a non-2xx ping, and a broken KV are all swallowed (KV failure still pings)', async () => {
  const failing = makeEnv({ fetchImpl: async () => { throw new Error('network down'); } });
  await assert.doesNotReject(() => maybeNotifyQuota(failing.env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW }));

  const non2xx = makeEnv({ fetchImpl: async () => ({ ok: false, status: 429 }) });
  const sent = await maybeNotifyQuota(non2xx.env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  assert.deepEqual(sent, ['quota_80']);

  const brokenKv = makeEnv({
    ASISTENT_CACHE: {
      async get() { throw new Error('KV outage'); },
      async put() { throw new Error('KV outage'); },
    },
  });
  const sentAnyway = await maybeNotifyQuota(brokenKv.env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  assert.deepEqual(sentAnyway, ['quota_80']);
  assert.equal(brokenKv.calls.length, 1);
});

test('maybeNotifyQuota is disabled entirely by QUOTA_PING_URL="" and honours a custom QUOTA_PING_URL', async () => {
  const off = makeEnv({ QUOTA_PING_URL: '' });
  assert.deepEqual(await maybeNotifyQuota(off.env, { tenantId: 't1', usedBefore: 0, usedAfter: 1, quota: 1, now: NOW }), []);
  assert.equal(off.calls.length, 0);

  const custom = makeEnv({ QUOTA_PING_URL: 'https://example.test/ping' });
  await maybeNotifyQuota(custom.env, { tenantId: 't1', usedBefore: 79, usedAfter: 80, quota: 100, now: NOW });
  assert.equal(custom.calls[0].url, 'https://example.test/ping?e=quota_80&t=t1&p=80');
});
