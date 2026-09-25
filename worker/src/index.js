/*
 * index.js
 *
 * The Worker's fetch router. Thin on purpose: every real decision (CORS,
 * rate limit, quota, retrieval, prompting) lives in the modules it calls
 * into, so those stay unit-testable without a Workers runtime.
 *
 * Routes:
 *   POST /v1/chat                    -> chat.js
 *   POST /v1/gift                    -> gift.js (Gift Finder, a second mode
 *                                        of the same widget/quota/engine)
 *   POST /v1/kontrola/upload         -> upload.js (the paid SEPA file
 *                                        check: raw XML body, only for a
 *                                        paid Stripe Checkout Session)
 *   GET  /v1/kontrola/status         -> upload.js
 *   GET  /v1/kontrola/download       -> upload.js (the delivered result, same
 *                                        paid-session check as the upload)
 *   GET  /v1/kontrola/admin/uploads  -> upload.js (admin only, X-Admin-Token)
 *   GET  /v1/kontrola/admin/upload   -> upload.js (admin only)
 *   PUT  /v1/kontrola/admin/deliver  -> upload.js (admin only)
 *   POST /v1/eshop/kontrola          -> eshop-kontrola.js (free public-page
 *                                        check of an e-shop, no AI, no storage)
 *   POST /v1/ucet/kod                -> ucet.js (e-mail login: send a 6-digit code)
 *   POST /v1/ucet/over               -> ucet.js (verify the code, returns a Bearer token)
 *   GET  /v1/ucet/ja                 -> ucet.js (Bearer; account, purchases, subscriptions)
 *   DELETE /v1/ucet/ja               -> ucet.js (Bearer; "forget me", purchases kept)
 *   POST /v1/ucet/nakup-session      -> ucet.js (Bearer; attach one paid Checkout Session)
 *   PUT  /v1/ucet/nakup              -> ucet.js (admin only, X-Admin-Token; licence-service webhook)
 *   GET  /v1/ucet/hra/:hra           -> ucet.js (Bearer; cross-device game state, opaque JSON)
 *   PUT  /v1/ucet/hra/:hra           -> ucet.js (Bearer; same, max 64 kB)
 *   POST /v1/ucet/odhlasit           -> ucet.js (Bearer; invalidate every token for this account)
 *   POST /v1/tenants                 -> onboarding.js
 *   GET  /v1/tenants/:id/status      -> onboarding.js
 *   POST /v1/tenants/:id/reingest    -> onboarding.js (admin only, X-Admin-Token)
 *   PATCH/POST /v1/tenants/:id/plan  -> onboarding.js (admin only, X-Admin-Token;
 *                                        this is what a paid Stripe plan actually
 *                                        changes, see licence-service/app.py)
 *   POST /v1/tiktok/{start,session,upload,status,cancel}
 *                                    -> tiktok-share.js (Puzzle video maker: a
 *                                        creator's own video to their own
 *                                        TikTok inbox; CORS only arling.sk)
 *   POST /v1/tenants/:id/udalost     -> zivotny-cyklus.js (admin; licence-service
 *                                        hlási zrušené predplatné)
 *   DELETE /v1/tenants/:id?potvrd=<doména>
 *                                    -> zivotny-cyklus.js (ASISTENT_ADMIN_ZAPIS; výmaz účtu)
 *   GET/POST /v1/tenants/:id/emaily/stop?k=
 *                                    -> zivotny-cyklus.js (zastavenie všetkých
 *                                        ďalších e-mailov, voľba „nevytváral
 *                                        som“, HMAC odkaz, RFC 8058)
 *   POST /v1/tenants/:id/overenie    -> zivotny-cyklus.js (Bearer z /v1/ucet/over;
 *                                        overenie e-mailu účtu)
 *   GET  /v1/admin/asistent/udalosti -> zivotny-cyklus.js (ADMIN_TOKEN alebo
 *                                        ASISTENT_ADMIN_CITANIE; zdroj pre Twenty)
 *   POST /v1/admin/asistent/doplnit  -> zivotny-cyklus.js (ASISTENT_ADMIN_ZAPIS; spätné udalosti)
 *   POST /v1/admin/asistent/uvitaci-email
 *                                    -> zivotny-cyklus.js (ASISTENT_ADMIN_ZAPIS; ručné E1)
 *   GET  /widget.js                  -> the embeddable widget, served from
 *                                        this worker's own origin (a Referer
 *                                        z domény obchodu zapíše zapojenie)
 *   GET  /health                     -> static ok
 *   *    (anything else)             -> 404
 *
 * Scheduled (cron) handler is re-exported from cron.js.
 *
 * CORS: every JSON response below goes through jsonResponse(), which always
 * attaches Access-Control-Allow-Origin (via corsFor()) for an allowed
 * Origin, the same allowlist and the same security.js helpers the OPTIONS
 * preflight and chat.js use. Previously only the preflight carried CORS
 * headers, so a browser would send the preflight, see it succeed, then send
 * the real POST/GET and have the actual response blocked for having no CORS
 * header at all (this hit POST /v1/tenants and GET /v1/tenants/:id/status
 * hardest, since the demo page's trial form calls both from arling.sk).
 */

