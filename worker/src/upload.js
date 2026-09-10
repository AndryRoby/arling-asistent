/*
 * upload.js
 *
 * The paid SEPA file check (149 EUR, https://arling.sk/kontrola-suboru/):
 * after Stripe Checkout the customer lands on
 * /kontrola-suboru/nahrat/?session_id=cs_... and hands the pain.001 file
 * over here instead of mailing it to andrej@arling.sk.
 *
 *   POST /v1/kontrola/upload?session_id=cs_...   raw XML body, max 5 MB
 *        header X-Arling-Consent: 1              the customer ticked the box on
 *                                                the upload page (see CONSENT_HEADER)
 *   GET  /v1/kontrola/status?session_id=cs_...   {paid, uploaded, email_masked}
 *
 * The only thing standing between the internet and this R2 bucket is the
 * Stripe Checkout Session, so verification FAILS CLOSED: if Stripe cannot
 * be reached, answers 403 (the key lacks the read permission) or answers
 * 5xx, the upload is refused with 503, never accepted "just in case". An
 * accepted file we cannot tie to a payment would be a stranger's IBAN list
 * sitting in our bucket, which is worse than a customer having to retry.
 *
 * The session id is the only credential, which is deliberate: it is a
 * 60+ character unguessable string that Stripe hands to the buyer's own
 * browser, the same trust model as a signed download link. It is checked
 * against a strict pattern before it ever reaches the Stripe URL, so a
 * crafted value cannot walk the API path.
 *
 * What is deliberately NOT here: no e-mail is sent, no file is parsed or
 * checked. Both are Andrej's manual work afterwards; the page must not
 * promise more than this code does.
 */

import { corsHeaders, parseAllowedOrigins } from './security.js';
import { notifyKontrolaUpload } from './notify.js';
import { checkRateLimit } from './security.js';

/** 5 MB. A pain.001 batch with thousands of payments is well under 1 MB; this is a guard, not a quota. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Stripe Checkout Session ids look like cs_live_… / cs_test_… . The value
 * is interpolated into an api.stripe.com path, so anything outside this
 * alphabet is rejected before the fetch rather than escaped.
 */
export const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_-]{8,200}$/;

/**
 * Every object for one order lives under kontrola/{session_id}/.
 *
 * Storage is Workers KV, not R2. R2 is not enabled on the account (enabling
 * it is a dashboard click plus a billing profile) and, more importantly, KV
 * has per-key expiration built in: every upload is written with
 * RETENTION_SECONDS, so the "deleted after 30 days" promise on the page is
 * enforced by the platform and not by a lifecycle rule someone has to
 * remember to create. Values up to 25 MB are fine for a 5 MB cap.
 */
export const R2_PREFIX = 'kontrola';
export const RETENTION_SECONDS = 30 * 24 * 60 * 60;
/**
 * A paid session may upload a few exports (one per bank is plausible), but
 * not an unbounded number: without a cap a leaked session id could be used
 * to fill the namespace with 5 MB files.
 */
export const MAX_UPLOADS_PER_SESSION = 5;

/**
 * The upload page asks the customer to tick one box before the file can be
 * chosen: consent to the service starting before the 14-day withdrawal
 * period ends, with the notice that the right of withdrawal is lost once
 * the corrected file and the report are delivered (zákon 102/2014 Z. z.,
 * § 7 ods. 6 písm. a), see ops/audit/2026-09-10/pravo-a-platby.md). The
 * page sends the tick as this header with the value "1". The worker only
 * RECORDS it, next to the file, so the declaration can be shown later; it
 * does not refuse an upload without it. Refusing would lock out a paying
 * customer whose browser still runs the page from before the box existed,
 * and the record of "no consent" is itself the useful fact.
 */
export const CONSENT_HEADER = 'X-Arling-Consent';

/** true only for the exact value the page sends; anything else is "not given". */
export function readConsent(request) {
  return String(request.headers.get(CONSENT_HEADER) || '').trim() === '1';
}

export function objectKeys(sessionId, isoTime, nonce) {
  // The time alone is not unique: a double-click or two files sent in the
  // same millisecond would share a key and the second would overwrite the
  // first. A short random suffix keeps every upload as its own object.
  const stamp = nonce ? `${isoTime}-${nonce}` : isoTime;
  return {
    xml: `${R2_PREFIX}/${sessionId}/${stamp}.xml`,
    // Metadata carries the same stamp in its own name, so a customer who
    // uploads a second export does not overwrite the record of the first
    // one (a single meta.json per session would).
    meta: `${R2_PREFIX}/${sessionId}/${stamp}.meta.json`,
  };
}

