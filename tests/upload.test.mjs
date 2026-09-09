// upload.test.mjs
// The paid SEPA file check (worker/src/upload.js): a file is accepted only
// against a Stripe Checkout Session that Stripe itself confirms as paid,
// verification fails closed, and no response ever carries the full e-mail.
//
// Everything runs through the real default.fetch router (index.js) with
// Node-native Request/Response, so the route wiring, the CORS headers and
// the R2 writes are exercised together rather than one pure function at a
// time. env.fetchImpl stands in for Stripe and for the owner ping, so no
// test here touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import {
  maskEmail,
  looksLikeXml,
  objectKeys,
  MAX_UPLOAD_BYTES,
  SESSION_ID_PATTERN,
} from '../worker/src/upload.js';
import { KONTROLA_UPLOAD_EVENT } from '../worker/src/notify.js';
import { RETENTION_SECONDS, MAX_UPLOADS_PER_SESSION } from '../worker/src/upload.js';

const SESSION = 'cs_test_a1b2c3d4e5f6g7h8i9j0';
const ORIGIN = 'https://arling.sk';
const XML = '<?xml version="1.0" encoding="UTF-8"?><Document><CstmrCdtTrfInitn/></Document>';

/**
 * In-memory Workers KV: just the put/get/list surface upload.js uses.
 * Records the options of every put so tests can assert the retention TTL,
 * which is the whole "deleted after 30 days" promise.
 */
function createMockKv() {
  const store = new Map();
  return {
    async put(key, value, options) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, { name: key, bytes, options: options || {} });
    },
    async get(key, type) {
      const o = store.get(key);
      if (!o) return null;
      if (type === 'arrayBuffer') return o.bytes.buffer;
      if (type === 'json') return JSON.parse(new TextDecoder().decode(o.bytes));
      return new TextDecoder().decode(o.bytes);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.values()].filter((o) => o.name.startsWith(prefix)).map((o) => ({ name: o.name, metadata: o.options.metadata }));
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

/** Rate-limit counter KV (security.js): get/put strings with a TTL. */
function createCounterKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    _m: m,
  };
}

/**
 * `stripe` decides what api.stripe.com answers:
 *   'paid' | 'unpaid' | 403 | 500 | 404 | 'throw'
 * Every outgoing call is recorded in env.outbound.
 */
function makeEnv({ stripe = 'paid', bucket = createMockKv(), stripeKey = 'sk_test_x', counter = createCounterKv() } = {}) {
  const outbound = [];
  const env = {
    KONTROLA: bucket,
    ASISTENT_CACHE: counter,
    ALLOWED_ORIGINS: 'arling.sk',
    STRIPE_SECRET_KEY: stripeKey,
    outbound,
    fetchImpl: async (url, opts) => {
      const href = String(url);
      outbound.push({ url: href, opts });

      // The owner ping (notify.js) goes to the homelab, not to Stripe.
      if (!href.startsWith('https://api.stripe.com/')) return { ok: true, status: 200 };

      if (stripe === 'throw') throw new Error('network down');
      if (typeof stripe === 'number') {
        return { ok: false, status: stripe, json: async () => ({ error: { message: 'nope' } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: SESSION,
          object: 'checkout.session',
          payment_status: stripe === 'paid' ? 'paid' : 'unpaid',
          amount_total: 14900,
          currency: 'eur',
          created: 1757500000,
          customer_details: { email: 'zakaznik@firma.sk' },
        }),
      };
    },
  };
  return env;
}

function uploadRequest(body, { session = SESSION, origin = ORIGIN, type = 'application/xml' } = {}) {
  const url = `https://arling-asistent.arling.workers.dev/v1/kontrola/upload${session ? `?session_id=${session}` : ''}`;
  const headers = { 'Content-Type': type };
  if (origin) headers.Origin = origin;
  return new Request(url, { method: 'POST', headers, body });
}

function statusRequest({ session = SESSION, origin = ORIGIN } = {}) {
  const url = `https://arling-asistent.arling.workers.dev/v1/kontrola/status${session ? `?session_id=${session}` : ''}`;
  return new Request(url, { method: 'GET', headers: origin ? { Origin: origin } : {} });
}

/** ctx.waitUntil like the real runtime: collect the promises so a test can await them. */
function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    _pending: () => pending,
    _settle: () => Promise.allSettled(pending),
  };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('maskEmail keeps the first letter and the domain, never the local part', () => {
  assert.equal(maskEmail('andrej@arling.sk'), 'a***@arling.sk');
  assert.equal(maskEmail('zakaznik@firma.sk'), 'z***@firma.sk');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(null), '');
  assert.equal(maskEmail('@firma.sk'), ''); // no local part at all is not an address
});

