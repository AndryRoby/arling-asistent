/*
 * zivotny-cyklus.js
 *
 * Životný cyklus účtu Asistenta podľa návrhu ops/asistent/zivotny-cyklus.md:
 * udalosti účtu v D1 (tabuľka tenant_udalosti), najviac štyri e-maily za
 * život účtu cez Resend, správy pre Andreja cez subscribe-service (ntfy),
 * zistenie, že si obchod Asistenta zapojil na web, 10-minútový cron
 * („dobeh“) a chránené admin cesty, z ktorých si udalosti ťahá Twenty CRM.
 *
 * Tri vypínače vo wrangler.toml [vars], všetky predvolene vypnuté, aby
 * samotný `wrangler deploy` nič neposlal skôr, než Fable dokončí zvyšok
 * (zásady súkromia, zápis v rozhodnutiach, subscribe-service):
 *   ASISTENT_EMAILY = "zapnute"   e-maily majiteľom obchodov (inak sa len
 *                                  zapisujú udalosti, e-mail nejde)
 *   ASISTENT_NTFY   = "zapnute"   pingy udalostí na subscribe-service
 *   ASISTENT_MAZANIE = "zapnute"  automatické zmazanie bezplatného účtu bez
 *                                  jediného rozhovoru za 12 mesiacov
 * Udalosti v D1 sa zapisujú vždy: sú to fakty o účte, nič neodchádza von.
 *
 * Pravidlá, ktoré tu platia bez výnimky:
 *   - E-mail ide len na tenants.contact_email, nikdy demo obchodu (doména v
 *     ALLOWED_ORIGINS alebo jej subdoména), adresa @arling.sk len ak je v
 *     tajomstve TEST_EMAILS, a nikdy na adresu, ktorej majiteľ na stránke
 *     zastavenia povedal „tohto Asistenta som nevytváral“ (asistent_potlacene).
 *   - Automatický e-mail len tomu, kto si Asistenta naozaj vytvoril
 *     (adverzárna kontrola 25. 9. 2026: formulár aj API dovolili zadať cudziu
 *     adresu a E0 odchádzal práve pri nenačítanom feede):
 *       E0 len adrese overenej 6-miestnym kódom (Bearer z /v1/ucet/over pri
 *          POST /v1/tenants alebo neskôr POST /v1/tenants/:id/overenie);
 *       E1 a E1W overenej adrese, alebo keď doména e-mailu aj adresa feedu
 *          patria doméne obchodu (a nejde o verejnú poštovú doménu);
 *       E2 až E4 len po skutočne odoslanom E1.
 *     Neoverené účty bez zhody domén nedostanú nič automaticky, len ručne cez
 *     admin cestu uvitaci-email.
 *   - Globálny denný strop automatických e-mailov (GLOBALNY_DENNY_STROP, v D1
 *     atomicky cez tabuľku asistent_strop), nad ním nejde nič a Andrej dostane
 *     jeden ping za deň. K tomu 3 e-maily E0/E1 na jednu adresu za deň.
 *   - Každý e-mail je v tabuľke riadok email:E<n> vložený cez INSERT OR
 *     IGNORE ešte pred odoslaním; kto riadok nevložil, neposiela. Resend
 *     dostane hlavičku Idempotency-Key (podporu overil tento agent v
 *     dokumentácii https://resend.com/docs/api-reference/emails/send-email
 *     25. 9. 2026: kľúč do 256 znakov, platí 24 hodín). Premenlivé údaje
 *     (počet produktov, čas zapojenia) sa pri prvom pokuse zmrazia do riadku,
 *     aby opakovanie poslalo rovnaké telo.
 *   - Strop 4 e-maily za život účtu (E1W sa ráta ako dva).
 *   - Automatické E0 a E1 len účtom, ktoré vznikli po nasadení tohto kódu
 *     (udalosť `vytvoreny` bez príznaku `spatne`). Staré účty dostanú e-mail
 *     len cez ručnú admin cestu uvitaci-email; E2 až E4 len účtom, ktorým
 *     E1 naozaj odišiel. Tak sa po nasadení nikdy nerozošle hromadný e-mail.
 *   - Zastavenie (odkaz v každom e-maile) zastaví všetky ďalšie e-maily
 *     vrátane E1; voliteľné E2, E3, E4 len so zastavovacím odkazom
 *     (UCET_TAJOMSTVO).
 *   - Nič z tohto modulu nesmie zhodiť chat, načítanie feedu ani doručenie
 *     widget.js: každá verejná funkcia chyby len zaloguje.
 *
 * O návštevníkoch e-shopu sa tu neukladá nič: z hlavičky Referer a Origin sa
 * berie len hostiteľ a ten sa porovná s doménou obchodu.
 */

import { getTenantById, listTenants, isPrivateHost, monthKey, dayKey, publicPlanName, conversationsUsedThisMonth } from './tenants.js';
import { domainMatches, hostnameFromOrigin, parseAllowedOrigins, bezpecnePorovnaj, corsHeaders, checkRateLimit, SECURITY_HEADERS } from './security.js';
import { DEFAULT_QUOTA_PING_URL, thresholdsCrossed } from './notify.js';
import { vytvorEmail, JAZYKY_EMAILOV, WIDGET_ORIGIN, castiDatumu } from './zivotny-cyklus-texty.js';
import { overenyEmailZBearer } from './ucet.js';

// ---------------------------------------------------------------------------
// Konštanty
// ---------------------------------------------------------------------------

export const ODOSIELATEL = 'ARLing Asistent <asistent@mail.arling.sk>';
export const ODPOVED_NA = 'andrej@arling.sk';
export const RESEND_URL = 'https://api.resend.com/emails';
export const STROP_EMAILOV = 4;
export const MAX_POKUSOV = 3;
export const DENNY_STROP_ADRESY = 3; // E0/E1 na jednu adresu za deň naprieč obchodmi
export const GLOBALNY_DENNY_STROP = 30; // všetky automatické e-maily spolu za deň (UTC)
export const PING_NOVY_DENNY_STROP = 20; // pingy „nový účet“ pre neoverené účty za deň
export const WORDPRESS_ODKLAD_MS = 15 * 60 * 1000;
export const E0_ODKLAD_MS = 10 * 60 * 1000;
export const E3_PO_MS = 72 * 60 * 60 * 1000;
export const ZASEKNUTY_MS = 15 * 60 * 1000;
export const CACHE_WIDGET_MS = 10 * 60 * 1000;
export const AKTIVNY_ROZHOVOROV = 10;
export const AKTIVNY_DNI = 3;
export const UDALOSTI_UCHOVAVANIE_MESIACOV = 24;
export const NEAKTIVNY_UCET_MESIACOV = 12;
export const DOBEH_OKNO_DNI = 11; // E3 najneskôr 10 dní po E1, s rezervou
// D1: najviac 1000 dopytov na jedno spustenie Workera pri Workers Paid
// (https://developers.cloudflare.com/d1/platform/limits/). Rezerva na e-maily.
export const DOBEH_MAX_DOPYTOV = 800;
export const DOBEH_REZERVA_NA_UCET = 40;
export const VEKTORY_MAX = 20000;
export const ZDROJE = ['formular', 'wordpress', 'shopify', 'api'];

// Verejné poštové domény: zhoda „doména e-mailu = doména obchodu“ pri nich nič
// nedokazuje (ktokoľvek by si mohol nárokovať obchod gmail.com).
export const VEREJNE_POSTOVE_DOMENY = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'seznam.cz', 'centrum.sk', 'centrum.cz', 'azet.sk', 'zoznam.sk', 'email.cz', 'post.cz', 'web.de', 'gmx.de', 'gmx.net', 'gmx.at', 't-online.de', 'protonmail.com', 'proton.me', 'pobox.sk', 'post.sk', 'aol.com', 'mail.com', 'yandex.com', 'zoho.com']);

const DEN_MS = 24 * 60 * 60 * 1000;

/**
 * Titulky ntfy, ktoré má pridať subscribe-service (products/subscribe-service/app.py,
 * PING_TITLES; mení Fable, mimo rozsahu tohto workera). Každý okrem platby
 * nesie „(nie platba)“; platbu hlási len licence-service. Test drží, že
 * žiadny z nich neznie ako predaj.
 */
export const NTFY_TITULKY = {
  asistent_novy: 'Asistent: nový skúšobný účet (nie platba)',
  asistent_ready: 'Asistent: produkty načítané (nie platba)',
  asistent_chyba: 'Asistent: produkty sa nenačítali (nie platba)',
  asistent_zapojeny: 'Asistent: zapojený na webe {domena} (nie platba)',
  asistent_otazka: 'Asistent: prvá otázka na webe {domena} (nie platba)',
  asistent_aktivny: 'Asistent: aktívne používaný na {domena} (nie platba)',
  asistent_email_chyba: 'Asistent: e-mail sa neodoslal (nie platba)',
  asistent_email_overit: 'Asistent: e-mail treba overiť v Resende (nie platba)',
  asistent_strop: 'Asistent: denný strop e-mailov dosiahnutý (nie platba)',
  asistent_stop: 'Asistent: zákazník zastavil e-maily (nie platba)',
  asistent_odmietnuty: 'Asistent: niekto odmietol účet, ktorý nevytvoril (nie platba)',
  asistent_zruseny: 'Asistent: predplatné zrušené, {domena} (nie platba)',
  quota_80: 'Asistent: 80 % bezplatného limitu (nie platba)',
  quota_100: 'Asistent: limit vyčerpaný (nie platba)',
};

// ---------------------------------------------------------------------------
// SQL (presné reťazce, rozpoznáva ich tests/helpers/mock-d1.mjs)
// ---------------------------------------------------------------------------