import { PUBLISHER_CONFIG } from './publisher-config.js';
import { handlePublisherRoute, handlePublisherReleaseRoute } from './publisher.js';
import { handleChatRoute } from './chat.js';
import { handleGiftRoute } from './gift.js';
import { handleCreateTenantRoute, handleTenantStatusRoute, handleReingestRoute, handleSetPlanRoute } from './onboarding.js';
import {
  handleKontrolaUploadRoute,
  handleKontrolaStatusRoute,
  handleKontrolaDownloadRoute,
  handleKontrolaAdminUploadsRoute,
  handleKontrolaAdminUploadRoute,
  handleKontrolaAdminDeliverRoute,
} from './upload.js';
import {
  handleUcetKodRoute,
  handleUcetOverRoute,
  handleUcetJaRoute,
  handleUcetDeleteRoute,
  handleUcetNakupSessionRoute,
  handleUcetNakupRoute,
  handleUcetHraGetRoute,
  handleUcetHraPutRoute,
  handleUcetOdhlasitRoute,
} from './ucet.js';
import { parseAllowedOrigins, corsHeaders, InputTooLargeError, SECURITY_HEADERS } from './security.js';
import { ValidationError } from './tenants.js';
import { handleEshopKontrolaRoute } from './eshop-kontrola.js';
import widgetSource from './widget-src.js';
import { handleTiktokRoute } from './tiktok-share.js';
import scheduledHandler from './cron.js';
import {
  poWidgetJs,
  handleAdminUdalostiRoute,
  handleAdminDoplnitRoute,
  handleAdminUvitaciEmailRoute,
  handleTenantUdalostRoute,
  handleDeleteTenantRoute,
  handleEmailyStopRoute,
  handleOverenieRoute,
} from './zivotny-cyklus.js';

/** CORS headers for a router-level response (no tenant context available here: ALLOWED_ORIGINS only). */
function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  return corsHeaders(origin, allowed) || {};
}

function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

/**
 * Detects Cloudflare Workers AI's own daily free-tier exhaustion error
 * (thrown out of env.AI.run()/embedTexts() as an AiError, code 4006:
 * "you have used up your daily free allocation of N neurons, please
 * upgrade to Cloudflare's Workers Paid plan..."). This is an account-level
 * billing limit, not a bug in this worker, so it gets its own honest
 * response instead of falling into the generic internal_error/500
 * catch-all below: 503 is the correct status for "temporarily out of
 * capacity, try later", and the widget already shows a calm, translated
 * "assistant is resting today" message for quota_exceeded (see
 * widget.js's quotaExceeded string) that fits this case just as well.
 */
function isAiCapacityError(err) {
  const message = String((err && err.message) || '');
  return /daily free allocation/i.test(message) && /neurons/i.test(message);
}

// Cesty, ktore vola widget na e-shope zakaznika. Ich preflight nemoze
// zavisiet od ALLOWED_ORIGINS: prehliadac posiela OPTIONS bez tela, takze sa
// z nej neda zistit, ktoremu zakaznikovi patri, a domena zakaznika v tom
// zozname nikdy nebude. Kym to platilo, kazdy chat na cudzom e-shope zomrel
// na preflighte a plugin vyzeral pokazeny.
//
// Bezpecnost tym netrpi. Preflight nie je hranica opravnenia, len otazka
// "smiem to poslat". Skutocna kontrola ostava na samotnom POST-e, ktory v
// chat.js a gift.js overuje Origin proti [tenant.domain, ...ALLOWED_ORIGINS]
// a bez znameho zakaznika vrati 403. Ziadne cookies sa neposielaju, takze
// hviezdicka je tu spravna odpoved.
//
// /v1/kontrola/* is deliberately NOT in this set. Those two routes are
// called from exactly one page, https://arling.sk/kontrola-suboru/nahrat/,
// and arling.sk is already in ALLOWED_ORIGINS, so the ordinary
// corsHeaders() preflight below answers them correctly. A wildcard exists
// for the widget only because a customer's e-shop domain can never be in
// that list in advance; here it would widen the surface for nothing.
const VEREJNE_CESTY = new Set(['/v1/chat', '/v1/gift']);