test('looksLikeXml accepts a declaration or a pain.001 Document root, rejects anything else', () => {
  assert.equal(looksLikeXml(XML), true);
  assert.equal(looksLikeXml('\n  <?xml version="1.0"?><x/>'), true);
  assert.equal(looksLikeXml('﻿<?xml version="1.0"?><x/>'), true); // BOM from Windows exports
  assert.equal(looksLikeXml('<Document xmlns="urn:iso:std:iso:20022"></Document>'), true);
  assert.equal(looksLikeXml('IBAN;suma\nSK12;100'), false);
  assert.equal(looksLikeXml('%PDF-1.7'), false);
  assert.equal(looksLikeXml(''), false);
});

test('objectKeys puts the xml and its metadata under one prefix per session', () => {
  const k = objectKeys(SESSION, '2026-09-10T08:00:00.000Z');
  assert.equal(k.xml, `kontrola/${SESSION}/2026-09-10T08:00:00.000Z.xml`);
  assert.equal(k.meta, `kontrola/${SESSION}/2026-09-10T08:00:00.000Z.meta.json`);
});

test('SESSION_ID_PATTERN accepts Stripe ids and rejects anything that could walk the API path', () => {
  assert.equal(SESSION_ID_PATTERN.test(SESSION), true);
  assert.equal(SESSION_ID_PATTERN.test('cs_live_b1QwErTyUiOpAsDfGh'), true);
  assert.equal(SESSION_ID_PATTERN.test('cs_test_x/../../charges'), false);
  assert.equal(SESSION_ID_PATTERN.test('pi_1234567890'), false);
  assert.equal(SESSION_ID_PATTERN.test('cs_'), false);
});

// ---------------------------------------------------------------------------
// POST /v1/kontrola/upload
// ---------------------------------------------------------------------------

test('a paid session plus an XML body stores the file and its metadata in KV and returns 200', async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(uploadRequest(XML), env, ctx);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.uploaded_at, 'the response tells the customer when we took the file');

  // Keys carry a random suffix after the timestamp (two uploads in the same
  // millisecond must not overwrite each other), so find them by prefix.
  const listed = (await env.KONTROLA.list({ prefix: `kontrola/${SESSION}/` })).keys.map((k) => k.name);
  const xmlKey = listed.find((k) => k.endsWith('.xml'));
  const metaKey = listed.find((k) => k.endsWith('.meta.json'));
  assert.ok(xmlKey && xmlKey.startsWith(`kontrola/${SESSION}/${body.uploaded_at}`), 'xml key starts with the upload time');
  assert.equal(await env.KONTROLA.get(xmlKey, 'text'), XML);

  const meta = await env.KONTROLA.get(metaKey, 'json');
  assert.equal(meta.session_id, SESSION);
  assert.equal(meta.email, 'zakaznik@firma.sk'); // full address only inside KV
  assert.equal(meta.amount_total, 14900);
  assert.equal(meta.currency, 'eur');
  assert.equal(meta.paid_at, new Date(1757500000 * 1000).toISOString());
  assert.equal(meta.uploaded_at, body.uploaded_at);
  assert.equal(meta.size, new TextEncoder().encode(XML).length);

  // Stripe was actually asked, on the session-specific URL.
  assert.ok(env.outbound.some((c) => c.url === `https://api.stripe.com/v1/checkout/sessions/${SESSION}`));
});

test('the upload pings the owner once, and the ping is not what the customer waits for', async () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const res = await worker.fetch(uploadRequest(XML), env, ctx);
  assert.equal(res.status, 200);

  // The ping is handed to ctx.waitUntil, so the response does not wait for
  // it; the promise is still pending when the customer already has the 200.
  assert.equal(ctx._pending().length, 1);
  await ctx._settle();

  const pings = env.outbound.filter((c) => c.url.includes(`e=${KONTROLA_UPLOAD_EVENT}`));
  assert.equal(pings.length, 1);
  // Only the tail of the session id travels to ntfy: the full id is the
  // key to this order, and a phone notification is not the place for it.
  assert.ok(!pings[0].url.includes(`t=${SESSION}`));
  assert.ok(pings[0].url.includes(`t=${SESSION.slice(-8)}`));
  assert.equal(pings[0].opts.method, 'GET');
});

test('a failing owner ping does not fail the upload: the file is already in KV', async () => {
  const env = makeEnv();
  const original = env.fetchImpl;
  env.fetchImpl = async (url, opts) => {
    if (!String(url).startsWith('https://api.stripe.com/')) throw new Error('ntfy is down');
    return original(url, opts);
  };
  const ctx = makeCtx();
  const res = await worker.fetch(uploadRequest(XML), env, ctx);
  await ctx._settle();
  assert.equal(res.status, 200);
  assert.equal((await env.KONTROLA.list({ prefix: `kontrola/${SESSION}/` })).keys.length, 2);
});