export const ZC_SQL = {
  CREATE_UDALOSTI: `CREATE TABLE IF NOT EXISTS tenant_udalosti (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, typ TEXT NOT NULL, kluc TEXT NOT NULL, kedy TEXT NOT NULL, data TEXT, UNIQUE (tenant_id, kluc))`,
  CREATE_STROP: `CREATE TABLE IF NOT EXISTS asistent_strop (den TEXT NOT NULL, poradie INTEGER NOT NULL, kedy TEXT NOT NULL, PRIMARY KEY (den, poradie))`,
  CREATE_POTLACENE: `CREATE TABLE IF NOT EXISTS asistent_potlacene (hash TEXT PRIMARY KEY, kedy TEXT NOT NULL)`,
  CREATE_ZMAZANE: `CREATE TABLE IF NOT EXISTS tenant_zmazane (tenant_id TEXT PRIMARY KEY, kedy TEXT NOT NULL)`,
  ADD_JAZYK: `ALTER TABLE tenants ADD COLUMN jazyk TEXT`,
  ADD_ZDROJ: `ALTER TABLE tenants ADD COLUMN zdroj TEXT`,
  ADD_EMAILY_STOP: `ALTER TABLE tenants ADD COLUMN emaily_stop_at TEXT`,
  ADD_WEB_CONVERSATIONS: `ALTER TABLE counters ADD COLUMN web_conversations INTEGER NOT NULL DEFAULT 0`,
  INSERT_UDALOST: `INSERT OR IGNORE INTO tenant_udalosti (tenant_id, typ, kluc, kedy, data) VALUES (?, ?, ?, ?, ?)`,
  LIST_UDALOSTI_TENANTA: `SELECT * FROM tenant_udalosti WHERE tenant_id = ? ORDER BY id`,
  LIST_UDALOSTI_PO: `SELECT * FROM tenant_udalosti WHERE id > ? ORDER BY id LIMIT ?`,
  SET_UDALOST_DATA: `UPDATE tenant_udalosti SET data = ? WHERE tenant_id = ? AND kluc = ?`,
  CAS_UDALOST_DATA: `UPDATE tenant_udalosti SET data = ? WHERE tenant_id = ? AND kluc = ? AND data = ?`,
  SET_JAZYK_ZDROJ: `UPDATE tenants SET jazyk = ?, zdroj = ? WHERE id = ?`,
  SET_JAZYK: `UPDATE tenants SET jazyk = ? WHERE id = ?`,
  SET_EMAILY_STOP: `UPDATE tenants SET emaily_stop_at = ? WHERE id = ? AND emaily_stop_at IS NULL`,
  INC_WEB_CONVERSATIONS: `UPDATE counters SET web_conversations = web_conversations + 1 WHERE tenant_id = ? AND day = ?`,
  COUNTERS_OD: `SELECT day, conversations, web_conversations FROM counters WHERE tenant_id = ? AND day >= ?`,
  TENANTY_PODLA_DOMEN: `SELECT id, domain, status FROM tenants WHERE domain IN (?, ?, ?)`,
  // Dobeh: len účty s prácou (udalosť za posledných DOBEH_OKNO_DNI dní alebo
  // e-mail, ktorý treba zopakovať), najnovšia aktivita prvá.
  TENANTY_S_PRACOU: `SELECT tenant_id FROM tenant_udalosti WHERE kedy > ? OR (typ = 'email' AND (data LIKE '%"stav":"zlyhal"%' OR data LIKE '%"stav":"odosiela"%')) GROUP BY tenant_id ORDER BY MAX(id) DESC`,
  ZAPOJENE_BEZ_AKTIVNEHO: `SELECT DISTINCT tenant_id FROM tenant_udalosti WHERE typ = 'zapojeny' AND tenant_id NOT IN (SELECT tenant_id FROM tenant_udalosti WHERE typ = 'aktivny')`,
  POCET_STROP: `SELECT COUNT(*) AS n FROM asistent_strop WHERE den = ? AND poradie > 0`,
  INSERT_STROP: `INSERT OR IGNORE INTO asistent_strop (den, poradie, kedy) VALUES (?, ?, ?)`,
  DELETE_STARY_STROP: `DELETE FROM asistent_strop WHERE den < ?`,
  JE_POTLACENA: `SELECT hash FROM asistent_potlacene WHERE hash = ?`,
  INSERT_POTLACENA: `INSERT OR IGNORE INTO asistent_potlacene (hash, kedy) VALUES (?, ?)`,
  INSERT_ZMAZANY: `INSERT OR IGNORE INTO tenant_zmazane (tenant_id, kedy) VALUES (?, ?)`,
  LIST_ZMAZANE: `SELECT tenant_id, kedy FROM tenant_zmazane ORDER BY kedy`,
  DELETE_TENANT: `DELETE FROM tenants WHERE id = ?`,
  DELETE_COUNTERS: `DELETE FROM counters WHERE tenant_id = ?`,
  DELETE_UDALOSTI: `DELETE FROM tenant_udalosti WHERE tenant_id = ?`,
  DELETE_STARE_UDALOSTI: `DELETE FROM tenant_udalosti WHERE kedy < ?`,
};

// ---------------------------------------------------------------------------
// Migrácia bez straty dát (rovnaký vzor ako ensureBillingColumns v tenants.js)
// ---------------------------------------------------------------------------

const schemaHotova = new WeakSet();

/**
 * Pridá tabuľky tenant_udalosti, asistent_strop, asistent_potlacene,
 * tenant_zmazane a stĺpce jazyk, zdroj, emaily_stop_at,
 * counters.web_conversations, ak ešte nie sú. Nič nemaže ani neprepisuje:
 * CREATE TABLE IF NOT EXISTS a ALTER TABLE ADD COLUMN, chyba „duplicate
 * column“ znamená, že to už urobil iný izolát. Ostatné chyby prebublú.
 */
export async function zabezpecSchemu(db) {
  if (!db) return;
  const kluc = db.__povodna || db;
  if (schemaHotova.has(kluc)) return;
  for (const sql of [ZC_SQL.CREATE_UDALOSTI, ZC_SQL.CREATE_STROP, ZC_SQL.CREATE_POTLACENE, ZC_SQL.CREATE_ZMAZANE]) {
    await db.prepare(sql).run();
  }
  for (const sql of [ZC_SQL.ADD_JAZYK, ZC_SQL.ADD_ZDROJ, ZC_SQL.ADD_EMAILY_STOP, ZC_SQL.ADD_WEB_CONVERSATIONS]) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      const message = String((err && err.message) || err);
      if (!/duplicate column/i.test(message)) throw err;
    }
  }
  schemaHotova.add(kluc);
}

// ---------------------------------------------------------------------------
// Malé pomocné funkcie
// ---------------------------------------------------------------------------

function varuj(co, err) {
  console.warn(`[arling-asistent] zivotny cyklus: ${co}:`, (err && err.message) || err);
}

async function spusti(waitUntil, promise) {
  if (typeof waitUntil === 'function') {
    waitUntil(promise);
    return undefined;
  }
  return promise;
}

function parsujData(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

function zmeny(res) {
  return (res && res.meta && res.meta.changes) || (res && res.changes) || 0;
}

/** Jazyk z formulára alebo pluginu: prázdny = null (určí sa neskôr podľa domény), nepodporovaný = en. */
export function jazykZoVstupu(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === 'auto') return null;
  const l = s.replace('_', '-').slice(0, 2);
  return JAZYKY_EMAILOV.includes(l) ? l : 'en';
}

/** Jazyk e-mailov účtu: uložený jazyk, inak koncovka domény (.sk, .cz, .de a .at), inak angličtina. */
export function jazykUctu(tenant) {
  if (tenant && JAZYKY_EMAILOV.includes(tenant.jazyk)) return tenant.jazyk;
  const d = String((tenant && tenant.domain) || '').toLowerCase();
  if (d.endsWith('.sk')) return 'sk';
  if (d.endsWith('.cz')) return 'cs';
  if (d.endsWith('.de') || d.endsWith('.at')) return 'de';
  return 'en';
}

