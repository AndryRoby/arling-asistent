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