test('an unpaid session is refused with 402 and nothing is written', async () => {
  const env = makeEnv({ stripe: 'unpaid' });
  const res = await worker.fetch(uploadRequest(XML), env, makeCtx());
  // 402 Payment Required, not 403: the request is fine, only the payment is
  // missing, and the page can say exactly that.
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, 'not_paid');
  assert.equal(env.KONTROLA._store.size, 0);
});

test('Stripe answering 403 (key without permission) refuses the upload with 503, never accepts it', async () => {
  const env = makeEnv({ stripe: 403 });
  const res = await worker.fetch(uploadRequest(XML), env, makeCtx());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'verification_unavailable');
  assert.equal(env.KONTROLA._store.size, 0);
});

test('a Stripe 500, an unreachable Stripe and a missing key all fail closed with 503', async () => {
  for (const options of [{ stripe: 500 }, { stripe: 'throw' }, { stripeKey: '' }]) {
    const env = makeEnv(options);
    const res = await worker.fetch(uploadRequest(XML), env, makeCtx());
    assert.equal(res.status, 503, JSON.stringify(options));
    assert.equal(env.KONTROLA._store.size, 0);
  }
});

test('a session Stripe does not know is 404, not 503: that answer is definitive', async () => {
  const env = makeEnv({ stripe: 404 });
  const res = await worker.fetch(uploadRequest(XML), env, makeCtx());
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'session_not_found');
});

test('a body that is not XML is rejected with 400 even on a paid session', async () => {
  const env = makeEnv();
  const res = await worker.fetch(uploadRequest('IBAN;suma\nSK1200;100', { type: 'text/csv' }), env, makeCtx());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'not_xml');
  assert.equal(env.KONTROLA._store.size, 0);
});

test('an empty body is rejected with 400', async () => {
  const env = makeEnv();
  const res = await worker.fetch(uploadRequest('', { type: 'application/xml' }), env, makeCtx());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'empty_body');
});

test('octet-stream and text/xml are accepted: the body decides, not the Content-Type label', async () => {
  for (const type of ['application/octet-stream', 'text/xml']) {
    const env = makeEnv();
    const res = await worker.fetch(uploadRequest(XML, { type }), env, makeCtx());
    assert.equal(res.status, 200, type);
  }
});

test('6 MB is refused with 413 and never reaches R2', async () => {
  const env = makeEnv();
  const big = `<?xml version="1.0"?><Document>${'x'.repeat(6 * 1024 * 1024)}</Document>`;
  assert.ok(new TextEncoder().encode(big).length > MAX_UPLOAD_BYTES);
  const res = await worker.fetch(uploadRequest(big), env, makeCtx());
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'payload_too_large');
  assert.equal(env.KONTROLA._store.size, 0);
});

