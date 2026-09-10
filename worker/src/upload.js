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
 *   GET  /v1/kontrola/status?session_id=cs_...   {paid, uploaded, email_masked,
 *                                                 delivered, delivered_at,
 *                                                 download_xml?, download_report?}
 *   GET  /v1/kontrola/download?session_id=cs_...&what=xml|report
 *                                                the delivered result, as an
 *                                                attachment; same fail-closed
 *                                                Stripe check as the upload
 *
 * Admin side (X-Admin-Token against env.ADMIN_TOKEN, the same shared secret
 * as the tenant admin routes in onboarding.js; ops/kontrola/zakazka.mjs is
 * the only caller):
 *
 *   GET  /v1/kontrola/admin/uploads              every upload under kontrola/,
 *                                                newest first, from KV list
 *                                                metadata (no Stripe call)
 *   GET  /v1/kontrola/admin/upload?key=kontrola/... the raw XML of one upload
 *   PUT  /v1/kontrola/admin/deliver?session_id=cs_... {xml, report_md, lang}
 *                                                stores the corrected file and
 *                                                the report next to the upload
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
 * checked. The analysis runs on Andrej's PC (ops/kontrola/zakazka.mjs), the
 * result comes back through the admin deliver route, and the customer
 * downloads it from the same page they uploaded to. The page must not
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
// The 149 EUR check is the only product whose session may upload a file.
// A cheaper checkout (the 29 EUR self-service address fix on the Doctor
// page) is paid, but must not open the human service; 402 wrong_product.
export const MIN_UPLOAD_AMOUNT_CENTS = 14900;
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
  if (String(request.headers.get(CONSENT_HEADER) || '').trim() === '1') return true;
  // The page sends consent=1 in the query string: a custom header would need
  // Access-Control-Allow-Headers on the preflight, a query parameter does not.
  try { return new URL(request.url).searchParams.get('consent') === '1'; } catch (e) { return false; }
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
 * The delivered result lives under the same prefix as the upload, with
 * fixed names: there is exactly one delivery per order, and a second PUT
 * from the admin script deliberately replaces the first (a corrected
 * correction). Written with the same expirationTtl as the upload, so the
 * "deleted after 30 days" promise covers the result as well.
 */
export const DELIVERY_BASENAMES = { xml: 'dodanie.xml', md: 'dodanie.md', meta: 'dodanie.meta.json' };

export function deliveryKeys(sessionId) {
  return {
    xml: `${R2_PREFIX}/${sessionId}/${DELIVERY_BASENAMES.xml}`,
    md: `${R2_PREFIX}/${sessionId}/${DELIVERY_BASENAMES.md}`,
    meta: `${R2_PREFIX}/${sessionId}/${DELIVERY_BASENAMES.meta}`,
  };
}

/**
 * An upload key is kontrola/<session>/<stamp>.xml. The delivered
 * dodanie.xml sits under the same prefix and also ends in .xml, so every
 * place that counts or lists uploads has to go through this one test,
 * otherwise a delivery would count against MAX_UPLOADS_PER_SESSION and show
 * up in the admin list as a customer file.
 */
export function isUploadKey(name) {
  const parts = String(name || '').split('/');
  if (parts.length !== 3 || parts[0] !== R2_PREFIX) return false;
  const base = parts[2];
  return base.endsWith('.xml') && base !== DELIVERY_BASENAMES.xml;
}

/** Only keys this worker itself writes: prefix, session id and a plain basename. */
const KV_KEY_PATTERN = /^kontrola\/cs_[A-Za-z0-9_-]{8,200}\/[A-Za-z0-9_.:-]{1,120}$/;

/**
 * Same rule as the tenant admin routes (onboarding.js): the header must
 * equal the ADMIN_TOKEN secret, and with no secret configured nothing is
 * admin.
 */
export function isAdmin(request, env) {
  const provided = request.headers.get('X-Admin-Token') || '';
  return !!(env && env.ADMIN_TOKEN && provided === env.ADMIN_TOKEN);
}

