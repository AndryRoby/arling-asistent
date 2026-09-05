// products-feed.test.mjs
// Feed source resolution: prefer Shopify's own public /products.json,
// fall back to the Admin GraphQL products query reshaped into the exact
// same { products: [...] } structure the parent product's feed.js
// (parseShopifyJson) expects.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  numericIdFromGid,
  graphqlNodeToShopifyProduct,
  fetchProductsViaGraphQL,
  isPublicFeedAvailable,
  resolveFeed,
} from '../shopify-worker/src/products-feed.js';
import { parseShopifyJson } from '../../worker/src/feed.js';

const SHOP = 'my-shop.myshopify.com';
const TOKEN = 'shpat_live_token';

test('numericIdFromGid extracts the trailing numeric id from a Shopify GID, or passes through an unexpected shape', () => {
  assert.equal(numericIdFromGid('gid://shopify/Product/123456789'), '123456789');
  assert.equal(numericIdFromGid('not-a-gid'), 'not-a-gid');
  assert.equal(numericIdFromGid(''), '');
});

test('graphqlNodeToShopifyProduct reshapes one Admin GraphQL product node into the exact raw item shape parseShopifyJson expects', () => {
  const node = {
    id: 'gid://shopify/Product/111',
    title: 'Kozena penazenka',
    descriptionHtml: '<p>Rucne sita</p>',
    handle: 'kozena-penazenka',
    productType: 'Doplnky',
    tags: ['kozene', 'doplnky'],
    images: { edges: [{ node: { url: 'https://cdn.shopify.com/img/penazenka.jpg' } }] },
    variants: { edges: [{ node: { price: '39.00', availableForSale: true } }] },
  };
  const raw = graphqlNodeToShopifyProduct(node);
  assert.equal(raw.id, '111');
  assert.equal(raw.title, 'Kozena penazenka');
  assert.equal(raw.body_html, '<p>Rucne sita</p>');
  assert.equal(raw.handle, 'kozena-penazenka');
  assert.equal(raw.product_type, 'Doplnky');
  assert.deepEqual(raw.tags, ['kozene', 'doplnky']);
  assert.equal(raw.variants[0].price, '39.00');
  assert.equal(raw.variants[0].available, true);
  assert.equal(raw.images[0].src, 'https://cdn.shopify.com/img/penazenka.jpg');
});

test('graphqlNodeToShopifyProduct handles a node with no image and no variant gracefully', () => {
  const node = { id: 'gid://shopify/Product/222', title: 'No image', descriptionHtml: '', handle: 'no-image', productType: '', tags: [], images: { edges: [] }, variants: { edges: [] } };
  const raw = graphqlNodeToShopifyProduct(node);
  assert.deepEqual(raw.images, []);
  assert.equal(raw.variants[0].available, false);
  assert.equal(raw.variants[0].price, '');
});

test('the GraphQL-derived feed JSON round-trips through the parent product\'s parseShopifyJson exactly like Shopify\'s own products.json would', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      data: {
        products: {
          edges: [
            { node: { id: 'gid://shopify/Product/111', title: 'Kozena penazenka', descriptionHtml: '<p>Popis</p>', handle: 'penazenka', productType: 'Doplnky', tags: ['kozene'], images: { edges: [{ node: { url: 'https://cdn/img.jpg' } }] }, variants: { edges: [{ node: { price: '39.00', availableForSale: true } }] } } },
          ],
        },
      },
    }),
  });

  const feedJsonText = await fetchProductsViaGraphQL(SHOP, TOKEN, { fetchImpl });
  const products = parseShopifyJson(feedJsonText, `https://${SHOP}/`); // returns raw (un-normalised) items, see worker/src/feed.js
  assert.equal(products.length, 1);
  assert.equal(products[0].id, '111');
  assert.equal(products[0].title, 'Kozena penazenka');
  assert.equal(products[0].price, '39.00');
});

test('fetchProductsViaGraphQL sends the access token header and the products query, and throws on a GraphQL error', async () => {
  let capturedOptions;
  const okFetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, json: async () => ({ data: { products: { edges: [] } } }) };
  };
  await fetchProductsViaGraphQL(SHOP, TOKEN, { fetchImpl: okFetch });
  assert.equal(capturedOptions.headers['X-Shopify-Access-Token'], TOKEN);
  assert.match(JSON.parse(capturedOptions.body).query, /products\(first: \$first\)/);

  const errorFetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'Access denied' }] }) });
  await assert.rejects(fetchProductsViaGraphQL(SHOP, TOKEN, { fetchImpl: errorFetch }), /graphql_products_error_Access denied/);

  const httpErrorFetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(fetchProductsViaGraphQL(SHOP, TOKEN, { fetchImpl: httpErrorFetch }), /graphql_products_failed_403/);
});

test('isPublicFeedAvailable is true only for a 200 response shaped like { products: [...] }', async () => {
  assert.equal(await isPublicFeedAvailable(SHOP, { fetchImpl: async () => ({ ok: true, json: async () => ({ products: [] }) }) }), true);
  assert.equal(await isPublicFeedAvailable(SHOP, { fetchImpl: async () => ({ ok: false, status: 404 }) }), false);
  assert.equal(await isPublicFeedAvailable(SHOP, { fetchImpl: async () => ({ ok: true, json: async () => ({ notProducts: true }) }) }), false);
  assert.equal(await isPublicFeedAvailable(SHOP, { fetchImpl: async () => { throw new Error('network down'); } }), false);
});

test('resolveFeed prefers the public products.json when available', async () => {
  const env = { APP_URL: 'https://shopify-app.arling.workers.dev' };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ products: [{ id: 1 }] }) });
  const result = await resolveFeed(env, SHOP, TOKEN, { fetchImpl });
  assert.equal(result.mode, 'public');
  assert.equal(result.feedUrl, `https://${SHOP}/products.json`);
  assert.equal(result.feedJson, null);
});

test('resolveFeed falls back to the GraphQL-derived feed hosted on this worker when products.json is unavailable', async () => {
  const env = { APP_URL: 'https://shopify-app.arling.workers.dev' };
  let call = 0;
  const fetchImpl = async (url) => {
    call += 1;
    if (String(url).includes('/products.json')) return { ok: false, status: 403 };
    return { ok: true, json: async () => ({ data: { products: { edges: [] } } }) };
  };
  const result = await resolveFeed(env, SHOP, TOKEN, { fetchImpl });
  assert.equal(result.mode, 'graphql');
  assert.equal(result.feedUrl, `https://shopify-app.arling.workers.dev/feed/${encodeURIComponent(SHOP)}.json`);
  assert.equal(JSON.parse(result.feedJson).products.length, 0);
  assert.ok(call >= 2);
});
