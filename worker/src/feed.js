/*
 * feed.js
 *
 * Downloads a shop's product feed and turns it into a flat, normalised
 * product list: {id, title, description, price, currency, url, image,
 * availability, category}.
 *
 * Supported formats, auto-detected from the response body:
 *   - Google Shopping RSS/XML (the "g:" namespace: g:id, g:price, g:image_link...)
 *   - Shopify's public /products.json endpoint ({ "products": [...] })
 *   - WooCommerce REST products JSON (an array of product objects, either the
 *     public Store API shape with a nested "prices" object, or the plain
 *     v2/v3 REST shape with a flat "price"/"regular_price" string)
 *   - A generic XML feed with <item><name><price><url><description><image>
 *
 * No XML/JSON parsing libraries: Cloudflare Workers has no DOMParser, so XML
 * is read with small regex-based tag extractors. This is deliberately
 * tolerant (namespaces, CDATA, HTML entities) rather than a full XML parser,
 * which is enough for the shape real product feeds actually use.
 *
 * Everything here is a pure function of the text it is given, so it is
 * testable without any network access (see tests/feed.test.mjs).
 */

export const MAX_PRODUCTS = 5000;

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeXmlEntities(text) {
  if (!text) return '';
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const num = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (Number.isNaN(num)) return match;
      try {
        return String.fromCodePoint(num);
      } catch (e) {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, code) ? ENTITY_MAP[code] : match;
  });
}

