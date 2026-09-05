/*
 * products-feed.js
 *
 * Decides what feed_url to hand the ARLing Asistent tenant API for a shop.
 *
 * Preferred path: Shopify's own public, unauthenticated catalogue endpoint,
 * `https://{shop}/products.json`. It is already in exactly the shape the
 * main product's feed parser expects (see ../../../worker/src/feed.js
 * parseShopifyJson / FEED_TYPES.SHOPIFY, and
 * ../../../tests/fixtures/shopify-products.json), and since it is public
 * and stable, the ARLing worker's daily cron can keep re-fetching it
 * directly forever with zero involvement from this Shopify integration
 * after onboarding.
 *
 * Fallback path: some merchants disable that endpoint (theme setting, or a
 * password-protected storefront). When it is unavailable, this worker uses
 * the Admin GraphQL API (which the offline access token from OAuth already
 * grants `read_products` on) to fetch the catalogue itself, reshapes it
 * into the exact same `{ products: [...] }` structure `parseShopifyJson`
 * understands, and caches that JSON in D1 (shops.feed_cache). The feed_url
 * given to the tenant API in that case is this worker's own
 * `GET /feed/:shop.json`, which just serves the cached JSON - so the daily
 * cron re-fetch still works, it just refreshes this worker's cache instead
 * of Shopify's, see refreshGraphqlFeedCache() below and the scheduled
 * handler in index.js.
 *
 * Known gap (see README): the GraphQL fallback only fetches the first page
 * (up to 250 products, `products(first: 250)`); a shop with a disabled
 * products.json endpoint AND more than 250 products would need pagination
 * added here, which the MVP does not implement.
 */

export const GRAPHQL_API_VERSION = '2025-01';
export const GRAPHQL_PAGE_SIZE = 250;

const PRODUCTS_QUERY = `
  query AsistentProductsFeed($first: Int!) {
    products(first: $first) {
      edges {
        node {
          id
          title
          descriptionHtml
          handle
          productType
          tags
          images(first: 1) { edges { node { url } } }
          variants(first: 1) { edges { node { price availableForSale } } }
        }
      }
    }
  }
`;

/** "gid://shopify/Product/123456789" -> "123456789". Falls back to the full gid if it does not match the expected shape. */
export function numericIdFromGid(gid) {
  const match = /\/(\d+)$/.exec(String(gid || ''));
  return match ? match[1] : String(gid || '');
}

/** Reshape one Admin GraphQL product node into the same raw item shape Shopify's public /products.json uses, so parseShopifyJson (main worker's feed.js) handles both identically. */
export function graphqlNodeToShopifyProduct(node) {
  const imageEdge = node.images && node.images.edges && node.images.edges[0];
  const variantEdge = node.variants && node.variants.edges && node.variants.edges[0];
  const variant = variantEdge ? variantEdge.node : {};
  return {
    id: numericIdFromGid(node.id),
    title: node.title || '',
    body_html: node.descriptionHtml || '',
    handle: node.handle || '',
    product_type: node.productType || '',
    tags: Array.isArray(node.tags) ? node.tags : [],
    variants: [{ price: variant.price != null ? String(variant.price) : '', available: variant.availableForSale === true }],
    images: imageEdge ? [{ src: imageEdge.node.url }] : [],
  };
}

/** Run the Admin GraphQL products query and return `{ products: [...] }` JSON text ready to cache/serve, matching parseShopifyJson's expected shape exactly. */
export async function fetchProductsViaGraphQL(shopDomain, accessToken, { fetchImpl = fetch, apiVersion = GRAPHQL_API_VERSION, pageSize = GRAPHQL_PAGE_SIZE } = {}) {
  const res = await fetchImpl(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { first: pageSize } }),
  });
  if (!res.ok) {
    throw new Error(`graphql_products_failed_${res.status}`);
  }
  const body = await res.json();
  if (body && body.errors && body.errors.length) {
    throw new Error(`graphql_products_error_${body.errors[0].message}`);
  }
  const edges = (body && body.data && body.data.products && body.data.products.edges) || [];
  const products = edges.map((edge) => graphqlNodeToShopifyProduct(edge.node));
  return JSON.stringify({ products });
}

/** Is Shopify's own public products.json endpoint reachable and does it look like the expected shape? Server-side probe, so it never runs into a browser CORS restriction. */
export async function isPublicFeedAvailable(shopDomain, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`https://${shopDomain}/products.json?limit=1`, {
      headers: { 'user-agent': 'ARLingAsistentShopifyApp/1.0 (+https://arling.sk/asistent/)' },
    });
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body && Array.isArray(body.products));
  } catch (e) {
    return false;
  }
}

/**
 * Decide the feed_url to give the ARLing tenant API for this shop, trying
 * the public endpoint first. Returns `{ feedUrl, mode }` where `mode` is
 * 'public' or 'graphql'; in the 'graphql' case the caller must also persist
 * `feedJson` (via shops.setShopFeedCache) so /feed/:shop.json in index.js
 * can serve it.
 */
export async function resolveFeed(env, shopDomain, accessToken, { fetchImpl = fetch } = {}) {
  const publicOk = await isPublicFeedAvailable(shopDomain, { fetchImpl });
  if (publicOk) {
    return { feedUrl: `https://${shopDomain}/products.json`, mode: 'public', feedJson: null };
  }
  const feedJson = await fetchProductsViaGraphQL(shopDomain, accessToken, { fetchImpl });
  const feedUrl = `${env.APP_URL.replace(/\/$/, '')}/feed/${encodeURIComponent(shopDomain)}.json`;
  return { feedUrl, mode: 'graphql', feedJson };
}
