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
import {
  RETENTION_SECONDS, MAX_UPLOADS_PER_SESSION, CONSENT_HEADER, readConsent,
  deliveryKeys, isUploadKey, DELIVERY_BASENAMES,
} from '../worker/src/upload.js';

const SESSION = 'cs_test_a1b2c3d4e5f6g7h8i9j0';
const SESSION_2 = 'cs_test_z9y8x7w6v5u4t3s2r1q0';
const ORIGIN = 'https://arling.sk';
const ADMIN = 'admin-token-for-tests';
const API = 'https://arling-asistent.arling.workers.dev';
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
function makeEnv({ stripe = 'paid', bucket = createMockKv(), stripeKey = 'sk_test_x', counter = createCounterKv(), adminToken = ADMIN, amount = 14900 } = {}) {
  const outbound = [];
  const env = {
    KONTROLA: bucket,
    ASISTENT_CACHE: counter,
    ALLOWED_ORIGINS: 'arling.sk',
    STRIPE_SECRET_KEY: stripeKey,
    ADMIN_TOKEN: adminToken,
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
      const asked = (href.match(/checkout\/sessions\/([^/?]+)/) || [])[1] || SESSION;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: asked,
          object: 'checkout.session',
          payment_status: stripe === 'paid' ? 'paid' : 'unpaid',
          amount_total: amount,
          currency: 'eur',
          created: 1757500000,
          customer_details: { email: 'zakaznik@firma.sk' },
        }),
      };
    },
  };
  return env;
}

/**
 * `consent` is what the page sends in X-Arling-Consent: '1' after the
 * customer ticked the box (the default here, like the page), any other
 * string to test odd values, or null for a request without the header
 * (a browser still running the page from before the box existed).
 */
function uploadRequest(body, { session = SESSION, origin = ORIGIN, type = 'application/xml', consent = '1' } = {}) {
  const url = `https://arling-asistent.arling.workers.dev/v1/kontrola/upload${session ? `?session_id=${session}` : ''}`;
  const headers = { 'Content-Type': type };
  if (origin) headers.Origin = origin;
  if (consent !== null && consent !== undefined) headers[CONSENT_HEADER] = consent;
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
  assert.equal(meta.consent, true); // the page sent X-Arling-Consent: 1

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

test('a paid 29 EUR session (self-service fix) is refused by upload with 402 wrong_product', async () => {
  const bucket = createMockKv();
  const env = makeEnv({ bucket, amount: 2900 });
  const res = await worker.fetch(uploadRequest(XML), env, makeCtx());
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error, 'wrong_product');
  assert.equal((await bucket.list({ prefix: 'kontrola/' })).keys.length, 0);
});