export function stripCdata(text) {
  if (!text) return '';
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Strip HTML tags from a description and collapse whitespace to plain text. */
export function stripHtml(text) {
  if (!text) return '';
  const withoutTags = String(text)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeXmlEntities(withoutTags)
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cap a string to a maximum length, on a word boundary where possible. */
export function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '\u2026';
}

// ---------------------------------------------------------------------------
// XML tag extraction (regex based, namespace-tolerant)
// ---------------------------------------------------------------------------

/** Extract the first <tag>...</tag> content from an XML fragment (self-closing tags return ''). */
export function extractTag(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return decodeXmlEntities(stripCdata(m[1])).trim();
}

/** Extract an attribute value from the first matching self-closing/opening tag, e.g. <g:image_link href="..."/>. */
export function extractAttr(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}\\b[^>]*\\b${attrName}=["']([^"']*)["']`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

/** Split an XML document into repeated top-level blocks (e.g. <item>...</item> or <entry>...</entry>). */
export function extractBlocks(xml, blockTag) {
  const re = new RegExp(`<${blockTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${blockTag}>`, 'gi');
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[0]);
    if (blocks.length >= MAX_PRODUCTS) break;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Feed type detection
// ---------------------------------------------------------------------------

export const FEED_TYPES = {
  GOOGLE_SHOPPING: 'google-shopping',
  SHOPIFY: 'shopify',
  WOOCOMMERCE: 'woocommerce',
  GENERIC_XML: 'generic-xml',
};

export function detectFeedType(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  if (text[0] === '{' || text[0] === '[') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (Array.isArray(parsed)) return FEED_TYPES.WOOCOMMERCE;
    if (parsed && Array.isArray(parsed.products)) return FEED_TYPES.SHOPIFY;
    return null;
  }

  if (text[0] === '<') {
    if (/xmlns:g=|<g:/i.test(text)) return FEED_TYPES.GOOGLE_SHOPPING;
    return FEED_TYPES.GENERIC_XML;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Format-specific parsers: raw text/JSON -> array of raw (un-normalised) items
// ---------------------------------------------------------------------------

export function parseGoogleShoppingXml(xml) {
  const items = extractBlocks(xml, 'item');
  return items.map((block) => ({
    id: extractTag(block, 'g:id') || extractTag(block, 'id') || extractTag(block, 'guid'),
    title: extractTag(block, 'g:title') || extractTag(block, 'title'),
    description: extractTag(block, 'g:description') || extractTag(block, 'description'),
    price: extractTag(block, 'g:price'),
    link: extractTag(block, 'g:link') || extractTag(block, 'link'),
    image: extractTag(block, 'g:image_link') || extractTag(block, 'image'),
    availability: extractTag(block, 'g:availability'),
    category: extractTag(block, 'g:product_type') || extractTag(block, 'g:google_product_category'),
  }));
}

export function parseGenericXml(xml) {
  const items = extractBlocks(xml, 'item');
  return items.map((block) => ({
    id: extractTag(block, 'id'),
    title: extractTag(block, 'name') || extractTag(block, 'title'),
    description: extractTag(block, 'description'),
    price: extractTag(block, 'price'),
    link: extractTag(block, 'url') || extractTag(block, 'link'),
    image: extractTag(block, 'image'),
    availability: extractTag(block, 'availability'),
    category: extractTag(block, 'category'),
  }));
}

function absoluteUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch (e) {
    return maybeRelative;
  }
}

export function parseShopifyJson(jsonText, feedUrl) {
  const parsed = JSON.parse(jsonText);
  const products = Array.isArray(parsed.products) ? parsed.products : [];
  return products.slice(0, MAX_PRODUCTS).map((p) => {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const firstVariant = variants[0] || {};
    const inStock = variants.some((v) => v.available === true) || (variants.length === 0 && false);
    const image = (Array.isArray(p.images) && p.images[0] && p.images[0].src) || (p.image && p.image.src) || '';
    const url = p.handle ? absoluteUrl(`/products/${p.handle}`, feedUrl) : '';
    return {
      id: p.id != null ? String(p.id) : '',
      title: p.title || '',
      description: p.body_html || '',
      price: firstVariant.price != null ? String(firstVariant.price) : '',
      link: url,
      image,
      availability: inStock ? 'in_stock' : 'out_of_stock',
      category: p.product_type || (Array.isArray(p.tags) ? p.tags[0] : (typeof p.tags === 'string' ? p.tags.split(',')[0] : '')) || '',
    };
  });
}

export function parseWooCommerceJson(jsonText, feedUrl) {
  const parsed = JSON.parse(jsonText);
  const products = Array.isArray(parsed) ? parsed : [];
  return products.slice(0, MAX_PRODUCTS).map((p) => {
    let price = '';
    let currency = '';
    if (p.prices && typeof p.prices === 'object') {
      // WooCommerce Store API (public, no auth): minor-unit integer string + currency_minor_unit.
      const minorUnit = Number.isFinite(p.prices.currency_minor_unit) ? p.prices.currency_minor_unit : 2;
      const raw = p.prices.price != null ? p.prices.price : p.prices.regular_price;
      if (raw != null && raw !== '') {
        const asNumber = Number(raw) / Math.pow(10, minorUnit);
        price = Number.isFinite(asNumber) ? String(asNumber) : '';
      }
      currency = p.prices.currency_code || '';
    } else {
      // WooCommerce REST API v2/v3 (store-wide currency, plain decimal string).
      price = p.price != null && p.price !== '' ? String(p.price) : (p.regular_price != null ? String(p.regular_price) : '');
    }
    const image = (Array.isArray(p.images) && p.images[0] && p.images[0].src) || '';
    const category = (Array.isArray(p.categories) && p.categories[0] && p.categories[0].name) || '';
    const description = p.short_description || p.description || '';
    const inStock = p.stock_status ? p.stock_status === 'instock' : (p.is_in_stock !== undefined ? !!p.is_in_stock : true);
    return {
      id: p.id != null ? String(p.id) : '',
      title: p.name || '',
      description,
      price,
      currency,
      link: p.permalink || absoluteUrl(p.slug ? `/product/${p.slug}` : '', feedUrl),
      image,
      availability: inStock ? 'in_stock' : 'out_of_stock',
      category,
    };
  });
}

// ---------------------------------------------------------------------------
// Normalisation: raw item (any format) -> {id, title, description, price,
// currency, url, image, availability, category}
// ---------------------------------------------------------------------------

const AVAILABILITY_IN_STOCK = new Set(['in stock', 'in_stock', 'instock', 'available']);

export function normaliseAvailability(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'unknown';
  return AVAILABILITY_IN_STOCK.has(v) ? 'in_stock' : 'out_of_stock';
}

export function normaliseProduct(raw, { defaultCurrency = 'EUR', descriptionMaxLen = 600 } = {}) {
  const title = String(raw.title || '').trim();
  const id = String(raw.id || '').trim() || title;
  const description = truncate(stripHtml(raw.description || ''), descriptionMaxLen);
  const priceNumber = parseFloat(String(raw.price || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
  return {
    id,
    title,
    description,
    price: Number.isFinite(priceNumber) ? priceNumber : null,
    currency: (raw.currency || defaultCurrency || 'EUR').trim(),
    url: String(raw.link || '').trim(),
    image: String(raw.image || '').trim(),
    availability: normaliseAvailability(raw.availability),
    category: String(raw.category || '').trim(),
  };
}

/**
 * Parse a feed's raw response text/body into normalised products.
 * `feedUrl` is used to resolve relative product URLs (e.g. Shopify handles).
 */
export function parseFeed(rawText, feedUrl, options = {}) {
  const type = detectFeedType(rawText);
  if (!type) {
    throw new Error('unrecognised_feed_format');
  }
  let rawItems;
  if (type === FEED_TYPES.GOOGLE_SHOPPING) rawItems = parseGoogleShoppingXml(rawText);
  else if (type === FEED_TYPES.GENERIC_XML) rawItems = parseGenericXml(rawText);
  else if (type === FEED_TYPES.SHOPIFY) rawItems = parseShopifyJson(rawText, feedUrl);
  else if (type === FEED_TYPES.WOOCOMMERCE) rawItems = parseWooCommerceJson(rawText, feedUrl);
  else rawItems = [];

  const truncated = rawItems.length >= MAX_PRODUCTS;
  const products = rawItems
    .slice(0, MAX_PRODUCTS)
    .map((raw) => normaliseProduct(raw, options))
    .filter((p) => p.title && p.id);

  return { type, products, truncated };
}

const FEED_FETCH_HEADERS = { 'user-agent': 'ARLingAsistentBot/1.0 (+https://arling.sk/asistent/)' };

// ---------------------------------------------------------------------------
// Pagination for feed formats that page their JSON instead of returning the
// whole catalogue in one response.
//
// Shopify's public /products.json defaults to 30 products per page, so a
// single unpaginated fetch silently truncates any shop with more than 30
// products. WooCommerce's public Store API (/wp-json/wc/store/v1/products)
// defaults to 10 per page. Both are paged with page=1,2,... until a page
// comes back short (fewer items than the requested page size) or the
// MAX_PRODUCTS cap is reached; a non-200 response stops the loop instead of
// failing outright, so a transient error on a later page still returns
// whatever was already fetched. maxPages below is a hard safety valve so a
// misbehaving server that always returns a full page can never loop forever.
// ---------------------------------------------------------------------------

export const SHOPIFY_PRODUCTS_JSON_PAGE_SIZE = 250;
export const WOOCOMMERCE_STORE_API_PAGE_SIZE = 100;

/** True when the feed URL's path is Shopify's public /products.json endpoint, regardless of query string. */
export function isShopifyProductsJsonUrl(feedUrl) {
  try {
    return /\/products\.json$/i.test(new URL(feedUrl).pathname);
  } catch (e) {
    return false;
  }
}

/** True when the feed URL's path is WooCommerce's public Store API products list. */
export function isWooCommerceStoreApiUrl(feedUrl) {
  try {
    return /\/wp-json\/wc\/store\/v1\/products\/?$/i.test(new URL(feedUrl).pathname);
  } catch (e) {
    return false;
  }
}

/**
 * Fetches page=1,2,... of a paged JSON list endpoint, keeping any query
 * params already on `feedUrl` and only setting/overriding the page-size
 * param and `page`. Stops when a page returns fewer than `pageSize` items,
 * MAX_PRODUCTS is reached, a non-first page is not ok, or `maxPages` is hit.
 * Throws (like a plain single-page fetch would) if the first page fails.
 */
async function fetchPaginatedJsonList(feedUrl, fetchImpl, { sizeParam, pageSize, extractItems }) {
  const items = [];
  const maxPages = Math.ceil(MAX_PRODUCTS / pageSize) + 1; // safety valve: never loop forever
  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = new URL(feedUrl);
    pageUrl.searchParams.set(sizeParam, String(pageSize));
    pageUrl.searchParams.set('page', String(page));

    const res = await fetchImpl(pageUrl.toString(), { headers: FEED_FETCH_HEADERS });
    if (!res.ok) {
      if (page === 1) throw new Error(`feed_fetch_failed_${res.status}`);
      break; // stop on non-200: keep whatever was already fetched
    }

    let pageItems;
    try {
      pageItems = extractItems(JSON.parse(await res.text()));
    } catch (e) {
      if (page === 1) throw e;
      break;
    }

    items.push(...pageItems);
    if (pageItems.length < pageSize) break; // short page: this was the last one
    if (items.length >= MAX_PRODUCTS) break; // cap reached
  }
  return items;
}

function fetchShopifyProductsPaginated(feedUrl, fetchImpl) {
  return fetchPaginatedJsonList(feedUrl, fetchImpl, {
    sizeParam: 'limit',
    pageSize: SHOPIFY_PRODUCTS_JSON_PAGE_SIZE,
    extractItems: (parsed) => (parsed && Array.isArray(parsed.products) ? parsed.products : []),
  });
}

function fetchWooCommerceStoreApiPaginated(feedUrl, fetchImpl) {
  return fetchPaginatedJsonList(feedUrl, fetchImpl, {
    sizeParam: 'per_page',
    pageSize: WOOCOMMERCE_STORE_API_PAGE_SIZE,
    extractItems: (parsed) => (Array.isArray(parsed) ? parsed : []),
  });
}

/** Fetch a feed URL and parse it. `fetchImpl` is injectable for tests. */
export async function fetchFeed(feedUrl, { fetchImpl = fetch, ...options } = {}) {
  if (isShopifyProductsJsonUrl(feedUrl)) {
    const products = await fetchShopifyProductsPaginated(feedUrl, fetchImpl);
    return parseFeed(JSON.stringify({ products }), feedUrl, options);
  }
  if (isWooCommerceStoreApiUrl(feedUrl)) {
    const products = await fetchWooCommerceStoreApiPaginated(feedUrl, fetchImpl);
    return parseFeed(JSON.stringify(products), feedUrl, options);
  }

  const res = await fetchImpl(feedUrl, { headers: FEED_FETCH_HEADERS });
  if (!res.ok) {
    throw new Error(`feed_fetch_failed_${res.status}`);
  }
  const text = await res.text();
  return parseFeed(text, feedUrl, options);
}