export const DELIVERY_LANGS = new Set(['sk', 'de', 'en']);

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
    return ((listed && listed.keys) || []).filter((k) => isUploadKey(k.name)).length;
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
  if (typeof session.amount_total === 'number' && session.amount_total < MIN_UPLOAD_AMOUNT_CENTS) {
    return jsonResponse(request, env, { error: 'wrong_product', amount_total: session.amount_total }, 402);
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
  // consent, time, size and the masked address also sit in the KV key
  // metadata, so the admin list (a single list() over the prefix) shows
  // them without reading every value. The full address stays inside the
  // value only.
  const listMeta = { consent, uploaded_at: uploadedAt, size: buf.byteLength, email_masked: maskEmail(meta.email) };
  await env.KONTROLA.put(keys.xml, buf, { expirationTtl: RETENTION_SECONDS, metadata: { contentType: 'application/xml', ...listMeta } });
  await env.KONTROLA.put(keys.meta, JSON.stringify(meta, null, 2), {
    expirationTtl: RETENTION_SECONDS, metadata: { contentType: 'application/json', ...listMeta },
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
  const delivery = paid ? await readDelivery(env.KONTROLA, sessionId) : null;
  const body = {
    paid,
    uploaded,
    // Amount lets the Doctor page tell a 29 EUR fix session from the
    // 149 EUR check session; both are "paid".
    amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: session.currency || null,
    email_masked: maskEmail(session.customer_details && session.customer_details.email),
    delivered: !!delivery,
    delivered_at: delivery ? delivery.delivered_at || null : null,
  };
  if (delivery) {
    // Relative on purpose: the page knows the API host, and the same
    // session id the page already holds is the whole credential.
    body.download_xml = downloadPath(sessionId, 'xml');
    body.download_report = downloadPath(sessionId, 'report');
  }
  return jsonResponse(request, env, body, 200);
}

function downloadPath(sessionId, what) {
  return `/v1/kontrola/download?session_id=${encodeURIComponent(sessionId)}&what=${what}`;
}

/** The dodanie.meta.json record, or null when nothing has been delivered (or KV is down). */
async function readDelivery(store, sessionId) {
  if (!store) return null;
  try {
    const meta = await store.get(deliveryKeys(sessionId).meta, 'json');
    return meta && typeof meta === 'object' ? meta : null;
  } catch (err) {
    console.warn('[arling-asistent] KV get (delivery meta) failed:', (err && err.message) || err);
    return null;
  }
}

/**
 * GET /v1/kontrola/download?session_id=cs_…&what=xml|report
 *
 * The customer's copy of the result. The session id is the credential, so
 * the check is the same fail-closed Stripe lookup the upload does: a file
 * with corrected IBANs and addresses must not be handed out on a session
 * we could not confirm as paid, and "Stripe is down" means "try again",
 * never "here you go".
 */
export async function handleKontrolaDownloadRoute(request, env) {
  const sessionId = readSessionId(request);
  if (!sessionId) return jsonResponse(request, env, { error: 'missing_session_id' }, 400);
  const what = new URL(request.url).searchParams.get('what') || '';
  if (what !== 'xml' && what !== 'report') return jsonResponse(request, env, { error: 'bad_what' }, 400);
  if (await rateLimited(request, env)) return jsonResponse(request, env, { error: 'rate_limited' }, 429);

  const check = await fetchCheckoutSession(env, sessionId);
  if (!check.ok) {
    if (check.reason === 'not_found') return jsonResponse(request, env, { error: 'session_not_found' }, 404);
    return jsonResponse(request, env, { error: 'verification_unavailable' }, 503);
  }
  if (check.session.payment_status !== 'paid') {
    return jsonResponse(request, env, { error: 'not_paid', payment_status: check.session.payment_status || 'unknown' }, 402);
  }

  const keys = deliveryKeys(sessionId);
  const key = what === 'xml' ? keys.xml : keys.md;
  let body = null;
  try {
    body = await env.KONTROLA.get(key, 'arrayBuffer');
  } catch (err) {
    console.warn('[arling-asistent] KV get (delivery) failed:', (err && err.message) || err);
    return jsonResponse(request, env, { error: 'storage_unavailable' }, 503);
  }
  if (!body) return jsonResponse(request, env, { error: 'not_delivered' }, 404);

  const filename = what === 'xml' ? 'opraveny-pain001.xml' : 'sprava.md';
  const contentType = what === 'xml' ? 'application/xml; charset=utf-8' : 'text/markdown; charset=utf-8';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      ...corsFor(request, env),
    },
  });
}

// ---------------------------------------------------------------------------
// Admin routes (X-Admin-Token). Called by ops/kontrola/zakazka.mjs from
// Andrej's PC, never from a browser page, so there is no rate limit and no
// Stripe call here: the token is the credential, the KV metadata is the
// data.
// ---------------------------------------------------------------------------

/** Every key under the prefix, following KV's cursor until the list is complete. */
async function listAllKeys(store, prefix) {
  const keys = [];
  let cursor;
  for (let round = 0; round < 100; round++) {
    const page = await store.list(cursor ? { prefix, cursor } : { prefix });
    keys.push(...((page && page.keys) || []));
    if (!page || page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return keys;
}

/** The upload time from a key stamp (kontrola/<s>/<ISO>-<nonce>.xml), or ''. */
function uploadedAtFromKey(name) {
  const base = String(name || '').split('/')[2] || '';
  const m = base.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  return m ? m[1] : '';
}

/**
 * GET /v1/kontrola/admin/uploads
 * {uploads: [{session_id, key, uploaded_at, size, consent, email_masked}]}
 * newest first. Everything comes from the list metadata written at upload
 * time; an upload from before that metadata existed shows null for size
 * and email_masked rather than a guess.
 */
export async function handleKontrolaAdminUploadsRoute(request, env) {
  if (!isAdmin(request, env)) return jsonResponse(request, env, { error: 'unauthorized' }, 401);
  let keys;
  try {
    keys = await listAllKeys(env.KONTROLA, `${R2_PREFIX}/`);
  } catch (err) {
    console.warn('[arling-asistent] KV list failed:', (err && err.message) || err);
    return jsonResponse(request, env, { error: 'storage_unavailable' }, 503);
  }
  const uploads = keys
    .filter((k) => isUploadKey(k.name))
    .map((k) => {
      const meta = (k && k.metadata) || {};
      return {
        session_id: k.name.split('/')[1],
        key: k.name,
        uploaded_at: meta.uploaded_at || uploadedAtFromKey(k.name) || null,
        size: Number.isFinite(meta.size) ? meta.size : null,
        consent: meta.consent === true,
        email_masked: typeof meta.email_masked === 'string' ? meta.email_masked : null,
      };
    })
    .sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));
  return jsonResponse(request, env, { uploads }, 200);
}

