/*
 * security.js
 *
 * Everything that keeps the widget endpoint from being abused:
 *   - CORS: only the shop's own registered domain (and its www./https
 *   variants) may call the API from a browser.
 *   - Rate limiting: a per-IP counter kept in KV, independent of the
 *   per-tenant monthly quota in tenants.js.
 *   - Input size limits: a chat request body has a hard byte cap.
 *   - Prompt-injection guard: product feed text is untrusted (a seller could
 *   put "ignore previous instructions" in a product description to try to
 *   hijack the assistant for other shoppers). It is never treated as
 *   instructions: it is wrapped in a clearly delimited data block and flagged
 *   for the system prompt to explicitly reject.
 */

// ---------------------------------------------------------------------------
// Porovnanie tajomstiev a spoločné bezpečnostné hlavičky
// ---------------------------------------------------------------------------

/**
 * Porovnanie dvoch reťazcov v konštantnom čase.
 *
 * Používa sa všade, kde sa porovnáva tajomstvo, ktoré poslal volajúci
 * (X-Admin-Token, prihlasovací kód účtu). Obyčajné `===` prestane porovnávať
 * na prvom rozdielnom znaku, takže čas odpovede nesie informáciu o tom, koľko
 * znakov už sedí. Cez internet je to slabý kanál, ale oprava nestojí nič a
 * modul ucet.js ten istý vzor už používal na podpis tokenu.
 *
 * Dĺžka sa porovnáva zvlášť a pri rozdiele sa vracia false hneď: dĺžka
 * tajomstva nie je to, čo chránime.
 */
