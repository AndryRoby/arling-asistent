/*
 * feed.js
 *
 * Downloads a shop's product feed and turns it into a flat, normalised
 * product list: {id, title, description, price, currency, url, image,
 * availability, category}.
 *
 * Supported formats, auto-detected from the response body:
 *   - Heureka / Zbozi.cz XML (root <SHOP>, one <SHOPITEM> per offer; the
 *     SK/CZ price-comparison format Shoptet and Upgates export, see the
 *     parseHeurekaXml section below for the spec references)
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

import { isPrivateHost, hostPatriDomene } from './tenants.js';
import { citajTelo } from './eshop-kontrola.js';

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

// ---------------------------------------------------------------------------
// Lineárny čas na každom vstupe (bezpečnostná kontrola 29. 9. 2026, druhé kolo)
//
// Feed posiela ktokoľvek a parsovanie beží synchrónne, takže ho časovač
// sťahovania nezastaví. Regulárne výrazy tvaru <tag>[\s\S]*?</tag> sú pri
// otváracích značkách bez zatváracej kvadratické: '<rss>' + '<item>'.repeat(n)
// trvalo pri 240 kB 6 s a pri 1 MB odhadom 100 s, čo v nočnom cron zhodilo
// celý beh (ostatné obchody sa neobnovili). Preto sa bloky, CDATA aj skripty v
// popise hľadajú cez indexOf a regulárne výrazy bez spätného prehľadávania
// obsahu: keď za prvou otváracou značkou chýba zatváracia, nemá ju ani žiadna
// ďalšia, takže hľadanie skončí namiesto skúšania každej ďalšej.
// ---------------------------------------------------------------------------

export function stripCdata(text) {
  if (!text) return '';
  const s = String(text);
  if (s.indexOf('<![CDATA[') < 0) return s;
  let out = '';
  let pos = 0;
  for (;;) {
    const od = s.indexOf('<![CDATA[', pos);
    if (od < 0) break;
    const po = s.indexOf(']]>', od + 9);
    if (po < 0) break; // nedokončená CDATA ostáva ako text, rovnako ako predtým
    out += s.slice(pos, od) + s.slice(od + 9, po);
    pos = po + 3;
  }
  return out + s.slice(pos);
}

/** <script>…</script> a <style>…</style> nahradí medzerou, lineárne (pozri úvod sekcie). */
function odstranSkriptyAStyly(s) {
  const otvor = /<(script|style)/gi;
  const bezZatvorenia = { script: false, style: false };
  let out = '';
  let pos = 0;
  let hladaj = 0;
  for (;;) {
    otvor.lastIndex = hladaj;
    const m = otvor.exec(s);
    if (!m) break;
    const meno = m[1].toLowerCase();
    hladaj = m.index + 1;
    if (bezZatvorenia[meno]) continue;
    const gt = s.indexOf('>', m.index + m[0].length);
    if (gt < 0) break; // za touto ani žiadnou ďalšou otváracou značkou už nie je '>'
    const zatvor = new RegExp(`</${meno}>`, 'gi');
    zatvor.lastIndex = gt + 1;
    const z = zatvor.exec(s);
    if (!z) {
      bezZatvorenia[meno] = true;
      if (bezZatvorenia.script && bezZatvorenia.style) break;
      continue;
    }
    out += s.slice(pos, m.index) + ' ';
    pos = z.index + z[0].length;
    hladaj = pos;
  }
  return out + s.slice(pos);
}

