/*
 * eshop-kontrola.js
 *
 * POST /v1/eshop/kontrola  {"url": "https://obchod.sk"}
 *
 * Bezplatná kontrola e-shopu pre stránku https://arling.sk/kontrola-eshopu/
 * (bod 2, F-N15, v ops/strategia/2026-09-24/napady/top-10.md). Worker načíta
 * úvodnú stránku zadanej adresy a najviac 3 ďalšie stránky tej istej domény,
 * na ktoré úvodná stránka odkazuje (zásady ochrany osobných údajov,
 * odstúpenie od zmluvy, prípadne obchodné podmienky). Bez prehliadača a bez
 * AI: len HTML a pravidlá nižšie. Výsledok je sedem riadkov, každý so stavom
 * "ok" (v poriadku), "nalez" (nález) alebo "nevieme" (nevieme overiť) a so
 * zdrojom.
 *
 * Bezpečnosť (nesmie to byť otvorená proxy):
 *   - len http a https, len predvolené porty, bez mena a hesla v adrese;
 *   - len doménové mená s bodkou, žiadne IP literály, localhost, .local,
 *     .internal a ostatné súkromné mená (isPrivateHost z tenants.js);
 *   - pred každým stiahnutím (aj po každom presmerovaní) preklad cez DNS over
 *     HTTPS; ak doména vedie na súkromnú, loopback alebo link-local adresu
 *     (10.x, 127.x, 192.168.x, 169.254.x vrátane metadát), odmietne sa;
 *   - presmerovania sa sledujú ručne, najviac 4, každý skok znova cez tú istú
 *     kontrolu;
 *   - limit veľkosti (úvod 3 MB, ostatné 1,5 MB) a času (8 s na stránku,
 *     20 s spolu);
 *   - limit na IP (6 za minútu, 30 za hodinu), na cieľovú doménu (10 za hodinu,
 *     kľúčom je len odtlačok SHA-256, nie adresa) a denný strop pre všetkých;
 *   - odpoveď NIKDY nenesie surové HTML ani text stránky, len naše vety,
 *     adresy nájdených stránok a krátke popisy odkazov (najviac 80 znakov);
 *   - nič sa neukladá: adresa sa nikam nezapisuje ani neloguje.
 *
 * "Automatická kontrola verejnej stránky, nie právne poradenstvo."
 */

import { isPrivateHost, parseIpv4, isPrivateIpv4Number, isPrivateIpv6 } from './tenants.js';
import { checkRateLimit, corsHeaders, parseAllowedOrigins, SECURITY_HEADERS } from './security.js';

export const KONTROLA_USER_AGENT = 'Mozilla/5.0 (compatible; ARLingKontrolaEshopu/1.0; +https://arling.sk/kontrola-eshopu/)';
export const MAX_PRESMEROVANI = 4;
export const LIMIT_UVOD_BAJTOV = 3 * 1024 * 1024;
export const LIMIT_PODSTRANKA_BAJTOV = 1.5 * 1024 * 1024;
export const CAS_NA_STRANKU_MS = 8000;
export const CAS_SPOLU_MS = 20000;
export const MAX_TELO_POZIADAVKY = 2048;
export const MAX_DALSICH_STRANOK = 3;

