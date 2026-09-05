/*
 * index.js
 *
 * The Shopify app worker's fetch router. Thin on purpose, same philosophy
 * as the parent product's worker/src/index.js: every real decision lives in
 * the module it calls into, so those stay unit-testable without a Workers
 * runtime.
 *
 * Routes:
 *   GET  /auth                       -> oauth.js, start install
 *   GET  /auth/callback              -> oauth.js, finish install, provision tenant
 *   GET  /app                        -> admin-page.js, embedded admin UI
 *   GET  /app/api/status             -> session-token verified, shop+tenant status
 *   POST /app/api/settings           -> session-token verified, save language/color/position
 *   POST /app/api/billing            -> session-token verified, start a plan charge
 *   POST /webhooks/app/uninstalled   -> webhooks.js
 *   POST /webhooks/customers/data_request -> webhooks.js
 *   POST /webhooks/customers/redact       -> webhooks.js
 *   POST /webhooks/shop/redact            -> webhooks.js
 *   GET  /proxy/settings.json        -> app-proxy.js, called by the theme extension
 *   GET  /feed/:shop.json            -> serves the cached GraphQL-derived feed
 *                                        (see products-feed.js), only used
 *                                        when a shop's public products.json
 *                                        is unavailable
 *   GET  /health                     -> static ok
 */

import { handleAuthStart, verifyCallback, exchangeCodeForToken } from './oauth.js';
import { withVerifiedWebhook, handleAppUninstalled, dispatchComplianceWebhook } from './webhooks.js';
import { handleProxySettings } from './app-proxy.js';
import { requireSessionToken } from './session-token.js';
import { renderAdminPage } from './admin-page.js';
import { createTenant, getTenantStatus } from './tenant-client.js';
import { resolveFeed } from './products-feed.js';
import { createRecurringCharge, FREE_PLAN } from './billing.js';
import { upsertShopOnInstall, getShopByDomain, setShopTenant, setShopFeedCache, setShopPlan, setShopSettings } from './shops.js';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** Runs right after OAuth completes: pick a feed source, create the ARLing tenant, store its id. Safe to run in ctx.waitUntil, same pattern as the parent product's onboarding.js ingestFeedForTenant. */
export async function provisionTenant(env, shopDomain, accessToken, { fetchImpl = fetch } = {}) {
  const shop = await getShopByDomain(env.DB, shopDomain);
  const contactEmail = (shop && shop.contact_email) || `merchant+${shopDomain}@arling.sk`;

  const feed = await resolveFeed(env, shopDomain, accessToken, { fetchImpl });
  if (feed.mode === 'graphql') {
    await setShopFeedCache(env.DB, shopDomain, 'graphql', feed.feedJson);
  }

  const result = await createTenant(env, { feedUrl: feed.feedUrl, domain: shopDomain, email: contactEmail }, { fetchImpl });
  if (result.ok) {
    await setShopTenant(env.DB, shopDomain, result.data.id, contactEmail, feed.mode);
  }
  return result;
}

async function handleAuthCallback(request, env, ctx) {
  const verification = await verifyCallback(request, env);
  if (!verification.ok) {
    return jsonResponse({ error: verification.error }, 400);
  }
  const { shop, code } = verification;
  let token;
  try {
    token = await exchangeCodeForToken(shop, code, env);
  } catch (err) {
    return jsonResponse({ error: 'token_exchange_failed', message: String((err && err.message) || err) }, 502);
  }

  await upsertShopOnInstall(env.DB, shop, token.accessToken, token.scope);

  const provisioning = provisionTenant(env, shop, token.accessToken);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(provisioning);
  } else {
    await provisioning;
  }

  const appUrl = new URL(`${env.APP_URL.replace(/\/$/, '')}/app`);
  appUrl.searchParams.set('shop', shop);
  return new Response(null, { status: 302, headers: { Location: appUrl.toString() } });
}