/** Odkiaľ účet vznikol: pole zdroj, pri starom plugine bez neho hlavička User-Agent WordPress/..., inak api. */
export function zdrojZoVstupu(raw, userAgent) {
  const s = String(raw || '').trim().toLowerCase();
  if (ZDROJE.includes(s)) return s;
  if (/^wordpress\//i.test(String(userAgent || ''))) return 'wordpress';
  return 'api';
}

/** Demo obchod: doména je v ALLOWED_ORIGINS alebo je jej subdoménou (README „Demo tenanti“). */
export function jeDemo(env, domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return true;
  return parseAllowedOrigins(env && env.ALLOWED_ORIGINS).some((a) => domainMatches(d, a));
}

function jeNasHost(env, host) {
  return parseAllowedOrigins(env && env.ALLOWED_ORIGINS).some((a) => domainMatches(host, a));
}

function adresaPovolena(env, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return false;
  const domena = e.slice(e.lastIndexOf('@') + 1);
  if (domena === 'arling.sk' || domena.endsWith('.arling.sk')) {
    const testovacie = String((env && env.TEST_EMAILS) || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return testovacie.includes(e);
  }
  return true;
}

const bezWww = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
const patri = (host, domena) => !!host && !!domena && (host === domena || host.endsWith(`.${domena}`));

/**
 * Doména e-mailu aj adresa feedu patria doméne obchodu (a nejde o verejnú
 * poštovú doménu). Slabšie overenie než kód, ale zaútočiť sa tým dá len na
 * skutočného majiteľa domény a len skutočným feedom jeho obchodu; stačí to na
 * E1 (nie na E0, ktorý ide aj bez feedu).
 */
export function domenaSedi(tenant) {
  if (!tenant) return false;
  const e = String(tenant.contact_email || '').trim().toLowerCase();
  if (!e.includes('@')) return false;
  const domenaEmailu = bezWww(e.slice(e.lastIndexOf('@') + 1));
  const obchod = bezWww(tenant.domain);
  if (!obchod || VEREJNE_POSTOVE_DOMENY.has(obchod) || VEREJNE_POSTOVE_DOMENY.has(domenaEmailu)) return false;
  let feedHost = '';
  try {
    feedHost = bezWww(new URL(tenant.feed_url).hostname);
  } catch (e2) {
    return false;
  }
  return patri(domenaEmailu, obchod) && patri(feedHost, obchod);
}

/** 'kod' (adresa potvrdená kódom), 'domena' (zhoda domén) alebo null. */
export function overenieUctu(tenant, udalosti) {
  const v = najdi(udalosti, 'vytvoreny');
  if ((v && v.data.overeny) || najdi(udalosti, 'overeny')) return 'kod';
  if (domenaSedi(tenant)) return 'domena';
  return null;
}

function najdi(udalosti, kluc) {
  return (udalosti || []).find((u) => u.kluc === kluc) || null;
}

function pocetEmailov(udalosti) {
  return (udalosti || []).filter((u) => u.typ === 'email' && u.data.stav !== 'nad_strop').length;
}

function vek(now, iso) {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) ? now.getTime() - t : Infinity;
}

function neskorsi(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** Pracovný deň 9:00 až 17:00 v Bratislave (sviatky sa nerátajú, to je vedomé zjednodušenie). */
export function jePracovnyCas(now) {
  const c = castiDatumu(now);
  return c.denTyzdna >= 1 && c.denTyzdna <= 5 && c.hodina >= 9 && c.hodina < 17;
}

/** Platforma pre návod: plugin, typ feedu z načítania, inak odhad z adresy feedu. */
export function platformaUctu(tenant, udalosti) {
  if (tenant && tenant.zdroj === 'wordpress') return 'wordpress';
  const feed = String((tenant && tenant.feed_url) || '').toLowerCase();
  // Eshop-rychle dáva Heureka feed, ale vlastný kód sa vkladá inde ako v
  // Shoptete. Feed Eshop-rychle má tvar /fotky<číslo>/xml/ (ľudovka:
  // https://www.ludovka.eu/fotky40717/xml/heureka_sk.xml, ops/asistent/integracie/PLAN-INTEGRACII.md:68).
  if (/eshop-rychl[eo]/.test(feed) || /\/fotky\d+\/xml\//.test(feed)) return 'eshoprychle';
  if (/shoptet/.test(feed)) return 'shoptet';
  const ready = najdi(udalosti, 'ready');
  const typ = ready && ready.data.feed_type;
  if (typ === 'woocommerce') return 'woocommerce';
  if (typ === 'shopify') return 'shopify';
  if (typ === 'heureka') return 'heureka';
  if (/heureka|upgates/.test(feed)) return 'heureka';
  if (/myshopify|\/products\.json/.test(feed)) return 'shopify';
  if (/wc\/store|rest_route=|wp-json/.test(feed)) return 'woocommerce';
  return 'vseobecne';
}

// ---------------------------------------------------------------------------
// Udalosti
// ---------------------------------------------------------------------------

/** Vloží udalosť; true len ak riadok naozaj pribudol (to je zámok proti dvojitému e-mailu či pingu). */
export async function zaznamenaj(env, tenantId, typ, kluc, data = {}, now = new Date(), kedy) {
  await zabezpecSchemu(env.DB);
  const res = await env.DB
    .prepare(ZC_SQL.INSERT_UDALOST)
    .bind(tenantId, typ, kluc, kedy || now.toISOString(), JSON.stringify(data || {}))
    .run();
  return zmeny(res) === 1;
}

export async function udalostiTenanta(db, tenantId) {
  await zabezpecSchemu(db);
  const res = await db.prepare(ZC_SQL.LIST_UDALOSTI_TENANTA).bind(tenantId).all();
  return ((res && res.results) || []).map((r) => ({ ...r, dataRaw: r.data, data: parsujData(r.data) }));
}

async function nastavData(db, tenantId, kluc, data) {
  await db.prepare(ZC_SQL.SET_UDALOST_DATA).bind(JSON.stringify(data), tenantId, kluc).run();
}

// ---------------------------------------------------------------------------
// ntfy cez subscribe-service
// ---------------------------------------------------------------------------

/**
 * GET {QUOTA_PING_URL}?e=<udalosť>&t=<doména s bodkami>&p=<krátky údaj>&d=<popis>.
 * Posiela sa len pri ASISTENT_NTFY = "zapnute": subscribe-service dnes tieto
 * udalosti nepozná (PING_EVENTS) a z `t` maže bodky (app.py:278), takže bez
 * jeho úpravy by ping skončil 400 alebo zobrazil „ludovkaeu“. Nikdy nevyhodí.
 */
export async function pingni(env, event, { domena = '', p = '', d = '' } = {}) {
  try {
    if (!env || env.ASISTENT_NTFY !== 'zapnute') return false;
    const baseUrl = env.QUOTA_PING_URL !== undefined ? env.QUOTA_PING_URL : DEFAULT_QUOTA_PING_URL;
    if (!baseUrl) return false;
    const url = new URL(baseUrl);
    url.searchParams.set('e', event);
    url.searchParams.set('t', String(domena || '-').slice(0, 64));
    if (p !== '' && p != null) url.searchParams.set('p', String(p).slice(0, 20));
    if (d) url.searchParams.set('d', String(d).slice(0, 200));
    const fetchImpl = env.fetchImpl || fetch;
    const headers = env.PING_TOKEN ? { 'X-Ping-Token': env.PING_TOKEN } : {};
    const res = await fetchImpl(url.toString(), { method: 'GET', headers });
    if (res && res.ok === false) {
      console.warn(`[arling-asistent] ping ${event} vratil HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    varuj(`ping ${event}`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Odkaz na zastavenie e-mailov (HMAC, návrh 2.6)
// ---------------------------------------------------------------------------

function bytesZBase64(b64) {
  const bin = atob(String(b64).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Podpis pre zastavenie e-mailov jedného účtu, alebo null bez UCET_TAJOMSTVO (voliteľné e-maily sa potom neposielajú). */
export async function podpisStop(env, tenantId) {
  if (!env || !env.UCET_TAJOMSTVO) return null;
  const kluc = await crypto.subtle.importKey('raw', bytesZBase64(env.UCET_TAJOMSTVO), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', kluc, new TextEncoder().encode(`asistent-emaily:${tenantId}`));
  return base64Url(new Uint8Array(sig));
}

function verejnaUrl(env) {
  return String((env && env.ASISTENT_VEREJNA_URL) || WIDGET_ORIGIN).replace(/\/$/, '');
}

export async function odkazStop(env, tenantId) {
  const podpis = await podpisStop(env, tenantId);
  if (!podpis) return null;
  return `${verejnaUrl(env)}/v1/tenants/${encodeURIComponent(tenantId)}/emaily/stop?k=${podpis}`;
}

// ---------------------------------------------------------------------------
// Adresy: hash, potlačené adresy, denné stropy
// ---------------------------------------------------------------------------

async function hashAdresy(email) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(email).trim().toLowerCase()));
  return Array.from(new Uint8Array(buf)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Adresa, ktorej majiteľ povedal „tohto Asistenta som nevytváral“: nikdy žiadny e-mail k žiadnemu účtu. */
export async function jePotlacena(env, email) {
  await zabezpecSchemu(env.DB);
  const r = await env.DB.prepare(ZC_SQL.JE_POTLACENA).bind(await hashAdresy(email)).first();
  return !!r;
}

async function dennyKlucAdresy(email, now) {
  return `email-den:${await hashAdresy(email)}:${dayKey(now)}`;
}

async function dennyPocet(env, email, now) {
  const kv = env.ASISTENT_CACHE;
  if (!kv) return 0;
  try {
    return Number(await kv.get(await dennyKlucAdresy(email, now))) || 0;
  } catch (e) {
    return 0;
  }
}

async function dennyPripocitaj(env, email, now, pred) {
  const kv = env.ASISTENT_CACHE;
  if (!kv) return;
  try {
    await kv.put(await dennyKlucAdresy(email, now), String(pred + 1), { expirationTtl: 2 * 24 * 60 * 60 });
  } catch (e) {
    varuj('denny strop adresy', e);
  }
}

function globalnyStrop(env) {
  const n = Number(env && env.ASISTENT_DENNY_STROP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : GLOBALNY_DENNY_STROP;
}

/**
 * Zaberie jedno miesto v dennom strope automatických e-mailov. Atomicky: riadok
 * (deň, poradie) je PRIMARY KEY, dvaja súbežní odosielatelia nedostanú to isté
 * poradie. Pri plnom strope pošle raz za deň ping (riadok s poradím 0).
 */
async function zaberGlobalnySlot(env, now) {
  const strop = globalnyStrop(env);
  const den = dayKey(now);
  for (let pokus = 0; pokus < 5; pokus++) {
    const r = await env.DB.prepare(ZC_SQL.POCET_STROP).bind(den).first();
    const n = Number(r && r.n) || 0;
    if (n >= strop) {
      const prvy = zmeny(await env.DB.prepare(ZC_SQL.INSERT_STROP).bind(den, 0, now.toISOString()).run()) === 1;
      if (prvy) await pingni(env, 'asistent_strop', { p: String(strop), d: `${strop} automatickych e-mailov za ${den} UTC, dalsie dnes nejdu` });
      return false;
    }
    const res = await env.DB.prepare(ZC_SQL.INSERT_STROP).bind(den, n + 1, now.toISOString()).run();
    if (zmeny(res) === 1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// E-maily
// ---------------------------------------------------------------------------

const NEVYHNUTNE = new Set(['E0', 'E1', 'E1W']);

function klucEmailu(kod) {
  return kod === 'E1W' ? 'email:E1' : `email:${kod}`;
}

/** Smie tento e-mail ísť? {ok, dovod}. Všetky pravidlá zo spoločnej časti návrhu (2.1, 2.2) na jednom mieste. */
export function mozeIst(env, tenant, kod, udalosti, { rucne = false } = {}) {
  const nie = (dovod) => ({ ok: false, dovod });
  if (!env || env.ASISTENT_EMAILY !== 'zapnute') return nie('vypnute');
  if (!env.RESEND_API_KEY) return nie('bez_resend_kluca');
  if (!tenant) return nie('bez_uctu');
  if (jeDemo(env, tenant.domain)) return nie('demo');
  if (!adresaPovolena(env, tenant.contact_email)) return nie('adresa');
  // Zastavenie platí pre všetko vrátane E0, E1 a E1W: pätička sľubuje, že po
  // kliknutí už nepríde nič (adverzárna kontrola 25. 9. 2026, nález 2).
  if (tenant.emaily_stop_at || najdi(udalosti, 'emaily_stop')) return nie('zastavene');
  if (najdi(udalosti, klucEmailu(kod))) return nie('uz_je');
  if (pocetEmailov(udalosti) + (kod === 'E1W' ? 2 : 1) > STROP_EMAILOV) return nie('strop');

  const vytvoreny = najdi(udalosti, 'vytvoreny');
  const ready = najdi(udalosti, 'ready');
  const zapojeny = najdi(udalosti, 'zapojeny');

  if (NEVYHNUTNE.has(kod)) {
    if (!rucne) {
      if (!vytvoreny || vytvoreny.data.spatne) return nie('stary_ucet');
      const over = overenieUctu(tenant, udalosti);
      // E0 ide aj bez načítaného feedu, preto len adrese potvrdenej kódom.
      if (kod === 'E0' && over !== 'kod') return nie('neovereny');
      if (!over) return nie('neovereny');
    }
    if (kod === 'E0') return ready || tenant.status === 'ready' ? nie('uz_ready') : { ok: true };
    if (tenant.status !== 'ready') return nie('nie_ready');
    if (kod === 'E1W' && (!zapojeny || najdi(udalosti, 'email:E2'))) return nie('nezapojeny');
    return { ok: true };
  }

  if (!env.UCET_TAJOMSTVO) return nie('bez_tajomstva');
  const e1 = najdi(udalosti, 'email:E1');
  if (!e1 || e1.data.stav !== 'odoslany') return nie('bez_e1');
  if (kod === 'E2' && !zapojeny) return nie('nezapojeny');
  if (kod === 'E3' && (zapojeny || najdi(udalosti, 'email:E0'))) return nie('zapojeny_alebo_e0');
  // Ručne napísaný uvítací e-mail už bol osobná pomoc so zapojením (ako E0).
  if (kod === 'E3' && e1.data.rucne) return nie('rucna_pomoc');
  if (kod === 'E4' && publicPlanName(tenant.plan) !== 'free') return nie('plateny_plan');
  return { ok: true };
}

function feedHostUctu(tenant) {
  try {
    return new URL(tenant.feed_url).hostname;
  } catch (e) {
    return '';
  }
}

function parametreEmailu(tenant, data, udalosti, stop) {
  const ready = najdi(udalosti, 'ready');
  const zapojeny = najdi(udalosti, 'zapojeny');
  const params = data.params || {};
  // Zmrazené pri prvom pokuse (posliEmail), aby opakovanie s tým istým
  // Idempotency-Key poslalo to isté telo. Staršie riadky bez nich: živé údaje.
  const pocet = params.pocet != null ? Number(params.pocet) : Number(tenant.product_count) || (ready && Number(ready.data.product_count)) || 0;
  const kedyZapojenia = params.zapojene_kedy || (zapojeny && zapojeny.kedy) || tenant.created_at || 0;
  return {
    domena: tenant.domain,
    tenantId: tenant.id,
    pocet,
    platforma: data.platforma,
    zdroj: tenant.zdroj,
    datum: new Date(tenant.created_at || 0),
    kedy: new Date(kedyZapojenia),
    // E0 uvádza len hostiteľa feedu, nikdy celú adresu ako odkaz (adresu
    // zadal ktokoľvek, v e-maile z mail.arling.sk by bola phishingom).
    feedHost: feedHostUctu(tenant),
    chybaKod: params.chyba_kod,
    used: params.used,
    quota: params.quota,
    mesiac: params.mesiac,
    dalsiMesiac: new Date(params.dalsi_mesiac || tenant.created_at || 0),
    ucet: `https://arling.sk/asistent/tenant/?t=${encodeURIComponent(tenant.id)}`,
    skusit: `https://arling.sk/asistent/live/?t=${encodeURIComponent(tenant.id)}&shop=${encodeURIComponent(tenant.domain)}`,
    stop,
    volitelne: !!stop && !tenant.emaily_stop_at,
    anglickaVeta: !!data.anglicka_veta,
  };
}

/** Názov chyby z tela odpovede Resendu (name alebo type), inak prázdny reťazec. */
async function nazovChybyResendu(res) {
  try {
    const telo = res && typeof res.json === 'function' ? await res.json() : null;
    return String((telo && (telo.name || telo.type || telo.error)) || '');
  } catch (e) {
    return '';
  }
}

/**
 * Jeden POST do Resendu pre už zabraný riadok email:E<n>. Stav riadku po
 * odpovedi: odoslany (2xx), zamietnuty (4xx okrem 429 a 409 pri súbežnom
 * kľúči, už nikdy znova), overit (409 invalid_idempotent_request: kľúč už
 * bol použitý s iným telom, prvý pokus mohol prejsť, treba pozrieť v
 * Resende), zlyhal (5xx, 429, 409 concurrent_idempotent_requests, sieť;
 * cron skúsi znova), vzdany (po MAX_POKUSOV). Kódy 409 podľa
 * https://resend.com/docs/dashboard/emails/idempotency-keys.
 */
async function odosli(env, tenant, kluc, data, udalosti, now) {
  const stop = await odkazStop(env, tenant.id);
  let sprava;
  try {
    sprava = vytvorEmail(data.sablona, data.jazyk, parametreEmailu(tenant, data, udalosti, stop));
  } catch (err) {
    varuj('zostavenie e-mailu', err);
    await nastavData(env.DB, tenant.id, kluc, { ...data, stav: 'zamietnuty', chyba: 'sablona' });
    return { poslane: false, stav: 'zamietnuty' };
  }
  const hlavicky = {};
  if (stop) {
    hlavicky['List-Unsubscribe'] = `<${stop}>`;
    hlavicky['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const fetchImpl = env.fetchImpl || fetch;
  let http = 0;
  let resendId = null;
  let chybaNazov = '';
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `asistent-${tenant.id}-${kluc.slice('email:'.length)}`,
      },
      body: JSON.stringify({
        from: ODOSIELATEL,
        to: [tenant.contact_email],
        reply_to: ODPOVED_NA,
        subject: sprava.predmet,
        text: sprava.text,
        html: sprava.html,
        headers: hlavicky,
      }),
    });
    http = (res && res.status) || 0;
    if (res && res.ok !== false && http >= 200 && http < 300) {
      try {
        const telo = typeof res.json === 'function' ? await res.json() : null;
        resendId = (telo && telo.id) || null;
      } catch (e) {
        resendId = null;
      }
    } else if (http === 409) {
      chybaNazov = await nazovChybyResendu(res);
    }
  } catch (err) {
    varuj(`odoslanie ${data.sablona}`, err);
    http = 0;
  }

  const opakovat = () => ((data.pokusy || 1) >= MAX_POKUSOV ? 'vzdany' : 'zlyhal');
  let stav;
  if (http >= 200 && http < 300) stav = 'odoslany';
  else if (http === 409 && /concurrent_idempotent/i.test(chybaNazov)) stav = opakovat();
  else if (http === 409 && /invalid_idempotent/i.test(chybaNazov)) stav = 'overit';
  else if (http >= 400 && http < 500 && http !== 429) stav = 'zamietnuty';
  else stav = opakovat();

  const nove = { ...data, stav, http, ...(chybaNazov ? { chyba: chybaNazov.slice(0, 60) } : {}), ...(resendId ? { resend_id: resendId } : {}), ...(stav === 'odoslany' ? { odoslane_at: now.toISOString() } : {}) };
  await nastavData(env.DB, tenant.id, kluc, nove);
  if (stav === 'zamietnuty' || stav === 'vzdany') {
    await pingni(env, 'asistent_email_chyba', { domena: tenant.domain, p: data.sablona, d: `${data.sablona}, Resend HTTP ${http || 'bez odpovede'}` });
  } else if (stav === 'overit') {
    await pingni(env, 'asistent_email_overit', { domena: tenant.domain, p: data.sablona, d: `${data.sablona}, Resend 409 ${chybaNazov}, prvy pokus mohol prejst` });
  }
  return { poslane: stav === 'odoslany', stav, http };
}

/**
 * Pošle e-mail `kod` (E0, E1, E1W, E2, E3, E4) jeden raz za život účtu.
 * Vracia {poslane, dovod?, stav?}. `params` sa uložia do riadku e-mailu, aby
 * cron pri opakovaní poslal to isté (kód chyby, použité/limit pri E4, počet
 * produktov a čas zapojenia v čase prvého pokusu).
 */
export async function posliEmail(env, tenant, kod, { now = new Date(), rucne = false, anglickaVeta = false, platforma, params = {} } = {}) {
  try {
    if (!env || !env.DB || !tenant) return { poslane: false, dovod: 'bez_uctu' };
    let udalosti = await udalostiTenanta(env.DB, tenant.id);
    const moze = mozeIst(env, tenant, kod, udalosti, { rucne });
    if (!moze.ok) return { poslane: false, dovod: moze.dovod };
    if (await jePotlacena(env, tenant.contact_email)) return { poslane: false, dovod: 'potlacena' };

    let pred = 0;
    if (NEVYHNUTNE.has(kod)) {
      pred = await dennyPocet(env, tenant.contact_email, now);
      if (pred >= DENNY_STROP_ADRESY) return { poslane: false, dovod: 'denny_strop_adresy' };
    }
    // Globálny strop len pre automatické e-maily; ručný e-mail posiela Andrej vedome.
    if (!rucne && !(await zaberGlobalnySlot(env, now))) return { poslane: false, dovod: 'globalny_strop' };

    const ready = najdi(udalosti, 'ready');
    const zapojeny = najdi(udalosti, 'zapojeny');
    const kluc = klucEmailu(kod);
    const data = {
      stav: 'odosiela',
      pokusy: 1,
      sablona: kod,
      jazyk: jazykUctu(tenant),
      platforma: platforma || platformaUctu(tenant, udalosti),
      params: {
        ...params,
        pocet: Number(tenant.product_count) || (ready && Number(ready.data.product_count)) || 0,
        zapojene_kedy: (zapojeny && zapojeny.kedy) || null,
      },
      anglicka_veta: !!anglickaVeta,
      pokus_at: now.toISOString(),
    };
    const zabrane = await zaznamenaj(env, tenant.id, 'email', kluc, data, now);
    if (!zabrane) return { poslane: false, dovod: 'uz_je' };
    if (kod === 'E1W') await zaznamenaj(env, tenant.id, 'email', 'email:E2', { stav: 'spojeny', sablona: 'E1W' }, now);
    if (NEVYHNUTNE.has(kod)) await dennyPripocitaj(env, tenant.contact_email, now, pred);

    // Poistka proti súbehu: strop sa overí aj po zabratí.
    udalosti = await udalostiTenanta(env.DB, tenant.id);
    if (pocetEmailov(udalosti) > STROP_EMAILOV) {
      await nastavData(env.DB, tenant.id, kluc, { ...data, stav: 'nad_strop' });
      return { poslane: false, dovod: 'strop' };
    }
    return await odosli(env, tenant, kluc, data, udalosti, now);
  } catch (err) {
    varuj(`e-mail ${kod}`, err);
    return { poslane: false, dovod: 'chyba' };
  }
}

/** E1 po načítaní, alebo spojený E1W, keď obchod Asistenta už stihol načítať. */
async function posliUvodny(env, tenant, opts = {}) {
  const udalosti = await udalostiTenanta(env.DB, tenant.id);
  const kod = najdi(udalosti, 'zapojeny') ? 'E1W' : 'E1';
  return posliEmail(env, tenant, kod, opts);
}

// ---------------------------------------------------------------------------
// Háky volané z onboarding.js, chat.js, gift.js a index.js
// ---------------------------------------------------------------------------

async function pingNovyPovoleny(env, now) {
  const kv = env.ASISTENT_CACHE;
  if (!kv) return true;
  const kluc = `ping-novy:${dayKey(now)}`;
  try {
    const n = Number(await kv.get(kluc)) || 0;
    if (n >= PING_NOVY_DENNY_STROP) return false;
    await kv.put(kluc, String(n + 1), { expirationTtl: 2 * 24 * 60 * 60 });
  } catch (e) {
    varuj('strop pingov nový účet', e);
  }
  return true;
}

/**
 * Nový obchod z POST /v1/tenants: uloží jazyk a zdroj, zapíše `vytvoreny`
 * (s príznakom `overeny`, keď adresu potvrdil kód), ping. Ping za neoverený
 * účet bez zhody domén má vlastný denný strop, aby sa nedal použiť na
 * zahltenie Andrejovho telefónu.
 */
export async function poVytvoreni(env, tenant, { jazyk = null, zdroj = 'api', overeny = false, now = new Date(), waitUntil } = {}) {
  try {
    await zabezpecSchemu(env.DB);
    await env.DB.prepare(ZC_SQL.SET_JAZYK_ZDROJ).bind(jazyk, zdroj, tenant.id).run();
    tenant.jazyk = jazyk;
    tenant.zdroj = zdroj;
    if (jeDemo(env, tenant.domain)) return;
    const feedHost = feedHostUctu(tenant);
    const nove = await zaznamenaj(env, tenant.id, 'vytvoreny', 'vytvoreny', { zdroj, jazyk, feed_host: feedHost, overeny: !!overeny }, now);
    if (nove && env.ASISTENT_NTFY === 'zapnute') {
      const over = overeny ? 'kod' : domenaSedi(tenant) ? 'domena' : null;
      if (over || (await pingNovyPovoleny(env, now))) {
        const popisOverenia = over === 'kod' ? 'e-mail overeny kodom' : over === 'domena' ? 'domena e-mailu sedi' : 'e-mail neovereny, automaticke e-maily nejdu';
        await spusti(waitUntil, pingni(env, 'asistent_novy', { domena: tenant.domain, p: zdroj, d: `${tenant.domain}, zdroj ${zdroj}, ${popisOverenia}, jazyk ${jazyk || jazykUctu(tenant) + ' (odhad z domeny)'}` }));
      }
    }
  } catch (err) {
    varuj('po vytvoreni', err);
  }
}

/**
 * Majiteľ potvrdil adresu kódom (POST /v1/tenants s Bearer tokenom pri už
 * existujúcom obchode, alebo POST /v1/tenants/:id/overenie). Zapíše
 * `overeny`; ak sú produkty už načítané a uvítací e-mail ešte neodišiel,
 * pošle ho hneď. E0 pri chybe pošle dobeh (10 minút po chybe).
 */
export async function poOvereniMajitela(env, tenant, { now = new Date(), waitUntil } = {}) {
  try {
    if (!tenant || jeDemo(env, tenant.domain)) return { nove: false };
    const nove = await zaznamenaj(env, tenant.id, 'overeny', 'overeny', { sposob: 'kod' }, now);
    if (!nove) return { nove: false };
    const udalosti = await udalostiTenanta(env.DB, tenant.id);
    const ready = najdi(udalosti, 'ready');
    if (tenant.status === 'ready' && ready && !ready.data.spatne && !najdi(udalosti, 'email:E1') && tenant.zdroj !== 'wordpress') {
      await spusti(waitUntil, posliUvodny(env, tenant, { now }));
    }
    return { nove: true };
  } catch (err) {
    varuj('po overeni', err);
    return { nove: false };
  }
}

/** Majiteľ (overený e-mailom) poslal formulár znova s jazykom: zapamätať si ho. */
export async function nastavJazyk(env, tenantId, jazyk) {
  try {
    if (!jazyk) return;
    await zabezpecSchemu(env.DB);
    await env.DB.prepare(ZC_SQL.SET_JAZYK).bind(jazyk, tenantId).run();
  } catch (err) {
    varuj('nastavenie jazyka', err);
  }
}

/**
 * Id vektorov obchodu v KV (vektory:<tenant>) pre úplný výmaz: Vectorize nevie
 * vypísať vektory podľa metadát a dopyt po zmazaní ešte chvíľu vracia staré
 * id. Zjednotenie so starším zoznamom, aby výmaz zasiahol aj produkty, ktoré
 * z feedu medzitým zmizli. Nikdy nevyhodí.
 */
export async function zapamatajVektory(env, tenantId, ids) {
  try {
    const kv = env && env.ASISTENT_CACHE;
    if (!kv || !Array.isArray(ids) || ids.length === 0) return;
    const stare = await nacitajIdsVektorov(env, tenantId);
    const spolu = Array.from(new Set([...ids, ...stare])).slice(0, VEKTORY_MAX);
    await kv.put(`vektory:${tenantId}`, JSON.stringify(spolu));
  } catch (err) {
    varuj('zoznam vektorov', err);
  }
}

async function nacitajIdsVektorov(env, tenantId) {
  const kv = env && env.ASISTENT_CACHE;
  if (!kv) return [];
  try {
    const raw = await kv.get(`vektory:${tenantId}`);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((id) => String(id).startsWith(`${tenantId}::`)) : [];
  } catch (e) {
    return [];
  }
}

/**
 * Po každom načítaní feedu. `bolReady` = obchod bol ready už pred týmto
 * načítaním (nočná obnova starého obchodu): udalosť ready sa vtedy zapíše
 * s príznakom `spatne` a bez e-mailu a pingu.
 */
export async function poNacitani(env, tenant, result, { bolReady = false, now = new Date() } = {}) {
  try {
    if (!tenant || jeDemo(env, tenant.domain)) return;
    if (result && result.ok) {
      const data = { product_count: result.productCount || 0, feed_type: result.feedType || null, truncated: !!result.truncated };
      if (bolReady) data.spatne = true;
      const nove = await zaznamenaj(env, tenant.id, 'ready', 'ready', data, now);
      if (!nove || bolReady) return;
      const aktualny = (await getTenantById(env.DB, tenant.id)) || tenant;
      let email = { poslane: false, dovod: 'wordpress_odklad' };
      if (aktualny.zdroj !== 'wordpress') email = await posliUvodny(env, aktualny, { now });
      await pingni(env, 'asistent_ready', {
        domena: aktualny.domain,
        p: String(data.product_count),
        d: `${aktualny.domain}, ${data.product_count} produktov, e-mail E1 ${email.poslane ? 'odoslany' : 'neodoslany (' + (email.dovod || email.stav) + ')'}`,
      });
      return;
    }
    const udalosti = await udalostiTenanta(env.DB, tenant.id);
    if (najdi(udalosti, 'ready')) return;
    const code = (result && result.code) || 'neznamy';
    const nove = await zaznamenaj(env, tenant.id, 'chyba', 'chyba', { code }, now);
    if (nove) {
      const e0 = overenieUctu(tenant, udalosti) === 'kod' ? 'e-mail E0 o 10 minut, ak sa to neopravi' : 'bez E0 (adresa neoverena kodom)';
      await pingni(env, 'asistent_chyba', { domena: tenant.domain, p: code, d: `${tenant.domain}, ${code}, ${e0}` });
    }
  } catch (err) {
    varuj('po nacitani', err);
  }
}

async function poZapojeni(env, tenant, udalost, now) {
  await pingni(env, 'asistent_zapojeny', { domena: tenant.domain, p: udalost.signal, d: `signal ${udalost.signal}, ${udalost.host}` });
  const udalosti = await udalostiTenanta(env.DB, tenant.id);
  const e1 = najdi(udalosti, 'email:E1');
  if (e1 && e1.data.stav === 'odoslany') return posliEmail(env, tenant, 'E2', { now });
  if (!e1 && tenant.status === 'ready') return posliEmail(env, tenant, 'E1W', { now });
  return null;
}

function prvyDenDalsiehoMesiaca(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Po rozhovore v /v1/chat alebo /v1/gift, ktorý prešiel kvótou. Zapojenie
 * len z Origin na doméne obchodu (nie arling.sk, nie lokálne adresy);
 * prvá otázka a web_conversations len keď sa rozhovor naozaj započítal a
 * nejde o náhľad v administrácii WordPressu (surface: "admin").
 */
export async function poRozhovore(env, tenant, { origin = '', surface = 'web', quota = null, now = new Date() } = {}) {
  try {
    if (!tenant || jeDemo(env, tenant.domain)) return;
    await zabezpecSchemu(env.DB);

    if (quota && quota.counted) {
      const mesiac = monthKey(now);
      for (const prah of thresholdsCrossed(quota.used - 1, quota.used, quota.quota)) {
        const nove = await zaznamenaj(env, tenant.id, `limit_${prah}`, `limit_${prah}:${mesiac}`, { used: quota.used, quota: quota.quota }, now);
        if (nove && prah === 80) {
          await posliEmail(env, tenant, 'E4', {
            now,
            params: { used: quota.used, quota: quota.quota, mesiac: now.getUTCMonth() + 1, dalsi_mesiac: prvyDenDalsiehoMesiaca(now).toISOString() },
          });
        }
      }
    }

    const host = hostnameFromOrigin(origin);
    if (!host || isPrivateHost(host) || jeNasHost(env, host) || !domainMatches(host, tenant.domain)) return;
    const jeAdminPlocha = surface === 'admin';

    const zap = { signal: 'chat', host, surface: jeAdminPlocha ? 'admin' : 'web' };
    if (await zaznamenaj(env, tenant.id, 'zapojeny', 'zapojeny', zap, now)) {
      await poZapojeni(env, tenant, zap, now);
    }

    if (!jeAdminPlocha && quota && quota.counted) {
      await env.DB.prepare(ZC_SQL.INC_WEB_CONVERSATIONS).bind(tenant.id, dayKey(now)).run();
      if (await zaznamenaj(env, tenant.id, 'prva_otazka', 'prva_otazka', { host }, now)) {
        await pingni(env, 'asistent_otazka', { domena: tenant.domain, d: host });
      }
    }
  } catch (err) {
    varuj('po rozhovore', err);
  }
}

// Izolátová cache pre GET /widget.js: hostiteľ -> {tenantId|null, zapojeny, do}.
// Kľúčovaná podľa väzby D1, aby sa testy s vlastnou databázou nemiešali.
const widgetCache = new WeakMap();
const WIDGET_CACHE_MAX = 1000;

function cachePre(db) {
  let m = widgetCache.get(db);
  if (!m) {
    m = new Map();
    widgetCache.set(db, m);
  }
  return m;
}

/** Stránky administrácie WordPressu (náhľad v plugine) nie sú zapojenie na webe. */
function jeAdministracia(url) {
  return /^\/(wp-admin|wp-login\.php)(\/|$|\?)/i.test(url.pathname);
}

/**
 * GET /widget.js s hlavičkou Referer: ak doména stránky patrí obchodu, zapíše
 * `zapojeny`. Bez Referer, z arling.sk, z lokálnej adresy, z administrácie
 * WordPressu alebo pre neznámu doménu nič. Prvé stretnutie s hostiteľom v
 * izoláte stojí jeden dopyt, potom 10 minút nič. Beží cez ctx.waitUntil,
 * chyba skript nikdy nezdrží.
 */
export async function poWidgetJs(env, request, { now = new Date() } = {}) {
  try {
    if (!env || !env.DB) return;
    const ref = request.headers.get('Referer') || '';
    if (!ref) return;
    let url;
    try {
      url = new URL(ref);
    } catch (e) {
      return;
    }
    const host = url.hostname.toLowerCase();
    if (!host || isPrivateHost(host) || jeNasHost(env, host) || jeAdministracia(url)) return;

    const cache = cachePre(env.DB);
    const t = now.getTime();
    const zaznam = cache.get(host);
    const platny = zaznam && zaznam.do > t;
    if (platny && (zaznam.tenantId === null || zaznam.zapojeny)) return;

    let tenantId = platny ? zaznam.tenantId : undefined;
    if (tenantId === undefined) {
      const bez = host.replace(/^www\./, '');
      const res = await env.DB.prepare(ZC_SQL.TENANTY_PODLA_DOMEN).bind(host, bez, `www.${bez}`).all();
      const najdeny = ((res && res.results) || []).find((r) => domainMatches(host, r.domain));
      // Plná cache: vyhodiť najstarší záznam, nie všetky (náhodné hostiteľské
      // mená v Referer by inak zakaždým zmazali aj skutočné obchody).
      if (cache.size >= WIDGET_CACHE_MAX) cache.delete(cache.keys().next().value);
      if (!najdeny || jeDemo(env, najdeny.domain)) {
        cache.set(host, { tenantId: null, zapojeny: false, do: t + CACHE_WIDGET_MS });
        return;
      }
      tenantId = najdeny.id;
    }

    const zap = { signal: 'widget_js', host };
    const nove = await zaznamenaj(env, tenantId, 'zapojeny', 'zapojeny', zap, now);
    cache.set(host, { tenantId, zapojeny: true, do: t + CACHE_WIDGET_MS });
    if (nove) {
      const tenant = await getTenantById(env.DB, tenantId);
      if (tenant) await poZapojeni(env, tenant, zap, now);
    }
  } catch (err) {
    varuj('widget.js', err);
  }
}

/** Po PATCH /plan: udalosť plan, a pri páde z plateného na free aj `zruseny`. */
export async function poZmenePlanu(env, predtym, { plan, billingRef = null, validUntil = null, now = new Date() } = {}) {
  try {
    if (!predtym || jeDemo(env, predtym.domain)) return;
    const stary = publicPlanName(predtym.plan);
    await zaznamenaj(env, predtym.id, 'plan', `plan:${plan}:${billingRef || '-'}`, { plan, predtym: stary, billing_ref: billingRef, valid_until: validUntil }, now);
    if (stary !== 'free' && plan === 'free' && predtym.billing_ref) {
      if (await zaznamenaj(env, predtym.id, 'zruseny', `zruseny:${predtym.billing_ref}`, { plati_do: predtym.valid_until || null, zdroj: 'plan' }, now)) {
        await pingni(env, 'asistent_zruseny', { domena: predtym.domain, d: `plati do ${predtym.valid_until || 'neuvedene'}` });
      }
    }
  } catch (err) {
    varuj('po zmene planu', err);
  }
}

// ---------------------------------------------------------------------------
// Cron každých 10 minút („dobeh“) a denná údržba
// ---------------------------------------------------------------------------

/**
 * D1 s počítadlom dopytov: dobeh a údržba sa zastavia skôr, než narazia na
 * limit dopytov jedného spustenia Workera. Schéma sa rozpozná podľa pôvodnej
 * väzby (__povodna), takže sa kvôli obalu nespúšťa znova.
 */
function sPocitadlom(db, pocitadlo) {
  const obal = (st) => ({
    bind: (...a) => obal(st.bind(...a)),
    run: () => { pocitadlo.n += 1; return st.run(); },
    all: () => { pocitadlo.n += 1; return st.all(); },
    first: (...a) => { pocitadlo.n += 1; return st.first(...a); },
  });
  return { __povodna: db.__povodna || db, prepare: (sql) => obal(db.prepare(sql)) };
}

async function opakujEmaily(env, tenant, udalosti, now, vysledky) {
  for (const u of udalosti) {
    if (u.typ !== 'email') continue;
    const d = u.data;
    const pokusy = Number(d.pokusy) || 1;
    const zaseknuty = d.stav === 'odosiela' && vek(now, d.pokus_at) > ZASEKNUTY_MS;
    if (!(d.stav === 'zlyhal' || zaseknuty)) continue;
    if (pokusy >= MAX_POKUSOV) {
      await nastavData(env.DB, tenant.id, u.kluc, { ...d, stav: 'vzdany' });
      await pingni(env, 'asistent_email_chyba', { domena: tenant.domain, p: d.sablona, d: `${d.sablona}, po ${pokusy} pokusoch` });
      continue;
    }
    if (env.ASISTENT_EMAILY !== 'zapnute' || !env.RESEND_API_KEY) continue;
    // Majiteľ medzitým zastavil e-maily: opakovanie nejde, riadok ostáva.
    if (tenant.emaily_stop_at || najdi(udalosti, 'emaily_stop')) continue;
    const nove = { ...d, stav: 'odosiela', pokusy: pokusy + 1, pokus_at: now.toISOString() };
    const res = await env.DB.prepare(ZC_SQL.CAS_UDALOST_DATA).bind(JSON.stringify(nove), tenant.id, u.kluc, u.dataRaw).run();
    if (zmeny(res) !== 1) continue; // iný beh ho už zobral
    const r = await odosli(env, tenant, u.kluc, nove, udalosti, now);
    vysledky.push({ tenant: tenant.id, email: d.sablona, opakovanie: pokusy + 1, ...r });
  }
}

async function skontrolujAktivny(env, tenant, udalosti, now) {
  if (!najdi(udalosti, 'zapojeny') || najdi(udalosti, 'aktivny')) return false;
  const od = dayKey(new Date(now.getTime() - 13 * DEN_MS));
  const res = await env.DB.prepare(ZC_SQL.COUNTERS_OD).bind(tenant.id, od).all();
  const riadky = (res && res.results) || [];
  const spolu = riadky.reduce((s, r) => s + (Number(r.web_conversations) || 0), 0);
  const dni = riadky.filter((r) => (Number(r.web_conversations) || 0) > 0).length;
  if (spolu < AKTIVNY_ROZHOVOROV || dni < AKTIVNY_DNI) return false;
  if (await zaznamenaj(env, tenant.id, 'aktivny', 'aktivny', { rozhovory_14d: spolu, dni }, now)) {
    await pingni(env, 'asistent_aktivny', { domena: tenant.domain, p: String(spolu), d: `${spolu} rozhovorov z webu za 14 dni, ${dni} dni` });
    return true;
  }
  return false;
}

async function readIngestErrorKod(env, tenantId) {
  if (!env.ASISTENT_CACHE) return null;
  try {
    return (await env.ASISTENT_CACHE.get(`ingest-error:${tenantId}`)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 10-minútový beh: dobehne neodoslané e-maily, pošle odložené E0 a E1
 * (WordPress, alebo po neskoršom overení adresy), E2 po zapojení, E3 po 72
 * hodinách a zapíše `aktivny`. Číta len účty s prácou (TENANTY_S_PRACOU, jeden
 * dopyt) a skončí pred limitom dopytov D1 (`prerusene` v prehľade).
 * Vracia prehľad pre logy a testy.
 */
export async function dobeh(env, { now = new Date(), maxDopytov = DOBEH_MAX_DOPYTOV } = {}) {
  const prehlad = { tenanty: 0, emaily: [], aktivne: [], prerusene: false, dopyty: 0 };
  const pocitadlo = { n: 0 };
  try {
    await zabezpecSchemu(env.DB);
    const envP = { ...env, DB: sPocitadlom(env.DB, pocitadlo) };
    const od = new Date(now.getTime() - DOBEH_OKNO_DNI * DEN_MS).toISOString();
    const res = await envP.DB.prepare(ZC_SQL.TENANTY_S_PRACOU).bind(od).all();
    const ids = ((res && res.results) || []).map((r) => r.tenant_id);
    for (const id of ids) {
      if (pocitadlo.n + DOBEH_REZERVA_NA_UCET > maxDopytov) {
        prehlad.prerusene = true;
        varuj('dobeh', `prerusene pred limitom D1 po ${pocitadlo.n} dopytoch, ${ids.length - prehlad.tenanty} uctov nabuduce`);
        break;
      }
      try {
        const tenant = await getTenantById(envP.DB, id);
        if (!tenant || jeDemo(env, tenant.domain)) continue;
        prehlad.tenanty += 1;
        let udalosti = await udalostiTenanta(envP.DB, tenant.id);
        if (udalosti.length === 0) continue;
        await opakujEmaily(envP, tenant, udalosti, now, prehlad.emaily);
        udalosti = await udalostiTenanta(envP.DB, tenant.id);

        const ready = najdi(udalosti, 'ready');
        const chyba = najdi(udalosti, 'chyba');
        const zapojeny = najdi(udalosti, 'zapojeny');
        const overenyU = najdi(udalosti, 'overeny');
        const e1 = najdi(udalosti, 'email:E1');
        const skus = async (kod, opts = {}) => {
          const r = await posliEmail(envP, tenant, kod, { now, ...opts });
          if (r.poslane || r.stav) prehlad.emaily.push({ tenant: tenant.id, email: kod, ...r });
          return r;
        };

        // E0: chyba trvá aspoň 10 minút a obchod nikdy nebol ready. Okno 3 dní
        // sa ráta od neskoršej z udalostí chyba a overeny (adresa potvrdená neskôr).
        if (chyba && !ready && tenant.status === 'error' && vek(now, chyba.kedy) >= E0_ODKLAD_MS
          && vek(now, neskorsi(chyba.kedy, overenyU && overenyU.kedy)) < 3 * DEN_MS && !najdi(udalosti, 'email:E0')) {
          const kod = (await readIngestErrorKod(env, tenant.id)) || chyba.data.code;
          await skus('E0', { params: { chyba_kod: kod } });
        }

        // E1: WordPress po 15 minútach, ostatné ako záchrana, ak neodišiel hneď
        // (alebo keď adresu majiteľ potvrdil až po načítaní).
        if (ready && !ready.data.spatne && !e1 && vek(now, neskorsi(ready.kedy, overenyU && overenyU.kedy)) < DEN_MS) {
          const wp = tenant.zdroj === 'wordpress';
          if (!wp || vek(now, ready.kedy) >= WORDPRESS_ODKLAD_MS) {
            await skus(zapojeny ? 'E1W' : 'E1');
          }
        }

        udalosti = await udalostiTenanta(envP.DB, tenant.id);
        const e1Teraz = najdi(udalosti, 'email:E1');

        // E2: zapojenie, ktoré sa stalo, keď už E1 odišiel, a E2 ešte nešiel.
        if (zapojeny && e1Teraz && e1Teraz.data.stav === 'odoslany' && !najdi(udalosti, 'email:E2') && vek(now, zapojeny.kedy) < 7 * DEN_MS) {
          await skus('E2');
        }

        // E3: 72 hodín po E1, bez zapojenia, v pracovný deň 9:00 až 17:00 v Bratislave.
        if (!zapojeny && e1Teraz && e1Teraz.data.stav === 'odoslany' && !najdi(udalosti, 'email:E3')) {
          const odE1 = vek(now, e1Teraz.data.odoslane_at || e1Teraz.kedy);
          if (odE1 >= E3_PO_MS && odE1 < 10 * DEN_MS && jePracovnyCas(now)) await skus('E3');
        }

        if (await skontrolujAktivny(envP, tenant, udalosti, now)) prehlad.aktivne.push(tenant.id);
      } catch (err) {
        varuj(`dobeh ${id}`, err);
      }
    }
  } catch (err) {
    varuj('dobeh', err);
  }
  prehlad.dopyty = pocitadlo.n;
  return prehlad;
}

function mesiaceSpat(now, mesiacov) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - mesiacov, now.getUTCDate()));
}

/**
 * Raz denne (s nočnou obnovou feedov): zmaže udalosti staršie ako 24
 * mesiacov a staré riadky denného stropu, dopočíta `aktivny` pre obchody
 * zapojené dávnejšie, než vidí dobeh, a len pri ASISTENT_MAZANIE = "zapnute"
 * zmaže bezplatné účty bez jediného rozhovoru za posledných 12 mesiacov
 * (návrh 6.3). Všetko s počítadlom dopytov D1.
 */
export async function dennaUdrzba(env, { now = new Date(), maxDopytov = DOBEH_MAX_DOPYTOV } = {}) {
  const vysledok = { stare_udalosti: 0, zmazane_ucty: [], aktivne: [], prerusene: false };
  const pocitadlo = { n: 0 };
  try {
    await zabezpecSchemu(env.DB);
    const envP = { ...env, DB: sPocitadlom(env.DB, pocitadlo) };
    const res = await envP.DB.prepare(ZC_SQL.DELETE_STARE_UDALOSTI).bind(mesiaceSpat(now, UDALOSTI_UCHOVAVANIE_MESIACOV).toISOString()).run();
    vysledok.stare_udalosti = zmeny(res);
    await envP.DB.prepare(ZC_SQL.DELETE_STARY_STROP).bind(dayKey(new Date(now.getTime() - 7 * DEN_MS))).run();

    const zapojene = await envP.DB.prepare(ZC_SQL.ZAPOJENE_BEZ_AKTIVNEHO).all();
    for (const r of (zapojene && zapojene.results) || []) {
      if (pocitadlo.n + 10 > maxDopytov) { vysledok.prerusene = true; break; }
      const tenant = await getTenantById(envP.DB, r.tenant_id);
      if (!tenant || jeDemo(env, tenant.domain)) continue;
      const udalosti = [{ kluc: 'zapojeny', data: {} }];
      if (await skontrolujAktivny(envP, tenant, udalosti, now)) vysledok.aktivne.push(tenant.id);
    }

    if (env.ASISTENT_MAZANIE !== 'zapnute') return vysledok;
    const hranica = mesiaceSpat(now, NEAKTIVNY_UCET_MESIACOV);
    for (const tenant of await listTenants(envP.DB)) {
      if (pocitadlo.n + 20 > maxDopytov) { vysledok.prerusene = true; break; }
      if (jeDemo(env, tenant.domain) || publicPlanName(tenant.plan) !== 'free') continue;
      if (new Date(tenant.created_at || now).getTime() > hranica.getTime()) continue;
      const c = await envP.DB.prepare(ZC_SQL.COUNTERS_OD).bind(tenant.id, dayKey(hranica)).all();
      const rozhovory = ((c && c.results) || []).reduce((s, x) => s + (Number(x.conversations) || 0), 0);
      if (rozhovory > 0) continue;
      await zmazTenanta(envP, tenant.id, { now });
      vysledok.zmazane_ucty.push(tenant.id);
    }
  } catch (err) {
    varuj('denna udrzba', err);
  }
  return vysledok;
}

// ---------------------------------------------------------------------------
// Zmazanie účtu
// ---------------------------------------------------------------------------

/**
 * Zmaže vektory, kód chyby a zoznam vektorov v KV, udalosti, počítadlá a
 * riadok obchodu. Predtým zapíše do tenant_zmazane (len id a čas, bez
 * osobných údajov), aby sa o výmaze dozvedel aj ops/crm/asistent.mjs a
 * zmazal záznam v Twenty.
 *
 * Vektory: najprv podľa zoznamu id z KV (zapamatajVektory pri každom
 * načítaní), potom záchranný dopyt s filtrom tenant pre staršie účty bez
 * zoznamu. Dopyt sa končí, keď vráti už raz zmazané id (deleteByIds je
 * asynchrónne, index ich chvíľu ešte vracia), takže sa netočí nad tou istou
 * dávkou. KV kľúče conv:* a quota-notified:* sa nedajú vymenovať, vypršia
 * samy (24 hodín, 40 dní). Správanie proti ostrému Vectorize: NEOVERENÉ (v
 * testoch len mock).
 */
export async function zmazTenanta(env, tenantId, { now = new Date() } = {}) {
  await zabezpecSchemu(env.DB);
  await env.DB.prepare(ZC_SQL.INSERT_ZMAZANY).bind(tenantId, now.toISOString()).run();
  const zmazane = new Set();
  if (env.VECTORIZE && typeof env.VECTORIZE.deleteByIds === 'function') {
    const zname = await nacitajIdsVektorov(env, tenantId);
    for (let i = 0; i < zname.length; i += 500) {
      const davka = zname.slice(i, i + 500).filter((id) => !zmazane.has(id));
      if (!davka.length) continue;
      try {
        await env.VECTORIZE.deleteByIds(davka);
        for (const id of davka) zmazane.add(id);
      } catch (e) {
        varuj('mazanie vektorov podla zoznamu', e);
        break;
      }
    }
    if (typeof env.VECTORIZE.query === 'function') {
      const dim = Number(env.VECTOR_DIM) || 1024;
      const vektor = new Array(dim).fill(0);
      vektor[0] = 1;
      for (let i = 0; i < 20; i++) {
        let ids = [];
        try {
          const res = await env.VECTORIZE.query(vektor, { topK: 50, filter: { tenant: tenantId }, returnMetadata: false });
          ids = ((res && res.matches) || []).map((m) => m.id).filter((id) => String(id).startsWith(`${tenantId}::`));
        } catch (e) {
          varuj('mazanie vektorov', e);
          break;
        }
        const nove = ids.filter((id) => !zmazane.has(id));
        if (nove.length === 0) break;
        try {
          await env.VECTORIZE.deleteByIds(nove);
        } catch (e) {
          varuj('mazanie vektorov', e);
          break;
        }
        for (const id of nove) zmazane.add(id);
      }
    }
  }
  if (env.ASISTENT_CACHE && typeof env.ASISTENT_CACHE.delete === 'function') {
    for (const kluc of [`ingest-error:${tenantId}`, `vektory:${tenantId}`]) {
      try {
        await env.ASISTENT_CACHE.delete(kluc);
      } catch (e) {
        varuj('mazanie KV', e);
      }
    }
  }
  await env.DB.prepare(ZC_SQL.DELETE_UDALOSTI).bind(tenantId).run();
  await env.DB.prepare(ZC_SQL.DELETE_COUNTERS).bind(tenantId).run();
  const res = await env.DB.prepare(ZC_SQL.DELETE_TENANT).bind(tenantId).run();
  return { zmazany: zmeny(res) === 1, vektory: zmazane.size };
}

// ---------------------------------------------------------------------------
// HTTP cesty
// ---------------------------------------------------------------------------

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra },
  });
}

