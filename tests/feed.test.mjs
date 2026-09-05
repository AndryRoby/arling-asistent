// feed.test.mjs
// Feed parsing (all 4 formats), normalisation, and text helpers. No network:
// fixtures are read straight from disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  MAX_PRODUCTS,
  detectFeedType,
  FEED_TYPES,
  parseFeed,
  parseGoogleShoppingXml,
  parseGenericXml,
  parseShopifyJson,
  parseWooCommerceJson,
  normaliseProduct,
  normaliseAvailability,
  stripHtml,
  decodeXmlEntities,
  stripCdata,
  truncate,
  fetchFeed,
  isShopifyProductsJsonUrl,
  isWooCommerceStoreApiUrl,
  SHOPIFY_PRODUCTS_JSON_PAGE_SIZE,
  WOOCOMMERCE_STORE_API_PAGE_SIZE,
} from '../worker/src/feed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('detectFeedType recognises all four formats', () => {
  assert.equal(detectFeedType(fixture('google-shopping.xml')), FEED_TYPES.GOOGLE_SHOPPING);
  assert.equal(detectFeedType(fixture('generic-feed.xml')), FEED_TYPES.GENERIC_XML);
  assert.equal(detectFeedType(fixture('shopify-products.json')), FEED_TYPES.SHOPIFY);
  assert.equal(detectFeedType(fixture('woocommerce-products.json')), FEED_TYPES.WOOCOMMERCE);
  assert.equal(detectFeedType(''), null);
  assert.equal(detectFeedType('not xml or json'), null);
  assert.equal(detectFeedType('{not valid json'), null);
});

test('parseGoogleShoppingXml extracts g: namespaced fields', () => {
  const items = parseGoogleShoppingXml(fixture('google-shopping.xml'));
  assert.equal(items.length, 3);
  assert.equal(items[0].id, 'SKU-1');
  assert.equal(items[0].title, 'Modre tenisky Runner');
  assert.match(items[0].price, /59\.90/);
  assert.equal(items[0].link, 'https://shop.example.sk/produkt/modre-tenisky-runner');
  assert.equal(items[0].availability, 'in stock');
  assert.match(items[0].description, /ignore previous instructions/);
  assert.equal(items[1].availability, 'out of stock');
});

