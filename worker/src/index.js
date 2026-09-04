/*
 * index.js
 *
 * The Worker's fetch router. Thin on purpose: every real decision (CORS,
 * rate limit, quota, retrieval, prompting) lives in the modules it calls
 * into, so those stay unit-testable without a Workers runtime.
 *
 * Routes:
 *   POST /v1/chat                  -> chat.js
 *   POST /v1/tenants               -> onboarding.js
 *   GET  /v1/tenants/:id/status    -> onboarding.js
 *   GET  /health                   -> static ok
 *   *    (anything else)           -> 404
 *
 * Scheduled (cron) handler is re-exported from cron.js.
 */

import { handleChatRoute } from './chat.js';
import { handleCreateTenantRoute, handleTenantStatusRoute } from './onboarding.js';
import { parseAllowedOrigins, corsHeaders } from './security.js';
import scheduledHandler from './cron.js';

function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function handleOptions(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const headers = corsHeaders(origin, allowed);
  return new Response(null, { status: headers ? 204 : 403, headers: headers || {} });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleOptions(request, env);
    }

    try {
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok', service: 'arling-asistent' });
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

      return jsonResponse({ error: 'not_found' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'internal_error' }, 500);
    }
  },

  scheduled: scheduledHandler.scheduled,
};