test('status says paid but not uploaded before the file arrives, and uploaded after it', async () => {
  const env = makeEnv();
  const before = await (await worker.fetch(statusRequest(), env, makeCtx())).json();
  assert.deepEqual(before, { paid: true, uploaded: false, amount_total: 14900, currency: 'eur', email_masked: 'z***@firma.sk', delivered: false, delivered_at: null });

  await worker.fetch(uploadRequest(XML), env, makeCtx());

  const after = await (await worker.fetch(statusRequest(), env, makeCtx())).json();
  assert.deepEqual(after, { paid: true, uploaded: true, amount_total: 14900, currency: 'eur', email_masked: 'z***@firma.sk', delivered: false, delivered_at: null });
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

// ---------------------------------------------------------------------------
// consent to the service starting before the withdrawal period ends
// ---------------------------------------------------------------------------

test('CONSENT_HEADER is the name the upload page sends, and readConsent accepts only the value 1', () => {
  assert.equal(CONSENT_HEADER, 'X-Arling-Consent');
  const req = (value) => new Request('https://x.example/', { headers: value === null ? {} : { [CONSENT_HEADER]: value } });
  assert.equal(readConsent(req('1')), true);
  assert.equal(readConsent(req(' 1 ')), true); // a stray space is not a refusal
  assert.equal(readConsent(req(null)), false);
  assert.equal(readConsent(req('')), false);
  assert.equal(readConsent(req('0')), false);
  assert.equal(readConsent(req('true')), false);
  assert.equal(readConsent(req('yes')), false);
});

test('an upload with X-Arling-Consent: 1 records consent true in the meta record and in the KV key metadata', async () => {
  const env = makeEnv();
  const res = await worker.fetch(uploadRequest(XML, { consent: '1' }), env, makeCtx());
  assert.equal(res.status, 200);
  const objs = [...env.KONTROLA._store.values()];
  assert.equal(objs.length, 2);
  // Both keys carry it in the metadata, so list() alone shows who declared what.
  for (const o of objs) assert.equal(o.options.metadata.consent, true, o.name);
  const metaKey = objs.map((o) => o.name).find((k) => k.endsWith('.meta.json'));
  assert.equal((await env.KONTROLA.get(metaKey, 'json')).consent, true);
});

test('an upload without the header is still accepted, and records consent false rather than guessing', async () => {
  const env = makeEnv();
  const res = await worker.fetch(uploadRequest(XML, { consent: null }), env, makeCtx());
  // Not refused: a customer whose browser still runs the page from before
  // the box existed has paid, and "no consent recorded" is the honest fact.
  assert.equal(res.status, 200);
  const objs = [...env.KONTROLA._store.values()];
  assert.equal(objs.length, 2);
  for (const o of objs) assert.equal(o.options.metadata.consent, false, o.name);
  const metaKey = objs.map((o) => o.name).find((k) => k.endsWith('.meta.json'));
  const meta = await env.KONTROLA.get(metaKey, 'json');
  assert.equal(meta.consent, false);
  assert.equal(typeof meta.consent, 'boolean'); // never undefined or a string
});

test('only the exact value 1 counts as consent; 0, true and yes are recorded as false', async () => {
  for (const value of ['0', 'true', 'yes', '']) {
    const env = makeEnv();
    const res = await worker.fetch(uploadRequest(XML, { consent: value }), env, makeCtx());
    assert.equal(res.status, 200, JSON.stringify(value));
    const metaKey = [...env.KONTROLA._store.keys()].find((k) => k.endsWith('.meta.json'));
    assert.equal((await env.KONTROLA.get(metaKey, 'json')).consent, false, JSON.stringify(value));
  }
});

test('consent is per upload: a second file without the header does not inherit the consent of the first one', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(uploadRequest(XML, { consent: '1' }), env, makeCtx())).status, 200);
  assert.equal((await worker.fetch(uploadRequest(XML, { consent: null }), env, makeCtx())).status, 200);
  const metas = [];
  for (const k of [...env.KONTROLA._store.keys()].filter((x) => x.endsWith('.meta.json')).sort()) {
    metas.push(await env.KONTROLA.get(k, 'json'));
  }
  assert.equal(metas.length, 2);
  assert.deepEqual(metas.map((m) => m.consent).sort(), [false, true]);
});