/** Chyba, ktorú vidí návštevník: kód pre stránku a HTTP stav. */
export class KontrolaChyba extends Error {
  constructor(kod, status = 400) {
    super(kod);
    this.name = 'KontrolaChyba';
    this.kod = kod;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Zdroje (čítané 24. 9. 2026, pozri stránku /kontrola-eshopu/, časť Zdroje)
// ---------------------------------------------------------------------------

export const ZDROJE = {
  odstupenie: {
    nazov: '§ 20a zákona č. 108/2024 Z. z., účinnosť 19. 6. 2026 (výklad Hronček & Partners, 18. 6. 2026)',
    url: 'https://www.legalfirm.sk/sk/stranky/clanok/eshop-online-formular-odstupenie-od-zmluvy-povinnost',
  },
  rso: {
    nazov: 'Európska komisia: platforma RSO (ODR) ukončená 20. 7. 2025, nariadenie (EÚ) 2024/3228',
    url: 'https://consumer-redress.ec.europa.eu/site-relocation_en',
  },
  zasady: {
    nazov: 'Čl. 12 a 13 nariadenia (EÚ) 2016/679 (GDPR)',
    url: 'https://eur-lex.europa.eu/legal-content/SK/TXT/?uri=CELEX:32016R0679',
  },
  prijemcovia: {
    nazov: 'Čl. 13 ods. 1 písm. e) GDPR: príjemcovia osobných údajov',
    url: 'https://eur-lex.europa.eu/legal-content/SK/TXT/?uri=CELEX:32016R0679',
  },
  cookies: {
    nazov: '§ 109 ods. 8 zákona č. 452/2021 Z. z. a tlačová správa regulačného úradu (aktualizovaná 27. 8. 2025)',
    url: 'https://www.teleoff.gov.sk/urad/aktuality/tlacove-spravy/urad-monitoruje-subory-cookies-weboch-vacsina-webovych-stranok-slovensku-nadalej-nezakonne-spracuva-data-pouzivateloch.html',
  },
  identifikacia: {
    nazov: '§ 4 ods. 1 zákona č. 22/2004 Z. z. o elektronickom obchode',
    url: 'https://www.zakonypreludi.sk/zz/2004-22',
  },
  podmienky: {
    nazov: 'Zákon č. 108/2024 Z. z. o ochrane spotrebiteľa (informácie pred uzavretím zmluvy na diaľku)',
    url: 'https://www.slov-lex.sk/pravne-predpisy/SK/ZZ/2024/108/',
  },
};

// ---------------------------------------------------------------------------
// Služby, ktoré hľadáme na stránke. `gdpr` je id v katalógu NASTROJE
// (products/arling-sk/gdpr-dokumenty/dokumenty-sk.js); služby mimo katalógu
// idú do poľa "Iné" ako `ine`.
// `kod` hľadá v HTML (skripty, adresy), `text` vo viditeľnom texte (dopravca
// alebo platobná brána spomenutá v päte je tiež príjemca údajov).
// `vZasadach` hľadá názov v texte zásad (bez diakritiky, malé písmená).
// `sledovanie`: skript, ktorý potrebuje súhlas s cookies.
// ---------------------------------------------------------------------------

export const SLUZBY = [
  { id: 'ga4', nazov: 'Google Analytics', gdpr: 'ga4', sledovanie: true, cookies: 'analyticke',
    kod: /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com\/(?:analytics|ga|urchin)\.js|gtag\(\s*['"]config['"]\s*,\s*['"]G-|['"]UA-\d{4,10}-\d{1,3}['"]/i,
    vZasadach: /google analytics|\bgoogle\b/ },
  { id: 'gtm', nazov: 'Google Tag Manager', ine: 'Google Tag Manager (Google Ireland Limited)', sledovanie: true,
    kod: /googletagmanager\.com\/gtm\.js|['"(]GTM-[A-Z0-9]{4,10}['")]/,
    vZasadach: /tag manager|\bgoogle\b/ },
  { id: 'gads', nazov: 'Google Ads', gdpr: 'gads', sledovanie: true, cookies: 'marketingove',
    kod: /googleadservices\.com|googleads\.g\.doubleclick\.net|gtag\(\s*['"]config['"]\s*,\s*['"]AW-|['"]AW-\d{6,12}/,
    vZasadach: /google ads|adwords|\bgoogle\b/ },
  { id: 'meta', nazov: 'Meta Pixel', gdpr: 'meta', sledovanie: true, cookies: 'marketingove',
    kod: /connect\.facebook\.net\/[^"'\s]*\/fbevents\.js|fbq\(\s*['"]init['"]|facebook\.com\/tr\?id=/,
    vZasadach: /\bmeta\b|facebook/ },
  { id: 'hotjar', nazov: 'Hotjar', ine: 'Hotjar (nahrávanie návštev a teplotné mapy)', sledovanie: true, cookies: 'analyticke',
    kod: /static\.hotjar\.com|script\.hotjar\.com|\bhjid\s*:/,
    vZasadach: /hotjar/ },
  { id: 'smartsupp', nazov: 'Smartsupp', ine: 'Smartsupp (chat na webe)',
    kod: /smartsuppchat\.com|smartsupp\.com|_smartsupp\b/,
    vZasadach: /smartsupp/ },
  { id: 'mailchimp', nazov: 'Mailchimp', gdpr: 'mailchimp', cinnost: 'newsletter',
    kod: /chimpstatic\.com|list-manage\.com/,
    vZasadach: /mailchimp|intuit/ },
  { id: 'ecomail', nazov: 'Ecomail', gdpr: 'ecomail', cinnost: 'newsletter',
    kod: /ecomail\.(?:cz|sk)|ecomailapp\./,
    vZasadach: /ecomail/ },
  { id: 'packeta', nazov: 'Packeta (Zásielkovňa)', gdpr: 'packeta',
    kod: /widget\.packeta\.com|packeta\.com\/v\d|zasilkovna\.cz\/api/,
    text: /\bpacket[ay]\b|zasielkovn|zasilkovn/,
    vZasadach: /packet[ay]|zasielkovn|zasilkovn/ },
  { id: 'gopay', nazov: 'GoPay', gdpr: 'gopay',
    kod: /gate\.gopay\.(?:cz|com)|gw\.sandbox\.gopay|gopay\.com\/gp-gw|gp-gw\/js/,
    text: /\bgopay\b/,
    vZasadach: /gopay/ },
  { id: 'stripe', nazov: 'Stripe', gdpr: 'stripe',
    kod: /js\.stripe\.com/,
    vZasadach: /\bstripe\b/ },
  // Ďalšie sledovacie a reklamné skripty bežné na slovenských a českých
  // e-shopoch. Nie sú v katalógu balíka, preto idú do poľa "Iné".
  { id: 'clarity', nazov: 'Microsoft Clarity', ine: 'Microsoft Clarity (nahrávanie návštev)', sledovanie: true, cookies: 'analyticke',
    kod: /clarity\.ms\/tag\//,
    vZasadach: /clarity/ },
  { id: 'tiktok', nazov: 'TikTok Pixel', ine: 'TikTok Pixel (meranie reklamy)', sledovanie: true, cookies: 'marketingove',
    kod: /analytics\.tiktok\.com|\bttq\.load\(/,
    vZasadach: /tiktok/ },
  { id: 'sklik', nazov: 'Sklik (Seznam.cz)', ine: 'Sklik, Seznam.cz (retargeting a konverzie)', sledovanie: true, cookies: 'marketingove',
    kod: /c\.seznam\.cz\/js\/rc\.js|\bseznam_retargeting_id\b|c\.imedia\.cz\/js\/(?:retargeting|conv)/,
    vZasadach: /sklik|seznam/ },
  { id: 'bing', nazov: 'Microsoft Advertising (Bing)', ine: 'Microsoft Advertising, Bing (meranie reklamy)', sledovanie: true, cookies: 'marketingove',
    kod: /bat\.bing\.com/,
    vZasadach: /\bbing\b|microsoft advertising/ },
  { id: 'pinterest', nazov: 'Pinterest Tag', ine: 'Pinterest Tag (meranie reklamy)', sledovanie: true, cookies: 'marketingove',
    kod: /s\.pinimg\.com\/ct\/|ct\.pinterest\.com|\bpintrk\(/,
    vZasadach: /pinterest/ },
  { id: 'linkedin', nazov: 'LinkedIn Insight Tag', ine: 'LinkedIn Insight Tag (meranie reklamy)', sledovanie: true, cookies: 'marketingove',
    kod: /snap\.licdn\.com|\b_linkedin_partner_id\b/,
    vZasadach: /linkedin/ },
  { id: 'leadhub', nazov: 'Leadhub', ine: 'Leadhub (e-mailový retargeting)', sledovanie: true, cookies: 'marketingove',
    kod: /\bleadhub\.co\b/,
    vZasadach: /leadhub/ },
  { id: 'heureka-konverzie', nazov: 'Heureka meranie konverzií', ine: 'Heureka (meranie konverzií)', sledovanie: true, cookies: 'marketingove',
    kod: /im9\.cz\/(?:sk|cz)\/js\/ext\/|\b_hrq\b|heureka\(\s*['"]authenticate['"]/,
    vZasadach: /heureka/ },
  { id: 'heureka-overene', nazov: 'Heureka Overené zákazníkmi', ine: 'Heureka Overené zákazníkmi (dotazník po nákupe)',
    kod: /\b_hwq\b|im9\.cz\/direct\/i\/gjs\.php/,
    vZasadach: /heureka/ },
];

/**
 * Nástroje na súhlas s cookies (CMP) podľa kódu stránky.
 *   volba: true    pomenovaný nástroj, ktorý ponúka voľbu (prijať aj odmietnuť);
 *   volba: regex   nástroj ponúka voľbu, len ak kód obsahuje aj tento znak
 *                  (napríklad tlačidlo Odmietnuť v Cookie Notice);
 *   volba: false   z kódu nevieme povedať, či lišta ponúka voľbu, alebo len oznamuje.
 * Vyhráva prvý nástroj s voľbou, inak prvý zásah.
 */
export const NASTROJE_SUHLASU = [
  { nazov: 'Cookiebot', re: /consent\.cookiebot\.(?:com|eu)|cookiebot/i, volba: true },
  { nazov: 'OneTrust', re: /cdn\.cookielaw\.org|optanon|onetrust/i, volba: true },
  { nazov: 'CookieYes', re: /cdn-cookieyes\.com|cookieyes/i, volba: true },
  { nazov: 'Complianz', re: /complianz|cmplz-/i, volba: true },
  { nazov: 'CookieLawInfo', re: /cookie-law-info|cookielawinfo|cli_cookie/i, volba: true },
  { nazov: 'Cookie Compliance (Hu-manity)', re: /cdn\.hu-manity\.co/i, volba: true },
  { nazov: 'Cookie-Script', re: /cookie-script\.com/i, volba: true },
  { nazov: 'iubenda', re: /iubenda\.com/i, volba: true },
  { nazov: 'Usercentrics', re: /usercentrics\.(?:eu|com)/i, volba: true },
  { nazov: 'Didomi', re: /sdk\.privacy-center\.org|didomi/i, volba: true },
  { nazov: 'Termly', re: /termly\.io/i, volba: true },
  { nazov: 'CookieFirst', re: /cookiefirst\.com/i, volba: true },
  { nazov: 'consentmanager', re: /consentmanager\.net/i, volba: true },
  { nazov: 'Axeptio', re: /axept\.io|axeptio/i, volba: true },
  { nazov: 'Klaro', re: /klaro(?:\.min)?\.js|klaro-config/i, volba: true },
  { nazov: 'Borlabs Cookie', re: /borlabs-cookie|borlabscookie/i, volba: true },
  { nazov: 'CookieConsent', re: /cookieconsent(?:\.min)?\.(?:js|css)|vanilla-cookieconsent|cc_cookie|orestbida/i, volba: true },
  { nazov: 'Moove GDPR', re: /moove_gdpr|moove-gdpr/i, volba: true },
  { nazov: 'Shoptet (vstavaná lišta)', re: /siteCookies|cookies-agreement|js-cookies-agreement/i, volba: true },
  { nazov: 'Cookie Notice', re: /cookie-notice|cn-notice-text/i, volba: /cn-refuse-cookie|data-cookie-set\s*=\s*["']?reject/i },
  { nazov: 'lišta podľa kódu stránky', re: /cookie[-_]?(?:bar|banner|consent|lista|popup|notice)\b|id=["']cookies?["']/i, volba: false },
];

export const PLATFORMY = [
  ['Shoptet', /cdn\.myshoptet\.com|shoptet\.(?:sk|cz)\/|\bshoptet\b/i],
  ['WooCommerce', /wp-content\/plugins\/woocommerce|woocommerce/i],
  ['Shopify', /cdn\.shopify\.com|Shopify\.shop/],
  ['PrestaShop', /prestashop/i],
  ['BiznisWeb', /biznisweb/i],
  ['Upgates', /upgates/i],
  ['Wix', /static\.wixstatic\.com|wix\.com/i],
];

// ---------------------------------------------------------------------------
// Pomocníci na text
// ---------------------------------------------------------------------------

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...' };

export function dekodujEntity(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return ' ';
      try { return String.fromCodePoint(n); } catch (err) { return ' '; }
    }
    const v = ENTITY[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Malé písmená bez diakritiky a so zlúčenými medzerami; na všetky porovnania textu. */
export function normalizuj(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function bezZnaciek(html) {
  return dekodujEntity(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function atribut(attrs, meno) {
  const re = new RegExp(`\\b${meno}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs || '');
  if (!m) return '';
  return dekodujEntity(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
}

/** Krátky text do odpovede: bez znakov, ktoré by sa dali čítať ako HTML, najviac 80 znakov. */
export function kratkyText(text, max = 80) {
  const t = String(text || '').replace(/[<>"`]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3).trim()}...` : t;
}

// ---------------------------------------------------------------------------
// Rozbor HTML (regulárne výrazy, bez DOM: Workers ho nemajú a na toto stačí)
// ---------------------------------------------------------------------------

/**
 * Z HTML vytiahne odkazy, formuláre, viditeľný text a pár príznakov.
 * Surové HTML ostáva len vo `kod` na hľadanie služieb a nikdy neodchádza
 * v odpovedi.
 */
export function rozoberStranku(html, baseUrl) {
  const bezKomentarov = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const odkazy = [];
  const reA = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = reA.exec(bezKomentarov)) && odkazy.length < 3000) {
    const href = atribut(m[1], 'href');
    if (!href || /^\s*(javascript|data):/i.test(href)) continue;
    const popis = [bezZnaciek(m[2]), atribut(m[1], 'title'), atribut(m[1], 'aria-label')].filter(Boolean).join(' ');
    let abs = '';
    try { abs = new URL(href, baseUrl).toString(); } catch (e) { continue; }
    odkazy.push({ href: abs, text: popis, norm: normalizuj(popis), hrefNorm: normalizuj(safeDecode(abs)) });
  }

  const formulare = [];
  const reForm = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  while ((m = reForm.exec(bezKomentarov)) && formulare.length < 50) {
    formulare.push(rozoberFormular(m[1], m[2]));
  }

  const viditelny = bezZnaciek(
    bezKomentarov
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' '),
  );

  return {
    odkazy,
    formulare,
    text: viditelny,
    textNorm: normalizuj(viditelny),
    kod: bezKomentarov,
    maIframe: /<iframe\b/i.test(bezKomentarov),
    // Aplikácia, ktorá obsah skladá až JavaScriptom: málo textu a koreň pre framework.
    jeJsAplikacia: viditelny.length < 400 && /<div[^>]+id=["'](?:root|app|__next|__nuxt)["']/i.test(bezKomentarov),
  };
}

function safeDecode(u) {
  try { return decodeURIComponent(u); } catch (e) { return u; }
}

/** Meno, id, placeholder a aria-label poľa v jednom normalizovanom reťazci. */
function popisPola(attrs) {
  return normalizuj(['name', 'id', 'placeholder', 'aria-label'].map((a) => atribut(attrs, a)).filter(Boolean).join(' '));
}

// Formulár, ktorý podľa akcie alebo polí nie je odstúpenie: prihlásenie,
// registrácia, newsletter, košík. Hľadá sa v normalizovanej akcii, id a class.
const VZOR_INY_FORMULAR = /login|log-in|signin|sign-in|prihlas|registr|register|newsletter|subscri|novink|kosik|basket|\bcart\b|cart[-_/]|checkout|kupon|coupon|voucher/;
// Telefón nie je identifikácia zmluvy, aj keď sa pole volá "telefónne číslo".
const VZOR_TELEFON_POLE = /telefon|phone|mobil|\btel\b/;
// Pole, ktoré identifikuje zmluvu (číslo objednávky, faktúry, zmluvy).
export const VZOR_POLE_ZMLUVY = /objednav|zmluv|smlouv|order|faktur|invoice|cislo/;
// Text potvrdzovacieho tlačidla.
export const VZOR_TLACIDLO_ODSTUPENIA = /odstup|odstoup|potvrd|odoslat|odeslat|withdraw|widerruf/;

function rozoberFormular(attrs, vnutro) {
  const polia = [];
  const reInput = /<input\b([^>]*)>/gi;
  let m;
  let maSubmit = false;
  let maHeslo = false;
  const tlacidla = [];
  while ((m = reInput.exec(vnutro))) {
    const typ = (atribut(m[1], 'type') || 'text').toLowerCase();
    if (typ === 'submit' || typ === 'image') {
      maSubmit = true;
      tlacidla.push(normalizuj(atribut(m[1], 'value') || atribut(m[1], 'alt') || atribut(m[1], 'aria-label')));
      continue;
    }
    if (typ === 'password') { maHeslo = true; continue; }
    if (['hidden', 'button', 'reset', 'checkbox', 'radio', 'file'].includes(typ)) continue;
    polia.push({ typ, meno: normalizuj(atribut(m[1], 'name')), popis: popisPola(m[1]) });
  }
  const reTextarea = /<textarea\b([^>]*)>/gi;
  while ((m = reTextarea.exec(vnutro))) polia.push({ typ: 'textarea', meno: normalizuj(atribut(m[1], 'name')), popis: popisPola(m[1]) });
  const reSelect = /<select\b([^>]*)>/gi;
  while ((m = reSelect.exec(vnutro))) polia.push({ typ: 'select', meno: normalizuj(atribut(m[1], 'name')), popis: popisPola(m[1]) });
  const reButton = /<button\b([^>]*)>([\s\S]*?)<\/button\s*>/gi;
  while ((m = reButton.exec(vnutro))) {
    const typ = (atribut(m[1], 'type') || 'submit').toLowerCase();
    if (typ === 'submit') {
      maSubmit = true;
      tlacidla.push(normalizuj([bezZnaciek(m[2]), atribut(m[1], 'value'), atribut(m[1], 'aria-label')].filter(Boolean).join(' ')));
    }
  }

  const akcia = normalizuj(atribut(attrs, 'action'));
  const oznacenie = normalizuj([akcia, atribut(attrs, 'id'), atribut(attrs, 'class'), atribut(attrs, 'name')].join(' '));
  const jeHladanie = /role\s*=\s*["']?search/i.test(attrs)
    || /search|hladat|vyhlad|hledat/.test(akcia)
    || polia.some((p) => p.typ === 'search' || ['q', 's', 'search', 'string', 'query'].includes(p.meno));
  const emailovePolia = polia.filter((p) => p.typ === 'email' || /mail/.test(p.meno));
  const maEmail = emailovePolia.length > 0;
  const lenEmail = polia.length === 1 && maEmail;
  const maPoleZmluvy = polia.some((p) => p.typ !== 'tel' && !VZOR_TELEFON_POLE.test(p.popis) && VZOR_POLE_ZMLUVY.test(p.popis));
  const maTlacidloOdstupenia = tlacidla.some((t) => VZOR_TLACIDLO_ODSTUPENIA.test(t));
  return {
    pocetPoli: polia.length,
    maEmail,
    maSubmit,
    maHeslo,
    maPoleZmluvy,
    maTlacidloOdstupenia,
    tlacidla,
    jeHladanie,
    // Prihlásenie, newsletter, košík a podobne: nikdy sa neráta ako odstúpenie.
    jeIny: maHeslo || lenEmail || VZOR_INY_FORMULAR.test(oznacenie),
  };
}

// ---------------------------------------------------------------------------
// Hľadanie odkazov
// ---------------------------------------------------------------------------

const VZOR_ZASADY = /ochran\w* osobn|osobn\w* udaj|gdpr|privacy|datenschutz|zasady spracovan|spracovani\w* osobn|ochran\w* sukromi|ochran\w* soukrom|osobnich udaj/;
const VZOR_ZASADY_HREF = /ochrana-osobnych|osobne-udaje|osobnych-udajov|gdpr|privacy|ochrana-sukromia|zasady-ochrany|ochrana-udajov|osobni-udaje/;
const VZOR_ODSTUPENIE = /odstup|odstoup|withdraw|widerruf/;
const VZOR_PODMIENKY = /obchodn\w* podmienk|obchodni podminky|\bvop\b|terms (?:and|&) conditions|podmienky nakupu|podmienky predaja/;
const VZOR_PODMIENKY_HREF = /obchodne-podmienky|obchodni-podminky|\bvop\b|terms|podmienky/;
const VZOR_REKLAMACIE = /reklamac|reklamaci|vytknut\w* vad|zarucn/;

function skoreOdstupenia(o) {
  const t = o.norm;
  if (/odstupit od zmluvy tu|odstoupit od smlouvy zde/.test(t)) return 4;
  if (/odstupit|odstoupit|withdraw from/.test(t)) return 3;
  if (VZOR_ODSTUPENIE.test(t)) return 2;
  if (VZOR_ODSTUPENIE.test(o.hrefNorm)) return 1;
  return 0;
}

// Holé „GDPR“ v dlhom texte je často produkt alebo článok („GDPR dokumenty pre e-shop za 10 minút“),
// nie zásady; preto vyhráva výslovný názov zásad, potom krátky odkaz „GDPR“, potom adresa.
const VZOR_ZASADY_SILNE = /ochran\w* osobn|osobn\w* udaj|ochran\w* udajov|zasady ochrany|privacy|datenschutz|zasady spracovan|spracovani\w* osobn|ochran\w* sukromi|ochran\w* soukrom|osobnich udaj/;
function skoreZasad(o) {
  const t = o.norm;
  const slova = t.split(/\s+/).filter(Boolean).length;
  const cookie = /cookie/.test(t) ? 0.5 : 0;
  if (VZOR_ZASADY_SILNE.test(t)) return 5 - cookie;
  if (/gdpr/.test(t) && slova <= 3) return 4 - cookie;
  if (VZOR_ZASADY_HREF.test(o.hrefNorm) && slova <= 4) return 3 - cookie;
  if (VZOR_ZASADY.test(t)) return 2 - cookie;
  if (VZOR_ZASADY_HREF.test(o.hrefNorm)) return 1;
  return 0;
}

/** Nájde najlepší odkaz na zásady, odstúpenie, obchodné podmienky a reklamácie. */
export function najdiOdkazy(odkazy) {
  let odstupenie = null;
  let najSkore = 0;
  for (const o of odkazy) {
    const s = skoreOdstupenia(o);
    if (s > najSkore) { najSkore = s; odstupenie = o; }
  }
  let zasady = null;
  let skoreZ = 0;
  for (const o of odkazy) {
    const s = skoreZasad(o);
    if (s > skoreZ) { skoreZ = s; zasady = o; }
  }
  const podmienky = odkazy.find((o) => VZOR_PODMIENKY.test(o.norm))
    || odkazy.find((o) => VZOR_PODMIENKY_HREF.test(o.hrefNorm) && !VZOR_ZASADY_HREF.test(o.hrefNorm)) || null;
  const reklamacie = odkazy.find((o) => VZOR_REKLAMACIE.test(o.norm) || VZOR_REKLAMACIE.test(o.hrefNorm)) || null;
  return { zasady, odstupenie, podmienky, reklamacie };
}

export function jeTaIstaStranka(hostA, hostB) {
  const a = String(hostA || '').toLowerCase().replace(/^www\./, '');
  const b = String(hostB || '').toLowerCase().replace(/^www\./, '');
  return !!a && a === b;
}

/** Druh cieľa odkazu: 'mailto', 'subor' (PDF a dokumenty), 'tel', 'cudzi' (iná doména) alebo 'html'. */
export function druhCiela(href, domaciHost) {
  let u;
  try { u = new URL(href); } catch (e) { return 'neplatny'; }
  if (u.protocol === 'mailto:') return 'mailto';
  if (u.protocol === 'tel:') return 'tel';
  if (!/^https?:$/.test(u.protocol)) return 'neplatny';
  if (/\.(pdf|docx?|odt|rtf|xlsx?)$/i.test(u.pathname)) return 'subor';
  if (!jeTaIstaStranka(u.hostname, domaciHost)) return 'cudzi';
  return 'html';
}

// ---------------------------------------------------------------------------
// Vstup a bezpečné sťahovanie
// ---------------------------------------------------------------------------

/** Adresa od návštevníka -> URL objekt. Doplní https:// a odmietne všetko nepovolené. */
export function normalizujAdresu(vstup) {
  let s = String(vstup || '').trim();
  if (!s || s.length > 500) throw new KontrolaChyba('adresa_neplatna');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(s); } catch (e) { throw new KontrolaChyba('adresa_neplatna'); }
  overUrl(u);
  u.hash = '';
  return u;
}

/** Kontrola jednej adresy pred stiahnutím (vstup aj každý skok presmerovania). */
export function overUrl(u) {
  if (!/^https?:$/.test(u.protocol)) throw new KontrolaChyba('adresa_schema');
  if (u.username || u.password) throw new KontrolaChyba('adresa_nepovolena');
  if (u.port && !['80', '443'].includes(u.port)) throw new KontrolaChyba('adresa_port');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.includes(':') || host.startsWith('[')) throw new KontrolaChyba('adresa_ip');
  if (parseIpv4(host) !== null) throw new KontrolaChyba('adresa_ip');
  if (!host.includes('.')) throw new KontrolaChyba('adresa_nepovolena');
  if (isPrivateHost(host)) throw new KontrolaChyba('adresa_nepovolena');
  if (!/^[a-z0-9.-]+$/.test(host)) throw new KontrolaChyba('adresa_neplatna');
  return u;
}

/** Je IP adresa z odpovede DNS súkromná, loopback, link-local alebo inak neverejná? */
export function jeNeverejnaIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return true;
  if (s.includes(':')) return isPrivateIpv6(s);
  const v4 = parseIpv4(s);
  if (v4 === null) return true;
  return isPrivateIpv4Number(v4);
}

/**
 * Preklad mena cez DNS over HTTPS (Cloudflare, JSON). Vracia zoznam adries
 * (A aj AAAA). NXDOMAIN -> chyba domena_neexistuje. Ak DoH neodpovie, vráti
 * null a kontrola pokračuje: Workers aj tak nevedia siahnuť do súkromnej
 * siete, preklad je druhá poistka, nie jediná.
 */
export async function prelozDns(host, fetchImpl) {
  const adresy = [];
  let existuje = false;
  let odpovedalo = false;
  for (const typ of ['A', 'AAAA']) {
    try {
      const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${typ}`, {
        headers: { accept: 'application/dns-json' },
      });
      if (!res || !res.ok) continue;
      const data = JSON.parse(await res.text());
      odpovedalo = true;
      if (data.Status === 3) continue;
      if (data.Status === 0) existuje = true;
      for (const a of data.Answer || []) {
        if (a.type === 1 || a.type === 28) adresy.push(String(a.data || ''));
      }
    } catch (e) { /* DoH nedostupné: rozhodne sa nižšie */ }
  }
  if (!odpovedalo) return null;
  if (!existuje && adresy.length === 0) throw new KontrolaChyba('domena_neexistuje', 422);
  return adresy;
}

async function overDns(host, deps, cache) {
  if (cache.has(host)) return;
  const dns = deps.dnsImpl || ((h) => prelozDns(h, deps.fetchImpl));
  const adresy = await dns(host);
  if (adresy && adresy.some(jeNeverejnaIp)) throw new KontrolaChyba('adresa_nepovolena');
  cache.set(host, true);
}

/** Prečíta telo odpovede najviac do `limit` bajtov. */
export async function citajTelo(res, limit) {
  let bajty;
  let orezane = false;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const kusy = [];
    let spolu = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (spolu + value.byteLength > limit) {
        kusy.push(value.subarray(0, limit - spolu));
        spolu = limit;
        orezane = true;
        try { await reader.cancel(); } catch (e) { /* nič */ }
        break;
      }
      kusy.push(value);
      spolu += value.byteLength;
    }
    bajty = new Uint8Array(spolu);
    let pos = 0;
    for (const k of kusy) { bajty.set(k, pos); pos += k.byteLength; }
  } else {
    const t = typeof res.text === 'function' ? await res.text() : '';
    bajty = new TextEncoder().encode(t);
    if (bajty.byteLength > limit) { bajty = bajty.subarray(0, limit); orezane = true; }
  }
  return { bajty, orezane };
}

function dekoduj(bajty, contentType) {
  let kodovanie = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!kodovanie) {
    const hlava = new TextDecoder('latin1').decode(bajty.subarray(0, 4096));
    kodovanie = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(hlava) || [])[1];
  }
  try {
    return new TextDecoder((kodovanie || 'utf-8').toLowerCase()).decode(bajty);
  } catch (e) {
    return new TextDecoder('utf-8').decode(bajty);
  }
}

function hlavicka(res, meno) {
  const h = res && res.headers;
  if (!h || typeof h.get !== 'function') return '';
  return h.get(meno) || '';
}

/**
 * Bezpečné stiahnutie jednej HTML stránky: ručné presmerovania, kontrola
 * každého skoku, DNS, časový a veľkostný limit. Vracia
 * {ok, url, status, html, orezane} alebo {ok:false, dovod, status}.
 */
export async function stiahniStranku(adresa, deps, { limit, dnsCache = new Map(), koniec = Infinity } = {}) {
  let aktualna = overUrl(new URL(adresa));
  for (let skok = 0; skok <= MAX_PRESMEROVANI; skok++) {
    await overDns(aktualna.hostname.toLowerCase(), deps, dnsCache);
    const zostava = Math.min(CAS_NA_STRANKU_MS, koniec - (deps.now ? deps.now() : Date.now()));
    if (zostava <= 0) return { ok: false, dovod: 'cas' };
    const ac = new AbortController();
    const casovac = setTimeout(() => ac.abort(), zostava);
    let res;
    try {
      res = await deps.fetchImpl(aktualna.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          'user-agent': KONTROLA_USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-language': 'sk,cs;q=0.8,en;q=0.5',
        },
      });
    } catch (e) {
      clearTimeout(casovac);
      return { ok: false, dovod: ac.signal.aborted ? 'cas' : 'spojenie' };
    }
    const status = res && res.status;
    const location = hlavicka(res, 'location');
    if (status >= 300 && status < 400 && location) {
      clearTimeout(casovac);
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* nič */ }
      aktualna = overUrl(new URL(location, aktualna));
      continue;
    }
    if (!res.ok) {
      clearTimeout(casovac);
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* nič */ }
      return { ok: false, dovod: 'status', status };
    }
    const ct = hlavicka(res, 'content-type');
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) {
      clearTimeout(casovac);
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* nič */ }
      return { ok: false, dovod: 'nie_html', status };
    }
    try {
      const { bajty, orezane } = await citajTelo(res, limit);
      return { ok: true, url: aktualna.toString(), status, html: dekoduj(bajty, ct), orezane };
    } catch (e) {
      return { ok: false, dovod: ac.signal.aborted ? 'cas' : 'spojenie' };
    } finally {
      clearTimeout(casovac);
    }
  }
  return { ok: false, dovod: 'presmerovania' };
}

// ---------------------------------------------------------------------------
// Vyhodnotenie siedmich kontrol
// ---------------------------------------------------------------------------

export function najdiSluzby(uvod) {
  const najdene = [];
  for (const s of SLUZBY) {
    if (s.kod.test(uvod.kod) || (s.text && s.text.test(uvod.textNorm))) najdene.push(s);
  }
  return najdene;
}

/** Nástroj na súhlas: {nazov, sVolbou} alebo null. Nástroj s voľbou má prednosť. */
export function najdiNastrojSuhlasu(kod) {
  let prvy = null;
  for (const n of NASTROJE_SUHLASU) {
    if (!n.re.test(kod)) continue;
    const sVolbou = n.volba === true || (n.volba instanceof RegExp && n.volba.test(kod));
    if (sVolbou) return { nazov: n.nazov, sVolbou: true };
    if (!prvy) prvy = { nazov: n.nazov, sVolbou: false };
  }
  return prvy;
}

/** Domény skriptov z iných domén (najviac 5, len znaky doménového mena). */
export function cudzieSkripty(kod, domaciHost) {
  const hosty = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi;
  let m;
  while ((m = re.exec(kod || '')) && hosty.length < 5) {
    let host = '';
    try { host = new URL(dekodujEntity(m[1]), `https://${domaciHost}/`).hostname.toLowerCase(); } catch (e) { continue; }
    const domaci = String(domaciHost || '').toLowerCase().replace(/^www\./, '');
    if (!/^[a-z0-9.-]+$/.test(host) || jeTaIstaStranka(host, domaci) || host.endsWith(`.${domaci}`) || hosty.includes(host)) continue;
    hosty.push(host);
  }
  return hosty;
}

export function najdiPlatformu(kod) {
  for (const [nazov, re] of PLATFORMY) if (re.test(kod)) return nazov;
  return null;
}

function riadok(id, nazov, stav, text) {
  return { id, typ: id, nazov, stav, text, zdroj: ZDROJE[id] };
}

function zoznamSlovami(polozky) {
  if (polozky.length <= 1) return polozky.join('');
  return `${polozky.slice(0, -1).join(', ')} a ${polozky[polozky.length - 1]}`;
}

function popisOdkazu(o) {
  return o && o.text ? `„${kratkyText(o.text, 60)}“` : 'bez textu';
}

/**
 * Formuláre na stránke rozdelí na:
 *   dobry: pole e-mail, pole s identifikáciou zmluvy (číslo objednávky,
 *          faktúry, zmluvy) a tlačidlo s textom odstúpiť, potvrdiť alebo odoslať;
 *   nejasne: iné formuláre s tlačidlom, ktoré nie sú vyhľadávanie, prihlásenie,
 *          newsletter ani košík; tie nevieme priradiť.
 */
export function formulareOdstupenia(stranka) {
  const kandidati = stranka.formulare.filter((f) => !f.jeHladanie && !f.jeIny && f.maSubmit && f.pocetPoli >= 1);
  const dobry = kandidati.find((f) => f.pocetPoli >= 2 && f.maEmail && f.maPoleZmluvy && f.maTlacidloOdstupenia) || null;
  return { dobry, nejasne: dobry ? [] : kandidati };
}

function vyhodnotOdstupenie(odkaz, druh, stranka, uvod) {
  const nazov = 'Funkcia na odstúpenie od zmluvy';
  if (!odkaz && uvod && (uvod.jeJsAplikacia || uvod.odkazy.length < 10)) {
    return riadok('odstupenie', nazov, 'nevieme', 'Úvodná stránka sa skladá až v prehliadači, bez neho sme v nej odkazy nevideli. Funkciu na odstúpenie preto nevieme overiť.');
  }
  if (!odkaz) {
    return riadok('odstupenie', nazov, 'nalez',
      'Na úvodnej stránke sme nenašli odkaz na odstúpenie od zmluvy. Od 19. 6. 2026 má byť v e-shope funkcia „odstúpiť od zmluvy tu“ s formulárom a samostatným potvrdzovacím tlačidlom, dostupná počas celej lehoty na odstúpenie. Ak ju máte napríklad len v účte zákazníka, overte, či je ľahko dostupná.');
  }
  const kde = `Odkaz ${popisOdkazu(odkaz)}`;
  if (druh === 'mailto') {
    return riadok('odstupenie', nazov, 'nalez', `${kde} otvára e-mail. Samotná e-mailová adresa podľa výkladu § 20a nestačí, zákon žiada formulár priamo na stránke s potvrdzovacím tlačidlom.`);
  }
  if (druh === 'subor') {
    return riadok('odstupenie', nazov, 'nalez', `${kde} vedie na súbor na stiahnutie (napríklad PDF). Formulár na vytlačenie podľa výkladu § 20a nestačí, zákon žiada funkciu priamo v online rozhraní.`);
  }
  if (druh === 'cudzi' || druh === 'neplatny' || druh === 'tel') {
    return riadok('odstupenie', nazov, 'nevieme', `${kde} vedie mimo vašej domény. Tam sme z bezpečnostných dôvodov nechodili, preto nevieme povedať, či je na druhej strane formulár.`);
  }
  if (!stranka) {
    return riadok('odstupenie', nazov, 'nevieme', `${kde} sme našli, ale stránku sa nepodarilo načítať. Skúste kontrolu zopakovať.`);
  }
  const { dobry, nejasne } = formulareOdstupenia(stranka);
  const naUvode = stranka === uvod;
  const kam = naUvode ? 'vedie na miesto na úvodnej stránke' : 'vedie na stránku';
  if (dobry) {
    const oznacenie = /odstupit od zmluvy tu|odstoupit od smlouvy zde/.test(odkaz.norm)
      ? ''
      : ' Zákon uvádza označenie „odstúpiť od zmluvy tu“ alebo podobne jednoznačné; skontrolujte znenie odkazu.';
    return riadok('odstupenie', nazov, 'ok', `${kde} ${kam} s formulárom, ktorý má pole na e-mail, pole na číslo objednávky alebo zmluvy a tlačidlo na potvrdenie. Či po odoslaní príde potvrdenie e-mailom, overíte skúšobným odstúpením.${oznacenie}`);
  }
  if (nejasne.length) {
    return riadok('odstupenie', nazov, 'nevieme', `${kde} ${kam}, kde je formulár, ale nevieme ho priradiť k odstúpeniu: chýba mu pole na e-mail, pole na číslo objednávky alebo zmluvy, alebo tlačidlo s textom odstúpiť, potvrdiť či odoslať. Otvorte stránku a skontrolujte, či zákazník vie formulárom od zmluvy odstúpiť.`);
  }
  if (stranka.maIframe || stranka.jeJsAplikacia) {
    return riadok('odstupenie', nazov, 'nevieme', `${kde} vedie na stránku, ktorej obsah sa skladá až v prehliadači alebo je vložený z inej stránky. Bez prehliadača formulár nevidíme.`);
  }
  const lenEmailAleboPdf = !naUvode && stranka.odkazy.some((o) => /^mailto:/i.test(o.href) || /\.(pdf|docx?|odt|rtf)(?:[?#]|$)/i.test(o.href));
  return riadok('odstupenie', nazov, 'nalez', `${kde} ${kam} bez formulára na odstúpenie s poľami a potvrdzovacím tlačidlom${lenEmailAleboPdf ? ' (ponúka e-mail alebo súbor na stiahnutie)' : ''}. Prihlásenie, newsletter ani vyhľadávanie sa nerátajú. Od 19. 6. 2026 to podľa výkladu § 20a nestačí.`);
}

const VZOR_RSO_KOD = /ec\.europa\.eu\/consumers\/odr|webgate\.ec\.europa\.eu\/odr|ec\.europa\.eu\/odr/i;
const VZOR_RSO_TEXT = /riesen\w* sporov online|platform\w* (?:pre )?rso\b|\bplatform\w* odr\b|online dispute resolution|reseni spotrebitelskych sporu online/;

// Veta „platforma ODR už neexistuje, preto na ňu neodkazujeme“ je správna, nie nález. Zmienka sa
// ráta len vtedy, keď v jej okolí nie je slovo o zrušení (nález 24. 9. 2026 na vlastnom arling.sk).
const VZOR_RSO_ZRUSENA = /zrus|neexist|ukonc|nefung|zanik|no longer|discontinu|closed|abolish|repeal|eingestellt|nicht mehr|zrusen/;
export function spominaZivuRso(textNorm) {
  const re = new RegExp(VZOR_RSO_TEXT.source, 'g');
  for (let m = re.exec(textNorm); m; m = re.exec(textNorm)) {
    const okolie = textNorm.slice(Math.max(0, m.index - 160), m.index + m[0].length + 260);
    if (!VZOR_RSO_ZRUSENA.test(okolie)) return true;
  }
  return false;
}

function vyhodnotRso(stranky, podmienkyPrecitane) {
  const nazov = 'Odkaz na zrušenú platformu RSO';
  const s = stranky.find((x) => VZOR_RSO_KOD.test(x.kod) || spominaZivuRso(x.textNorm));
  if (s) {
    return riadok('rso', nazov, 'nalez', `Na prečítanej stránke (${s.nazovStranky}) je odkaz alebo zmienka o platforme na riešenie sporov online (RSO, ODR). Európska komisia platformu 20. 7. 2025 ukončila, zákazníka už nikam užitočne nepošle. Odporúčame odkaz aj vetu o nej z textov odstrániť.`);
  }
  if (podmienkyPrecitane) {
    return riadok('rso', nazov, 'ok', 'Na úvodnej stránke, v zásadách ani v obchodných podmienkach sme odkaz na zrušenú platformu RSO nenašli.');
  }
  return riadok('rso', nazov, 'nevieme', `Na prečítaných stránkach (${zoznamSlovami(stranky.map((x) => x.nazovStranky))}) odkaz na zrušenú platformu RSO nie je. Obchodné podmienky, kde býva najčastejšie, sme v tejto kontrole neotvárali.`);
}

function vyhodnotZasady(odkaz, uvod, stranka) {
  const nazov = 'Odkaz na zásady ochrany osobných údajov';
  if (odkaz) {
    const dovetok = stranka ? '' : ' Samotnú stránku sa nepodarilo načítať, preto nižšie nevieme porovnať služby.';
    return riadok('zasady', nazov, 'ok', `Úvodná stránka odkazuje na zásady: ${popisOdkazu(odkaz)}.${dovetok}`);
  }
  if (uvod.odkazy.length < 10 || uvod.jeJsAplikacia) {
    return riadok('zasady', nazov, 'nevieme', 'Úvodná stránka sa skladá až v prehliadači, bez neho sme v nej odkazy nevideli.');
  }
  return riadok('zasady', nazov, 'nalez', 'Na úvodnej stránke sme nenašli odkaz na zásady ochrany osobných údajov. Informácie podľa čl. 13 GDPR majú byť ľahko dostupné, zvyčajne cez odkaz v päte.');
}

function vyhodnotPrijemcov(sluzby, zasadyStranka) {
  const nazov = 'Služby na stránke a príjemcovia v zásadách';
  if (sluzby.length === 0) {
    return { riadok: riadok('prijemcovia', nazov, 'nevieme', `Na úvodnej stránke sme nenašli žiadnu zo služieb, ktoré poznáme (${zoznamSlovami(SLUZBY.map((s) => s.nazov))}). Platobné a dopravné služby sa často načítajú až v košíku, ten sme nevideli.`), chybajuce: [] };
  }
  const mena = sluzby.map((s) => s.nazov);
  if (!zasadyStranka) {
    return { riadok: riadok('prijemcovia', nazov, 'nevieme', `Na stránke beží alebo sa spomína: ${zoznamSlovami(mena)}. Zásady sme nenašli alebo sa nedali načítať, preto nevieme porovnať, či sú v nich tieto služby ako príjemcovia uvedené.`), chybajuce: [] };
  }
  const chybajuce = sluzby.filter((s) => !s.vZasadach.test(zasadyStranka.textNorm));
  if (chybajuce.length) {
    return { riadok: riadok('prijemcovia', nazov, 'nalez', `Na stránke beží alebo sa spomína ${zoznamSlovami(mena)}, ale v zásadách sme nenašli názov: ${zoznamSlovami(chybajuce.map((s) => s.nazov))}. Zásady majú uvádzať príjemcov osobných údajov.`), chybajuce };
  }
  return { riadok: riadok('prijemcovia', nazov, 'ok', `Na stránke beží alebo sa spomína ${zoznamSlovami(mena)} a každá z týchto služieb sa v zásadách spomína menom. Či je popis správny (účel, prenos mimo EÚ), automaticky nevieme posúdiť.`), chybajuce: [] };
}

const ZNAME_SLEDOVACIE = zoznamSlovami(SLUZBY.filter((s) => s.sledovanie).map((s) => s.nazov));

function vyhodnotCookies(sluzby, uvod) {
  const nazov = 'Súhlas s cookies pri sledovacích skriptoch';
  const sledovacie = sluzby.filter((s) => s.sledovanie);
  const cmp = najdiNastrojSuhlasu(uvod.kod);
  if (sledovacie.length === 0 && uvod.jeJsAplikacia) {
    return riadok('cookies', nazov, 'nevieme', 'Úvodná stránka sa skladá až v prehliadači. Skripty, ktoré sa načítajú až potom, bez prehliadača nevidíme.');
  }
  if (sledovacie.length === 0) {
    // Nič známe sme nenašli. To ešte neznamená, že na stránke nič nesleduje:
    // nepoznané skripty nevidíme, preto nikdy "v poriadku".
    let host = '';
    try { host = new URL(uvod.url).hostname; } catch (e) { /* bez adresy */ }
    const cudzie = host ? cudzieSkripty(uvod.kod, host) : [];
    const skripty = cudzie.length
      ? ` Stránka načítava skripty z iných domén (${zoznamSlovami(cudzie)}), tie sme neposudzovali.`
      : '';
    const lista = cmp ? ` Nástroj na súhlas na stránke je (${cmp.nazov}).` : '';
    return riadok('cookies', nazov, 'nevieme', `V kóde úvodnej stránky sme nenašli sledovacie skripty, ktoré poznáme (${ZNAME_SLEDOVACIE}). Nepoznané skripty nevidíme, preto súhlas s cookies nevieme overiť.${skripty}${lista}`);
  }
  const mena = zoznamSlovami(sledovacie.map((s) => s.nazov));
  if (cmp && cmp.sVolbou) {
    return riadok('cookies', nazov, 'ok', `Beží ${mena} a na stránke je nástroj na súhlas s cookies (${cmp.nazov}). Či skripty naozaj čakajú na súhlas, zistí až kontrola v prehliadači, tú táto verzia nerobí.`);
  }
  if (cmp) {
    return riadok('cookies', nazov, 'nevieme', `Beží ${mena} a na stránke je lišta o cookies (${cmp.nazov}), ale z kódu nevieme povedať, či ponúka voľbu (prijať aj odmietnuť), alebo len oznamuje. Lišta, ktorá len oznamuje, na súhlas nestačí; sledovacie cookies sa smú ukladať až po súhlase návštevníka.`);
  }
  if (sledovacie.some((s) => s.id === 'gtm')) {
    return riadok('cookies', nazov, 'nevieme', `Beží ${mena}, nástroj na súhlas sme v kóde nevideli. Mohol by sa načítať cez Google Tag Manager, to bez prehliadača nevidíme.`);
  }
  return riadok('cookies', nazov, 'nalez', `Beží ${mena}, ale v kóde úvodnej stránky sme nenašli nástroj na súhlas s cookies. Sledovacie cookies sa smú ukladať až po súhlase návštevníka.`);
}

const VZOR_ICO = /\bic\s?o?\s*[:.]?\s*\d{2}\s?\d{3}\s?\d{3}\b|\bidentifikacne cislo\s*[:.]?\s*\d{2}\s?\d{3}\s?\d{3}\b/;
// PSČ a obec ("821 04 bratislava"), nie množstvo ("12345 kusov", "100 00 eur").
const VZOR_PSC = /\b\d{3}\s?\d{2}\s+(?!(?:ks|kus\w*|eur\w*|ml|mm|cm|kg|ks|sk|czk|dni|hod\w*)\b)[a-z]{3,}/;
const VZOR_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;
const VZOR_TELEFON = /(?:\+|00)42[01]\s?\d{3}\s?\d{3}\s?\d{3}|\b0\d{3}\s?\d{3}\s?\d{3}\b/;

function vyhodnotIdentifikaciu(stranky) {
  const nazov = 'IČO, sídlo a kontakt';
  const text = stranky.map((s) => s.textNorm).join(' ');
  const odkazy = stranky.flatMap((s) => s.odkazy);
  const ico = VZOR_ICO.test(text);
  const sidlo = VZOR_PSC.test(text);
  const kontakt = VZOR_EMAIL.test(text) || VZOR_TELEFON.test(text) || odkazy.some((o) => /^(mailto|tel):/i.test(o.href));
  const chyba = [];
  if (!ico) chyba.push('IČO');
  if (!sidlo) chyba.push('sídlo s PSČ');
  if (!kontakt) chyba.push('e-mail alebo telefón');
  const kde = zoznamSlovami(stranky.map((s) => s.nazovStranky));
  if (chyba.length === 0) {
    return riadok('identifikacia', nazov, 'ok', `IČO, adresu s PSČ aj kontakt sme našli (${kde}).`);
  }
  if (stranky.length >= 2) {
    return riadok('identifikacia', nazov, 'nalez', `Na prečítaných stránkach (${kde}) sme nenašli: ${zoznamSlovami(chyba)}. Údaje o predávajúcom majú byť na webe ľahko dostupné, najčastejšie v päte.`);
  }
  return riadok('identifikacia', nazov, 'nevieme', `Na úvodnej stránke sme nenašli: ${zoznamSlovami(chyba)}. Ďalšie stránky sme prečítať nevedeli, údaje môžu byť na stránke Kontakt.`);
}

function vyhodnotPodmienky(odkazy, uvod, podmienkyStranka) {
  const nazov = 'Obchodné podmienky a reklamácie';
  if (!odkazy.podmienky) {
    if (uvod.odkazy.length < 10 || uvod.jeJsAplikacia) {
      return riadok('podmienky', nazov, 'nevieme', 'Úvodná stránka sa skladá až v prehliadači, bez neho sme v nej odkazy nevideli.');
    }
    return riadok('podmienky', nazov, 'nalez', 'Na úvodnej stránke sme nenašli odkaz na obchodné podmienky. Pred objednávkou má zákazník dostať informácie o predávajúcom, cene, dodaní, zodpovednosti za vady a odstúpení; e-shopy ich dávajú do obchodných podmienok s odkazom v päte.');
  }
  if (odkazy.reklamacie) {
    return riadok('podmienky', nazov, 'ok', `Odkaz na obchodné podmienky ${popisOdkazu(odkazy.podmienky)} aj na reklamácie ${popisOdkazu(odkazy.reklamacie)} je na úvodnej stránke.`);
  }
  if (podmienkyStranka && VZOR_REKLAMACIE.test(podmienkyStranka.textNorm)) {
    return riadok('podmienky', nazov, 'ok', `Odkaz na obchodné podmienky ${popisOdkazu(odkazy.podmienky)} je na úvodnej stránke a reklamácie sú opísané priamo v nich.`);
  }
  if (podmienkyStranka) {
    return riadok('podmienky', nazov, 'nalez', `Odkaz na obchodné podmienky ${popisOdkazu(odkazy.podmienky)} je na úvodnej stránke, ale samostatný odkaz na reklamácie chýba a v podmienkach sme nenašli slovo reklamácia ani vytknutie vady. Zákazník má vedieť, ako uplatniť vadu tovaru.`);
  }
  return riadok('podmienky', nazov, 'nevieme', `Odkaz na obchodné podmienky ${popisOdkazu(odkazy.podmienky)} je na úvodnej stránke. Samostatný odkaz na reklamácie sme nenašli a podmienky sme neotvárali; reklamácie môžu byť opísané v nich.`);
}

/** Z nájdených služieb poskladá predvyplnenie balíka GDPR (parameter v adrese). */
export function predvyplnenie(sluzby, webUrl) {
  const nastroje = [...new Set(sluzby.filter((s) => s.gdpr).map((s) => s.gdpr))];
  const ine = [...new Set(sluzby.filter((s) => s.ine).map((s) => s.ine))];
  const cookies = [...new Set(sluzby.filter((s) => s.cookies).map((s) => s.cookies))];
  const cinnosti = ['eshop'];
  if (sluzby.some((s) => s.id === 'ga4' || s.id === 'hotjar')) cinnosti.push('analytika');
  if (sluzby.some((s) => s.cinnost === 'newsletter')) cinnosti.push('newsletter');
  return { nastroje, ine, cookies, cinnosti, web: webUrl };
}

// ---------------------------------------------------------------------------
// Celá kontrola
// ---------------------------------------------------------------------------

const NAZVY_STRANOK = { uvod: 'úvodná stránka', zasady: 'zásady', odstupenie: 'odstúpenie', podmienky: 'obchodné podmienky' };

/**
 * deps: {fetchImpl, dnsImpl?, now?}. Vráti objekt na odoslanie návštevníkovi,
 * alebo vyhodí KontrolaChyba.
 */
export async function skontrolujEshop(vstup, deps) {
  const now = deps.now || Date.now;
  const koniec = now() + CAS_SPOLU_MS;
  const dnsCache = new Map();
  const adresa = normalizujAdresu(vstup);

  const uvodRaw = await stiahniStranku(adresa.toString(), deps, { limit: LIMIT_UVOD_BAJTOV, dnsCache, koniec });
  if (!uvodRaw.ok) {
    const kod = uvodRaw.dovod === 'status' ? (uvodRaw.status === 403 || uvodRaw.status === 429 || uvodRaw.status === 503 ? 'stranka_blokuje' : 'stranka_chyba')
      : uvodRaw.dovod === 'nie_html' ? 'nie_html'
        : uvodRaw.dovod === 'cas' ? 'stranka_pomala'
          : uvodRaw.dovod === 'presmerovania' ? 'vela_presmerovani' : 'stranka_nedostupna';
    const chyba = new KontrolaChyba(kod, 422);
    chyba.httpStatus = uvodRaw.status || null;
    throw chyba;
  }
  const uvodUrl = new URL(uvodRaw.url);
  const domaciHost = uvodUrl.hostname;
  const uvod = { ...rozoberStranku(uvodRaw.html, uvodRaw.url), typ: 'uvod', nazovStranky: NAZVY_STRANOK.uvod, url: uvodRaw.url };
  const odkazy = najdiOdkazy(uvod.odkazy);
  const druhOdstupenia = odkazy.odstupenie ? druhCiela(odkazy.odstupenie.href, domaciHost) : null;

  // Poradie ďalších stránok: zásady, odstúpenie (len HTML na tej istej doméne),
  // obchodné podmienky, ak ostane miesto. Najviac MAX_DALSICH_STRANOK.
  const plan = [];
  const pridaj = (typ, o) => {
    if (!o || plan.length >= MAX_DALSICH_STRANOK) return;
    if (druhCiela(o.href, domaciHost) !== 'html') return;
    const bezHash = o.href.split('#')[0];
    if (bezHash === uvodRaw.url.split('#')[0]) return;
    if (plan.some((p) => p.url === bezHash)) { plan.find((p) => p.url === bezHash).typy.push(typ); return; }
    plan.push({ typy: [typ], url: bezHash });
  };
  pridaj('zasady', odkazy.zasady);
  pridaj('odstupenie', odkazy.odstupenie);
  pridaj('podmienky', odkazy.podmienky);

  const vysledky = await Promise.all(plan.map((p) => stiahniStranku(p.url, deps, { limit: LIMIT_PODSTRANKA_BAJTOV, dnsCache, koniec })
    .catch(() => ({ ok: false, dovod: 'nepovolena' }))));
  const podla = {};
  const precitane = [uvod];
  const zoznamStranok = [{ typ: 'uvod', url: uvodRaw.url, precitana: true, orezana: !!uvodRaw.orezane }];
  plan.forEach((p, i) => {
    const v = vysledky[i];
    if (v.ok) {
      const s = { ...rozoberStranku(v.html, v.url), typ: p.typy[0], nazovStranky: p.typy.map((t) => NAZVY_STRANOK[t]).join(' a '), url: v.url };
      for (const t of p.typy) podla[t] = s;
      precitane.push(s);
    }
    zoznamStranok.push({ typ: p.typy.join(','), url: p.url, precitana: !!v.ok, orezana: !!(v.ok && v.orezane) });
  });
  // Odkaz môže viesť na kotvu priamo na úvodnej stránke (napríklad #odstupenie).
  for (const typ of ['zasady', 'odstupenie', 'podmienky']) {
    const o = odkazy[typ];
    if (o && !podla[typ] && o.href.split('#')[0] === uvodRaw.url.split('#')[0]) podla[typ] = uvod;
  }

  const sluzby = najdiSluzby(uvod);
  const prijemcovia = vyhodnotPrijemcov(sluzby, podla.zasady || null);
  const riadky = [
    vyhodnotOdstupenie(odkazy.odstupenie, druhOdstupenia, podla.odstupenie || null, uvod),
    vyhodnotRso(precitane, !!podla.podmienky),
    vyhodnotZasady(odkazy.zasady, uvod, podla.zasady || null),
    prijemcovia.riadok,
    vyhodnotCookies(sluzby, uvod),
    vyhodnotIdentifikaciu(precitane),
    vyhodnotPodmienky(odkazy, uvod, podla.podmienky || null),
  ];

  const webUrl = `${uvodUrl.protocol}//${uvodUrl.host}/`;
  return {
    adresa: webUrl,
    cas: new Date(now()).toISOString(),
    platforma: najdiPlatformu(uvod.kod),
    sluzby: sluzby.map((s) => ({ id: s.id, nazov: s.nazov })),
    stranky: zoznamStranok,
    riadky,
    suhrn: {
      ok: riadky.filter((r) => r.stav === 'ok').length,
      nalez: riadky.filter((r) => r.stav === 'nalez').length,
      nevieme: riadky.filter((r) => r.stav === 'nevieme').length,
    },
    predvyplnenie: predvyplnenie(sluzby, webUrl),
    upozornenie: 'Automatická kontrola verejnej stránky, nie právne poradenstvo.',
  };
}

// ---------------------------------------------------------------------------
// Trasa
// ---------------------------------------------------------------------------

async function odtlacok(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return 'bez-odtlacku';
  }
}

function odpoved(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...cors },
  });
}

export async function handleEshopKontrolaRoute(request, env) {
  const origin = request.headers.get('Origin') || '';
  const cors = (origin && corsHeaders(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS))) || {};
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const kv = env.ASISTENT_CACHE;

  if (kv) {
    const minuta = await checkRateLimit(kv, ip, { limit: 6, windowSeconds: 60, name: 'eshop' });
    const hodina = minuta.allowed ? await checkRateLimit(kv, ip, { limit: 30, windowSeconds: 3600, name: 'eshoph' }) : minuta;
    if (!minuta.allowed || !hodina.allowed) return odpoved({ error: 'rate_limited' }, 429, cors);
    const den = await checkRateLimit(kv, 'vsetci', { limit: 3000, windowSeconds: 86400, name: 'eshopden' });
    if (!den.allowed) return odpoved({ error: 'denny_strop' }, 503, cors);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_TELO_POZIADAVKY) return odpoved({ error: 'payload_too_large' }, 413, cors);
  let telo;
  try { telo = JSON.parse(text || '{}'); } catch (e) { return odpoved({ error: 'adresa_neplatna' }, 400, cors); }

  let adresa;
  try {
    adresa = normalizujAdresu(telo && telo.url);
  } catch (e) {
    if (e instanceof KontrolaChyba) return odpoved({ error: e.kod }, e.status, cors);
    throw e;
  }

  if (kv) {
    const ciel = await odtlacok(adresa.hostname.replace(/^www\./, ''));
    const naCiel = await checkRateLimit(kv, ciel, { limit: 10, windowSeconds: 3600, name: 'eshopciel' });
    if (!naCiel.allowed) return odpoved({ error: 'rate_limited_ciel' }, 429, cors);
  }

  try {
    const vysledok = await skontrolujEshop(adresa.toString(), { fetchImpl: env.fetchImpl || fetch.bind(globalThis), dnsImpl: env.dnsImpl });
    return odpoved(vysledok, 200, cors);
  } catch (e) {
    if (e instanceof KontrolaChyba) return odpoved({ error: e.kod, status: e.httpStatus || null }, e.status, cors);
    console.error('[arling-asistent] eshop kontrola zlyhala:', e && e.message ? e.message : e);
    return odpoved({ error: 'internal_error' }, 500, cors);
  }
}
