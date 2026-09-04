/*
 * security.js
 *
 * Everything that keeps the widget endpoint from being abused:
 *   - CORS: only the shop's own registered domain (and its www./https
 *   variants) may call the API from a browser.
 *   - Rate limiting: a per-IP counter kept in KV, independent of the
 *   per-tenant monthly quota in tenants.js.
 *   - Input size limits: a chat request body has a hard byte cap.
 *   - Prompt-injection guard: product feed text is untrusted (a seller could
 *   put "ignore previous instructions" in a product description to try to
 *   hijack the assistant for other shoppers). It is never treated as
 *   instructions: it is wrapped in a clearly delimited data block and flagged
 *   for the system prompt to explicitly reject.
 */

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** Extract the hostname from an origin string ("https://shop.sk" -> "shop.sk"), or '' if invalid. */
export function hostnameFromOrigin(origin) {
  if (!origin) return '';
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

/** True if `hostname` is `allowedDomain` itself or a subdomain of it (e.g. "www.shop.sk" matches "shop.sk"). */
export function domainMatches(hostname, allowedDomain) {
  if (!hostname || !allowedDomain) return false;
  const h = hostname.toLowerCase();
  const a = allowedDomain.toLowerCase().replace(/^www\./, '');
  return h === a || h === `www.${a}` || h.endsWith(`.${a}`);
}

/**
 * Is this origin allowed to call the API? `allowedDomains` is the list of
 * shop domains known to the worker (tenant domains, plus ALLOWED_ORIGINS env
 * var entries for the demo page / admin UI).
 */
export function isOriginAllowed(origin, allowedDomains) {
  const hostname = hostnameFromOrigin(origin);
  if (!hostname) return false;
  return (allowedDomains || []).some((domain) => domainMatches(hostname, domain));
}

/** Parse the ALLOWED_ORIGINS env var (comma-separated hostnames) into an array. */
export function parseAllowedOrigins(envValue) {
  return String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build CORS response headers for a request, or null if the origin is not allowed. */
export function corsHeaders(origin, allowedDomains) {
  if (!isOriginAllowed(origin, allowedDomains)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (KV, per IP, sliding window bucketed by minute)
// ---------------------------------------------------------------------------

export const RATE_LIMIT_DEFAULT = 30; // requests
export const RATE_LIMIT_WINDOW_SECONDS = 60;

function rateLimitKey(ip, windowSeconds, now) {
  const bucket = Math.floor(now / (windowSeconds * 1000));
  return `ratelimit:${ip}:${bucket}`;
}

/**
 * Increment and check a per-IP request counter in KV. Returns
 * {allowed, remaining, limit}. `kv` needs get/put with the standard Workers
 * KV signature; a small in-memory mock is enough for tests.
 */
export async function checkRateLimit(kv, ip, { limit = RATE_LIMIT_DEFAULT, windowSeconds = RATE_LIMIT_WINDOW_SECONDS, now = Date.now() } = {}) {
  const safeIp = ip || 'unknown';
  const key = rateLimitKey(safeIp, windowSeconds, now);
  const current = parseInt((await kv.get(key)) || '0', 10);
  if (current >= limit) {
    return { allowed: false, remaining: 0, limit };
  }
  await kv.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return { allowed: true, remaining: limit - current - 1, limit };
}

// ---------------------------------------------------------------------------
// Input size limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 8000;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_MESSAGES = 20;

export class InputTooLargeError extends Error {}

/** Throws InputTooLargeError if the raw request body text exceeds the byte cap. */
export function assertBodySize(text, maxBytes = MAX_BODY_BYTES) {
  const bytes = new TextEncoder().encode(text || '').length;
  if (bytes > maxBytes) {
    throw new InputTooLargeError(`request body ${bytes} bytes exceeds limit of ${maxBytes}`);
  }
}

// ---------------------------------------------------------------------------
// Prompt-injection guard
// ---------------------------------------------------------------------------

// Deliberately broad and multilingual (SK/CS/EN/DE): false positives here
// only mean a chunk gets flagged and reinforced with an extra reminder, they
// never delete or alter the underlying product text. Patterns are written
// without diacritics because detectInjection() strips them from the input
// first (product feeds are inconsistent about accents), so e.g. "všetky"
// and "vsetky" both match "vsetky" below.
const INJECTION_PATTERNS = [
  /ignore\s+(all|any|the)?\s*(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all|any|the)?\s*(previous|prior|above)/i,
  /forget\s+(all|your|any)\s+(previous|prior)\s+instructions?/i,
  /you\s+are\s+now\s+/i,
  /system\s*prompt/i,
  /new\s+instructions?\s*:/i,
  /ignoruj\s+(vsetky\s+)?(predchadzaj[uú]ce|predosle|vyssie uvedene)\s+(instrukcie|pokyny)/i,
  /nezohladnuj\s+(predchadzajuce|vyssie)/i,
  /zapomen\s+(na\s+)?(predchozi|predesle)\s+(instrukce|pokyny)/i,
  /ignorier[e]?\s+(alle\s+)?(vorherigen|bisherigen)\s+anweisungen/i,
];

/** Strip combining diacritical marks (NFD) so "všetky"/"vsetky" both match the same pattern. */
function stripDiacritics(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Does this text contain a recognisable prompt-injection attempt? */
export function detectInjection(text) {
  if (!text) return false;
  return INJECTION_PATTERNS.some((re) => re.test(stripDiacritics(text)));
}

/**
 * Wrap untrusted text (product data, shop facts) in an explicit, labelled
 * block for the prompt. Neutralises attempts to break out of the block by
 * escaping any literal fence markers, and never removes content: the model
 * is instructed (in the system prompt) to treat everything inside as data,
 * never as instructions, regardless of what it says.
 */
export function wrapUntrustedBlock(label, text) {
  const safe = String(text || '').replace(/```/g, "'''").replace(/<\/?untrusted-data>/gi, '');
  return `<${label}>\n${safe}\n</${label}>`;
}

/**
 * Scan a batch of retrieved product chunks for injection attempts. Returns
 * {flagged: boolean, flaggedIds: string[]} for logging/metadata; callers
 * still pass every product through wrapUntrustedBlock regardless, this is
 * purely observability, not a filter.
 */
export function scanForInjection(candidates) {
  const flaggedIds = candidates.filter((c) => detectInjection(`${c.title} ${c.description || ''}`)).map((c) => c.id);
  return { flagged: flaggedIds.length > 0, flaggedIds };
}