export function bezpecnePorovnaj(a, b) {
  const bytesA = new TextEncoder().encode(String(a == null ? '' : a));
  const bytesB = new TextEncoder().encode(String(b == null ? '' : b));
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

/**
 * Hlavičky, ktoré patria na každú odpoveď tohto workera.
 *
 * nosniff: odpovede sú JSON, ale niektoré nesú text od tretej strany (názov
 * produktu z feedu, chybová hláška). Bez tejto hlavičky si starší prehliadač
 * vie obsah preinterpretovať ako HTML a spustiť z neho skript.
 * referrer-policy: adresy tohto API nosia session_id platby a id nájomcu;
 * nemajú odísť v hlavičke Referer na cudzí server.
 */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** Extract the hostname from an origin string ("https://shop.sk" -> "shop.sk"), or '' if invalid. */
export function hostnameFromOrigin(origin) {
  if (!origin) return '';
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

/** True if `hostname` is `allowedDomain` itself or a subdomain of it (e.g. "www.shop.sk" matches "shop.sk"). */
export function domainMatches(hostname, allowedDomain) {
  if (!hostname || !allowedDomain) return false;
  const h = hostname.toLowerCase();
  const a = allowedDomain.toLowerCase().replace(/^www\./, '');
  return h === a || h === `www.${a}` || h.endsWith(`.${a}`);
}

/**
 * Is this origin allowed to call the API? `allowedDomains` is the list of
 * shop domains known to the worker (tenant domains, plus ALLOWED_ORIGINS env
 * var entries for the demo page / admin UI).
 */
export function isOriginAllowed(origin, allowedDomains) {
  const hostname = hostnameFromOrigin(origin);
  if (!hostname) return false;
  return (allowedDomains || []).some((domain) => domainMatches(hostname, domain));
}

/** Parse the ALLOWED_ORIGINS env var (comma-separated hostnames) into an array. */
export function parseAllowedOrigins(envValue) {
  return String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build CORS response headers for a request, or null if the origin is not
 * allowed. PUT and DELETE, and the Authorization/X-Admin-Token headers, are
 * here for /v1/ucet/* (ucet.js): a Bearer token authenticates the account
 * routes, X-Admin-Token the one admin write, and the game-state and
 * "forget me" routes need PUT/DELETE. Every other caller only ever sends
 * headers/methods it already used, so this is purely additive.
 */
export function corsHeaders(origin, allowedDomains) {
  if (!isOriginAllowed(origin, allowedDomains)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Arling-Consent, Authorization, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (KV, per IP, sliding window bucketed by minute)
// ---------------------------------------------------------------------------

export const RATE_LIMIT_DEFAULT = 30; // requests
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * `name` oddeľuje počítadlá s rôznym oknom. Bez neho by minútové počítadlo
 * chatu a hodinové počítadlo zakladania nájomcov mohli pre tú istú IP trafiť
 * ten istý kľúč (číslo okna je len delenie času, nie je zaručene odlišné).
 * Prázdny názov je predvolený, takže kľúč existujúcich volajúcich sa nemení.
 */
function rateLimitKey(ip, windowSeconds, now, name = '') {
  const bucket = Math.floor(now / (windowSeconds * 1000));
  return `ratelimit:${name ? `${name}:` : ''}${ip}:${bucket}`;
}

/**
 * Increment and check a per-IP request counter in KV. Returns
 * {allowed, remaining, limit}. `kv` needs get/put with the standard Workers
 * KV signature; a small in-memory mock is enough for tests.
 *
 * Never throws: KV is eventually consistent and a concurrent burst of
 * requests can race on the same get-then-put key (two requests both read the
 * same counter value before either writes it back), and either the get or
 * the put can also simply fail as a transient KV error. Either way this must
 * not turn into a 500 for the visitor, so any KV error fails OPEN (the
 * request is allowed through) rather than failing the whole chat request;
 * the 429 path above is unaffected and still applies whenever KV itself
 * works but the counter is over the limit.
 */
export async function checkRateLimit(kv, ip, { limit = RATE_LIMIT_DEFAULT, windowSeconds = RATE_LIMIT_WINDOW_SECONDS, now = Date.now(), name = '' } = {}) {
  const safeIp = ip || 'unknown';
  const key = rateLimitKey(safeIp, windowSeconds, now, name);
  try {
    const current = parseInt((await kv.get(key)) || '0', 10);
    if (current >= limit) {
      return { allowed: false, remaining: 0, limit };
    }
    await kv.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 });
    return { allowed: true, remaining: limit - current - 1, limit };
  } catch (err) {
    console.warn('[arling-asistent] rate limit KV error, failing open:', (err && err.message) || err);
    return { allowed: true, remaining: limit, limit, failedOpen: true };
  }
}

// ---------------------------------------------------------------------------
// Denné limity na IP (plán 2.2 bod 3, krok 1, oprava nálezov kontroly)
//
// Minútový limit vyššie nezastaví robota, ktorý sa pýta pomaly celý deň.
// Denné limity sa počítajú atomicky v D1 (pocty.js, rezervácia pred modelom),
// nie v KV: KV nevie „pripočítaj, ak je pod limitom“, súbežná dávka ho
// obišla a pri viac ako 1 zápise za sekundu na kľúč zlyháva (nálezy 1, 9).
//
// Za UTC deň na dvojicu (obchod, sieť):
//   - 60 otázok spolu (s modelom aj bez neho), 61. je 429 rate_limited,
//   - 5 započítaných nových rozhovorov; ďalší nový rozhovor dostane odpoveď
//     bez modelu a do mesačnej kvóty sa nezapočíta (zákazník chybu nevidí),
//   - otázky s modelom: bezplatný obchod 10, platený 30 (zlomok denného stropu
//     obchodu, nález 3); ďalšie odpovedá kód bez modelu.
// Za UTC deň na IP cez všetky obchody: 30 otázok s modelom (nález B1: tenant id
// sú verejné, jedna IP by inak minula strop cez viac obchodov).
//
// IPv6 sa pre denné limity skracuje na sieť /56 (tretie kolo, nález K3; pred
// ním /64), pre minútový na /64. Do D1 ide len číslo koša 0 až 65 535 z
// odtlačku siete s dňom a tajomstvom (kosIp), nie IP.
// ---------------------------------------------------------------------------

export const DENNY_LIMIT_IP_ROZHOVORY = 5;
export const DENNY_LIMIT_IP_OTAZKY = 60;
export const DENNY_LIMIT_IP_AI = { free: 10, platene: 30 };
export const DENNY_LIMIT_IP_AI_SPOLU = 30;
export const IP_KOSOV = 65536;

/** Rozvinie IPv6 zápis na 8 skupín, alebo null. */
function rozvinIpv6(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  if (!s.includes(':')) return null;
  // Koniec vo forme IPv4 (::ffff:1.2.3.4) na dve skupiny.
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return null;
    s = s.slice(0, s.length - v4[0].length) + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16);
  }
  const casti = s.split('::');
  if (casti.length > 2) return null;
  const hlava = casti[0] ? casti[0].split(':') : [];
  const chvost = casti.length === 2 && casti[1] ? casti[1].split(':') : [];
  const chyba = 8 - hlava.length - chvost.length;
  if (casti.length === 1 && chyba !== 0) return null;
  if (chyba < 0) return null;
  const skupiny = [...hlava, ...Array(casti.length === 2 ? chyba : 0).fill('0'), ...chvost];
  if (skupiny.length !== 8 || skupiny.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return skupiny.map((g) => parseInt(g, 16));
}

/**
 * IP na jednotku limitu: IPv4 celá, IPv6 prvé 4 skupiny (sieť /64), IPv4
 * zapísaná v IPv6 (::ffff:a.b.c.d) ako IPv4. Neznámy tvar ostáva ako je.
 */
export function normalizujIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  const g = rozvinIpv6(s);
  if (!g) return s;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Sieť pre DENNÉ limity (tretie kolo, nález K3): IPv4 celá, IPv6 prvých 56
 * bitov. Domáca prípojka dostáva bežne delegovanú /56 (256 sietí /64) a tunel
 * zadarmo aj /48, takže na /64 stačilo útočníkovi 6 sietí jednej prípojky na
 * minutie spoločného stropu. Minútový limit ostáva na /64 (normalizujIp).
 * IPv4 zámerne nie /24: v jednej /24 sú bežne stovky zákazníkov poskytovateľa
 * (a za CGNAT celé mestá), limit 30 odpovedí modelom za deň by zasiahol
 * skutočných zákazníkov ľudovky; útočníka s viac IPv4 ohraničí atomický bazén
 * bezplatných obchodov (budget.js neuronovePolozky).
 */
export function sietIpDenna(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  const g = rozvinIpv6(s);
  if (!g) return s;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${[g[0], g[1], g[2], g[3] & 0xff00].map((x) => x.toString(16)).join(':')}::/56`;
}

async function sha256Bajty(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Kôš 0 až IP_KOSOV-1 pre (deň, sieť denných limitov) s tajomstvom. Jediné, čo
 * z IP ide do D1. Dve rôzne siete padnú do jedného koša zriedka (pri 200
 * návštevníkoch obchodu za deň asi 0,3 %) a vtedy len zdieľajú limit.
 * Pseudonym, nie anonym: kto má tajomstvo a konkrétnu IP, vie jej kôš
 * dopočítať; riadky sa preto mažú po 2 dňoch (pocty.js zmazStare).
 */
export async function kosIp(ip, den, sol = '') {
  const b = await sha256Bajty(`kos|${den}|${sietIpDenna(ip)}|${sol || ''}`);
  return ((b[0] << 8) | b[1]) % IP_KOSOV;
}

/** Odtlačok siete denných limitov pre kľúč KV (16 hex znakov), aby KV nenieslo holú IP. */
export async function odtlacokIpSiete(ip, sol = '') {
  const b = await sha256Bajty(`siet|${sietIpDenna(ip)}|${sol || ''}`);
  let hex = '';
  for (const x of b.slice(0, 8)) hex += (x < 16 ? '0' : '') + x.toString(16);
  return hex;
}

/** Odtlačok siete pre kľúč minútového limitu v KV (16 hex znakov), aby KV nenieslo holú IP. */
export async function odtlacokIpMinuta(ip, sol = '') {
  const b = await sha256Bajty(`min|${normalizujIp(ip)}|${sol || ''}`);
  let hex = '';
  for (const x of b.slice(0, 8)) hex += (x < 16 ? '0' : '') + x.toString(16);
  return hex;
}

// ---------------------------------------------------------------------------
// Input size limits
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 8000;
/**
 * Najdlhšia otázka, ktorú server pošle do vektora a modelu (nález 4 kontroly
 * kroku 1): dlhšia sa skráti. Predtým bolo číslo 2000 definované, ale nikde
 * sa nepoužívalo, a otázka mohla mať asi 7 900 znakov (asi +60 neurónov).
 * Widget má na poli ten istý maxlength.
 */
export const MAX_MESSAGE_CHARS = 500;
/** Najdlhšie pole darčeka (recipient, interests) do vektora a modelu. */
export const MAX_DARCEK_POLE_CHARS = 200;
export const MAX_MESSAGES = 20;

/** Skráti text na `max` znakov (po orezaní medzier), nikdy nehádže. */
export function skratText(text, max) {
  const s = String(text == null ? '' : text).trim();
  return s.length > max ? s.slice(0, max) : s;
}

export class InputTooLargeError extends Error {}

/** Throws InputTooLargeError if the raw request body text exceeds the byte cap. */
export function assertBodySize(text, maxBytes = MAX_BODY_BYTES) {
  const bytes = new TextEncoder().encode(text || '').length;
  if (bytes > maxBytes) {
    throw new InputTooLargeError(`request body ${bytes} bytes exceeds limit of ${maxBytes}`);
  }
}

// ---------------------------------------------------------------------------
// Prompt-injection guard
// ---------------------------------------------------------------------------

// Deliberately broad and multilingual (SK/CS/EN/DE): false positives here
// only mean a chunk gets flagged and reinforced with an extra reminder, they
// never delete or alter the underlying product text. Patterns are written
// without diacritics because detectInjection() strips them from the input
// first (product feeds are inconsistent about accents), so e.g. "všetky"
// and "vsetky" both match "vsetky" below.
const INJECTION_PATTERNS = [
  /ignore\s+(all|any|the)?\s*(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all|any|the)?\s*(previous|prior|above)/i,
  /forget\s+(all|your|any)\s+(previous|prior)\s+instructions?/i,
  /you\s+are\s+now\s+/i,
  /system\s*prompt/i,
  /new\s+instructions?\s*:/i,
  /ignoruj\s+(vsetky\s+)?(predchadzaj[uú]ce|predosle|vyssie uvedene)\s+(instrukcie|pokyny)/i,
  /nezohladnuj\s+(predchadzajuce|vyssie)/i,
  /zapomen\s+(na\s+)?(predchozi|predesle)\s+(instrukce|pokyny)/i,
  /ignorier[e]?\s+(alle\s+)?(vorherigen|bisherigen)\s+anweisungen/i,
];

/** Strip combining diacritical marks (NFD) so "všetky"/"vsetky" both match the same pattern. */
function stripDiacritics(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Does this text contain a recognisable prompt-injection attempt? */
export function detectInjection(text) {
  if (!text) return false;
  return INJECTION_PATTERNS.some((re) => re.test(stripDiacritics(text)));
}

/**
 * Wrap untrusted text (product data, shop facts) in an explicit, labelled
 * block for the prompt. Neutralises attempts to break out of the block by
 * escaping any literal fence markers, and never removes content: the model
 * is instructed (in the system prompt) to treat everything inside as data,
 * never as instructions, regardless of what it says.
 */
export function wrapUntrustedBlock(label, text) {
  const safe = String(text || '').replace(/```/g, "'''").replace(/<\/?untrusted-data>/gi, '');
  return `<${label}>\n${safe}\n</${label}>`;
}

/**
 * Scan a batch of retrieved product chunks for injection attempts. Returns
 * {flagged: boolean, flaggedIds: string[]} for logging/metadata; callers
 * still pass every product through wrapUntrustedBlock regardless, this is
 * purely observability, not a filter.
 */
export function scanForInjection(candidates) {
  const flaggedIds = candidates.filter((c) => detectInjection(`${c.title} ${c.description || ''}`)).map((c) => c.id);
  return { flagged: flaggedIds.length > 0, flaggedIds };
}