function uploadNonce() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 'andrej@arling.sk' -> 'a***@arling.sk'. The page only needs to show the
 * customer which mailbox the result goes to; the full address never leaves
 * this worker in a response, so a leaked session id cannot be turned into
 * an address harvest.
 */
export function maskEmail(email) {
  const value = String(email || '');
  const at = value.lastIndexOf('@');
  if (at < 1) return '';
  return `${value[0]}***${value.slice(at)}`;
}

/**
 * Does this body look like a SEPA XML export? Deliberately shallow: we
 * check that it is XML at all (and pain.001's Document root when the file
 * has no declaration), not that it is valid pain.001. Judging the content
 * is the paid work that happens after the upload, and rejecting a real
 * customer's odd-but-parseable file here would be the worse mistake.
 */
export function looksLikeXml(text) {
  const head = String(text || '').replace(/^﻿/, '').trimStart().slice(0, 2000);
  return head.startsWith('<?xml') || head.includes('<Document');
}

/** CORS headers for this route (no tenant context: ALLOWED_ORIGINS only, which carries arling.sk). */
function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  return corsHeaders(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS)) || {};
}

function jsonResponse(request, env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      // A payment page must never be served from a cache: paid/uploaded
      // both change during the visit.
      'cache-control': 'no-store',
      ...corsFor(request, env),
    },
  });
}

/**
 * Read one Checkout Session from Stripe. Returns
 *   {ok: true, session}                     verified, whatever payment_status says
 *   {ok: false, reason: 'unavailable'}      Stripe unreachable / 403 / 5xx -> 503
 *   {ok: false, reason: 'not_found'}        Stripe says the session does not exist -> 404
 *
 * env.fetchImpl exists so tests can drive every one of those branches
 * without a network (same convention as notify.js and onboarding.js).
 */
