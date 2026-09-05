/*
 * index.js
 *
 * The Worker's fetch router. Thin on purpose: every real decision (CORS,
 * rate limit, quota, retrieval, prompting) lives in the modules it calls
 * into, so those stay unit-testable without a Workers runtime.
 *
 * Routes:
 *   POST /v1/chat                    -> chat.js
 *   POST /v1/tenants                 -> onboarding.js
 *   GET  /v1/tenants/:id/status      -> onboarding.js
 *   POST /v1/tenants/:id/reingest    -> onboarding.js (admin only, X-Admin-Token)
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
import { handleCreateTenantRoute, handleTenantStatusRoute, handleReingestRoute } from './onboarding.js';
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
      return jsonResponse({ error: 'internal_error' }, 500, corsFor(request, env));
    }
  },

  scheduled: scheduledHandler.scheduled,
};