/** Strip HTML tags from a description and collapse whitespace to plain text. */
export function stripHtml(text) {
  if (!text) return '';
  const bezSkriptov = odstranSkriptyAStyly(String(text));
  // Značka <…> sa dá dokončiť len po posledný '>'. Za ním ostáva text bez
  // zmeny (tak ako predtým), len ho regulárny výraz neprechádza pre každé
  // osamelé '<' znova až do konca.
  const posledny = bezSkriptov.lastIndexOf('>');
  const hlava = posledny >= 0 ? bezSkriptov.slice(0, posledny + 1) : '';
  const chvost = posledny >= 0 ? bezSkriptov.slice(posledny + 1) : bezSkriptov;
  const withoutTags = hlava
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ') + chvost;
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
// XML tag extraction (namespace-tolerant, linear time, see stripCdata above)
// ---------------------------------------------------------------------------

const vzoryZnaciek = new Map();

/** Otváracia značka <tag …> (za menom medzera alebo '>') a zatváracia </tag>, bez ohľadu na veľkosť písmen. */
function vzoryZnacky(tagName) {
  const kluc = String(tagName);
  let vzory = vzoryZnaciek.get(kluc);
  if (!vzory) {
    const t = kluc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    vzory = { otvor: new RegExp(`<${t}(?=[\\s>])`, 'gi'), zatvor: new RegExp(`</${t}>`, 'gi') };
    vzoryZnaciek.set(kluc, vzory);
  }
  return vzory;
}

/**
 * Prvý celý blok <tag …>…</tag> od pozície `od`: {zaciatok, obsahOd, obsahDo,
 * koniec}, alebo null. To isté, čo predtým regulárny výraz
 * <tag(?:\s[^>]*)?>([\s\S]*?)</tag>, ale lineárne: keď za prvou otváracou
 * značkou nie je zatváracia, nie je ani za žiadnou ďalšou, takže sa končí.
 */
function najdiBlok(text, vzory, od = 0) {
  vzory.otvor.lastIndex = od;
  const o = vzory.otvor.exec(text);
  if (!o) return null;
  const koniecOtvorenia = text.indexOf('>', o.index + o[0].length);
  if (koniecOtvorenia < 0) return null;
  vzory.zatvor.lastIndex = koniecOtvorenia + 1;
  const z = vzory.zatvor.exec(text);
  if (!z) return null;
  return { zaciatok: o.index, obsahOd: koniecOtvorenia + 1, obsahDo: z.index, koniec: z.index + z[0].length };
}

/** Extract the first <tag>...</tag> content from an XML fragment (self-closing tags return ''). */
export function extractTag(xml, tagName) {
  const text = String(xml || '');
  const b = najdiBlok(text, vzoryZnacky(tagName), 0);
  if (!b) return '';
  return decodeXmlEntities(stripCdata(text.slice(b.obsahOd, b.obsahDo))).trim();
}

/** Extract an attribute value from the first matching self-closing/opening tag, e.g. <g:image_link href="..."/>. */
export function extractAttr(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}\\b[^>]*\\b${attrName}=["']([^"']*)["']`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

/**
 * Split an XML document into repeated top-level blocks (e.g. <item>...</item>
 * or <entry>...</entry>), at most `max`. Lineárne cez najdiBlok: každý znak sa
 * prejde najviac raz, aj keď otváracie značky nemajú zatváracie.
 */
export function extractBlocks(xml, blockTag, max = MAX_PRODUCTS) {
  const text = String(xml || '');
  const vzory = vzoryZnacky(blockTag);
  const blocks = [];
  let pos = 0;
  while (blocks.length < max) {
    const b = najdiBlok(text, vzory, pos);
    if (!b) break;
    blocks.push(text.slice(b.zaciatok, b.koniec));
    pos = b.koniec;
  }
  return blocks;
}

/** Decoded inner text of every <tag>...</tag> in a fragment, in document order (e.g. repeated <VAL> or <IMGURL_ALTERNATIVE>). */
export function extractTags(xml, tagName) {
  return extractBlocks(xml, tagName).map((block) => extractTag(block, tagName));
}

// ---------------------------------------------------------------------------
// Feed type detection
// ---------------------------------------------------------------------------

export const FEED_TYPES = {
  HEUREKA: 'heureka',
  GOOGLE_SHOPPING: 'google-shopping',
  SHOPIFY: 'shopify',
  WOOCOMMERCE: 'woocommerce',
  GENERIC_XML: 'generic-xml',
};

/**
 * Root <SHOP> followed by at least one <SHOPITEM>: Heureka.sk/.cz and Zbozi.cz
 * share these element names. To isté ako predtým výraz
 * /<SHOP(?:\s[^>]*)?>[\s\S]*?<SHOPITEM(?:\s[^>]*)?>/i, ale lineárne: stačí
 * prvé <SHOP …>; keď za ním <SHOPITEM> nie je, nie je ani za ďalším.
 */
function jeHeurekaTvar(text) {
  const shop = /<SHOP(?=[\s>])/gi;
  const m = shop.exec(text);
  if (!m) return false;
  const gt = text.indexOf('>', m.index + m[0].length);
  if (gt < 0) return false;
  const polozka = /<SHOPITEM(?=[\s>])/gi;
  polozka.lastIndex = gt + 1;
  const p = polozka.exec(text);
  return !!p && text.indexOf('>', p.index + p[0].length) >= 0;
}

// ---------------------------------------------------------------------------
// Strop JSON (bezpečnostná kontrola 29. 9. 2026, druhé kolo): JSON.parse 20 MB
// tela tvaru [{},{},…] zabral v meraní 468 MB haldy, izolát má 128 MB. Jedna
// JSON odpoveď (aj jedna strana stránkovania) má preto najviac
// MAX_JSON_NA_STRANU bajtov a MAX_JSON_OBJEKTOV znakov '{' a '[' (horná hranica
// objektov a polí po parsovaní; tie v reťazcoch sa rátajú tiež, teda radšej
// viac). Parsuje sa raz: rozpoznajFeed vráti typ aj hotový objekt.
// Skutočné strany sú ďaleko pod stropom: WooCommerce Store API 100 produktov
// asi 0,3 až 1 MB, Shopify 250 produktov bežne 1 až 2 MB.
// ---------------------------------------------------------------------------

export const MAX_JSON_NA_STRANU = 4 * 1024 * 1024;
export const MAX_JSON_OBJEKTOV = 300000;

/** Počet znakov '{' a '[' v texte; skončí hneď, keď prekročí `strop`. */
export function pocetJsonObjektov(text, strop = Infinity) {
  const s = String(text || '');
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 123 || c === 91) {
      n += 1;
      if (n > strop) return n;
    }
  }
  return n;
}

/** JSON.parse so stropom znakov a objektov; nad stropom chyba FEED_CHYBY.PRILIS_VELKY (kód feed_too_large). */
export function parsujJsonSoStropom(text, { maxZnakov = MAX_JSON_NA_STRANU, maxObjektov = MAX_JSON_OBJEKTOV } = {}) {
  const s = String(text || '');
  if (s.length > maxZnakov || pocetJsonObjektov(s, maxObjektov) > maxObjektov) throw new Error(FEED_CHYBY.PRILIS_VELKY);
  return JSON.parse(s);
}

/**
 * Typ feedu a pri JSON aj rozparsovaný objekt: {type, json} alebo null.
 * JSON nad stropom vyhodí FEED_CHYBY.PRILIS_VELKY (nie null), aby majiteľ
 * dostal kód feed_too_large a nie „nečitateľný feed“.
 */
export function rozpoznajFeed(rawText, strop = {}) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  if (text[0] === '{' || text[0] === '[') {
    let json;
    try {
      json = parsujJsonSoStropom(text, strop);
    } catch (e) {
      if (e && e.message === FEED_CHYBY.PRILIS_VELKY) throw e;
      return null;
    }
    if (Array.isArray(json)) return { type: FEED_TYPES.WOOCOMMERCE, json };
    if (json && Array.isArray(json.products)) return { type: FEED_TYPES.SHOPIFY, json };
    return null;
  }

  if (text[0] === '<') {
    if (jeHeurekaTvar(text)) return { type: FEED_TYPES.HEUREKA, json: null };
    if (/xmlns:g=|<g:/i.test(text)) return { type: FEED_TYPES.GOOGLE_SHOPPING, json: null };
    return { type: FEED_TYPES.GENERIC_XML, json: null };
  }

  return null;
}

/** Len typ feedu (reťazec z FEED_TYPES) alebo null; JSON nad stropom je tiež null. */
export function detectFeedType(rawText) {
  try {
    const r = rozpoznajFeed(rawText);
    return r ? r.type : null;
  } catch (e) {
    return null;
  }
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

// ---------------------------------------------------------------------------
// Heureka / Zbozi.cz XML (the SK/CZ price-comparison feed format)
//
// Element names verified against the public specifications on 2026-09-05:
//   - Heureka.sk "Feed 2.0": https://sluzby.heureka.sk/napoveda/xml-feed/
//   - Heureka.cz "Specifikace XML souboru": https://sluzby.heureka.cz/napoveda/xml-feed/
//   - Zbozi.cz (same SHOP/SHOPITEM element names, root xmlns
//     http://www.zbozi.cz/ns/offer/1.0):
//     https://napoveda.sklik.cz/en/shopping-ads/xml-feed-shopping/specifications/
//
// Root <SHOP>, one <SHOPITEM> per offer with: ITEM_ID (required, max 36
// chars), PRODUCTNAME (required; PRODUCT is PRODUCTNAME plus distribution
// info such as "osobny odber"), DESCRIPTION, URL (required), IMGURL,
// IMGURL_ALTERNATIVE (repeatable), PRICE_VAT (required, final price incl.
// VAT, written as "25000", "25000,50" or "25000.50"; EUR on Heureka.sk, CZK on
// Heureka.cz and Zbozi.cz; the spec defines no CURRENCY element but some
// exports add one, which is honoured when present), CATEGORYTEXT (full path,
// pipe separated: "Dom a zahrada | Kuchyna | Kavovary"), MANUFACTURER, EAN
// (EAN-13), ITEMGROUP_ID (joins the variants of one product), DELIVERY_DATE
// (0 = in stock, N = ships in N days, YYYY-MM-DD = pre-order date, empty =
// "info in store"; Zbozi.cz also uses -1 = unknown) and repeatable PARAM
// blocks holding PARAM_NAME and VAL. Everything except ITEM_ID, PRODUCTNAME,
// URL and PRICE_VAT is optional in practice, so every field is tolerated
// missing.
//
// Shops that export this format out of the box (help pages read 2026-09-05):
//   - Shoptet: system feeds "pre porovnavace Heureka, Zbozi.cz, Google Nakupy,
//     Glami a Arukereso", admin "Prepojenie -> XML feedy":
//     https://podpora.shoptet.sk/xml-feedy/
//   - Upgates: Heureka feed generated automatically 4x a day, admin
//     "Doplnky / Heureka": https://www.upgates.cz/a/export-produktu-na-heureku
// ---------------------------------------------------------------------------

/** Upper bound on PARAM blocks folded into one description; normaliseProduct caps the text anyway. */
export const HEUREKA_MAX_PARAMS = 40;

function feedHostname(feedUrl) {
  try {
    return new URL(feedUrl).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * Currency of a Heureka/Zbozi feed: an explicit <CURRENCY> in the feed head
 * (before the first SHOPITEM) if the export adds one, else CZK for Zbozi.cz
 * feeds and for shops on a .cz domain, else '' so normaliseProduct applies
 * its default (EUR, which is what Heureka.sk prices are in).
 */
export function heurekaFeedCurrency(xml, feedUrl) {
  const text = String(xml || '');
  const firstItem = text.search(/<SHOPITEM[\s>]/i);
  const head = firstItem > 0 ? text.slice(0, firstItem) : '';
  const declared = extractTag(head, 'CURRENCY').toUpperCase();
  if (/^[A-Z]{3}$/.test(declared)) return declared;
  if (/zbozi\.cz\/ns\/offer/i.test(head)) return 'CZK';
  if (/\.cz$/.test(feedHostname(feedUrl))) return 'CZK';
  return '';
}

/**
 * DELIVERY_DATE -> raw availability. 0 is "skladom"; a positive number is the
 * number of days until dispatch (orderable, not on the shelf), kept as
 * "available_in_N_days" rather than collapsed to out_of_stock so the
 * assistant does not turn "do 3 dni" into "not available"; a date is a
 * pre-order; empty (or Zbozi's -1) is unknown.
 */
export function heurekaAvailability(deliveryDate) {
  const v = String(deliveryDate || '').trim();
  if (!v) return '';
  if (/^\d+$/.test(v)) {
    const days = parseInt(v, 10);
    return days === 0 ? 'in_stock' : `available_in_${days}_days`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `available_from_${v}`;
  return '';
}

function heurekaParamLines(block) {
  return extractBlocks(block, 'PARAM', HEUREKA_MAX_PARAMS)
    .map((param) => {
      const name = extractTag(param, 'PARAM_NAME');
      const value = extractTags(param, 'VAL').filter(Boolean).join(', ');
      return name && value ? `${name}: ${value}` : '';
    })
    .filter(Boolean);
}

export function parseHeurekaXml(xml, feedUrl) {
  const feedCurrency = heurekaFeedCurrency(xml, feedUrl);
  // Heureka feeds are Slovak or Czech by definition; CZK is the only signal we
  // have for the label language of the folded manufacturer line.
  const brandLabel = feedCurrency === 'CZK' ? 'Výrobce' : 'Výrobca';
  const items = extractBlocks(xml, 'SHOPITEM');
  return items.map((block) => {
    const title = extractTag(block, 'PRODUCTNAME') || extractTag(block, 'PRODUCT');
    const brand = extractTag(block, 'MANUFACTURER');
    const itemCurrency = extractTag(block, 'CURRENCY').toUpperCase();

    // Fold the manufacturer (when the name does not already carry it, the
    // spec says it should) and every PARAM into the description as
    // "Name: value" lines, so they reach the embedding and the prompt.
    const extraLines = [];
    if (brand && !title.toLowerCase().includes(brand.toLowerCase())) extraLines.push(`${brandLabel}: ${brand}`);
    extraLines.push(...heurekaParamLines(block));
    const description = [extractTag(block, 'DESCRIPTION'), extraLines.join('\n')].filter(Boolean).join('\n');

    const category = extractTag(block, 'CATEGORYTEXT')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' > ');

    return {
      id: extractTag(block, 'ITEM_ID'),
      title,
      description,
      price: extractTag(block, 'PRICE_VAT'),
      currency: /^[A-Z]{3}$/.test(itemCurrency) ? itemCurrency : feedCurrency,
      link: extractTag(block, 'URL'),
      image: extractTag(block, 'IMGURL') || extractTag(block, 'IMGURL_ALTERNATIVE'),
      availability: heurekaAvailability(extractTag(block, 'DELIVERY_DATE')),
      category,
      brand,
      gtin: extractTag(block, 'EAN'),
      group: extractTag(block, 'ITEMGROUP_ID'),
    };
  });
}

function absoluteUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch (e) {
    return maybeRelative;
  }
}

/** Text JSON alebo už rozparsovaný objekt (rozpoznajFeed, stránkovanie): JSON sa neparsuje druhýkrát. */
function jsonObjekt(jsonTextOrObject) {
  return typeof jsonTextOrObject === 'string' ? JSON.parse(jsonTextOrObject) : jsonTextOrObject;
}

export function parseShopifyJson(jsonText, feedUrl) {
  const parsed = jsonObjekt(jsonText);
  return mapShopifyProducts(parsed && Array.isArray(parsed.products) ? parsed.products : [], feedUrl);
}

/** Pole produktov z Shopify products.json -> surové položky (aj pre každú stranu stránkovania zvlášť). */
function mapShopifyProducts(products, feedUrl) {
  return products.filter((p) => p && typeof p === 'object').slice(0, MAX_PRODUCTS).map((p) => {
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
  const parsed = jsonObjekt(jsonText);
  return mapWooCommerceProducts(Array.isArray(parsed) ? parsed : [], feedUrl);
}

/** Pole produktov WooCommerce (Store API aj REST v2/v3) -> surové položky. */
function mapWooCommerceProducts(products, feedUrl) {
  return products.filter((p) => p && typeof p === 'object').slice(0, MAX_PRODUCTS).map((p) => {
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

/** Self-describing values produced by heurekaAvailability(): orderable with a lead time, kept verbatim for the prompt. */
const AVAILABILITY_LEAD_TIME = /^available_(?:in_\d+_days|from_\d{4}-\d{2}-\d{2})$/;

export function normaliseAvailability(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'unknown';
  if (AVAILABILITY_IN_STOCK.has(v)) return 'in_stock';
  if (AVAILABILITY_LEAD_TIME.test(v)) return v;
  return 'out_of_stock';
}

/** Optional raw fields carried through when a parser provides them (today only Heureka: MANUFACTURER, EAN, ITEMGROUP_ID). */
const OPTIONAL_PRODUCT_FIELDS = ['brand', 'gtin', 'group'];

/**
 * Najdlhší názov produktu (znaky). Bezpečnostná kontrola 29. 9. 2026: názov
 * nemal strop a embed.js ho opakuje v každom kuse textu, takže jeden feed s
 * obrovskými názvami minul viac rozpočtu obnovy, než sa pred vektormi
 * rezervovalo. So stropom 180 a popisom do 600 (plus „…“) je jeden produkt
 * najviac 180 + 1 + 2 + 601 = 784 znakov, teda jeden kus textu a nikdy viac
 * ako onboarding.js ODHAD_ZNAKOV_NA_PRODUKT (800).
 */
export const TITLE_MAX_LEN = 180;

export function normaliseProduct(raw, { defaultCurrency = 'EUR', descriptionMaxLen = 600 } = {}) {
  const celyTitul = String(raw.title || '').trim();
  const title = truncate(celyTitul, TITLE_MAX_LEN);
  // Id z celého názvu, nie orezaného: produkty bez id si nechajú ten istý vektor.
  const id = String(raw.id || '').trim() || celyTitul;
  const description = truncate(stripHtml(raw.description || ''), descriptionMaxLen);
  const priceNumber = parseFloat(String(raw.price || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
  const product = {
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
  for (const key of OPTIONAL_PRODUCT_FIELDS) {
    const value = String(raw[key] || '').trim();
    if (value) product[key] = value;
  }
  return product;
}

/**
 * Parse a feed's raw response text/body into normalised products.
 * `feedUrl` is used to resolve relative product URLs (e.g. Shopify handles).
 */
export function parseFeed(rawText, feedUrl, options = {}) {
  return parsujRozpoznany(rozpoznajFeed(rawText), rawText, feedUrl, options);
}

/** Výsledok rozpoznajFeed -> {type, products, truncated}. JSON sa parsuje raz, parsery dostanú hotový objekt. */
function parsujRozpoznany(rozpoznane, rawText, feedUrl, options = {}) {
  if (!rozpoznane) {
    throw new Error('unrecognised_feed_format');
  }
  const { type, json } = rozpoznane;
  let rawItems;
  if (type === FEED_TYPES.HEUREKA) rawItems = parseHeurekaXml(rawText, feedUrl);
  else if (type === FEED_TYPES.GOOGLE_SHOPPING) rawItems = parseGoogleShoppingXml(rawText);
  else if (type === FEED_TYPES.GENERIC_XML) rawItems = parseGenericXml(rawText);
  else if (type === FEED_TYPES.SHOPIFY) rawItems = parseShopifyJson(json, feedUrl);
  else if (type === FEED_TYPES.WOOCOMMERCE) rawItems = parseWooCommerceJson(json, feedUrl);
  else rawItems = [];
  return hotovyFeed(type, rawItems, options);
}

/**
 * Surové položky -> {type, products, truncated}. `orezane` = sťahovanie
 * skončilo na strope bajtov alebo času (XML po posledný celý záznam, alebo
 * stránkovanie bez posledných strán): katalóg je neúplný, aj keď má menej
 * ako MAX_PRODUCTS produktov.
 */
function hotovyFeed(type, rawItems, options = {}, { orezane = false } = {}) {
  const truncated = orezane || rawItems.length >= MAX_PRODUCTS;
  const products = rawItems
    .slice(0, MAX_PRODUCTS)
    .map((raw) => normaliseProduct(raw, options))
    .filter((p) => p.title && p.id);

  return { type, products, truncated };
}

const FEED_FETCH_HEADERS = { 'user-agent': 'ARLingAsistentBot/1.0 (+https://arling.sk/asistent/)' };

// ---------------------------------------------------------------------------
// SSRF pri sťahovaní feedu
//
// feed_url zadáva ktokoľvek z internetu. validateTenantInput (tenants.js) ju
// pri zakladaní nájomcu prekontroluje, lenže kontrola adresy pred stiahnutím
// nestačí: verejná adresa smie odpovedať presmerovaním na http://127.0.0.1/
// alebo na 169.254.169.254 a `fetch` ho ticho nasleduje. Preto sa tu
// presmerovania nesledujú automaticky (`redirect: 'manual'`), ale ručne, a
// KAŽDÝ skok prejde tou istou kontrolou ako pôvodná adresa.
//
// Počet skokov je zámerne malý: skutočné feedy presmerúvajú nanajvýš raz či
// dvakrát (http -> https, doména -> www).
// ---------------------------------------------------------------------------

export const MAX_FEED_REDIRECTS = 3;

/** Adresa feedu, ktorú worker odmietol stiahnuť. Vyhodená pred akýmkoľvek volaním siete. */
export class FeedUrlNotAllowedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'FeedUrlNotAllowedError';
    this.reason = reason;
  }
}

/** Vráti URL objekt, alebo vyhodí FeedUrlNotAllowedError: len http(s) a len verejný hostiteľ. */
export function assertFetchableUrl(rawUrl, { base } = {}) {
  let u;
  try {
    u = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch (e) {
    throw new FeedUrlNotAllowedError('feed_url_invalid');
  }
  if (!/^https?:$/.test(u.protocol)) throw new FeedUrlNotAllowedError('feed_url_scheme');
  if (isPrivateHost(u.hostname)) throw new FeedUrlNotAllowedError('feed_url_private_host');
  return u;
}

/** Hlavička Location z odpovede, ak ju odpoveď vôbec má (testovacie dvojníky hlavičky nemajú). */
function locationHeader(res) {
  const headers = res && res.headers;
  if (!headers || typeof headers.get !== 'function') return '';
  return headers.get('location') || headers.get('Location') || '';
}

// ---------------------------------------------------------------------------
// Strop veľkosti a času pri sťahovaní feedu (bezpečnostná kontrola 29. 9. 2026)
//
// Do vtedy sa telo čítalo cez `await res.text()` celé, bez stropu bajtov aj
// bez časového limitu. Adresu feedu zadáva ktokoľvek (POST /v1/tenants), takže
// odpoveď so stovkami MB (alebo malý gzip, ktorý fetch sám rozbalí) minula
// pamäť izolátu a pomalá odpoveď držala spojenie; v nočnom cron to zastavilo
// obnovu všetkých obchodov po útočníkovom. MAX_PRODUCTS obmedzoval až
// rozparsované produkty, nie surové bajty. Teraz:
//   - telo sa číta po kusoch najviac do MAX_FEED_BAJTOV (rozbalené bajty, vzor
//     citajTelo v eshop-kontrola.js). XML nad stropom sa spracuje po posledný
//     celý záznam a výsledok má truncated: true (druhé kolo kontroly: Heureka
//     XML s tisíckami produktov má 15 až 30 MB a predtým dal aspoň prvých
//     5 000, nie chybu). JSON nad stropom a XML bez jediného celého záznamu
//     skončia chybou FEED_CHYBY.PRILIS_VELKY, onboarding.js ju hlási ako
//     feed_too_large,
//   - každá požiadavka (všetky skoky presmerovaní aj čítanie tela) má časový
//     limit CAS_NA_FEED_MS cez AbortController a celý feed vrátane strán
//     stránkovania CAS_FEED_SPOLU_MS; po ňom chyba FEED_CHYBY.CAS,
//   - pri stránkovaní platí strop bajtov pre súčet všetkých strán a každá
//     strana má najviac MAX_JSON_NA_STRANU; stránkovanie ukončené stropom
//     vráti truncated: true,
//   - s voľbou `domena` musí byť každý skok (aj prvá adresa) na doméne obchodu
//     alebo jej subdoméne (tenants.js hostPatriDomene), inak chyba
//     FeedUrlNotAllowedError('feed_other_domain').
// ---------------------------------------------------------------------------

export const MAX_FEED_BAJTOV = 20 * 1024 * 1024;
export const CAS_NA_FEED_MS = 20 * 1000;
export const CAS_FEED_SPOLU_MS = 60 * 1000;

/** Chyby sťahovania; onboarding.js classifyFeedError ich prekladá na stabilné kódy. */
export const FEED_CHYBY = {
  PRILIS_VELKY: 'feed_too_large', // -> feed_too_large
  CAS: 'feed_timeout', // -> feed_unreachable
};

/** Dôvod FeedUrlNotAllowedError, keď adresa alebo skok presmerovania nie je na doméne obchodu. */
export const FEED_INA_DOMENA = 'feed_other_domain';

/** Prísľub, ktorý sa pri prerušení `signal` hneď zamietne chybou FEED_CHYBY.CAS (aj keď fetchImpl signal ignoruje). */
function sCasom(prisluba, signal) {
  if (!signal) return prisluba;
  if (signal.aborted) return Promise.reject(new Error(FEED_CHYBY.CAS));
  return new Promise((resolve, reject) => {
    const priPreruseni = () => reject(new Error(FEED_CHYBY.CAS));
    signal.addEventListener('abort', priPreruseni, { once: true });
    Promise.resolve(prisluba).then(
      (hodnota) => { signal.removeEventListener('abort', priPreruseni); resolve(hodnota); },
      (chyba) => { signal.removeEventListener('abort', priPreruseni); reject(signal.aborted ? new Error(FEED_CHYBY.CAS) : chyba); }
    );
  });
}

/** Zahodí nečítané telo odpovede (presmerovanie, chybový stav), aby nedržalo spojenie. */
function zahodTelo(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
  } catch (e) {
    // nič: telo už mohlo byť zamknuté alebo prečítané
  }
}

/** Adresa (URL objekt) na doméne obchodu, alebo FeedUrlNotAllowedError(feed_other_domain). Bez `domena` sa nekontroluje. */
function naDomene(u, domena) {
  if (domena && !hostPatriDomene(u.hostname, domena)) throw new FeedUrlNotAllowedError(FEED_INA_DOMENA);
  return u;
}

/**
 * fetch s ručným sledovaním presmerovaní, kde každý skok prejde
 * assertFetchableUrl. Odpoveď vracia rovnako ako obyčajný fetch, takže
 * volajúci sa nemení. `init.signal` (AbortController so časovým limitom zo
 * stiahniFeed) platí pre všetky skoky; po prerušení vyhodí FEED_CHYBY.CAS.
 * S `domena` musí byť prvá adresa aj každý skok na doméne obchodu alebo jej
 * subdoméne (druhé kolo bezpečnostnej kontroly 29. 9. 2026: otvorené
 * presmerovanie na webe obete inak viedlo na cudzí feed).
 */
export async function guardedFetch(rawUrl, fetchImpl, init = {}, { domena = null } = {}) {
  let current = naDomene(assertFetchableUrl(rawUrl), domena).toString();
  const signal = init && init.signal;
  for (let hop = 0; hop <= MAX_FEED_REDIRECTS; hop++) {
    const res = await sCasom(fetchImpl(current, { ...init, redirect: 'manual' }), signal);
    const status = res && res.status;
    const location = locationHeader(res);
    if (!(Number.isFinite(status) && status >= 300 && status < 400 && location)) return res;
    zahodTelo(res);
    current = naDomene(assertFetchableUrl(location, { base: current }), domena).toString();
  }
  throw new FeedUrlNotAllowedError('feed_too_many_redirects');
}

/** Zatváracie značky záznamov, po ktoré sa oreže XML nad stropom (Heureka, Google a všeobecné RSS, Atom). */
const KONCE_ZAZNAMOV = ['</SHOPITEM>', '</shopitem>', '</Shopitem>', '</item>', '</ITEM>', '</Item>', '</entry>', '</ENTRY>'];

/**
 * XML orezané na strope bajtov -> text po koniec posledného celého záznamu,
 * alebo null (nie je to XML, alebo v ňom nie je ani jeden celý záznam).
 * Parsery berú len celé bloky, takže nedokončený koreň nevadí.
 */
export function xmlPoPoslednyZaznam(text) {
  const s = String(text || '');
  if (!/^[\s﻿]*</.test(s.slice(0, 1024))) return null;
  let koniec = -1;
  for (const znacka of KONCE_ZAZNAMOV) {
    const i = s.lastIndexOf(znacka);
    if (i >= 0 && i + znacka.length > koniec) koniec = i + znacka.length;
  }
  return koniec > 0 ? s.slice(0, koniec) : null;
}

/**
 * Prečíta telo odpovede najviac do `limit` bajtov. Text je UTF-8 ako pri
 * res.text(). Nad stropom: s `orezatXml` XML po posledný celý záznam
 * (orezane: true), inak chyba FEED_CHYBY.PRILIS_VELKY.
 */
async function citajTeloFeedu(res, limit, signal, { orezatXml = false } = {}) {
  const { bajty, orezane } = await sCasom(citajTelo(res, Math.max(0, limit)), signal);
  const text = new TextDecoder('utf-8').decode(bajty);
  if (!orezane) return { text, bajtov: bajty.byteLength, orezane: false };
  const cast = orezatXml ? xmlPoPoslednyZaznam(text) : null;
  if (cast == null) throw new Error(FEED_CHYBY.PRILIS_VELKY);
  return { text: cast, bajtov: bajty.byteLength, orezane: true };
}

/**
 * Jedna požiadavka feedu so všetkým naraz: presmerovania cez guardedFetch
 * (s `domena` len na doméne obchodu), časový limit `casMs` na skoky aj čítanie
 * tela a strop `maxBajtov`. Vracia {res, text, bajtov, orezane}; pri stave
 * mimo 2xx je text null a telo sa zahodí nečítané.
 */
async function stiahniFeed(url, fetchImpl, { maxBajtov, casMs, orezatXml = false, domena = null }) {
  if (!(casMs > 0)) throw new Error(FEED_CHYBY.CAS);
  const ac = new AbortController();
  const casovac = setTimeout(() => ac.abort(), casMs);
  try {
    const res = await guardedFetch(url, fetchImpl, { headers: FEED_FETCH_HEADERS, signal: ac.signal }, { domena });
    if (!res.ok) {
      zahodTelo(res);
      return { res, text: null, bajtov: 0, orezane: false };
    }
    const { text, bajtov, orezane } = await citajTeloFeedu(res, maxBajtov, ac.signal, { orezatXml });
    return { res, text, bajtov, orezane };
  } finally {
    clearTimeout(casovac);
  }
}

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

/**
 * True when the feed URL is WooCommerce's public Store API products list.
 *
 * Tri tvary tej istej adresy, všetky tri posiela plugin 0.3.0+ cez
 * get_rest_url():
 *   - bežné pekné odkazy: /wp-json/wc/store/v1/products
 *   - vlastná predpona REST (filter rest_url_prefix): /api/wc/store/v1/products
 *   - „Jednoduché“ trvalé odkazy bez prepisovania adries:
 *     /?rest_route=/wc/store/v1/products
 * Do verzie 0.2.1 plugin skladal /wp-json/ natvrdo, takže obchod s
 * jednoduchými odkazmi dostal 404 a asistent sa nikdy nezapol. Rozpoznanie
 * tu rozhoduje o stránkovaní; bez neho by sa z obchodu načítala len prvá
 * stovka produktov.
 */
export function isWooCommerceStoreApiUrl(feedUrl) {
  try {
    const u = new URL(feedUrl);
    if (/\/wc\/store\/v1\/products\/?$/i.test(u.pathname)) return true;
    const route = u.searchParams.get('rest_route');
    return !!route && /^\/wc\/store\/v1\/products\/?$/i.test(route);
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
 *
 * Strop bajtov `limity.maxBajtov` platí pre súčet všetkých strán, každá
 * strana má navyše najviac `limity.maxJsonBajtov` (MAX_JSON_NA_STRANU) a
 * MAX_JSON_OBJEKTOV, a čas `limity.casSpoluMs` platí pre celé stránkovanie
 * (každá strana najviac `limity.casMs`). Prvá strana nad stropom alebo po čase
 * vyhodí chybu ako každé iné zlyhanie prvej strany; neskoršia strana
 * stránkovanie len ukončí, ostane to, čo sa už stiahlo, a výsledok má
 * `orezane: true` (feed je neúplný).
 *
 * Každá strana sa hneď zmení na malé surové položky (`mapItems`) a jej
 * rozparsovaný JSON sa zahodí: v pamäti sa nedrží celý katalóg ako JSON a
 * nerobí sa JSON.stringify s druhým JSON.parse (predtým áno).
 */
async function fetchPaginatedJsonList(feedUrl, fetchImpl, { sizeParam, pageSize, extractItems, mapItems }, limity) {
  const items = [];
  const maxPages = Math.ceil(MAX_PRODUCTS / pageSize) + 1; // safety valve: never loop forever
  const koniec = limity.now() + limity.casSpoluMs;
  let bajtovSpolu = 0;
  let orezane = false;
  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = new URL(feedUrl);
    pageUrl.searchParams.set(sizeParam, String(pageSize));
    pageUrl.searchParams.set('page', String(page));

    let stiahnute;
    try {
      stiahnute = await stiahniFeed(pageUrl.toString(), fetchImpl, {
        maxBajtov: Math.min(limity.maxJsonBajtov, limity.maxBajtov - bajtovSpolu),
        casMs: Math.min(limity.casMs, koniec - limity.now()),
        domena: limity.domena,
      });
    } catch (e) {
      const limit = e && (e.message === FEED_CHYBY.PRILIS_VELKY || e.message === FEED_CHYBY.CAS);
      if (page === 1 || !limit) throw e;
      orezane = true;
      break; // strop bajtov alebo času na neskoršej strane: nechať, čo už je stiahnuté
    }
    const { res, text, bajtov } = stiahnute;
    if (!res.ok) {
      if (page === 1) throw new Error(`feed_fetch_failed_${res.status}`);
      break; // stop on non-200: keep whatever was already fetched
    }
    bajtovSpolu += bajtov;

    let pageItems;
    try {
      pageItems = extractItems(parsujJsonSoStropom(text, { maxZnakov: limity.maxJsonBajtov }));
    } catch (e) {
      if (page === 1) throw e;
      if (e && e.message === FEED_CHYBY.PRILIS_VELKY) orezane = true;
      break;
    }

    items.push(...mapItems(pageItems.slice(0, Math.max(0, MAX_PRODUCTS - items.length)), feedUrl));
    if (pageItems.length < pageSize) break; // short page: this was the last one
    if (items.length >= MAX_PRODUCTS) break; // cap reached
  }
  return { items, orezane };
}

function fetchShopifyProductsPaginated(feedUrl, fetchImpl, limity) {
  return fetchPaginatedJsonList(feedUrl, fetchImpl, {
    sizeParam: 'limit',
    pageSize: SHOPIFY_PRODUCTS_JSON_PAGE_SIZE,
    extractItems: (parsed) => (parsed && Array.isArray(parsed.products) ? parsed.products : []),
    mapItems: mapShopifyProducts,
  }, limity);
}

function fetchWooCommerceStoreApiPaginated(feedUrl, fetchImpl, limity) {
  return fetchPaginatedJsonList(feedUrl, fetchImpl, {
    sizeParam: 'per_page',
    pageSize: WOOCOMMERCE_STORE_API_PAGE_SIZE,
    extractItems: (parsed) => (Array.isArray(parsed) ? parsed : []),
    mapItems: mapWooCommerceProducts,
  }, limity);
}

/**
 * Fetch a feed URL and parse it. `fetchImpl` is injectable for tests, and so
 * are the limits (`maxBajtov`, `maxJsonBajtov`, `casMs`, `casSpoluMs`, `now`)
 * and `domena` (doména obchodu: prvá adresa aj každý skok presmerovania musí
 * byť na nej, onboarding.js ju posiela pre každý obchod okrem ukážok
 * oslovení a demo obchodu); everything else in the options goes to parseFeed
 * as before. Výsledok má `truncated: true` aj vtedy, keď sťahovanie skončilo
 * na strope bajtov alebo času a katalóg je preto neúplný.
 */
export async function fetchFeed(feedUrl, {
  fetchImpl = fetch,
  maxBajtov = MAX_FEED_BAJTOV,
  maxJsonBajtov = MAX_JSON_NA_STRANU,
  casMs = CAS_NA_FEED_MS,
  casSpoluMs = CAS_FEED_SPOLU_MS,
  now = Date.now,
  domena = null,
  ...options
} = {}) {
  const limity = { maxBajtov, maxJsonBajtov, casMs, casSpoluMs, now, domena };
  if (isShopifyProductsJsonUrl(feedUrl)) {
    const { items, orezane } = await fetchShopifyProductsPaginated(feedUrl, fetchImpl, limity);
    return hotovyFeed(FEED_TYPES.SHOPIFY, items, options, { orezane });
  }
  if (isWooCommerceStoreApiUrl(feedUrl)) {
    const { items, orezane } = await fetchWooCommerceStoreApiPaginated(feedUrl, fetchImpl, limity);
    return hotovyFeed(FEED_TYPES.WOOCOMMERCE, items, options, { orezane });
  }

  const { res, text, orezane } = await stiahniFeed(feedUrl, fetchImpl, { maxBajtov, casMs: Math.min(casMs, casSpoluMs), orezatXml: true, domena });
  if (!res.ok) {
    throw new Error(`feed_fetch_failed_${res.status}`);
  }
  // Jeden JSON (nie stránkovaný) má ten istý strop ako jedna strana.
  const vysledok = parsujRozpoznany(rozpoznajFeed(text, { maxZnakov: maxJsonBajtov }), text, feedUrl, options);
  if (orezane) vysledok.truncated = true;
  return vysledok;
}