test('consent never appears in the upload or status response body: it is a record, not something the page reads back', async () => {
  const env = makeEnv();
  const up = await (await worker.fetch(uploadRequest(XML, { consent: '1' }), env, makeCtx())).json();
  assert.equal('consent' in up, false);
  const st = await (await worker.fetch(statusRequest(), env, makeCtx())).json();
  assert.deepEqual(Object.keys(st).sort(), ['amount_total', 'currency', 'delivered', 'delivered_at', 'email_masked', 'paid', 'uploaded']);
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

// ---------------------------------------------------------------------------
// Delivery: admin routes, /status delivered fields, /download
// ---------------------------------------------------------------------------

const REPORT_MD = '# Správa z kontroly\n\nO prijatí súboru rozhoduje banka.\n';
const FIXED_XML = '<?xml version="1.0" encoding="UTF-8"?><Document><CstmrCdtTrfInitn><GrpHdr><NbOfTxs>1</NbOfTxs></GrpHdr></CstmrCdtTrfInitn></Document>';

function adminHeaders(token = ADMIN) {
  return token === null ? {} : { 'X-Admin-Token': token };
}

function listRequest({ token = ADMIN } = {}) {
  return new Request(`${API}/v1/kontrola/admin/uploads`, { method: 'GET', headers: adminHeaders(token) });
}

function adminGetRequest(key, { token = ADMIN } = {}) {
  return new Request(`${API}/v1/kontrola/admin/upload?key=${encodeURIComponent(key)}`, { method: 'GET', headers: adminHeaders(token) });
}

function deliverRequest(body, { session = SESSION, token = ADMIN, raw = false } = {}) {
  return new Request(`${API}/v1/kontrola/admin/deliver${session ? `?session_id=${session}` : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...adminHeaders(token) },
    body: raw ? body : JSON.stringify(body),
  });
}

function downloadRequest({ session = SESSION, what = 'xml', origin = ORIGIN, ip } = {}) {
  const headers = origin ? { Origin: origin } : {};
  if (ip) headers['CF-Connecting-IP'] = ip;
  const q = [session ? `session_id=${session}` : '', what ? `what=${what}` : ''].filter(Boolean).join('&');
  return new Request(`${API}/v1/kontrola/download${q ? `?${q}` : ''}`, { method: 'GET', headers });
}

/** A full delivery on env for `session`; returns the deliver response body. */
async function deliver(env, session = SESSION, lang = 'sk') {
  const res = await worker.fetch(deliverRequest({ xml: FIXED_XML, report_md: REPORT_MD, lang }, { session }), env, makeCtx());
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

test('deliveryKeys and isUploadKey: the delivered files share the prefix but are never counted as uploads', () => {
  const k = deliveryKeys(SESSION);
  assert.equal(k.xml, `kontrola/${SESSION}/dodanie.xml`);
  assert.equal(k.md, `kontrola/${SESSION}/dodanie.md`);
  assert.equal(k.meta, `kontrola/${SESSION}/dodanie.meta.json`);
  assert.equal(DELIVERY_BASENAMES.xml, 'dodanie.xml');
  assert.equal(isUploadKey(`kontrola/${SESSION}/2026-09-10T08:00:00.000Z-abcd1234.xml`), true);
  assert.equal(isUploadKey(k.xml), false);
  assert.equal(isUploadKey(k.md), false);
  assert.equal(isUploadKey(`kontrola/${SESSION}/2026-09-10T08:00:00.000Z-abcd1234.meta.json`), false);
  assert.equal(isUploadKey(`other/${SESSION}/x.xml`), false);
  assert.equal(isUploadKey(''), false);
});

test('every admin route answers 401 without the token, with a wrong token, and when no ADMIN_TOKEN is configured', async () => {
  const cases = [
    { name: 'no header', env: makeEnv(), token: null },
    { name: 'wrong token', env: makeEnv(), token: 'nope' },
    { name: 'no secret configured', env: makeEnv({ adminToken: '' }), token: ADMIN },
    { name: 'no secret, empty header', env: makeEnv({ adminToken: '' }), token: '' },
  ];
  for (const c of cases) {
    const list = await worker.fetch(listRequest({ token: c.token }), c.env, makeCtx());
    assert.equal(list.status, 401, `list: ${c.name}`);
    assert.equal((await list.json()).error, 'unauthorized');
    const get = await worker.fetch(adminGetRequest(`kontrola/${SESSION}/x.xml`, { token: c.token }), c.env, makeCtx());
    assert.equal(get.status, 401, `get: ${c.name}`);
    const put = await worker.fetch(deliverRequest({ xml: FIXED_XML, report_md: REPORT_MD, lang: 'sk' }, { token: c.token }), c.env, makeCtx());
    assert.equal(put.status, 401, `deliver: ${c.name}`);
    assert.equal(c.env.KONTROLA._store.size, 0, `deliver wrote nothing: ${c.name}`);
    // Admin routes never touch Stripe, authorised or not.
    assert.equal(c.env.outbound.filter((x) => x.url.startsWith('https://api.stripe.com/')).length, 0, c.name);
  }
});

test('admin list shows every upload newest first with the list metadata, and no Stripe call', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(uploadRequest(XML, { session: SESSION, consent: '1' }), env, makeCtx())).status, 200);
  // A later upload from a second session, without consent.
  await new Promise((r) => setTimeout(r, 5));
  const second = await (await worker.fetch(uploadRequest(`${XML}<!-- 2 -->`, { session: SESSION_2, consent: null }), env, makeCtx())).json();
  env.outbound.length = 0;

  const res = await worker.fetch(listRequest(), env, makeCtx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.uploads.length, 2);
  assert.deepEqual(Object.keys(body.uploads[0]).sort(), ['consent', 'email_masked', 'key', 'session_id', 'size', 'uploaded_at']);

  const [newest, oldest] = body.uploads;
  assert.equal(newest.session_id, SESSION_2);
  assert.equal(newest.uploaded_at, second.uploaded_at);
  assert.ok(newest.key.startsWith(`kontrola/${SESSION_2}/`) && newest.key.endsWith('.xml'));
  assert.equal(newest.size, new TextEncoder().encode(`${XML}<!-- 2 -->`).length);
  assert.equal(newest.consent, false);
  assert.equal(newest.email_masked, 'z***@firma.sk');

  assert.equal(oldest.session_id, SESSION);
  assert.equal(oldest.consent, true);
  assert.equal(oldest.size, new TextEncoder().encode(XML).length);
  assert.ok(oldest.uploaded_at < newest.uploaded_at);

  assert.equal(env.outbound.length, 0, 'the list is built from KV metadata alone');
  assert.equal(JSON.stringify(body).includes('zakaznik@firma.sk'), false);
});

test('admin list is empty on a fresh namespace and does not include delivered files as uploads', async () => {
  const env = makeEnv();
  assert.deepEqual(await (await worker.fetch(listRequest(), env, makeCtx())).json(), { uploads: [] });
  await worker.fetch(uploadRequest(XML), env, makeCtx());
  await deliver(env);
  const body = await (await worker.fetch(listRequest(), env, makeCtx())).json();
  assert.equal(body.uploads.length, 1);
  assert.ok(!body.uploads[0].key.endsWith('dodanie.xml'));
});

test('admin list follows the KV cursor when the namespace is paged', async () => {
  const env = makeEnv();
  await worker.fetch(uploadRequest(XML, { session: SESSION }), env, makeCtx());
  await worker.fetch(uploadRequest(XML, { session: SESSION_2 }), env, makeCtx());
  const all = [...env.KONTROLA._store.values()].map((o) => ({ name: o.name, metadata: o.options.metadata }));
  const calls = [];
  env.KONTROLA.list = async (opts) => {
    calls.push(opts);
    if (!opts.cursor) return { keys: all.slice(0, 2), list_complete: false, cursor: 'c1' };
    return { keys: all.slice(2), list_complete: true };
  };
  const body = await (await worker.fetch(listRequest(), env, makeCtx())).json();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'c1');
  assert.equal(body.uploads.length, 2);
});

test('admin list answers 503 when KV cannot be listed, rather than an empty list that looks like "no work"', async () => {
  const env = makeEnv();
  env.KONTROLA.list = async () => { throw new Error('kv down'); };
  const res = await worker.fetch(listRequest(), env, makeCtx());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'storage_unavailable');
});

test('admin upload GET returns the raw XML as application/xml, 404 when missing, 400 for a key outside kontrola/', async () => {
  const env = makeEnv();
  await worker.fetch(uploadRequest(XML), env, makeCtx());
  const key = [...env.KONTROLA._store.keys()].find((k) => k.endsWith('.xml'));

  const ok = await worker.fetch(adminGetRequest(key), env, makeCtx());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/xml');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(await ok.text(), XML);

  const missing = await worker.fetch(adminGetRequest(`kontrola/${SESSION}/2026-01-01T00:00:00.000Z-00000000.xml`), env, makeCtx());
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'not_found');

  for (const bad of ['', 'tenants/x', `kontrola/../${SESSION}/x.xml`, 'kontrola/notasession/x.xml', `kontrola/${SESSION}/a/b.xml`, `kontrola/${SESSION}/x y.xml`]) {
    const res = await worker.fetch(adminGetRequest(bad), env, makeCtx());
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).error, 'bad_key');
  }

  // The meta record can be read too, as JSON.
  const metaKey = [...env.KONTROLA._store.keys()].find((k) => k.endsWith('.meta.json'));
  const meta = await worker.fetch(adminGetRequest(metaKey), env, makeCtx());
  assert.equal(meta.status, 200);
  assert.equal(meta.headers.get('content-type'), 'application/json');
  assert.equal((await meta.json()).session_id, SESSION);
});

test('deliver stores dodanie.xml, dodanie.md and dodanie.meta.json with the 30-day TTL and reports delivered_at', async () => {
  const env = makeEnv();
  await worker.fetch(uploadRequest(XML), env, makeCtx());
  const before = env.KONTROLA._store.size;

  const body = await deliver(env, SESSION, 'de');
  assert.equal(body.ok, true);
  assert.ok(body.delivered_at);
  assert.equal(body.lang, 'de');

  const k = deliveryKeys(SESSION);
  assert.equal(env.KONTROLA._store.size, before + 3);
  assert.equal(await env.KONTROLA.get(k.xml, 'text'), FIXED_XML);
  assert.equal(await env.KONTROLA.get(k.md, 'text'), REPORT_MD);
  const meta = await env.KONTROLA.get(k.meta, 'json');
  assert.equal(meta.delivered_at, body.delivered_at);
  assert.equal(meta.lang, 'de');
  assert.equal(meta.session_id, SESSION);
  for (const key of [k.xml, k.md, k.meta]) {
    assert.equal(env.KONTROLA._store.get(key).options.expirationTtl, RETENTION_SECONDS, key);
  }
  // No Stripe call for the delivery: the admin token is the whole credential here.
  assert.equal(env.outbound.filter((x) => x.url.startsWith('https://api.stripe.com/')).length, 1, 'only the upload asked Stripe');
});

test('deliver answers 400 on a missing field, an unknown language, a non-XML file, bad JSON or a missing session_id', async () => {
  const env = makeEnv();
  const good = { xml: FIXED_XML, report_md: REPORT_MD, lang: 'sk' };
  const cases = [
    [{ ...good, xml: '' }, ['xml']],
    [{ ...good, xml: undefined }, ['xml']],
    [{ ...good, report_md: '   ' }, ['report_md']],
    [{ ...good, lang: 'fr' }, ['lang']],
    [{ ...good, lang: undefined }, ['lang']],
    [{ lang: 'sk' }, ['xml', 'report_md']],
    [{}, ['xml', 'report_md', 'lang']],
  ];
  for (const [payload, fields] of cases) {
    const res = await worker.fetch(deliverRequest(payload), env, makeCtx());
    assert.equal(res.status, 400, JSON.stringify(payload));
    const body = await res.json();
    assert.equal(body.error, 'missing_fields');
    assert.deepEqual(body.fields, fields);
  }
  const notXml = await worker.fetch(deliverRequest({ ...good, xml: 'IBAN;suma' }), env, makeCtx());
  assert.equal(notXml.status, 400);
  assert.equal((await notXml.json()).error, 'not_xml');

  const badJson = await worker.fetch(deliverRequest('{not json', { raw: true }), env, makeCtx());
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error, 'bad_json');

  const noSession = await worker.fetch(deliverRequest(good, { session: '' }), env, makeCtx());
  assert.equal(noSession.status, 400);
  assert.equal((await noSession.json()).error, 'missing_session_id');

  assert.equal(env.KONTROLA._store.size, 0, 'nothing was written by any refused delivery');
});

test('a second deliver replaces the first: one delivery per order, the latest wins', async () => {
  const env = makeEnv();
  await deliver(env, SESSION, 'sk');
  const res = await worker.fetch(deliverRequest({ xml: `${FIXED_XML}<!-- v2 -->`, report_md: `${REPORT_MD}v2\n`, lang: 'en' }), env, makeCtx());
  assert.equal(res.status, 200);
  const k = deliveryKeys(SESSION);
  assert.equal(await env.KONTROLA.get(k.xml, 'text'), `${FIXED_XML}<!-- v2 -->`);
  assert.equal((await env.KONTROLA.get(k.meta, 'json')).lang, 'en');
  assert.equal([...env.KONTROLA._store.keys()].filter((x) => x.startsWith(`kontrola/${SESSION}/dodanie`)).length, 3);
});

test('status reports delivered false before and delivered true with both download paths after the delivery', async () => {
  const env = makeEnv();
  await worker.fetch(uploadRequest(XML), env, makeCtx());
  const before = await (await worker.fetch(statusRequest(), env, makeCtx())).json();
  assert.equal(before.delivered, false);
  assert.equal(before.delivered_at, null);
  assert.equal('download_xml' in before, false);
  assert.equal('download_report' in before, false);

  const d = await deliver(env);
  const after = await (await worker.fetch(statusRequest(), env, makeCtx())).json();
  assert.equal(after.paid, true);
  assert.equal(after.uploaded, true);
  assert.equal(after.delivered, true);
  assert.equal(after.delivered_at, d.delivered_at);
  assert.equal(after.download_xml, `/v1/kontrola/download?session_id=${SESSION}&what=xml`);
  assert.equal(after.download_report, `/v1/kontrola/download?session_id=${SESSION}&what=report`);
  // Relative paths only: the page adds the API host itself.
  assert.ok(after.download_xml.startsWith('/'));
});

test('status on an unpaid session never reports a delivery, even when the files exist', async () => {
  const bucket = createMockKv();
  await deliver(makeEnv({ bucket }));
  const body = await (await worker.fetch(statusRequest(), makeEnv({ bucket, stripe: 'unpaid' }), makeCtx())).json();
  assert.equal(body.paid, false);
  assert.equal(body.delivered, false);
  assert.equal('download_xml' in body, false);
});

test('a delivery does not use up the upload allowance of the session', async () => {
  const env = makeEnv();
  await deliver(env);
  for (let i = 0; i < MAX_UPLOADS_PER_SESSION; i++) {
    const r = await worker.fetch(uploadRequest(XML), env, makeCtx());
    assert.equal(r.status, 200, `upload ${i + 1} after delivery`);
  }
  assert.equal((await worker.fetch(uploadRequest(XML), env, makeCtx())).status, 429);
});

test('download before delivery is 404 not_delivered, after delivery the xml and the report come back as attachments', async () => {
  const env = makeEnv();
  await worker.fetch(uploadRequest(XML), env, makeCtx());

  const early = await worker.fetch(downloadRequest({ what: 'xml' }), env, makeCtx());
  assert.equal(early.status, 404);
  assert.equal((await early.json()).error, 'not_delivered');
  const earlyReport = await worker.fetch(downloadRequest({ what: 'report' }), env, makeCtx());
  assert.equal(earlyReport.status, 404);

  await deliver(env);

  const xml = await worker.fetch(downloadRequest({ what: 'xml' }), env, makeCtx());
  assert.equal(xml.status, 200);
  assert.equal(xml.headers.get('content-disposition'), 'attachment; filename="opraveny-pain001.xml"');
  assert.ok(xml.headers.get('content-type').startsWith('application/xml'));
  assert.equal(xml.headers.get('cache-control'), 'no-store');
  assert.equal(xml.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(await xml.text(), FIXED_XML);

  const report = await worker.fetch(downloadRequest({ what: 'report' }), env, makeCtx());
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('content-disposition'), 'attachment; filename="sprava.md"');
  assert.ok(report.headers.get('content-type').startsWith('text/markdown'));
  assert.equal(await report.text(), REPORT_MD);
});

test('download fails closed exactly like the upload: 402 unpaid, 404 unknown session, 503 when Stripe cannot be asked', async () => {
  // The delivered files exist in every case below; only the verification differs.
  const bucket = createMockKv();
  await deliver(makeEnv({ bucket }));

  const unpaid = await worker.fetch(downloadRequest(), makeEnv({ bucket, stripe: 'unpaid' }), makeCtx());
  assert.equal(unpaid.status, 402);
  assert.equal((await unpaid.json()).error, 'not_paid');

  const unknown = await worker.fetch(downloadRequest(), makeEnv({ bucket, stripe: 404 }), makeCtx());
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'session_not_found');

  for (const options of [{ stripe: 403 }, { stripe: 500 }, { stripe: 'throw' }, { stripeKey: '' }]) {
    const res = await worker.fetch(downloadRequest(), makeEnv({ bucket, ...options }), makeCtx());
    assert.equal(res.status, 503, JSON.stringify(options));
    assert.equal((await res.json()).error, 'verification_unavailable');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  }
});

test('download refuses a missing session_id, an unknown what, and never asks Stripe for either', async () => {
  const env = makeEnv();
  await deliver(env);
  env.outbound.length = 0;
  const noSession = await worker.fetch(downloadRequest({ session: '' }), env, makeCtx());
  assert.equal(noSession.status, 400);
  assert.equal((await noSession.json()).error, 'missing_session_id');
  for (const what of ['', 'meta', 'xml/../report', 'XML']) {
    const res = await worker.fetch(downloadRequest({ what }), env, makeCtx());
    assert.equal(res.status, 400, JSON.stringify(what));
    assert.equal((await res.json()).error, 'bad_what');
  }
  assert.equal(env.outbound.filter((x) => x.url.startsWith('https://api.stripe.com/')).length, 0);
});

test('a paid session cannot download another session\'s delivery: the key is derived from the verified session id only', async () => {
  const env = makeEnv();
  await deliver(env, SESSION);
  const other = await worker.fetch(downloadRequest({ session: SESSION_2 }), env, makeCtx());
  assert.equal(other.status, 404);
  assert.equal((await other.json()).error, 'not_delivered');
});

test('download shares the per-IP rate limit with status and upload', async () => {
  const env = makeEnv();
  const { RATE_LIMIT_DEFAULT, RATE_LIMIT_WINDOW_SECONDS } = await import('../worker/src/security.js');
  const key = `ratelimit:8.8.8.8:${Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000))}`;
  await env.ASISTENT_CACHE.put(key, String(RATE_LIMIT_DEFAULT));
  const res = await worker.fetch(downloadRequest({ ip: '8.8.8.8' }), env, makeCtx());
  assert.equal(res.status, 429);
  assert.equal(env.outbound.filter((c) => c.url.startsWith('https://api.stripe.com/')).length, 0);
});

test('the OPTIONS preflight for /v1/kontrola/download passes for arling.sk and is refused for a stranger', async () => {
  const env = makeEnv();
  const okRes = await worker.fetch(new Request(`${API}/v1/kontrola/download`, {
    method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' },
  }), env, makeCtx());
  assert.equal(okRes.status, 204);
  assert.equal(okRes.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const badRes = await worker.fetch(new Request(`${API}/v1/kontrola/download`, {
    method: 'OPTIONS', headers: { Origin: 'https://zly.example', 'Access-Control-Request-Method': 'GET' },
  }), env, makeCtx());
  assert.equal(badRes.status, 403);
});

test('download from a stranger origin carries no CORS header, so a foreign page cannot read the file even with the session id', async () => {
  const env = makeEnv();
  await deliver(env);
  const res = await worker.fetch(downloadRequest({ origin: 'https://zly.example' }), env, makeCtx());
  assert.equal(res.status, 200); // the request itself is valid; the browser refuses to expose the body
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('no delivery-side response body contains the full customer e-mail', async () => {
  const env = makeEnv();
  await worker.fetch(uploadRequest(XML), env, makeCtx());
  await deliver(env);
  const bodies = [];
  bodies.push(await (await worker.fetch(listRequest(), env, makeCtx())).text());
  bodies.push(await (await worker.fetch(statusRequest(), env, makeCtx())).text());
  bodies.push(await (await worker.fetch(downloadRequest({ what: 'report' }), env, makeCtx())).text());
  bodies.push(await (await worker.fetch(deliverRequest({ xml: FIXED_XML, report_md: REPORT_MD, lang: 'sk' }), env, makeCtx())).text());
  for (const body of bodies) {
    assert.equal(body.includes('zakaznik@firma.sk'), false, body);
  }
});

test('the wrong method on a kontrola route is 404, not an admin action: GET deliver, POST uploads', async () => {
  const env = makeEnv();
  const getDeliver = await worker.fetch(new Request(`${API}/v1/kontrola/admin/deliver?session_id=${SESSION}`, { method: 'GET', headers: adminHeaders() }), env, makeCtx());
  assert.equal(getDeliver.status, 404);
  const postList = await worker.fetch(new Request(`${API}/v1/kontrola/admin/uploads`, { method: 'POST', headers: adminHeaders() }), env, makeCtx());
  assert.equal(postList.status, 404);
  assert.equal(env.KONTROLA._store.size, 0);
});