function tokenZHlavicky(request) {
  return request.headers.get('X-Admin-Token') || '';
}

/** Čítanie udalostí (Twenty CRM, ranný brief): ADMIN_TOKEN alebo samostatný ASISTENT_ADMIN_CITANIE. */
function jeAdminCitanie(request, env) {
  const token = tokenZHlavicky(request);
  if (!token || !env) return false;
  return (!!env.ADMIN_TOKEN && bezpecnePorovnaj(token, env.ADMIN_TOKEN))
    || (!!env.ASISTENT_ADMIN_CITANIE && bezpecnePorovnaj(token, env.ASISTENT_ADMIN_CITANIE));
}

/** Cesty volané licence-service (plán, zrušenie): ADMIN_TOKEN. */
function jeAdmin(request, env) {
  return !!(env && env.ADMIN_TOKEN) && bezpecnePorovnaj(tokenZHlavicky(request), env.ADMIN_TOKEN);
}

/**
 * Zápis, ktorý maže alebo posiela e-maily (DELETE, doplnit, uvitaci-email):
 * len samostatné tajomstvo ASISTENT_ADMIN_ZAPIS, ktoré nepozná licence-service
 * ani CRM skript. Bez neho sú tieto cesty zatvorené (503), nikdy nie otvorené.
 * Vracia Response pri odmietnutí, inak null.
 */