test('a missing or malformed session_id is 400 and costs no Stripe call', async () => {
  for (const session of ['', 'cs_test_x/../../charges', 'pi_123456789']) {
    const env = makeEnv();
    const res = await worker.fetch(uploadRequest(XML, { session }), env, makeCtx());
    assert.equal(res.status, 400, session);
    assert.equal((await res.json()).error, 'missing_session_id');
    assert.equal(env.outbound.length, 0);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/kontrola/status
// ---------------------------------------------------------------------------

test('status says paid but not uploaded before the file arrives, and uploaded after it', async () => {
  const env = makeEnv();
  const before = await (await worker.fetch(statusRequest(), env, makeCtx())).json();
  assert.deepEqual(before, { paid: true, uploaded: false, email_masked: 'z***@firma.sk' });

  await worker.fetch(uploadRequest(XML), env, makeCtx());

  const after = await (await worker.fetch(statusRequest(), env, makeCtx())).json();
  assert.deepEqual(after, { paid: true, uploaded: true, email_masked: 'z***@firma.sk' });
});

test('status on an unpaid session reports paid false and does not claim an upload', async () => {
  const env = makeEnv({ stripe: 'unpaid' });
  const res = await worker.fetch(statusRequest(), env, makeCtx());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paid, false);
  assert.equal(body.uploaded, false);
});

test('status fails closed with 503 when Stripe cannot be asked', async () => {
  for (const stripe of [403, 500, 'throw']) {
    const env = makeEnv({ stripe });
    const res = await worker.fetch(statusRequest(), env, makeCtx());
    assert.equal(res.status, 503, String(stripe));
    assert.equal((await res.json()).error, 'verification_unavailable');
  }
});

test('status without a session_id is 400', async () => {
  const env = makeEnv();
  const res = await worker.fetch(statusRequest({ session: '' }), env, makeCtx());
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// CORS and what leaves the worker
// ---------------------------------------------------------------------------

test('both routes carry CORS headers for https://arling.sk, on success and on refusal', async () => {
  const env = makeEnv();
  const ok = await worker.fetch(uploadRequest(XML), env, makeCtx());
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(ok.headers.get('Vary'), 'Origin');
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  const st = await worker.fetch(statusRequest(), env, makeCtx());
  assert.equal(st.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  const refused = await worker.fetch(uploadRequest(XML), makeEnv({ stripe: 403 }), makeCtx());
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('the OPTIONS preflight for both routes passes for arling.sk and is refused for a stranger', async () => {
  const env = makeEnv();
  for (const path of ['/v1/kontrola/upload', '/v1/kontrola/status']) {
    const okRes = await worker.fetch(
      new Request(`https://arling-asistent.arling.workers.dev${path}`, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      }),
      env,
      makeCtx(),
    );
    assert.equal(okRes.status, 204, path);
    assert.equal(okRes.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    // No wildcard here, unlike /v1/chat: only our own page calls these.
    assert.notEqual(okRes.headers.get('Access-Control-Allow-Origin'), '*');

    const badRes = await worker.fetch(
      new Request(`https://arling-asistent.arling.workers.dev${path}`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://zly.example', 'Access-Control-Request-Method': 'POST' },
      }),
      env,
      makeCtx(),
    );
    assert.equal(badRes.status, 403, path);
  }
});

test('no response body ever contains the full customer e-mail', async () => {
  const env = makeEnv();
  const bodies = [];
  bodies.push(await (await worker.fetch(statusRequest(), env, makeCtx())).text());
  bodies.push(await (await worker.fetch(uploadRequest(XML), env, makeCtx())).text());
  bodies.push(await (await worker.fetch(statusRequest(), env, makeCtx())).text());
  bodies.push(await (await worker.fetch(uploadRequest(XML), makeEnv({ stripe: 'unpaid' }), makeCtx())).text());
  for (const body of bodies) {
    assert.equal(body.includes('zakaznik@firma.sk'), false, body);
    assert.equal(body.includes('zakaznik'), false, body);
  }
});

test('every stored object carries the 30-day retention TTL: that is the deletion promise on the page', async () => {
  const env = makeEnv();
  const res = await worker.fetch(uploadRequest(XML), env, makeCtx());
  assert.equal(res.status, 200);
  const objs = [...env.KONTROLA._store.values()];
  assert.equal(objs.length, 2);
  for (const o of objs) assert.equal(o.options.expirationTtl, RETENTION_SECONDS);
  assert.equal(RETENTION_SECONDS, 30 * 24 * 60 * 60);
});

test('a paid session cannot upload more than MAX_UPLOADS_PER_SESSION files', async () => {
  const env = makeEnv();
  for (let i = 0; i < MAX_UPLOADS_PER_SESSION; i++) {
    const r = await worker.fetch(uploadRequest(XML), env, makeCtx());
    assert.equal(r.status, 200, `upload ${i + 1}`);
  }
  const res = await worker.fetch(uploadRequest(XML), env, makeCtx());
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'upload_limit');
  const xmls = [...env.KONTROLA._store.keys()].filter((k) => k.endsWith('.xml'));
  assert.equal(xmls.length, MAX_UPLOADS_PER_SESSION);
});

test('status and upload share the per-IP rate limit used by chat, so nobody can burn our Stripe quota', async () => {
  const env = makeEnv();
  // Pretend this IP already hit the limit in the current window.
  const { RATE_LIMIT_DEFAULT, RATE_LIMIT_WINDOW_SECONDS } = await import('../worker/src/security.js');
  // Same key shape as security.js builds internally (ratelimit:{ip}:{window}).
  const key = `ratelimit:9.9.9.9:${Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000))}`;
  await env.ASISTENT_CACHE.put(key, String(RATE_LIMIT_DEFAULT));
  const hdr = { 'CF-Connecting-IP': '9.9.9.9', Origin: ORIGIN };
  const st = await worker.fetch(new Request(`https://arling-asistent.arling.workers.dev/v1/kontrola/status?session_id=${SESSION}`, { headers: hdr }), env, makeCtx());
  assert.equal(st.status, 429);
  const up = await worker.fetch(new Request(`https://arling-asistent.arling.workers.dev/v1/kontrola/upload?session_id=${SESSION}`, { method: 'POST', headers: { ...hdr, 'Content-Type': 'application/xml' }, body: XML }), env, makeCtx());
  assert.equal(up.status, 429);
  // Neither call reached Stripe.
  assert.equal(env.outbound.filter((c) => c.url.startsWith('https://api.stripe.com/')).length, 0);
});