test('parseGenericXml extracts item/name/price/url/description/image', () => {
  const items = parseGenericXml(fixture('generic-feed.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'G-1');
  assert.equal(items[0].title, 'Drevena hracka Vlacik');
  assert.equal(items[0].price, '19.99');
  assert.equal(items[0].link, 'https://hracky.example.cz/vlacik');
  assert.equal(items[0].image, 'https://hracky.example.cz/img/vlacik.jpg');
});

test('parseShopifyJson maps products.json into raw items', () => {
  const items = parseShopifyJson(fixture('shopify-products.json'), 'https://shop.example.com/products.json');
  assert.equal(items.length, 2);
  assert.equal(items[0].id, '111');
  assert.equal(items[0].title, 'Kozena penazenka');
  assert.equal(items[0].price, '39.00');
  assert.equal(items[0].link, 'https://shop.example.com/products/kozena-penazenka');
  assert.equal(items[0].availability, 'in_stock');
  assert.equal(items[1].availability, 'out_of_stock');
  assert.equal(items[1].image, '');
});

test('parseWooCommerceJson handles the public Store API shape (nested prices, minor units)', () => {
  const items = parseWooCommerceJson(fixture('woocommerce-products.json'), 'https://eshop.example.sk/wp-json/wc/store/v1/products');
  assert.equal(items.length, 2);
  assert.equal(items[0].id, '501');
  assert.equal(items[0].title, 'Bavlnene tricko');
  assert.equal(items[0].price, '19.99');
  assert.equal(items[0].currency, 'EUR');
  assert.equal(items[0].availability, 'in_stock');
  assert.equal(items[1].availability, 'out_of_stock');
});

test('parseWooCommerceJson also handles the flat REST v2/v3 shape (no nested prices)', () => {
  const flatJson = JSON.stringify([
    { id: 9, name: 'Hrncek', permalink: 'https://e.example/hrncek', price: '12.50', regular_price: '12.50', stock_status: 'instock', images: [], categories: [] },
  ]);
  const items = parseWooCommerceJson(flatJson, 'https://e.example/');
  assert.equal(items[0].price, '12.50');
  assert.equal(items[0].availability, 'in_stock');
});

test('normaliseAvailability maps varied source strings to in_stock/out_of_stock/unknown', () => {
  assert.equal(normaliseAvailability('in stock'), 'in_stock');
  assert.equal(normaliseAvailability('in_stock'), 'in_stock');
  assert.equal(normaliseAvailability('instock'), 'in_stock');
  assert.equal(normaliseAvailability('out of stock'), 'out_of_stock');
  assert.equal(normaliseAvailability(''), 'unknown');
});

test('normaliseProduct produces the canonical product shape', () => {
  const p = normaliseProduct({
    id: '1', title: ' Cap ', description: '<p>Nice <b>cap</b></p>', price: '19,90', link: 'https://x/1', image: 'https://x/1.jpg', availability: 'in stock', category: 'Hats',
  });
  assert.deepEqual(Object.keys(p).sort(), ['availability', 'category', 'currency', 'description', 'id', 'image', 'price', 'title', 'url'].sort());
  assert.equal(p.title, 'Cap');
  assert.equal(p.description, 'Nice cap');
  assert.equal(p.price, 19.9);
  assert.equal(p.currency, 'EUR');
  assert.equal(p.availability, 'in_stock');
});

test('stripHtml removes tags, decodes entities, and collapses whitespace', () => {
  assert.equal(stripHtml('<p>Hello&nbsp;<b>world</b>!</p>'), 'Hello world!');
  assert.equal(stripHtml('Line1<br>Line2'), 'Line1\nLine2');
  assert.equal(stripHtml(''), '');
});

test('decodeXmlEntities handles named and numeric entities', () => {
  assert.equal(decodeXmlEntities('A &amp; B'), 'A & B');
  assert.equal(decodeXmlEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeXmlEntities('&#65;&#66;'), 'AB');
});

test('stripCdata unwraps CDATA sections', () => {
  assert.equal(stripCdata('<![CDATA[hello]]>'), 'hello');
  assert.equal(stripCdata('plain'), 'plain');
});

test('truncate cuts long text on a word boundary and adds an ellipsis', () => {
  const long = 'word '.repeat(50).trim();
  const short = truncate(long, 20);
  assert.ok(short.length <= 21);
  assert.ok(short.endsWith('…'));
  assert.equal(truncate('short', 20), 'short');
});

test('parseFeed end to end for all four fixtures, capped and filtered', () => {
  const google = parseFeed(fixture('google-shopping.xml'), 'https://shop.example.sk/feed.xml');
  assert.equal(google.type, FEED_TYPES.GOOGLE_SHOPPING);
  assert.equal(google.products.length, 3);
  assert.equal(google.truncated, false);

  const woo = parseFeed(fixture('woocommerce-products.json'), 'https://eshop.example.sk/wp-json/wc/store/v1/products');
  assert.equal(woo.type, FEED_TYPES.WOOCOMMERCE);
  assert.equal(woo.products.length, 2);

  assert.throws(() => parseFeed('garbage', 'https://x/'), /unrecognised_feed_format/);
});

test('parseFeed caps at MAX_PRODUCTS', () => {
  const items = Array.from({ length: MAX_PRODUCTS + 50 }, (_, i) => `<item><id>${i}</id><name>P${i}</name><price>1</price><url>https://x/${i}</url></item>`).join('');
  const xml = `<products>${items}</products>`;
  const result = parseFeed(xml, 'https://x/feed.xml');
  assert.equal(result.products.length, MAX_PRODUCTS);
  assert.equal(result.truncated, true);
});

test('fetchFeed downloads and parses using an injected fetch implementation', async () => {
  const fakeFetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => fixture('generic-feed.xml'),
  });
  const result = await fetchFeed('https://hracky.example.cz/feed.xml', { fetchImpl: fakeFetch });
  assert.equal(result.type, FEED_TYPES.GENERIC_XML);
  assert.equal(result.products.length, 2);
});

test('fetchFeed throws a descriptive error on a non-OK response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => '' });
  await assert.rejects(() => fetchFeed('https://x/missing.xml', { fetchImpl: fakeFetch }), /feed_fetch_failed_404/);
});

// ---------------------------------------------------------------------------
// Shopify /products.json and WooCommerce Store API pagination.
//
// Both endpoints default to a small page (Shopify: 30, WooCommerce Store
// API: 10), so fetchFeed must ask for a full page (limit=250 / per_page=100)
// and keep requesting page=2,3,... until a short page or the MAX_PRODUCTS
// cap ends the loop, instead of silently returning only page 1.
// ---------------------------------------------------------------------------

function shopifyProduct(i) {
  return { id: 1000 + i, title: `Shopify Product ${i}`, handle: `product-${i}`, variants: [{ price: '9.99', available: true }] };
}

function wooProduct(i) {
  return { id: 2000 + i, name: `Woo Product ${i}`, permalink: `https://shop.example/product-${i}`, prices: { price: '999', currency_code: 'EUR', currency_minor_unit: 2 }, stock_status: 'instock' };
}

/** Builds a fake fetchImpl over paged JSON responses, keyed by page count, and records every requested URL. */
function makePagedFetch(pagesOfItems, wrap) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') || '1');
    const items = pagesOfItems[page - 1];
    if (items === undefined) return { ok: true, status: 200, text: async () => JSON.stringify(wrap([])) };
    return { ok: true, status: 200, text: async () => JSON.stringify(wrap(items)) };
  };
  return { fetchImpl, calls };
}