function strazZapisu(request, env) {
  if (!env || !env.ASISTENT_ADMIN_ZAPIS) return json({ error: 'admin_zapis_nenastaveny' }, 503);
  if (!bezpecnePorovnaj(tokenZHlavicky(request), env.ASISTENT_ADMIN_ZAPIS)) return json({ error: 'unauthorized' }, 401);
  return null;
}

async function citajJson(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

/**
 * GET /v1/admin/asistent/udalosti?po=<id>&limit=<1..500>, X-Admin-Token
 * (ADMIN_TOKEN alebo ASISTENT_ADMIN_CITANIE). Zdroj pre Twenty CRM
 * (ops/crm/asistent.mjs) a ranný brief. Demo obchody chýbajú;
 * contact_email je len tu, nikdy vo verejnom /status. `zmazane` je zoznam
 * zmazaných účtov (id a čas, bez osobných údajov), aby CRM zmazalo aj svoj
 * záznam.
 */
export async function handleAdminUdalostiRoute(request, env) {
  if (!jeAdminCitanie(request, env)) return json({ error: 'unauthorized' }, 401);
  await zabezpecSchemu(env.DB);
  const url = new URL(request.url);
  const po = Math.max(0, parseInt(url.searchParams.get('po') || '0', 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
  const res = await env.DB.prepare(ZC_SQL.LIST_UDALOSTI_PO).bind(po, limit).all();
  const riadky = (res && res.results) || [];
  const tenanti = {};
  const vynechane = new Set();
  const udalosti = [];
  const now = new Date();
  for (const r of riadky) {
    if (vynechane.has(r.tenant_id)) continue;
    if (!tenanti[r.tenant_id]) {
      const t = await getTenantById(env.DB, r.tenant_id);
      if (!t || jeDemo(env, t.domain)) {
        vynechane.add(r.tenant_id);
        continue;
      }
      tenanti[r.tenant_id] = {
        domain: t.domain,
        contact_email: t.contact_email,
        jazyk: jazykUctu(t),
        jazyk_zvoleny: t.jazyk || null,
        zdroj: t.zdroj || null,
        plan: publicPlanName(t.plan),
        status: t.status,
        product_count: Number(t.product_count) || 0,
        created_at: t.created_at,
        monthly_quota: t.monthly_quota,
        conversations_used: conversationsUsedThisMonth(t, now),
        billing_ref: t.billing_ref || null,
        valid_until: t.valid_until || null,
        emaily_stop_at: t.emaily_stop_at || null,
        domena_sedi: domenaSedi(t),
      };
    }
    udalosti.push({ id: r.id, tenant_id: r.tenant_id, typ: r.typ, kluc: r.kluc, kedy: r.kedy, data: parsujData(r.data) });
  }
  const z = await env.DB.prepare(ZC_SQL.LIST_ZMAZANE).all();
  const zmazane = ((z && z.results) || []).map((x) => ({ tenant_id: x.tenant_id, kedy: x.kedy }));
  const posledne = riadky.length ? riadky[riadky.length - 1].id : po;
  return json({ udalosti, tenanti, zmazane, dalsi: riadky.length === limit ? posledne : null, posledne_id: posledne });
}

/**
 * POST /v1/admin/asistent/doplnit?po=<poradie>&limit=<1..300>
 * (ASISTENT_ADMIN_ZAPIS): jednorazové spätné doplnenie `vytvoreny` a `ready` s
 * pôvodnými časmi, bez e-mailov a pingov. Po dávkach (obchody zoradené podľa
 * id), aby jedno volanie nenarazilo na limit dopytov D1; `dalsi` je `po` pre
 * ďalšie volanie, null na konci.
 */
export async function handleAdminDoplnitRoute(request, env) {
  const straz = strazZapisu(request, env);
  if (straz) return straz;
  await zabezpecSchemu(env.DB);
  const url = new URL(request.url);
  const po = Math.max(0, parseInt(url.searchParams.get('po') || '0', 10) || 0);
  const limit = Math.min(300, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
  const now = new Date();
  let vytvorene = 0;
  let ready = 0;
  const vsetky = (await listTenants(env.DB)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const davka = vsetky.slice(po, po + limit);
  for (const t of davka) {
    if (jeDemo(env, t.domain)) continue;
    if (await zaznamenaj(env, t.id, 'vytvoreny', 'vytvoreny', { spatne: true, zdroj: t.zdroj || null, jazyk: t.jazyk || null }, now, t.created_at || now.toISOString())) vytvorene += 1;
    if (t.status === 'ready' && (await zaznamenaj(env, t.id, 'ready', 'ready', { spatne: true, product_count: Number(t.product_count) || 0 }, now, t.last_ingested_at || t.created_at || now.toISOString()))) ready += 1;
  }
  const dalsi = po + limit < vsetky.length ? po + limit : null;
  return json({ vytvoreny: vytvorene, ready, spracovane: davka.length, dalsi });
}

/**
 * POST /v1/admin/asistent/uvitaci-email {tenant_id, jazyk?, anglicka_veta?, platforma?, rucne_odoslany?}
 * (ASISTENT_ADMIN_ZAPIS). Ručné E1 (alebo E0 pri chybe) pre účet, ktorý
 * vznikol pred týmto kódom alebo nemá overenú adresu. Zámok email:E1 platí aj
 * tu: druhé volanie nič nepošle. Zastavenie a potlačená adresa platia aj tu.
 * S `rucne_odoslany: {odoslane_at, resend_id?, poznamka?}` sa nič neposiela,
 * len sa zapíše, že uvítací e-mail už odišiel inou cestou.
 */
export async function handleAdminUvitaciEmailRoute(request, env) {
  const straz = strazZapisu(request, env);
  if (straz) return straz;
  let body;
  try {
    body = await citajJson(request);
  } catch (e) {
    return json({ error: 'invalid_json' }, 400);
  }
  const tenantId = body && body.tenant_id;
  const tenant = tenantId ? await getTenantById(env.DB, tenantId) : null;
  if (!tenant) return json({ error: 'not_found' }, 404);
  if (jeDemo(env, tenant.domain)) return json({ error: 'demo' }, 400);
  await zabezpecSchemu(env.DB);
  const jazyk = body.jazyk ? jazykZoVstupu(body.jazyk) : null;
  if (jazyk) {
    await env.DB.prepare(ZC_SQL.SET_JAZYK).bind(jazyk, tenant.id).run();
    tenant.jazyk = jazyk;
  }
  const udalosti = await udalostiTenanta(env.DB, tenant.id);
  const kod = tenant.status === 'ready' ? (najdi(udalosti, 'zapojeny') ? 'E1W' : 'E1') : 'E0';
  const existujuci = najdi(udalosti, kod === 'E0' ? 'email:E0' : 'email:E1');
  if (existujuci) return json({ uz_odoslany: true, email: kod, stav: existujuci.data.stav });

  // Uvítací e-mail už odišiel ručne (ľudovka 25. 9. 2026 okolo 13:12, návrh
  // časť 5 bod 5): len zapísať zámok email:E1 ako odoslaný, nič neposlať.
  // Tým sa E1 nikdy nezopakuje a neskoršie E2 až E4 majú na čo nadviazať.
  if (body.rucne_odoslany) {
    const r = body.rucne_odoslany && typeof body.rucne_odoslany === 'object' ? body.rucne_odoslany : {};
    const kedy = new Date(r.odoslane_at || '');
    if (!Number.isFinite(kedy.getTime())) return json({ error: 'validation_failed', issues: ['rucne_odoslany.odoslane_at must be an ISO time'] }, 400);
    const kluc = kod === 'E0' ? 'email:E0' : 'email:E1';
    const data = {
      stav: 'odoslany',
      pokusy: 0,
      sablona: kod === 'E0' ? 'E0' : 'E1',
      jazyk: jazykUctu(tenant),
      rucne: true,
      odoslane_at: kedy.toISOString(),
      ...(r.resend_id ? { resend_id: String(r.resend_id).slice(0, 64) } : {}),
      ...(r.poznamka ? { poznamka: String(r.poznamka).slice(0, 200) } : {}),
    };
    const nove = await zaznamenaj(env, tenant.id, 'email', kluc, data, new Date(), kedy.toISOString());
    return json({ email: data.sablona, jazyk: data.jazyk, zapisane: nove, poslane: false });
  }

  const platforma = body.platforma ? String(body.platforma) : undefined;
  const params = kod === 'E0' ? { chyba_kod: (await readIngestErrorKod(env, tenant.id)) || (najdi(udalosti, 'chyba') || { data: {} }).data.code } : {};
  const r = await posliEmail(env, tenant, kod, { rucne: true, anglickaVeta: !!body.anglicka_veta, platforma, params });
  return json({ email: kod, jazyk: jazykUctu(tenant), ...r }, r.poslane ? 200 : 409);
}

/** POST /v1/tenants/:id/udalost {typ: "zruseny", billing_ref, plati_do}: volá licence-service pri zrušení predplatného. */
export async function handleTenantUdalostRoute(request, env, tenantId) {
  if (!jeAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await citajJson(request);
  } catch (e) {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!body || body.typ !== 'zruseny') return json({ error: 'validation_failed', issues: ['typ must be zruseny'] }, 400);
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return json({ error: 'not_found' }, 404);
  if (jeDemo(env, tenant.domain)) return json({ nove: false, demo: true });
  const ref = String(body.billing_ref || tenant.billing_ref || '-');
  const nove = await zaznamenaj(env, tenant.id, 'zruseny', `zruseny:${ref}`, { plati_do: body.plati_do || null, zdroj: 'licence-service' });
  if (nove) await pingni(env, 'asistent_zruseny', { domena: tenant.domain, d: `plati do ${body.plati_do || 'neuvedene'}` });
  return json({ nove });
}

/**
 * DELETE /v1/tenants/:id?potvrd=<doména obchodu> (ASISTENT_ADMIN_ZAPIS): výmaz
 * na požiadanie (návrh 6.3). Doména v `potvrd` chráni pred omylom v id.
 */
export async function handleDeleteTenantRoute(request, env, tenantId) {
  const straz = strazZapisu(request, env);
  if (straz) return straz;
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return json({ error: 'not_found' }, 404);
  const potvrd = String(new URL(request.url).searchParams.get('potvrd') || '').trim().toLowerCase();
  if (!potvrd || potvrd !== String(tenant.domain || '').toLowerCase()) {
    return json({ error: 'validation_failed', issues: ['potvrd must equal the tenant domain'] }, 400);
  }
  const r = await zmazTenanta(env, tenantId);
  return json({ id: tenantId, domain: tenant.domain, ...r });
}

/**
 * POST /v1/tenants/:id/overenie, hlavička Authorization: Bearer <token z POST
 * /v1/ucet/over>. Formulár na arling.sk ho volá po zadaní 6-miestneho kódu.
 * Token musí patriť presne adrese účtu (contact_email). Odpoveď nič
 * neprezradí o cudzom účte: iná adresa je 403 bez ďalších údajov.
 */
export async function handleOverenieRoute(request, env, tenantId, ctx) {
  const origin = request.headers.get('Origin') || '';
  const cors = origin ? corsHeaders(origin, parseAllowedOrigins(env && env.ALLOWED_ORIGINS)) || {} : {};
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env && env.ASISTENT_CACHE) {
    const rate = await checkRateLimit(env.ASISTENT_CACHE, ip, { name: 'overenie' });
    if (!rate.allowed) return json({ error: 'rate_limited' }, 429, cors);
  }
  const email = await overenyEmailZBearer(request, env);
  if (!email) return json({ error: 'unauthorized' }, 401, cors);
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return json({ error: 'not_found' }, 404, cors);
  if (jeDemo(env, tenant.domain)) return json({ error: 'demo' }, 400, cors);
  if (!bezpecnePorovnaj(email, String(tenant.contact_email || '').trim().toLowerCase())) return json({ error: 'ina_adresa' }, 403, cors);
  const waitUntil = ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : undefined;
  const r = await poOvereniMajitela(env, tenant, { waitUntil });
  return json({ overeny: true, nove: !!r.nove }, 200, cors);
}

const STOP_TEXTY = {
  sk: {
    titul: 'Zastaviť e-maily Asistenta',
    otazka: (d) => `Po kliknutí vám k Asistentovi pre ${d} už nepošleme žiadny ďalší e-mail. Asistent na vašom webe beží ďalej.`,
    tlacidlo: 'Zastaviť e-maily',
    nevytvaralOtazka: 'Tohto Asistenta ste nevytvárali vy? Potom vám na túto adresu už nepošleme žiadny e-mail k žiadnemu Asistentovi a Andrejovi dáme vedieť, že účet s vašou adresou založil niekto iný.',
    nevytvaralTlacidlo: 'Tohto Asistenta som nevytváral',
    hotovo: (d) => `Hotovo. K Asistentovi pre ${d} vám už nepošleme žiadny e-mail. Ak chcete Asistenta zrušiť a zmazať údaje, napíšte na andrej@arling.sk.`,
    hotovoNevytvaral: 'Ďakujeme, zaznamenali sme to. Na túto adresu vám už nepošleme žiadny e-mail k žiadnemu Asistentovi. Ak chcete, aby sme účet s vašou adresou zmazali hneď, napíšte na andrej@arling.sk, inak ho posúdime sami.',
  },
  cs: {
    titul: 'Zastavit e-maily Asistenta',
    otazka: (d) => `Po kliknutí vám k Asistentovi pro ${d} už nepošleme žádný další e-mail. Asistent na vašem webu běží dál.`,
    tlacidlo: 'Zastavit e-maily',
    nevytvaralOtazka: 'Tohoto Asistenta jste nevytvořili vy? Pak vám na tuto adresu už nepošleme žádný e-mail k žádnému Asistentovi a Andrejovi dáme vědět, že účet s vaší adresou založil někdo jiný.',
    nevytvaralTlacidlo: 'Tohoto Asistenta jsem nevytvořil',
    hotovo: (d) => `Hotovo. K Asistentovi pro ${d} vám už nepošleme žádný e-mail. Pokud chcete Asistenta zrušit a smazat údaje, napište na andrej@arling.sk.`,
    hotovoNevytvaral: 'Děkujeme, zaznamenali jsme to. Na tuto adresu vám už nepošleme žádný e-mail k žádnému Asistentovi. Pokud chcete, abychom účet s vaší adresou smazali hned, napište na andrej@arling.sk, jinak ho posoudíme sami.',
  },
  en: {
    titul: 'Stop assistant e-mails',
    otazka: (d) => `After you click, we will not send you any more e-mails about the assistant for ${d}. The assistant on your site keeps running.`,
    tlacidlo: 'Stop e-mails',
    nevytvaralOtazka: 'You did not create this assistant? Then we will not send any e-mail about any assistant to this address again, and we will let Andrej know that someone else used your address.',
    nevytvaralTlacidlo: 'I did not create this assistant',
    hotovo: (d) => `Done. We will not send you any more e-mails about the assistant for ${d}. To cancel the assistant and delete your data, write to andrej@arling.sk.`,
    hotovoNevytvaral: 'Thank you, noted. We will not send any e-mail about any assistant to this address again. If you want the account with your address deleted right away, write to andrej@arling.sk; otherwise we will review it ourselves.',
  },
  de: {
    titul: 'E-Mails zum Assistenten stoppen',
    otazka: (d) => `Nach dem Klick senden wir Ihnen zum Assistenten für ${d} keine weiteren E-Mails mehr. Der Assistent auf Ihrer Website läuft weiter.`,
    tlacidlo: 'E-Mails stoppen',
    nevytvaralOtazka: 'Sie haben diesen Assistenten nicht erstellt? Dann senden wir an diese Adresse keine E-Mails zu irgendeinem Assistenten mehr und geben Andrej Bescheid, dass jemand anderes Ihre Adresse verwendet hat.',
    nevytvaralTlacidlo: 'Ich habe diesen Assistenten nicht erstellt',
    hotovo: (d) => `Erledigt. Zum Assistenten für ${d} senden wir Ihnen keine E-Mails mehr. Wenn Sie den Assistenten kündigen und Ihre Daten löschen möchten, schreiben Sie an andrej@arling.sk.`,
    hotovoNevytvaral: 'Danke, wir haben es vermerkt. An diese Adresse senden wir keine E-Mails zu irgendeinem Assistenten mehr. Wenn das Konto mit Ihrer Adresse sofort gelöscht werden soll, schreiben Sie an andrej@arling.sk, sonst prüfen wir es selbst.',
  },
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stopStranka(jazyk, titul, obsah, status = 200) {
  const html = `<!doctype html><html lang="${jazyk}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(titul)}</title></head>`
    + '<body style="margin:0;padding:32px 16px;background:#faf8f4;color:#1a1a1a;font:17px/1.55 -apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'
    + `<main style="max-width:520px;margin:0 auto"><h1 style="font-size:22px;margin:0 0 16px">${escapeHtml(titul)}</h1>${obsah}<p style="margin-top:32px;font-size:13px;color:#666">ARLing s. r. o., Bratislava</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      ...SECURITY_HEADERS,
    },
  });
}

const TLACIDLO_PLNE = 'font:inherit;padding:10px 18px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;border-radius:4px;cursor:pointer';
const TLACIDLO_OBRYS = 'font:inherit;padding:10px 18px;border:1px solid #1a1a1a;background:transparent;color:#1a1a1a;border-radius:4px;cursor:pointer';

/**
 * GET/POST /v1/tenants/:id/emaily/stop?k=<podpis>. GET len ukáže dve tlačidlá
 * (poštové skenery otvárajú odkazy samy, GET preto nič nemení). POST, aj
 * jedným kliknutím z poštového klienta podľa RFC 8058, zastaví všetky ďalšie
 * e-maily k účtu. POST s akcia=nevytvaral navyše zapíše hash adresy do
 * asistent_potlacene (nikdy žiadny e-mail k žiadnemu účtu) a pingne Andreja.
 */
export async function handleEmailyStopRoute(request, env, tenantId, { now = new Date() } = {}) {
  if (!env || !env.UCET_TAJOMSTVO) return json({ error: 'unavailable' }, 503);
  const url = new URL(request.url);
  const poslany = url.searchParams.get('k') || '';
  const ocakavany = await podpisStop(env, tenantId);
  if (!poslany || !bezpecnePorovnaj(poslany, ocakavany)) return json({ error: 'forbidden' }, 403);
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return json({ error: 'not_found' }, 404);
  const jazyk = jazykUctu(tenant);
  const T = STOP_TEXTY[jazyk] || STOP_TEXTY.en;
  const d = escapeHtml(tenant.domain);

  if (request.method === 'GET') {
    const akcia = escapeHtml(`${url.pathname}?k=${encodeURIComponent(poslany)}`);
    return stopStranka(jazyk, T.titul,
      `<p>${T.otazka(d)}</p><form method="post" action="${akcia}"><button type="submit" style="${TLACIDLO_PLNE}">${escapeHtml(T.tlacidlo)}</button></form>`
      + `<p style="margin-top:28px">${escapeHtml(T.nevytvaralOtazka)}</p><form method="post" action="${akcia}"><input type="hidden" name="akcia" value="nevytvaral"><button type="submit" style="${TLACIDLO_OBRYS}">${escapeHtml(T.nevytvaralTlacidlo)}</button></form>`);
  }

  let akciaPost = '';
  try {
    akciaPost = new URLSearchParams(await request.text()).get('akcia') || '';
  } catch (e) {
    akciaPost = '';
  }
  const nevytvaral = akciaPost === 'nevytvaral';

  await zabezpecSchemu(env.DB);
  await env.DB.prepare(ZC_SQL.SET_EMAILY_STOP).bind(now.toISOString(), tenant.id).run();
  if (await zaznamenaj(env, tenant.id, 'emaily_stop', 'emaily_stop', nevytvaral ? { nevytvaral: true } : {}, now)) {
    if (!nevytvaral) await pingni(env, 'asistent_stop', { domena: tenant.domain });
  }
  if (nevytvaral) {
    await env.DB.prepare(ZC_SQL.INSERT_POTLACENA).bind(await hashAdresy(tenant.contact_email), now.toISOString()).run();
    if (await zaznamenaj(env, tenant.id, 'odmietnuty', 'odmietnuty', {}, now)) {
      await pingni(env, 'asistent_odmietnuty', { domena: tenant.domain, d: `${tenant.domain}: adresa povedala, ze ucet nezalozila; zvazit vymaz` });
    }
    return stopStranka(jazyk, T.titul, `<p>${escapeHtml(T.hotovoNevytvaral)}</p>`);
  }
  return stopStranka(jazyk, T.titul, `<p>${T.hotovo(d)}</p>`);
}
