/*
 * crypto-utils.js
 *
 * All HMAC/signature primitives used by the Shopify integration, in one
 * place so every verification path (OAuth callback, webhooks, app proxy,
 * session tokens) uses the same tested building blocks. Uses only Web
 * Crypto (`crypto.subtle`), which is a global in both the Cloudflare
 * Workers runtime and modern Node (no `node:crypto`, no nodejs_compat flag
 * needed), so the exact same code runs in production and in `node --test`.
 *
 * Every comparison against an attacker-influenced value goes through
 * timingSafeEqual() below rather than `===`, so a mismatched signature does
 * not leak how many leading bytes were correct via response timing.
 */

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64url (no padding) used by JWT segments, per RFC 7515. */
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return base64ToBytes(b64);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToJson(b64url) {
  const bytes = base64UrlToBytes(b64url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Constant-time string comparison: always walks the full length of the longer string. */
export function timingSafeEqual(a, b) {
  const strA = String(a == null ? '' : a);
  const strB = String(b == null ? '' : b);
  const len = Math.max(strA.length, strB.length);
  let diff = strA.length === strB.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < strA.length ? strA.charCodeAt(i) : 0;
    const cb = i < strB.length ? strB.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Raw HMAC-SHA256 digest bytes of `message`, keyed by `secret`. */
export async function hmacSha256Bytes(secret, message) {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(secret, message) {
  return bytesToHex(await hmacSha256Bytes(secret, message));
}

export async function hmacSha256Base64(secret, message) {
  return bytesToBase64(await hmacSha256Bytes(secret, message));
}

/**
 * Verify a Shopify OAuth callback (or any admin-redirect) query string.
 * Algorithm (Shopify docs "Getting started with OAuth" > "Verify the
 * installation request"): remove `hmac` (and `signature`, a legacy alias),
 * sort the remaining parameters by key, join as `key=value` pairs with `&`,
 * and compare the hex HMAC-SHA256 of that string (keyed by the app's client
 * secret) against the `hmac` query parameter.
 */
export async function verifyOAuthHmac(searchParams, apiSecret) {
  const provided = searchParams.get('hmac') || '';
  if (!provided) return false;
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === 'hmac' || key === 'signature') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join('&');
  const computed = await hmacSha256Hex(apiSecret, message);
  return timingSafeEqual(computed, provided);
}

/**
 * Verify a Shopify webhook delivery: base64 HMAC-SHA256 of the *raw* request
 * body (before any JSON.parse), keyed by the client secret, compared against
 * the `X-Shopify-Hmac-Sha256` header. Callers must pass the untouched body
 * text/bytes, since re-serialising parsed JSON can change byte-for-byte
 * formatting and break the signature.
 */
export async function verifyWebhookHmac(rawBody, headerHmac, apiSecret) {
  if (!headerHmac) return false;
  const computed = await hmacSha256Base64(apiSecret, rawBody);
  return timingSafeEqual(computed, headerHmac);
}

/**
 * Verify a Shopify app proxy request signature (Shopify docs "Authenticate
 * app proxy requests"): drop the `signature` parameter, join multi-valued
 * parameters' values with commas, format every remaining pair as
 * `key=value`, sort the pairs lexicographically by key, concatenate them
 * with NO separator (unlike the OAuth callback, which joins with `&`), and
 * compare the hex HMAC-SHA256 of that string against `signature`.
 */
export async function verifyAppProxySignature(searchParams, apiSecret) {
  const provided = searchParams.get('signature') || '';
  if (!provided) return false;
  const grouped = new Map();
  for (const [key, value] of searchParams.entries()) {
    if (key === 'signature') continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  const pairs = Array.from(grouped.entries())
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort();
  const message = pairs.join('');
  const computed = await hmacSha256Hex(apiSecret, message);
  return timingSafeEqual(computed, provided);
}

/**
 * Verify a Shopify App Bridge session (ID) token: a compact JWS with header
 * `{"alg":"HS256"}`, signed with the app's client secret. Checks the
 * signature, `exp`/`nbf`, `aud` (must equal the app's client/API key), and
 * that `dest` (the shop's origin) matches the expected shop domain when one
 * is supplied. Returns `{ valid: true, payload }` or `{ valid: false, error }`.
 */
export async function verifySessionToken(token, { apiKey, apiSecret, shopDomain, now = Date.now() } = {}) {
  if (!token || typeof token !== 'string') return { valid: false, error: 'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, error: 'malformed_token' };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = base64UrlToJson(headerB64);
    payload = base64UrlToJson(payloadB64);
  } catch (e) {
    return { valid: false, error: 'malformed_token' };
  }

  if (!header || header.alg !== 'HS256') return { valid: false, error: 'unsupported_alg' };

  const expectedSig = await hmacSha256Bytes(apiSecret, `${headerB64}.${payloadB64}`);
  const expectedSigB64Url = bytesToBase64Url(expectedSig);
  if (!timingSafeEqual(expectedSigB64Url, signatureB64)) return { valid: false, error: 'bad_signature' };

  const nowSeconds = now / 1000;
  if (typeof payload.exp !== 'number' || payload.exp < nowSeconds) return { valid: false, error: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) return { valid: false, error: 'not_yet_valid' };
  if (apiKey && payload.aud !== apiKey) return { valid: false, error: 'bad_audience' };
  if (shopDomain) {
    const dest = String(payload.dest || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (dest && dest !== shopDomain) return { valid: false, error: 'bad_destination' };
  }

  return { valid: true, payload };
}

export const _internal = { bytesToHex, bytesToBase64, base64ToBytes, base64UrlToBytes, bytesToBase64Url, base64UrlToJson };