function handleOptions(request, env) {
  const origin = request.headers.get('Origin') || '';
  const cesta = new URL(request.url).pathname;

  if (VEREJNE_CESTY.has(cesta)) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const headers = corsHeaders(origin, allowed);
  return new Response(null, { status: headers ? 204 : 403, headers: headers || {} });
}

function handleWidgetJs() {
  return new Response(widgetSource, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      // Widget sa načítava z cudzej domény ako <script src>; nosniff bráni
      // tomu, aby si ho prehliadač preložil ako iný typ obsahu.
      'x-content-type-options': 'nosniff',
      // Loaded as a <script src>, from any e-shop's own domain: this is
      // static, tenant-agnostic code (the tenant id is just a data
      // attribute), so a wildcard is correct here, unlike the JSON API
      // routes below which echo back one specific allowed Origin.
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Puzzle video maker, zdieľanie do TikTok inboxu tvorcu (tiktok-share.js).
    // Vlastný preflight, CORS len https://arling.sk, vlastné chyby; preto pred OPTIONS a try.
    if (url.pathname.startsWith('/v1/tiktok/')) {
      const tiktok = await handleTiktokRoute(request, env);
      if (tiktok) return tiktok;
    }

    if (request.method === 'OPTIONS') {
      return handleOptions(request, env);
    }

    try {
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok', service: 'arling-asistent' }, 200, corsFor(request, env));
      }

      if (url.pathname === '/widget.js' && request.method === 'GET') {
        // Zapojenie na webe obchodu z hlavičky Referer (zivotny-cyklus.js).
        // Mimo odpovede cez waitUntil; poWidgetJs nikdy nevyhodí, takže
        // skript sa doručí vždy rovnaký.
        const zapojenie = poWidgetJs(env, request);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(zapojenie);
        else await zapojenie;
        return handleWidgetJs();
      }

      // Životný cyklus Asistenta: chránený zdroj udalostí pre Twenty CRM a
      // jednorazové admin cesty (všetko X-Admin-Token), zastavenie e-mailov.
      if (url.pathname === '/v1/admin/asistent/udalosti' && request.method === 'GET') {
        return await handleAdminUdalostiRoute(request, env);
      }
      if (url.pathname === '/v1/admin/asistent/doplnit' && request.method === 'POST') {
        return await handleAdminDoplnitRoute(request, env);
      }
      if (url.pathname === '/v1/admin/asistent/uvitaci-email' && request.method === 'POST') {
        return await handleAdminUvitaciEmailRoute(request, env);
      }
      const stopMatch = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/emaily\/stop$/);
      if (stopMatch && (request.method === 'GET' || request.method === 'POST')) {
        // Chybné percentové kódovanie (napr. %E0) je chyba volajúceho: 400, nie 500.
        let stopId;
        try {
          stopId = decodeURIComponent(stopMatch[1]);
        } catch (e) {
          return jsonResponse({ error: 'bad_request' }, 400, corsFor(request, env));
        }
        return await handleEmailyStopRoute(request, env, stopId);
      }
      // Overenie e-mailu účtu kódom z /v1/ucet/kod (formulár na arling.sk).
      const overenieMatch = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/overenie$/);
      if (overenieMatch && request.method === 'POST') {
        return await handleOverenieRoute(request, env, overenieMatch[1], ctx);
      }
      const udalostMatch = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/udalost$/);
      if (udalostMatch && request.method === 'POST') {
        return await handleTenantUdalostRoute(request, env, udalostMatch[1]);
      }
      const deleteMatch = url.pathname.match(/^\/v1\/tenants\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return await handleDeleteTenantRoute(request, env, deleteMatch[1]);
      }

      if (url.pathname === '/v1/chat' && request.method === 'POST') {
        return await handleChatRoute(request, env, ctx);
      }

      if (url.pathname === '/v1/gift' && request.method === 'POST') {
        return await handleGiftRoute(request, env, ctx);
      }

      if (['/v1/publisher/status', '/v1/publisher/download'].includes(url.pathname) && request.method === 'GET') {
        return await handlePublisherRoute(request, { ...env, ...PUBLISHER_CONFIG });
      }
      if (url.pathname === '/v1/publisher/admin/release' && request.method === 'PUT') {
        return await handlePublisherReleaseRoute(request, { ...env, ...PUBLISHER_CONFIG });
      }

      if (url.pathname === '/v1/kontrola/upload' && request.method === 'POST') {
        return await handleKontrolaUploadRoute(request, env, ctx);
      }

      if (url.pathname === '/v1/kontrola/status' && request.method === 'GET') {
        return await handleKontrolaStatusRoute(request, env);
      }

      if (url.pathname === '/v1/kontrola/download' && request.method === 'GET') {
        return await handleKontrolaDownloadRoute(request, env);
      }

      if (url.pathname === '/v1/kontrola/admin/uploads' && request.method === 'GET') {
        return await handleKontrolaAdminUploadsRoute(request, env);
      }

      if (url.pathname === '/v1/kontrola/admin/upload' && request.method === 'GET') {
        return await handleKontrolaAdminUploadRoute(request, env);
      }

      if (url.pathname === '/v1/kontrola/admin/deliver' && request.method === 'PUT') {
        return await handleKontrolaAdminDeliverRoute(request, env);
      }

      // Bezplatná kontrola e-shopu pre arling.sk/kontrola-eshopu/ (eshop-kontrola.js).
      if (url.pathname === '/v1/eshop/kontrola' && request.method === 'POST') {
        return await handleEshopKontrolaRoute(request, env);
      }

      if (url.pathname === '/v1/ucet/kod' && request.method === 'POST') {
        return await handleUcetKodRoute(request, env);
      }

      if (url.pathname === '/v1/ucet/over' && request.method === 'POST') {
        return await handleUcetOverRoute(request, env);
      }

      if (url.pathname === '/v1/ucet/ja' && request.method === 'GET') {
        return await handleUcetJaRoute(request, env);
      }

      if (url.pathname === '/v1/ucet/ja' && request.method === 'DELETE') {
        return await handleUcetDeleteRoute(request, env);
      }

      if (url.pathname === '/v1/ucet/nakup-session' && request.method === 'POST') {
        return await handleUcetNakupSessionRoute(request, env);
      }

      if (url.pathname === '/v1/ucet/nakup' && request.method === 'PUT') {
        return await handleUcetNakupRoute(request, env);
      }

      if (url.pathname === '/v1/ucet/odhlasit' && request.method === 'POST') {
        return await handleUcetOdhlasitRoute(request, env);
      }

      const hraMatch = url.pathname.match(/^\/v1\/ucet\/hra\/([^/]+)$/);
      if (hraMatch && request.method === 'GET') {
        return await handleUcetHraGetRoute(request, env, hraMatch[1]);
      }
      if (hraMatch && request.method === 'PUT') {
        return await handleUcetHraPutRoute(request, env, hraMatch[1]);
      }

      if (url.pathname === '/v1/tenants' && request.method === 'POST') {
        return await handleCreateTenantRoute(request, env, ctx);
      }

      const statusMatch = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/status$/);
      if (statusMatch && request.method === 'GET') {
        return await handleTenantStatusRoute(request, env, statusMatch[1]);
      }

      const reingestMatch = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/reingest$/);
      if (reingestMatch && request.method === 'POST') {
        return await handleReingestRoute(request, env, reingestMatch[1]);
      }

      const planMatch = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/plan$/);
      if (planMatch && (request.method === 'PATCH' || request.method === 'POST')) {
        return await handleSetPlanRoute(request, env, planMatch[1]);
      }

      return jsonResponse({ error: 'not_found' }, 404, corsFor(request, env));
    } catch (err) {
      // Input-size and validation errors are the visitor's fault, not ours:
      // report them as 413/400, not a generic 500 (previously an oversized
      // /v1/chat body threw InputTooLargeError out of assertBodySize()
      // uncaught, which fell all the way through to the 500 below).
      if (err instanceof InputTooLargeError) {
        return jsonResponse({ error: 'payload_too_large' }, 413, corsFor(request, env));
      }
      if (err instanceof ValidationError) {
        return jsonResponse({ error: 'validation_failed', issues: err.issues }, 400, corsFor(request, env));
      }
      if (isAiCapacityError(err)) {
        console.error('[arling-asistent] Workers AI daily capacity exhausted:', err && err.message ? err.message : err);
        return jsonResponse({ error: 'quota_exceeded' }, 503, corsFor(request, env));
      }
      // Previously silent: a 500 gave no clue at all in `wrangler tail`
      // (this catch produced a clean Response, so Cloudflare's own outcome
      // stayed "ok" with no exception recorded). Logging here is the only
      // way to see what actually broke.
      console.error('[arling-asistent] unhandled error:', err && err.stack ? err.stack : err);
      return jsonResponse({ error: 'internal_error' }, 500, corsFor(request, env));
    }
  },

  scheduled: scheduledHandler.scheduled,
};
