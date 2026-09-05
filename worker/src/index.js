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
 *   POST /v1/tenants                 -> onboarding.js
 *   GET  /v1/tenants/:id/status      -> onboarding.js
 *   POST /v1/tenants/:id/reingest    -> onboarding.js (admin only, X-Admin-Token)
 *   PATCH/POST /v1/tenants/:id/plan  -> onboarding.js (admin only, X-Admin-Token;
 *                                        this is what a paid Stripe plan actually
 *                                        changes, see licence-service/app.py)
 *   GET  /widget.js                  -> the embeddable widget, served from
 *                                        this worker's own origin
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

import { handleChatRoute } from './chat.js';
import { handleGiftRoute } from './gift.js';
import { handleCreateTenantRoute, handleTenantStatusRoute, handleReingestRoute, handleSetPlanRoute } from './onboarding.js';
import { parseAllowedOrigins, corsHeaders, InputTooLargeError } from './security.js';
import { ValidationError } from './tenants.js';
import widgetSource from './widget-src.js';
import scheduledHandler from './cron.js';

/** CORS headers for a router-level response (no tenant context available here: ALLOWED_ORIGINS only). */
function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  return corsHeaders(origin, allowed) || {};
}

function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
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

function handleOptions(request, env) {
  const origin = request.headers.get('Origin') || '';
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

    if (request.method === 'OPTIONS') {
      return handleOptions(request, env);
    }

    try {
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok', service: 'arling-asistent' }, 200, corsFor(request, env));
      }

      if (url.pathname === '/widget.js' && request.method === 'GET') {
        return handleWidgetJs();
      }

      if (url.pathname === '/v1/chat' && request.method === 'POST') {
        return await handleChatRoute(request, env, ctx);
      }

      if (url.pathname === '/v1/gift' && request.method === 'POST') {
        return await handleGiftRoute(request, env, ctx);
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
