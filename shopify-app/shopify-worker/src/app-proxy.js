/*
 * app-proxy.js
 *
 * GET /proxy/settings.json - the endpoint the theme app extension's Liquid
 * block calls (through Shopify's app proxy, so it runs same-origin on the
 * storefront domain, no CORS needed) to learn which ARLing Asistent tenant
 * belongs to this shop and which widget settings (language/colour/position)
 * to render with.
 *
 * Reached as https://{shop-domain}/apps/asistent/settings.json on the
 * storefront (path configured in shopify.app.toml [app_proxy], subpath
 * "asistent"); Shopify rewrites that to a signed request to this worker's
 * `application_url + /proxy/settings.json?shop=...&signature=...`.
 *
 * Chose the app-proxy route over shop metafields for the "simpler
 * documented way" the task calls for: metafields would need the extension
 * to declare a `metafield` block target and the worker to write them via
 * Admin GraphQL on every settings save (an extra write path, and the
 * storefront would still need the app's own domain for `/widget.js` and
 * `/v1/chat` anyway); an app-proxy JSON endpoint is one route, reuses the
 * exact D1 row saved by the admin page, and needs no metafield
 * read-your-own-write consistency handling in Liquid.
 */

import { verifyAppProxySignature } from './crypto-utils.js';
import { getShopByDomain } from './shops.js';

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=60', ...extraHeaders } });
}

export async function handleProxySettings(request, env) {
  const url = new URL(request.url);
  const signatureOk = await verifyAppProxySignature(url.searchParams, env.SHOPIFY_API_SECRET);
  if (!signatureOk) {
    return jsonResponse({ error: 'invalid_signature' }, 401);
  }

  const shopDomain = url.searchParams.get('shop') || '';
  const shop = shopDomain ? await getShopByDomain(env.DB, shopDomain) : null;
  if (!shop || !shop.tenant_id) {
    return jsonResponse({ error: 'not_configured' }, 404);
  }

  return jsonResponse({
    tenant: shop.tenant_id,
    lang: shop.language || 'auto',
    color: shop.color || 'auto',
    position: shop.position || 'right',
    endpoint: env.ARLING_API_BASE,
  }, 200);
}
