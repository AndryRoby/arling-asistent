// hmac.test.mjs
// HMAC/signature primitives (crypto-utils.js), checked against independently
// computed expected values using Node's built-in node:crypto (not the
// module under test), with a fixed shared secret and known payloads, so a
// bug mirrored between the implementation and a hand-rolled test helper
// cannot hide a real mismatch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  timingSafeEqual,
  hmacSha256Hex,
  hmacSha256Base64,
  verifyOAuthHmac,
  verifyWebhookHmac,
  verifyAppProxySignature,
} from '../shopify-worker/src/crypto-utils.js';

const SECRET = 'test-client-secret-fixed';

test('timingSafeEqual: equal strings match, differing strings (including different lengths) do not', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('hmacSha256Hex matches Node crypto.createHmac hex digest for a known message', async () => {
  const expected = createHmac('sha256', SECRET).update('hello-arling').digest('hex');
  const actual = await hmacSha256Hex(SECRET, 'hello-arling');
  assert.equal(actual, expected);
});

test('hmacSha256Base64 matches Node crypto.createHmac base64 digest for a known message', async () => {
  const expected = createHmac('sha256', SECRET).update('{"shop_id":1}').digest('base64');
  const actual = await hmacSha256Base64(SECRET, '{"shop_id":1}');
  assert.equal(actual, expected);
});

// ---------------------------------------------------------------------------
// OAuth callback HMAC (query string, hex, joined with &, sorted by key)
// ---------------------------------------------------------------------------

test('verifyOAuthHmac accepts a correctly computed hmac and rejects a tampered one', async () => {
  const params = new URLSearchParams({ code: 'abc123', shop: 'my-shop.myshopify.com', state: 'nonce1', timestamp: '1700000000' });
  const message = ['code=abc123', 'shop=my-shop.myshopify.com', 'state=nonce1', 'timestamp=1700000000'].join('&');
  const validHmac = createHmac('sha256', SECRET).update(message).digest('hex');

  const goodParams = new URLSearchParams(params);
  goodParams.set('hmac', validHmac);
  assert.equal(await verifyOAuthHmac(goodParams, SECRET), true);

  const tamperedParams = new URLSearchParams(params);
  tamperedParams.set('shop', 'attacker.myshopify.com'); // changed after hmac was computed
  tamperedParams.set('hmac', validHmac);
  assert.equal(await verifyOAuthHmac(tamperedParams, SECRET), false);

  const wrongSecretHmac = createHmac('sha256', 'wrong-secret').update(message).digest('hex');
  const wrongSecretParams = new URLSearchParams(params);
  wrongSecretParams.set('hmac', wrongSecretHmac);
  assert.equal(await verifyOAuthHmac(wrongSecretParams, SECRET), false);
});

test('verifyOAuthHmac returns false when no hmac parameter is present at all', async () => {
  const params = new URLSearchParams({ shop: 'my-shop.myshopify.com' });
  assert.equal(await verifyOAuthHmac(params, SECRET), false);
});

// ---------------------------------------------------------------------------
// Webhook body HMAC (raw body, base64, X-Shopify-Hmac-Sha256 header)
// ---------------------------------------------------------------------------

test('verifyWebhookHmac accepts a correctly signed raw body and rejects a modified body or wrong signature', async () => {
  const rawBody = JSON.stringify({ shop_id: 954889, shop_domain: 'my-shop.myshopify.com' });
  const validSig = createHmac('sha256', SECRET).update(rawBody).digest('base64');

  assert.equal(await verifyWebhookHmac(rawBody, validSig, SECRET), true);
  assert.equal(await verifyWebhookHmac(rawBody + ' ', validSig, SECRET), false); // body modified after signing
  assert.equal(await verifyWebhookHmac(rawBody, 'bm90LWEtcmVhbC1zaWc=', SECRET), false); // well-formed base64, wrong signature
  assert.equal(await verifyWebhookHmac(rawBody, '', SECRET), false); // missing header entirely
});

// ---------------------------------------------------------------------------
// App proxy signature (query string minus `signature`, hex, comma-joined
// multi-values, concatenated with no separator, sorted by key)
// ---------------------------------------------------------------------------

test('verifyAppProxySignature accepts a correctly computed signature and rejects a tampered query', async () => {
  // Deliberately includes a repeated key (ids) to exercise the comma-join rule.
  const params = new URLSearchParams();
  params.append('shop', 'my-shop.myshopify.com');
  params.append('path_prefix', '/apps/asistent');
  params.append('timestamp', '1700000000');
  params.append('ids', '1');
  params.append('ids', '2');

  const message = ['ids=1,2', 'path_prefix=/apps/asistent', 'shop=my-shop.myshopify.com', 'timestamp=1700000000'].join('');
  const validSig = createHmac('sha256', SECRET).update(message).digest('hex');

  const goodParams = new URLSearchParams(params);
  goodParams.set('signature', validSig);
  assert.equal(await verifyAppProxySignature(goodParams, SECRET), true);

  const tamperedParams = new URLSearchParams(params);
  tamperedParams.set('timestamp', '1700000099');
  tamperedParams.set('signature', validSig);
  assert.equal(await verifyAppProxySignature(tamperedParams, SECRET), false);
});

test('verifyAppProxySignature returns false when the signature parameter is missing', async () => {
  const params = new URLSearchParams({ shop: 'my-shop.myshopify.com' });
  assert.equal(await verifyAppProxySignature(params, SECRET), false);
});