test('isShopifyProductsJsonUrl / isWooCommerceStoreApiUrl detect the paginated endpoints by path only', () => {
  assert.equal(isShopifyProductsJsonUrl('https://shop.example.com/products.json'), true);
  assert.equal(isShopifyProductsJsonUrl('https://shop.example.com/products.json?collection_id=55'), true);
  assert.equal(isShopifyProductsJsonUrl('https://shop.example.com/collections/all/products.json'), true);
  assert.equal(isShopifyProductsJsonUrl('https://shop.example.com/feed.xml'), false);
  assert.equal(isWooCommerceStoreApiUrl('https://eshop.example.sk/wp-json/wc/store/v1/products'), true);
  assert.equal(isWooCommerceStoreApiUrl('https://eshop.example.sk/wp-json/wc/store/v1/products/'), true);
  assert.equal(isWooCommerceStoreApiUrl('https://eshop.example.sk/wp-json/wc/store/v1/products/123'), false);
  assert.equal(isWooCommerceStoreApiUrl('https://eshop.example.sk/feed.xml'), false);
});

test('fetchFeed paginates Shopify /products.json with limit=250 until a short page (250, 250, 40)', async () => {
  const page1 = Array.from({ length: 250 }, (_, i) => shopifyProduct(i));
  const page2 = Array.from({ length: 250 }, (_, i) => shopifyProduct(250 + i));
  const page3 = Array.from({ length: 40 }, (_, i) => shopifyProduct(500 + i));
  const { fetchImpl, calls } = makePagedFetch([page1, page2, page3], (items) => ({ products: items }));

  const result = await fetchFeed('https://shop.example.com/products.json', { fetchImpl });

  assert.equal(result.type, FEED_TYPES.SHOPIFY);
  assert.equal(result.products.length, 540); // 250 + 250 + 40
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 3); // stopped after the short (40-item) page, did not request a 4th
  calls.forEach((url, idx) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('limit'), String(SHOPIFY_PRODUCTS_JSON_PAGE_SIZE));
    assert.equal(u.searchParams.get('page'), String(idx + 1));
  });
});

test('fetchFeed paginates WooCommerce Store API with per_page=100 until a short page (100, 100, 7)', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => wooProduct(i));
  const page2 = Array.from({ length: 100 }, (_, i) => wooProduct(100 + i));
  const page3 = Array.from({ length: 7 }, (_, i) => wooProduct(200 + i));
  const { fetchImpl, calls } = makePagedFetch([page1, page2, page3], (items) => items);

  const result = await fetchFeed('https://eshop.example.sk/wp-json/wc/store/v1/products', { fetchImpl });

  assert.equal(result.type, FEED_TYPES.WOOCOMMERCE);
  assert.equal(result.products.length, 207); // 100 + 100 + 7
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 3); // stopped after the short (7-item) page
  calls.forEach((url, idx) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('per_page'), String(WOOCOMMERCE_STORE_API_PAGE_SIZE));
    assert.equal(u.searchParams.get('page'), String(idx + 1));
  });
});

test('fetchFeed pagination respects existing query params on the feed URL', async () => {
  const page1 = Array.from({ length: 10 }, (_, i) => shopifyProduct(i)); // short first page: stops immediately
  const { fetchImpl, calls } = makePagedFetch([page1], (items) => ({ products: items }));

  await fetchFeed('https://shop.example.com/products.json?collection_id=55', { fetchImpl });

  assert.equal(calls.length, 1);
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get('collection_id'), '55');
  assert.equal(u.searchParams.get('limit'), String(SHOPIFY_PRODUCTS_JSON_PAGE_SIZE));
});

test('fetchFeed pagination stops at the MAX_PRODUCTS cap instead of looping forever', async () => {
  // A server that always returns a full page: without the cap this would
  // never terminate on its own except for the hard maxPages safety valve.
  const fetchImpl = async (url) => {
    const items = Array.from({ length: SHOPIFY_PRODUCTS_JSON_PAGE_SIZE }, (_, i) => shopifyProduct(i));
    return { ok: true, status: 200, text: async () => JSON.stringify({ products: items }) };
  };
  let calls = 0;
  const countingFetch = async (url) => { calls += 1; return fetchImpl(url); };

  const result = await fetchFeed('https://shop.example.com/products.json', { fetchImpl: countingFetch });

  assert.equal(result.products.length, MAX_PRODUCTS);
  assert.equal(result.truncated, true);
  assert.equal(calls, MAX_PRODUCTS / SHOPIFY_PRODUCTS_JSON_PAGE_SIZE); // exactly enough full pages to hit the cap, no more
});

test('fetchFeed pagination stops (without throwing) when a later page is non-200', async () => {
  const page1 = Array.from({ length: 250 }, (_, i) => shopifyProduct(i));
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page') || '1');
    if (page === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ products: page1 }) };
    return { ok: false, status: 500, text: async () => '' };
  };

  const result = await fetchFeed('https://shop.example.com/products.json', { fetchImpl });

  assert.equal(result.products.length, 250); // only page 1's items, loop stopped instead of throwing
});

test('fetchFeed still throws a descriptive error when the first Shopify/WooCommerce page is non-200', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
  await assert.rejects(() => fetchFeed('https://shop.example.com/products.json', { fetchImpl }), /feed_fetch_failed_503/);
  await assert.rejects(() => fetchFeed('https://eshop.example.sk/wp-json/wc/store/v1/products', { fetchImpl }), /feed_fetch_failed_503/);
});