/**
 * GET /v1/kontrola/admin/upload?key=kontrola/cs_…/….xml
 * The raw file, so the PC script can pull it into ops/kontrola/zakazky/.
 */
export async function handleKontrolaAdminUploadRoute(request, env) {
  if (!isAdmin(request, env)) return jsonResponse(request, env, { error: 'unauthorized' }, 401);
  const key = new URL(request.url).searchParams.get('key') || '';
  if (!key.startsWith(`${R2_PREFIX}/`) || !KV_KEY_PATTERN.test(key)) {
    return jsonResponse(request, env, { error: 'bad_key' }, 400);
  }
  let body = null;
  try {
    body = await env.KONTROLA.get(key, 'arrayBuffer');
  } catch (err) {
    console.warn('[arling-asistent] KV get failed:', (err && err.message) || err);
    return jsonResponse(request, env, { error: 'storage_unavailable' }, 503);
  }
  if (!body) return jsonResponse(request, env, { error: 'not_found' }, 404);
  const isJson = key.endsWith('.json');
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': isJson ? 'application/json' : 'application/xml',
      'cache-control': 'no-store',
      ...corsFor(request, env),
    },
  });
}

/**
 * PUT /v1/kontrola/admin/deliver?session_id=cs_…
 * Body {xml, report_md, lang}. Writes dodanie.xml, dodanie.md and
 * dodanie.meta.json {delivered_at, lang} under the session prefix, each
 * with RETENTION_SECONDS. From that moment /status reports delivered and
 * the page shows the download links.
 */
export async function handleKontrolaAdminDeliverRoute(request, env) {
  if (!isAdmin(request, env)) return jsonResponse(request, env, { error: 'unauthorized' }, 401);
  const sessionId = readSessionId(request);
  if (!sessionId) return jsonResponse(request, env, { error: 'missing_session_id' }, 400);

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse(request, env, { error: 'bad_json' }, 400);
  }
  const xml = payload && typeof payload.xml === 'string' ? payload.xml : '';
  const reportMd = payload && typeof payload.report_md === 'string' ? payload.report_md : '';
  const lang = payload && typeof payload.lang === 'string' ? payload.lang : '';
  const missing = [];
  if (!xml.trim()) missing.push('xml');
  if (!reportMd.trim()) missing.push('report_md');
  if (!DELIVERY_LANGS.has(lang)) missing.push('lang');
  if (missing.length) return jsonResponse(request, env, { error: 'missing_fields', fields: missing }, 400);
  if (!looksLikeXml(xml)) return jsonResponse(request, env, { error: 'not_xml' }, 400);
  const xmlBytes = new TextEncoder().encode(xml);
  if (xmlBytes.byteLength > MAX_UPLOAD_BYTES) {
    return jsonResponse(request, env, { error: 'payload_too_large', max_bytes: MAX_UPLOAD_BYTES }, 413);
  }

  const deliveredAt = new Date().toISOString();
  const keys = deliveryKeys(sessionId);
  const meta = { session_id: sessionId, delivered_at: deliveredAt, lang, xml_size: xmlBytes.byteLength };
  const opts = { expirationTtl: RETENTION_SECONDS };
  try {
    await env.KONTROLA.put(keys.xml, xmlBytes, { ...opts, metadata: { contentType: 'application/xml', delivered_at: deliveredAt, lang } });
    await env.KONTROLA.put(keys.md, reportMd, { ...opts, metadata: { contentType: 'text/markdown', delivered_at: deliveredAt, lang } });
    // The meta record goes last: status reads only this key, so a delivery
    // becomes visible to the customer only once both files are in place.
    await env.KONTROLA.put(keys.meta, JSON.stringify(meta, null, 2), { ...opts, metadata: { contentType: 'application/json', delivered_at: deliveredAt, lang } });
  } catch (err) {
    console.warn('[arling-asistent] KV put (delivery) failed:', (err && err.message) || err);
    return jsonResponse(request, env, { error: 'storage_unavailable' }, 503);
  }
  return jsonResponse(request, env, { ok: true, delivered_at: deliveredAt, lang }, 200);
}