function handleAppPage(request, env) {
  const url = new URL(request.url);
  const shop = url.searchParams.get('shop') || '';
  const host = url.searchParams.get('host') || '';
  return new Response(renderAdminPage({ apiKey: env.SHOPIFY_API_KEY, shop, host }), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function handleApiStatus(request, env) {
  const auth = await requireSessionToken(request, env);
  if (!auth.ok) return auth.response;

  const shop = await getShopByDomain(env.DB, auth.shop);
  if (!shop) return jsonResponse({ error: 'shop_not_found' }, 404);

  let tenant = null;
  if (shop.tenant_id) {
    const statusResult = await getTenantStatus(env, shop.tenant_id);
    if (statusResult.ok) tenant = statusResult.data;
  }

  return jsonResponse({
    shop: shop.domain,
    plan: shop.plan,
    language: shop.language,
    color: shop.color,
    position: shop.position,
    tenant,
  });
}

async function handleApiSettings(request, env) {
  const auth = await requireSessionToken(request, env);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  // 'auto' matches the widget's own current default (see widget/widget.js
  // resolveAutoLang): the widget's own chrome follows the visitor's browser
  // language, and the same value is sent to /v1/chat as-is so the assistant
  // replies in whatever language the customer actually types in.
  const language = ['auto', 'sk', 'cs', 'en', 'de'].includes(body.language) ? body.language : 'auto';
  const color = ['auto', 'light', 'dark'].includes(body.color) ? body.color : 'auto';
  const position = ['left', 'right'].includes(body.position) ? body.position : 'right';

  await setShopSettings(env.DB, auth.shop, { language, color, position });
  return jsonResponse({ ok: true, language, color, position });
}

async function handleApiBilling(request, env) {
  const auth = await requireSessionToken(request, env);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const plan = body.plan;
  if (plan === FREE_PLAN.key) {
    await setShopPlan(env.DB, auth.shop, 'free', null);
    return jsonResponse({ ok: true, plan: 'free' });
  }
  if (plan !== 'starter' && plan !== 'pro') {
    return jsonResponse({ error: 'unknown_plan' }, 400);
  }

  const shop = await getShopByDomain(env.DB, auth.shop);
  if (!shop || !shop.access_token) return jsonResponse({ error: 'shop_not_installed' }, 400);

  const returnUrl = `${env.APP_URL.replace(/\/$/, '')}/app?shop=${encodeURIComponent(auth.shop)}`;
  try {
    const charge = await createRecurringCharge(auth.shop, shop.access_token, plan, { returnUrl, test: env.BILLING_TEST_MODE === 'true' });
    return jsonResponse({ ok: true, confirmationUrl: charge.confirmationUrl, subscriptionId: charge.subscriptionId });
  } catch (err) {
    return jsonResponse({ error: 'billing_failed', message: String((err && err.message) || err) }, 502);
  }
}

async function handleFeedJson(request, env, shopDomain) {
  const shop = await getShopByDomain(env.DB, shopDomain);
  if (!shop || shop.feed_mode !== 'graphql' || !shop.feed_cache) {
    return jsonResponse({ products: [] }, 200);
  }
  return new Response(shop.feed_cache, { status: 200, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok', service: 'arling-asistent-shopify' });
      }

      if (url.pathname === '/auth' && request.method === 'GET') {
        return handleAuthStart(request, env);
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        return handleAuthCallback(request, env, ctx);
      }

      if (url.pathname === '/app' && request.method === 'GET') {
        return handleAppPage(request, env);
      }
      if (url.pathname === '/app/api/status' && request.method === 'GET') {
        return handleApiStatus(request, env);
      }
      if (url.pathname === '/app/api/settings' && request.method === 'POST') {
        return handleApiSettings(request, env);
      }
      if (url.pathname === '/app/api/billing' && request.method === 'POST') {
        return handleApiBilling(request, env);
      }

      if (url.pathname === '/webhooks/app/uninstalled' && request.method === 'POST') {
        return withVerifiedWebhook(request, env, ctx, handleAppUninstalled);
      }
      // All three mandatory compliance topics share one route, matching the
      // single `[[webhooks.subscriptions]] compliance_topics = [...]` entry
      // in shopify.app.toml; see webhooks.js dispatchComplianceWebhook.
      if (url.pathname === '/webhooks/compliance' && request.method === 'POST') {
        return dispatchComplianceWebhook(request, env, ctx);
      }

      if (url.pathname === '/proxy/settings.json' && request.method === 'GET') {
        return handleProxySettings(request, env);
      }

      const feedMatch = url.pathname.match(/^\/feed\/([^/]+)\.json$/);
      if (feedMatch && request.method === 'GET') {
        return handleFeedJson(request, env, decodeURIComponent(feedMatch[1]));
      }

      return jsonResponse({ error: 'not_found' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'internal_error', message: String((err && err.message) || err) }, 500);
    }
  },
};