export async function fetchCheckoutSession(env, sessionId) {
  const key = env && env.STRIPE_SECRET_KEY;
  if (!key) {
    // The secret is set by hand (wrangler secret put STRIPE_SECRET_KEY).
    // Until it is, refusing everything is the only honest answer.
    console.error('[arling-asistent] STRIPE_SECRET_KEY is not set, refusing kontrola uploads');
    return { ok: false, reason: 'unavailable' };
  }
  const fetchImpl = (env && env.fetchImpl) || fetch;
  let res;
  try {
    res = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${btoa(`${key}:`)}` },
    });
  } catch (err) {
    console.warn('[arling-asistent] Stripe session lookup failed:', (err && err.message) || err);
    return { ok: false, reason: 'unavailable' };
  }

  if (res && res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res || res.ok === false) {
    console.warn(`[arling-asistent] Stripe session lookup returned HTTP ${res && res.status}`);
    return { ok: false, reason: 'unavailable' };
  }

  let session;
  try {
    session = await res.json();
  } catch (err) {
    console.warn('[arling-asistent] Stripe session response was not JSON:', (err && err.message) || err);
    return { ok: false, reason: 'unavailable' };
  }
  // Stripe reports some errors with a 200 body carrying {error: …}.
  if (!session || session.error || !session.id) return { ok: false, reason: 'unavailable' };
  return { ok: true, session };
}

/** The session_id query parameter, or '' if absent/malformed. */
function readSessionId(request) {
  const raw = new URL(request.url).searchParams.get('session_id') || '';
  return SESSION_ID_PATTERN.test(raw) ? raw : '';
}

/** How many files this session has uploaded so far (KV list is by prefix). */
async function countUploads(store, sessionId) {
  if (!store) return 0;
  try {
    const listed = await store.list({ prefix: `${R2_PREFIX}/${sessionId}/` });
    return ((listed && listed.keys) || []).filter((k) => k.name.endsWith('.xml')).length;
  } catch (err) {
    console.warn('[arling-asistent] KV list failed:', (err && err.message) || err);
    return 0;
  }
}

/**
 * Same limiter as /v1/chat and /v1/gift. Every status call costs one Stripe
 * API request made with our secret key, so an unlimited caller could burn
 * our Stripe rate limit even though they learn nothing from the answers.
 */
async function rateLimited(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(env.ASISTENT_CACHE, ip);
  return !rate.allowed;
}

/**
 * POST /v1/kontrola/upload?session_id=cs_…
 * Body is the raw file. 200 {ok, uploaded_at} on success.
 */
export async function handleKontrolaUploadRoute(request, env, ctx) {
  const sessionId = readSessionId(request);
  if (!sessionId) return jsonResponse(request, env, { error: 'missing_session_id' }, 400);
  if (await rateLimited(request, env)) return jsonResponse(request, env, { error: 'rate_limited' }, 429);

  // Cheap rejection first: an oversized upload should not cost a Stripe
  // call, and Content-Length lets us answer before reading the body.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return jsonResponse(request, env, { error: 'payload_too_large', max_bytes: MAX_UPLOAD_BYTES }, 413);
  }

  const check = await fetchCheckoutSession(env, sessionId);
  if (!check.ok) {
    if (check.reason === 'not_found') return jsonResponse(request, env, { error: 'session_not_found' }, 404);
    return jsonResponse(request, env, { error: 'verification_unavailable' }, 503);
  }
  const session = check.session;
  if (session.payment_status !== 'paid') {
    // 402 rather than 403: the request is well formed and the caller is
    // who they say they are, only the payment is missing. 403 would read
    // as "you may never do this", which is wrong and unhelpful on a page
    // whose whole job is "you just paid, now hand over the file".
    return jsonResponse(request, env, { error: 'not_paid', payment_status: session.payment_status || 'unknown' }, 402);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    return jsonResponse(request, env, { error: 'payload_too_large', max_bytes: MAX_UPLOAD_BYTES }, 413);
  }
  if (buf.byteLength === 0) return jsonResponse(request, env, { error: 'empty_body' }, 400);

  // Content-Type is not the gate. Browsers and file pickers label .xml
  // inconsistently (application/xml, text/xml, octet-stream, sometimes
  // nothing at all), so the body itself decides.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!looksLikeXml(text)) return jsonResponse(request, env, { error: 'not_xml' }, 400);

  const uploadedAt = new Date().toISOString();
  const keys = objectKeys(sessionId, uploadedAt, uploadNonce());
  const consent = readConsent(request);
  const meta = {
    session_id: sessionId,
    email: (session.customer_details && session.customer_details.email) || null,
    amount_total: session.amount_total ?? null,
    currency: session.currency || null,
    // A Checkout Session has no "paid at" field of its own; `created` is
    // the closest timestamp Stripe gives us, so that is what this is.
    paid_at: Number.isFinite(session.created) ? new Date(session.created * 1000).toISOString() : null,
    uploaded_at: uploadedAt,
    size: buf.byteLength,
    // The declaration from the upload page (CONSENT_HEADER). Stored per
    // upload, not per session: it is the customer's statement that goes
    // with this file, and a later upload carries its own.
    consent,
  };

  if ((await countUploads(env.KONTROLA, sessionId)) >= MAX_UPLOADS_PER_SESSION) {
    return jsonResponse(request, env, { error: 'upload_limit', max_files: MAX_UPLOADS_PER_SESSION }, 429);
  }

  // expirationTtl is the whole retention policy. See RETENTION_SECONDS.
  // consent also sits in the KV key metadata, so a list() over the prefix
  // shows it without reading every value.
  await env.KONTROLA.put(keys.xml, buf, { expirationTtl: RETENTION_SECONDS, metadata: { contentType: 'application/xml', consent } });
  await env.KONTROLA.put(keys.meta, JSON.stringify(meta, null, 2), {
    expirationTtl: RETENTION_SECONDS, metadata: { contentType: 'application/json', consent },
  });

  // The ntfy line telling Andrej there is work waiting. It must never fail
  // the upload: the file is already safely in KV by this point, and a
  // missed notification is a smaller problem than a customer being told
  // their upload failed when it did not.
  // Only the tail of the session id goes to ntfy: the full id is the one key
  // to this order's upload and status, and a phone notification is not the
  // place to carry a credential. The tail is enough to find the order in
  // the Stripe dashboard.
  const ping = notifyKontrolaUpload(env, { sessionId: sessionId.slice(-8) });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(ping);
  else await ping;

  return jsonResponse(request, env, { ok: true, uploaded_at: uploadedAt }, 200);
}

/**
 * GET /v1/kontrola/status?session_id=cs_…
 * What the upload page needs to decide what to show, and nothing more.
 */
export async function handleKontrolaStatusRoute(request, env) {
  const sessionId = readSessionId(request);
  if (!sessionId) return jsonResponse(request, env, { error: 'missing_session_id' }, 400);
  if (await rateLimited(request, env)) return jsonResponse(request, env, { error: 'rate_limited' }, 429);

  const check = await fetchCheckoutSession(env, sessionId);
  if (!check.ok) {
    if (check.reason === 'not_found') return jsonResponse(request, env, { error: 'session_not_found' }, 404);
    return jsonResponse(request, env, { error: 'verification_unavailable' }, 503);
  }

  const session = check.session;
  const paid = session.payment_status === 'paid';
  const uploaded = paid ? (await countUploads(env.KONTROLA, sessionId)) > 0 : false;
  return jsonResponse(request, env, {
    paid,
    uploaded,
    email_masked: maskEmail(session.customer_details && session.customer_details.email),
  }, 200);
}
