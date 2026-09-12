/* A-021: private fixed ZIP, verified against Stripe on every request.
 * Prepared only; deployment and server configuration are separate steps.
 * No customer records, e-mails, notifications or background work.
 */
import { corsHeaders, parseAllowedOrigins, checkRateLimit } from './security.js';
import { isAdmin } from './upload.js';

export const PACK = 'slitherlink-pattern-01';
export const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const SID = /^cs_(live|test)_[A-Za-z0-9]{8,200}$/;
const SHA = /^[a-f0-9]{64}$/;
function headers(request, env) {
  return { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    ...(corsHeaders(request.headers.get('Origin'), parseAllowedOrigins(env.ALLOWED_ORIGINS)) || {}) };
}
function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers(request, env), 'content-type': 'application/json' } });
}
function releaseKey(env) { return 'publisher/' + PACK + '/' + env.PUBLISHER_RELEASE_SHA256 + '.zip'; }
function configured(env) { return !!env.KONTROLA && SHA.test(env.PUBLISHER_RELEASE_SHA256 || ''); }
async function stripe(env, key, path) {
  try {
    const response = await (env.fetchImpl || fetch)('https://api.stripe.com/v1/' + path, {
      headers: { Authorization: 'Basic ' + btoa(key + ':'), 'Stripe-Version': '2025-03-31.basil' }, signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return { error: 'session_not_found', status: 404 };
    if (!response.ok) return { error: 'verification_unavailable', status: 503 };
    const data = await response.json();
    return !data || data.error ? { error: 'verification_unavailable', status: 503 } : { data };
  } catch { return { error: 'verification_unavailable', status: 503 }; }
}
export function validPurchase(session, items, expected) {
  const item = items?.data?.[0];
  const price = item?.price;
  return session?.id === expected.sid && session.mode === 'payment' && session.status === 'complete'
    && session.payment_status === 'paid' && session.livemode === expected.live
    && session.currency === 'eur' && session.amount_total === 1900
    && session.automatic_tax?.enabled === true
    && session.automatic_tax?.status === 'complete'
    && items?.has_more === false && Array.isArray(items.data) && items.data.length === 1 && item.quantity === 1
    && price?.id === expected.price && price.currency === 'eur' && price.unit_amount === 1900
    && price.tax_behavior === 'inclusive' && price.livemode === expected.live;
}
export async function handlePublisherRoute(request, env) {
  const url = new URL(request.url);
  const sid = url.searchParams.get('session_id') || '';
  if (!SID.test(sid)) return json(request, env, { error: 'invalid_session_id' }, 400);
  if (!configured(env)) return json(request, env, { error: 'delivery_unavailable' }, 503);
  const live = sid.startsWith('cs_live_');
  // Explicit test flag is server-side. Disable after sandbox QA; a public
  // browser query parameter can never turn it on or substitute a live purchase.
  if (!live && env.PUBLISHER_TEST_ENABLED !== '1') return json(request, env, { error: 'test_disabled' }, 403);
  if (!live) {
    let until = 0;
    try { until = Number(await env.KONTROLA.get('publisher/' + PACK + '/test-until')); } catch {}
    if (!(until > Date.now())) return json(request, env, { error: 'test_disabled' }, 403);
  }
  const price = live ? env.PUBLISHER_LIVE_PRICE : env.PUBLISHER_TEST_PRICE;
  const key = live ? env.STRIPE_SECRET_KEY : env.STRIPE_TEST_SECRET_KEY;
  if (!/^price_[A-Za-z0-9]+$/.test(price || '') || !key) return json(request, env, { error: 'verification_unavailable' }, 503);
  const limit = await checkRateLimit(env.ASISTENT_CACHE, request.headers.get('CF-Connecting-IP'));
  if (!limit.allowed) return json(request, env, { error: 'rate_limited' }, 429);
  const lookup = await stripe(env, key, 'checkout/sessions/' + sid);
  if (lookup.error) return json(request, env, { error: lookup.error }, lookup.status);
  if (lookup.data.payment_status !== 'paid') return json(request, env, { error: 'not_paid' }, 402);
  const lines = await stripe(env, key, 'checkout/sessions/' + sid + '/line_items?limit=2');
  if (lines.error) return json(request, env, { error: lines.error }, lines.status);
  if (!validPurchase(lookup.data, lines.data, { sid, live, price })) return json(request, env, { error: 'wrong_product' }, 402);
  let body;
  try { body = await env.KONTROLA.get(releaseKey(env), 'arrayBuffer'); }
  catch { return json(request, env, { error: 'delivery_unavailable' }, 503); }
  if (!body) return json(request, env, { error: 'delivery_unavailable' }, 503);
  if (url.pathname.endsWith('/status')) return json(request, env, { paid: true, pack: PACK, livemode: live, ready: true });
  return new Response(body, { headers: { ...headers(request, env), 'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="' + PACK + '.zip"', 'x-content-type-options': 'nosniff' } });
}
/* Upload the exact reviewed release, using the existing admin credential.
 * No ZIP or static paid-file URL ever appears in the public website repo.
 */
export async function handlePublisherReleaseRoute(request, env) {
  if (!isAdmin(request, env)) return json(request, env, { error: 'unauthorized' }, 401);
  if (!configured(env)) return json(request, env, { error: 'delivery_unavailable' }, 503);
  if (Number(request.headers.get('content-length')) > MAX_ZIP_BYTES) return json(request, env, { error: 'too_large' }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_ZIP_BYTES) return json(request, env, { error: 'too_large' }, 413);
  const bytes = new Uint8Array(body);
  if (bytes.length < 22 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) return json(request, env, { error: 'invalid_zip' }, 400);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), b => b.toString(16).padStart(2, '0')).join('');
  if (sha !== env.PUBLISHER_RELEASE_SHA256) return json(request, env, { error: 'release_mismatch' }, 409);
  try { await env.KONTROLA.put(releaseKey(env), body); }
  catch { return json(request, env, { error: 'storage_unavailable' }, 503); }
  // QA opens test delivery for one hour, then KV expires automatically.
  const testWindow = new URL(request.url).searchParams.get('test_window') === '1';
  if (testWindow) {
    try { await env.KONTROLA.put('publisher/' + PACK + '/test-until', String(Date.now() + 3600000), { expirationTtl: 3600 }); }
    catch { return json(request, env, { error: 'test_window_unavailable' }, 503); }
  }
  return json(request, env, { ok: true, pack: PACK, sha256: sha, test_window_minutes: testWindow ? 60 : 0 });
}
