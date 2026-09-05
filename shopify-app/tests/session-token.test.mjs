// session-token.test.mjs
// App Bridge session (ID) token verification (crypto-utils.js
// verifySessionToken + session-token.js's HTTP-layer glue). Tokens are
// hand-built here with Node's own base64url + createHmac, independently of
// the module under test, so this exercises real JWT bytes rather than
// round-tripping through the same signing code being tested.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifySessionToken } from '../shopify-worker/src/crypto-utils.js';
import { extractBearerToken, shopDomainFromPayload, requireSessionToken } from '../shopify-worker/src/session-token.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-client-secret-fixed';
const SHOP = 'my-shop.myshopify.com';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildToken(payloadOverrides = {}, { secret = API_SECRET, alg = 'HS256' } = {}) {
  const header = { alg, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: API_KEY,
    sub: '1',
    exp: now + 60,
    nbf: now - 10,
    iat: now,
    jti: 'abc',
    sid: 'sess1',
    ...payloadOverrides,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${headerB64}.${payloadB64}.${signature}`;
}

test('verifySessionToken accepts a validly signed, unexpired token with the right audience', async () => {
  const token = buildToken();
  const result = await verifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET, shopDomain: SHOP });
  assert.equal(result.valid, true);
  assert.equal(result.payload.aud, API_KEY);
});

test('verifySessionToken rejects a token signed with the wrong secret', async () => {
  const token = buildToken({}, { secret: 'wrong-secret' });
  const result = await verifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'bad_signature');
});

test('verifySessionToken rejects an expired token', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = buildToken({ exp: now - 100 });
  const result = await verifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'expired');
});

test('verifySessionToken rejects a not-yet-valid token (nbf in the future)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = buildToken({ nbf: now + 1000 });
  const result = await verifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'not_yet_valid');
});

test('verifySessionToken rejects a token issued for a different app (wrong aud)', async () => {
  const token = buildToken({ aud: 'someone-elses-api-key' });
  const result = await verifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'bad_audience');
});

test('verifySessionToken rejects a token whose dest does not match the expected shop', async () => {
  const token = buildToken({ dest: 'https://attacker.myshopify.com' });
  const result = await verifySessionToken(token, { apiKey: API_KEY, apiSecret: API_SECRET, shopDomain: SHOP });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'bad_destination');
});

test('verifySessionToken rejects malformed input: not enough JWT segments, missing token, unsupported alg', async () => {
  assert.equal((await verifySessionToken('only.two')).valid, false);
  assert.equal((await verifySessionToken('')).valid, false);
  assert.equal((await verifySessionToken(null)).valid, false);
  const noneAlgToken = buildToken({}, { alg: 'none' });
  const result = await verifySessionToken(noneAlgToken, { apiKey: API_KEY, apiSecret: API_SECRET });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'unsupported_alg');
});

test('extractBearerToken reads the token out of an Authorization: Bearer header, case-insensitively, or returns empty string', () => {
  const req1 = new Request('https://x/', { headers: { Authorization: 'Bearer abc.def.ghi' } });
  assert.equal(extractBearerToken(req1), 'abc.def.ghi');
  const req2 = new Request('https://x/', { headers: { Authorization: 'bearer xyz' } });
  assert.equal(extractBearerToken(req2), 'xyz');
  const req3 = new Request('https://x/');
  assert.equal(extractBearerToken(req3), '');
});

test('shopDomainFromPayload strips the scheme and trailing slash from the dest claim', () => {
  assert.equal(shopDomainFromPayload({ dest: 'https://my-shop.myshopify.com' }), 'my-shop.myshopify.com');
  assert.equal(shopDomainFromPayload({ dest: 'https://my-shop.myshopify.com/' }), 'my-shop.myshopify.com');
  assert.equal(shopDomainFromPayload({}), '');
});

test('requireSessionToken returns ok:true with the shop domain for a valid token, and a 401 response otherwise', async () => {
  const env = { SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: API_SECRET };
  const goodToken = buildToken();
  const okReq = new Request('https://x/', { headers: { Authorization: `Bearer ${goodToken}` } });
  const okResult = await requireSessionToken(okReq, env);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.shop, SHOP);

  const badReq = new Request('https://x/', { headers: { Authorization: 'Bearer not-a-jwt' } });
  const badResult = await requireSessionToken(badReq, env);
  assert.equal(badResult.ok, false);
  assert.equal(badResult.response.status, 401);
});
