/*
 * ucet.js
 *
 * "Účet cez e-mail": zákazníkov účet bez hesla a bez registrácie, jeden
 * e-mail = jeden účet. Presná špecifikácia je v
 * ops/spec-ucet.md (časť A), zámer za ňou v ops/plan-ucty-hub-appky.md.
 * Nič, čo tu nie je popísané, sa nedostavuje (heslá, profily, appka - viď
 * časť E špecifikácie).
 *
 * Žiadna D1 migrácia, všetko v existujúcom KV `ASISTENT_CACHE`:
 *   ucet:kod:<email>          -> { kod, pokusy, vytvorene }, TTL 900 s
 *   ucet:limit:email:<email>  -> počet kódov za hodinu, TTL 3600 s
 *   ucet:limit:ip:<ip>        -> počet kódov za hodinu, TTL 3600 s
 *   ucet:ucet:<email>         -> { email, vytvorene, verzia, nakupy, predplatne }
 *   ucet:hra:<hra>:<email>    -> ľubovoľný JSON stav hry, do 64 kB, bez TTL
 *
 * Token: base64url(JSON{e:email, v:verzia, exp:unix}) + "." +
 * base64url(HMAC-SHA256(UCET_TAJOMSTVO, prvá časť)). Platnosť 90 dní.
 * Overenie: podpis, exp, a že payload.v sa rovná aktuálnej verzii účtu -
 * odhlásenie "všade" je len verzia+1, po ňom je každý starý token neplatný.
 *
 * Bez secretu UCET_TAJOMSTVO (wrangler secret put UCET_TAJOMSTVO, base64
 * kľúč) je celý modul vypnutý: každá cesta z tohto súboru odpovie 503
 * {error:'ucet_unavailable'} skôr, než sa čokoľvek prečíta či zapíše. To isté
 * zámerne platí aj pre admin cestu PUT /v1/ucet/nakup, hoci tá sama osebe
 * token nepoužíva - zapisuje do rovnakých KV záznamov, ktoré token-based
 * cesty čítajú, takže bez podpisového kľúča by účet, do ktorého admin cesta
 * zapísala, aj tak nemal ako overiť prihlásenie.
 *
 * Stripe (spätné dohľadanie nákupov, časť A.2) a nákup jednej session (časť
 * A.4) používajú fetchCheckoutSession a SESSION_ID_PATTERN priamo z
 * upload.js - žiadna druhá implementácia toho istého volania Stripe API.
 * Rovnako isAdmin (X-Admin-Token) je ten istý strážca ako pri kontrole a
 * tenantoch.
 */

import { corsHeaders, parseAllowedOrigins, checkRateLimit, SECURITY_HEADERS, odtlacokIpMinuta, kosIp } from './security.js';
import { fetchCheckoutSession, isAdmin, SESSION_ID_PATTERN } from './upload.js';
import { rezervuj, vrat, kluce } from './pocty.js';
import { pingni } from './zivotny-cyklus.js';

/*
 * OCHRANA PRIHLÁSENIA KÓDOM (veľký audit 30. 9. 2026, oprava O-04, nálezy
 * 01 V3 a V4)
 *
 * 1. Globálny denný strop odoslaných kódov: DENNY_STROP_KODOV za UTC deň,
 *    atomicky v D1 (asistent_pocty, kľúč ucetkody:<deň>, pocty.js rezervuj).
 *    Rezervuje sa PRED odoslaním e-mailu, pri zlyhaní Resendu sa vráti. Nad
 *    stropom 503 s poctivou vetou a raz za deň ntfy (asistent_strop, titulok
 *    „(nie platba)“). Chráni dennú dávku Resendu, z ktorej idú aj nákupné
 *    e-maily kníh, Memory Post a Puzzle Post.
 * 2. Pokusy o kód na ADRESU (nie na kód) atomicky v D1 (tabuľka ucet_pokusy,
 *    migrations/0004_ucet_ochrana.sql): jedna veta INSERT ... ON CONFLICT DO
 *    UPDATE SET pokusy = pokusy + 1 ... WHERE pokusy < 10 RETURNING pokusy,
 *    PRED porovnaním kódu. Súbežná dávka teda porovná najviac
 *    MAX_ZLYCH_POKUSOV kódov za 24 h; potom je adresa zamknutá (429 s
 *    časom odomknutia) a nový kód sa na ňu neposiela. Úspešné prihlásenie
 *    počítadlo zmaže. Pôvodné počítadlo na kód v KV (MAX_POKUSOV) ostáva len
 *    pre UX (koľko pokusov zostáva na tento kód), ochranu nesie D1.
 * 3. Limity na IP cez sieť /64 (security.js odtlacokIpMinuta), nie surovú IP:
 *    IPv6 prípojka má celú /64, rotácia adries v nej limit neobíde. Kľúč KV
 *    nesie len odtlačok siete, nie IP.
 * 3b. Denný limit kódov na sieť (doladenie O-04, nález V1 kontroly): najviac
 *    DENNY_LIMIT_KODOV_SIETE za UTC deň na sieť denných limitov (security.js
 *    sietIpDenna: IPv4 celá, IPv6 /56, teda aj každá /64 v nej), atomicky v D1
 *    popri globálnom strope. Bez neho jedna sieť za 2 hodiny (20 za hodinu)
 *    minula celý denný strop 40 pre všetkých. Kľúč D1 nesie len kôš 0 až
 *    65 535 (kosIp s dňom a UCET_TAJOMSTVO), nie IP; riadky maže denný cron
 *    po 2 dňoch (pocty.js zmazStare).
 * 4. GET /v1/ucet/ja a POST /v1/ucet/over nevracajú holé session_id nákupov
 *    (session_id je jediné heslo k súborom kníh aj k SEPA XML s IBAN), len
 *    nepriehľadné id, produkt, dátum a sumu. session_id jedného nákupu vydá
 *    POST /v1/ucet/nakup-pristup {id} s Bearer tokenom, až keď človek klikne
 *    na stiahnutie (stránka účtu a gdpr-dokumenty).
 *
 * Bez väzby DB (lokálne testy bez D1) body 1 a 2 nebežia a v logu je
 * varovanie; v produkcii je DB vo wrangler.toml vždy. Chyba D1 pri väzbe DB
 * je 503 (radšej chvíľu bez prihlásenia než bez ochrany).
 */

// ---------------------------------------------------------------------------
// Konštanty
// ---------------------------------------------------------------------------

export const KOD_TTL_SECONDS = 900; // 15 minut, ako v e-maile
export const MAX_POKUSOV = 5;
export const LIMIT_EMAIL_ZA_HODINU = 5;
export const LIMIT_IP_ZA_HODINU = 20;
export const LIMIT_OKNO_SECONDS = 3600;
export const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 dni
export const HRA_MAX_BYTES = 64 * 1024;
export const HRA_PATTERN = /^[a-z0-9-]{1,32}$/;
/**
 * Koľko rôznych hier si smie jeden účet odložiť.
 *
 * HRA_PATTERN pripúšťa prakticky neobmedzene veľa mien, takže prihlásený
 * zákazník vedel do KV zapísať ľubovoľný počet 64 kB záznamov (PUT
 * /v1/ucet/hra/cokolvek-1, -2, -3 …) a platili by sme to my. Na arling.sk je
 * hier rádovo desať, tridsaťdva je pohodlná rezerva.
 */
export const HRA_MAX_POCET = 32;

/** Najviac toľko e-mailov s kódom za UTC deň pre všetkých spolu (O-04). Resend Free má 100 za deň pre celú firmu. */
export const DENNY_STROP_KODOV = 40;
/**
 * Najviac toľko e-mailov s kódom za UTC deň z jednej siete (IPv4 celá, IPv6
 * /56). Doladenie O-04 (V1): 40 / 5 = útočník potrebuje aspoň 8 sietí, nie
 * jednu. Domácnosť alebo kancelária s niekoľkými nákupmi za deň sa zmestí.
 */
export const DENNY_LIMIT_KODOV_SIETE = 5;
/** Najviac toľko porovnaných kódov na jednu adresu za OKNO_POKUSOV_SECONDS (O-04). */
export const MAX_ZLYCH_POKUSOV = 10;
export const OKNO_POKUSOV_SECONDS = 24 * 60 * 60;

export const UCET_SQL = {
  CREATE_POKUSY: `CREATE TABLE IF NOT EXISTS ucet_pokusy (kluc TEXT PRIMARY KEY, pokusy INTEGER NOT NULL DEFAULT 0, okno_od INTEGER NOT NULL)`,
  CREATE_POKUSY_INDEX: `CREATE INDEX IF NOT EXISTS idx_ucet_pokusy_okno ON ucet_pokusy (okno_od)`,
  // Väzby: kluc, teraz, hranica, hranica, hranica, limit (hranica = teraz - okno).
  // Staré okno sa začne znova od 1; v bežiacom okne sa pripočíta len pod limitom.
  // Keď sa nepripočíta nič, RETURNING nevráti riadok: adresa je zamknutá.
  REZERVUJ_POKUS: `INSERT INTO ucet_pokusy (kluc, pokusy, okno_od) VALUES (?, 1, ?) ON CONFLICT(kluc) DO UPDATE SET pokusy = CASE WHEN ucet_pokusy.okno_od <= ? THEN 1 ELSE ucet_pokusy.pokusy + 1 END, okno_od = CASE WHEN ucet_pokusy.okno_od <= ? THEN excluded.okno_od ELSE ucet_pokusy.okno_od END WHERE ucet_pokusy.okno_od <= ? OR ucet_pokusy.pokusy < ? RETURNING pokusy, okno_od`,
  STAV_POKUSOV: `SELECT pokusy, okno_od FROM ucet_pokusy WHERE kluc = ?`,
  ZMAZ_POKUSY: `DELETE FROM ucet_pokusy WHERE kluc = ?`,
  ZMAZ_STARE_POKUSY: `DELETE FROM ucet_pokusy WHERE okno_od <= ?`,
};

// Poctivé vety pre zámok adresy, denný strop kódov a denný limit siete, v jazyku žiadosti.
// Zámok (doladenie O-04, D2): vetu číta aj obeť, ktorej adresu zamkol niekto
// iný, a tá sa do odomknutia neprihlási. Preto nie „nič netreba robiť“, ale
// čo sa stalo, dokedy a kam písať; podpora vie adresu odomknúť (POST
// /v1/ucet/odomkni s X-Admin-Token).
const TEXTY_OCHRANY = {
  sk: {
    zamok: (cas) => `Pre túto adresu bolo zadaných priveľa nesprávnych kódov, preto sme prihlásenie zastavili najviac na 24 hodín, do ${cas} UTC. Vaše nákupy ostávajú nedotknuté. Ak ste to neboli vy alebo sa potrebujete prihlásiť skôr, napíšte na podpora@arling.sk.`,
    strop: 'Dnes sme už poslali najviac prihlasovacích kódov, koľko vieme bezpečne poslať. Skúste to zajtra, alebo napíšte na podpora@arling.sk.',
    siet: 'Do tejto siete sme dnes poslali najviac prihlasovacích kódov, koľko jedna sieť za deň dostane. Skúste to zajtra alebo z inej siete (napríklad mobilné dáta namiesto Wi-Fi), alebo napíšte na podpora@arling.sk.',
  },
  cs: {
    zamok: (cas) => `Pro tuto adresu bylo zadáno příliš mnoho nesprávných kódů, proto jsme přihlášení zastavili nejvýše na 24 hodin, do ${cas} UTC. Vaše nákupy zůstávají nedotčené. Pokud jste to nebyli vy nebo se potřebujete přihlásit dřív, napište na podpora@arling.sk.`,
    strop: 'Dnes jsme už poslali nejvíc přihlašovacích kódů, kolik umíme bezpečně poslat. Zkuste to zítra, nebo napište na podpora@arling.sk.',
    siet: 'Do této sítě jsme dnes poslali nejvíc přihlašovacích kódů, kolik jedna síť za den dostane. Zkuste to zítra nebo z jiné sítě (například mobilní data místo Wi-Fi), nebo napište na podpora@arling.sk.',
  },
  en: {
    zamok: (cas) => `Too many wrong codes were entered for this address, so we have paused sign-in for up to 24 hours, until ${cas} UTC. Your purchases are not affected. If this was not you, or you need to sign in sooner, write to support@arling.sk.`,
    strop: 'We have already sent as many sign-in codes today as we can safely send. Please try again tomorrow or write to support@arling.sk.',
    siet: 'We have already sent as many sign-in codes to this network today as one network gets per day. Please try again tomorrow or from another network (for example mobile data instead of Wi-Fi), or write to support@arling.sk.',
  },
  de: {
    zamok: (cas) => `Für diese Adresse wurden zu viele falsche Codes eingegeben, deshalb haben wir die Anmeldung für höchstens 24 Stunden angehalten, bis ${cas} UTC. Ihre Käufe sind davon nicht betroffen. Wenn Sie das nicht waren oder sich früher anmelden müssen, schreiben Sie an support@arling.sk.`,
    strop: 'Wir haben heute bereits so viele Anmeldecodes verschickt, wie wir sicher verschicken können. Bitte versuchen Sie es morgen erneut oder schreiben Sie an support@arling.sk.',
    siet: 'An dieses Netzwerk haben wir heute bereits so viele Anmeldecodes verschickt, wie ein Netzwerk pro Tag bekommt. Bitte versuchen Sie es morgen erneut oder aus einem anderen Netzwerk (zum Beispiel mobile Daten statt WLAN), oder schreiben Sie an support@arling.sk.',
  },
};

// Konštanta zo špecifikácie (časť A.3); env.STRIPE_PORTAL_URL ju môže
// prepísať, keby sa Stripe portál niekedy presunul.
export const DEFAULT_STRIPE_PORTAL_URL = 'https://billing.stripe.com/p/login/3cIaER9M63hNeFcg8B4ko00';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JAZYKY = new Set(['sk', 'cs', 'en', 'de']);

// ---------------------------------------------------------------------------
// Malé pomocné funkcie: e-mail, KV kľúče, base64url, JSON odpoveď, CORS
// ---------------------------------------------------------------------------

/** Malé písmená, orezané. Rovnaký e-mail z rôznych zariadení musí trafiť ten istý kľúč. */
export function normalizujEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function jePlatnyEmail(email) {
  return EMAIL_PATTERN.test(email) && email.length <= 254;
}

function kodKluc(email) { return `ucet:kod:${email}`; }
function limitEmailKluc(email) { return `ucet:limit:email:${email}`; }
function limitIpKluc(ip) { return `ucet:limit:ip:${ip}`; }
function ucetKluc(email) { return `ucet:ucet:${email}`; }
function hraKluc(hra, email) { return `ucet:hra:${hra}:${email}`; }

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const b64 = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function textToBase64Url(text) {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function base64UrlToText(str) {
  return new TextDecoder().decode(base64UrlToBytes(str));
}

/** UCET_TAJOMSTVO je bežné base64 (nie url-safe), ako pri každom secrete cez wrangler. */
function base64ToBytes(b64) {
  const binary = atob(String(b64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Porovnanie v konštantnom čase, aby chyba pri overovaní podpisu nepriradila nič cez timing. */
function bezpecneRovnake(a, b) {
  const bytesA = new TextEncoder().encode(String(a || ''));
  const bytesB = new TextEncoder().encode(String(b || ''));
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

async function hmacPodpis(secretBase64, sprava) {
  const kluc = await crypto.subtle.importKey('raw', base64ToBytes(secretBase64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', kluc, new TextEncoder().encode(sprava));
  return bytesToBase64Url(new Uint8Array(buf));
}

/** { e: email, v: verzia, exp: unix } -> podpísaný token, platný TOKEN_TTL_SECONDS od teraz. */
export async function vytvorToken(env, { email, verzia }) {
  const payload = { e: email, v: verzia, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const cast1 = textToBase64Url(JSON.stringify(payload));
  const podpis = await hmacPodpis(env.UCET_TAJOMSTVO, cast1);
  return `${cast1}.${podpis}`;
}

/** Token -> { e, v, exp }, alebo null, keď podpis, tvar alebo platnosť nesedí. Nikdy nehádže. */
export async function overToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const bodka = token.indexOf('.');
  if (bodka < 1) return null;
  const cast1 = token.slice(0, bodka);
  const podpis = token.slice(bodka + 1);
  if (!podpis) return null;
  let ocakavanyPodpis;
  try {
    ocakavanyPodpis = await hmacPodpis(env.UCET_TAJOMSTVO, cast1);
  } catch (e) {
    return null;
  }
  if (!bezpecneRovnake(podpis, ocakavanyPodpis)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlToText(cast1));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.e !== 'string' || typeof payload.v !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function jsonOdpoved(request, env, obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...corsFor(request, env),
      ...extraHeaders,
    },
  });
}

function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  return corsHeaders(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS)) || {};
}

/**
 * Bez podpisového kľúča je celý modul vypnutý (viď hlavičkový komentár).
 * Volá sa na začiatku každého handlera nižšie; vráti Response, keď treba
 * odpovedať 503, inak null.
 */
function strazSecretu(request, env) {
  if (!env || !env.UCET_TAJOMSTVO) {
    return jsonOdpoved(request, env, { error: 'ucet_unavailable' }, 503);
  }
  return null;
}

/**
 * Ten istý minútový limit na IP ako /v1/chat a /v1/kontrola/*.
 *
 * Cesty účtu ho do 21. 9. 2026 nemali žiadny okrem hodinového počítadla
 * kódov, takže overovanie kódu, čítanie účtu aj zápis stavu hry sa dali
 * volať ľubovoľne často a každé volanie znamená čítanie a zápis do KV,
 * ktoré platíme my. Vracia Response pri prekročení, inak null.
 *
 * Od 30. 9. 2026 (O-04) na sieť /64, nie na surovú IP, a s vlastným menom
 * počítadla „ucet“, aby nezdieľal minútu s chatom tej istej siete.
 */
async function strazLimitu(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(env.ASISTENT_CACHE, await sietIp(env, ip), { name: 'ucet' });
  if (!rate.allowed) return jsonOdpoved(request, env, { error: 'rate_limited' }, 429);
  return null;
}

/** Odtlačok siete /64 (IPv4 celá) s tajomstvom účtu: jednotka všetkých limitov na IP v tomto súbore. */
export async function sietIp(env, ip) {
  return odtlacokIpMinuta(ip || 'unknown', (env && env.UCET_TAJOMSTVO) || '');
}

// ---------------------------------------------------------------------------
// O-04: pokusy na adresu a denný strop kódov v D1
// ---------------------------------------------------------------------------

function jazykZ(raw) {
  return JAZYKY.has(raw) ? raw : 'sk';
}

/** "2026-10-01 14:05" z unix sekúnd, pre vetu o zámku. */
function casUtc(sekundy) {
  return new Date(sekundy * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

const tabulkaPokusovHotova = new WeakSet();

/** Strážené vytvorenie tabuľky pri behu, to isté je v migrations/0004_ucet_ochrana.sql. */
async function zabezpecPokusy(db) {
  if (!db || tabulkaPokusovHotova.has(db)) return;
  await db.prepare(UCET_SQL.CREATE_POKUSY).run();
  await db.prepare(UCET_SQL.CREATE_POKUSY_INDEX).run();
  tabulkaPokusovHotova.add(db);
}

/** Odtlačok adresy pre D1 (32 hex znakov): v tabuľke nikdy nie je holý e-mail. */
async function klucPokusov(env, email) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ucet-pokusy|${email}|${env.UCET_TAJOMSTVO || ''}`)));
  let hex = '';
  for (const x of b.slice(0, 16)) hex += (x < 16 ? '0' : '') + x.toString(16);
  return hex;
}

/**
 * Je adresa zamknutá? { zamknute, odomkne } (odomkne = unix sekundy), len
 * čítanie. Chyba D1 sa hádže ďalej.
 */
async function stavZamku(env, email, teraz) {
  await zabezpecPokusy(env.DB);
  const row = await env.DB.prepare(UCET_SQL.STAV_POKUSOV).bind(await klucPokusov(env, email)).first();
  if (!row) return { zamknute: false };
  const oknoOd = Number(row.okno_od) || 0;
  const zamknute = oknoOd > teraz - OKNO_POKUSOV_SECONDS && (Number(row.pokusy) || 0) >= MAX_ZLYCH_POKUSOV;
  return { zamknute, odomkne: oknoOd + OKNO_POKUSOV_SECONDS };
}

/**
 * Atomicky zaberie jeden pokus pre adresu PRED porovnaním kódu.
 * { ok: true, pokusy } alebo { ok: false, odomkne } pri zámku. Chyba D1 sa hádže ďalej.
 */
async function rezervujPokus(env, email, teraz) {
  await zabezpecPokusy(env.DB);
  const kluc = await klucPokusov(env, email);
  const hranica = teraz - OKNO_POKUSOV_SECONDS;
  const row = await env.DB.prepare(UCET_SQL.REZERVUJ_POKUS).bind(kluc, teraz, hranica, hranica, hranica, MAX_ZLYCH_POKUSOV).first();
  if (row) return { ok: true, pokusy: Number(row.pokusy) || 0 };
  const stav = await env.DB.prepare(UCET_SQL.STAV_POKUSOV).bind(kluc).first();
  return { ok: false, odomkne: (Number(stav && stav.okno_od) || teraz) + OKNO_POKUSOV_SECONDS };
}

/** Po úspešnom prihlásení sa počítadlo adresy zmaže. Chyba sa len zapíše. */
async function zmazPokusy(env, email) {
  try {
    await zabezpecPokusy(env.DB);
    await env.DB.prepare(UCET_SQL.ZMAZ_POKUSY).bind(await klucPokusov(env, email)).run();
  } catch (e) {
    console.warn('[arling-asistent] ucet: zmazanie pocitadla pokusov zlyhalo:', (e && e.message) || e);
  }
}

/** Denný cron: riadky s oknom starším ako 24 h preč. */
export async function zmazStarePokusy(db, teraz = Math.floor(Date.now() / 1000)) {
  if (!db) return;
  await zabezpecPokusy(db);
  await db.prepare(UCET_SQL.ZMAZ_STARE_POKUSY).bind(teraz - OKNO_POKUSOV_SECONDS).run();
}

function odpovedZamku(request, env, odomkne, teraz, jazyk) {
  return jsonOdpoved(request, env, {
    error: 'rate_limited',
    dovod: 'zamok',
    until: new Date(odomkne * 1000).toISOString(),
    message: TEXTY_OCHRANY[jazykZ(jazyk)].zamok(casUtc(odomkne)),
  }, 429, { 'Retry-After': String(Math.max(1, odomkne - teraz)) });
}

const klucKodovDna = (den) => `ucetkody:${den}`;
// Iná predpona než ucetkody:, aby dotaz LIKE 'ucetkody:%' z krokov nasadenia ukazoval len globálny strop.
const klucKodovSiete = (den, kos) => `ucetsiet:${den}:${kos}`;

/** Raz za deň ntfy o plnom strope kódov; značka atomicky v D1. Nikdy nehádže. */
async function upozorniNaStropKodov(env, den) {
  console.warn(`[arling-asistent] ucet: denny strop ${DENNY_STROP_KODOV} kodov za ${den} UTC dosiahnuty, dalsie kody dnes nejdu`);
  try {
    const prva = await rezervuj(env.DB, kluce.znacka('ucet_kody', den), den, 1, 1);
    if (prva == null) return;
    // asistent_strop už subscribe-service pozná, titulok končí „(nie platba)“.
    await pingni(env, 'asistent_strop', { p: String(DENNY_STROP_KODOV), d: `kody uctu: ${DENNY_STROP_KODOV} prihlasovacich kodov za ${den} UTC, dalsie dnes nejdu` });
  } catch (e) {
    console.warn('[arling-asistent] ucet: ping o strope kodov zlyhal:', (e && e.message) || e);
  }
}

function sekundDoPolnociUtc(nowMs) {
  const d = new Date(nowMs);
  const polnoc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((polnoc - nowMs) / 1000));
}

// ---------------------------------------------------------------------------
// Účet v KV
// ---------------------------------------------------------------------------

function novyUcet(email) {
  return { email, vytvorene: new Date().toISOString(), verzia: 1, nakupy: [], predplatne: [] };
}

async function nacitajUcet(kv, email) {
  try {
    const zaznam = await kv.get(ucetKluc(email), 'json');
    return zaznam && typeof zaznam === 'object' ? zaznam : null;
  } catch (e) {
    console.warn('[arling-asistent] ucet: citanie uctu z KV zlyhalo:', (e && e.message) || e);
    return null;
  }
}

async function ulozUcet(kv, ucet) {
  await kv.put(ucetKluc(ucet.email), JSON.stringify(ucet));
}

/**
 * Nepriehľadné id nákupu (22 znakov base64url z HMAC session_id s
 * UCET_TAJOMSTVO). Stabilné, z neho sa session_id spätne nezistí; stránka ním
 * pýta session_id cez POST /v1/ucet/nakup-pristup s Bearer tokenom.
 */
export async function idNakupu(env, sessionId) {
  return (await hmacPodpis(env.UCET_TAJOMSTVO, `nakup|${sessionId || ''}`)).slice(0, 22);
}

/**
 * Kľúč stavu obchodu (O-25): 32 znakov base64url z HMAC(UCET_TAJOMSTVO,
 * "obchod-stav|<id>"). Kto ho pošle v hlavičke X-Arling-Kluc, dostane z GET
 * /v1/tenants/:id/status aj plán, kvótu a spotrebu. Vydáva ho len POST
 * /v1/tenants tomu, kto obchod založil, alebo overenému majiteľovi. Bez
 * UCET_TAJOMSTVO null (kľúče vypnuté).
 */
export async function klucObchodu(env, tenantId) {
  if (!env || !env.UCET_TAJOMSTVO || !tenantId) return null;
  try {
    return (await hmacPodpis(env.UCET_TAJOMSTVO, `obchod-stav|${tenantId}`)).slice(0, 32);
  } catch (e) {
    return null;
  }
}

/** Porovná poslaný kľúč stavu obchodu v konštantnom čase. Nikdy nehádže. */
export async function jeKlucObchodu(env, tenantId, poslany) {
  if (!poslany) return false;
  const ocakavany = await klucObchodu(env, tenantId);
  return !!ocakavany && bezpecneRovnake(String(poslany).trim(), ocakavany);
}

/** Nákup bez session_id (O-04): id, produkt, dátum, suma, mena, livemode. */
async function verejnyNakup(env, n) {
  return {
    id: await idNakupu(env, n && n.session_id),
    produkt: (n && n.produkt) || '',
    datum: (n && n.datum) || null,
    suma: n && typeof n.suma === 'number' ? n.suma : null,
    mena: (n && n.mena) || null,
    livemode: !n || n.livemode !== false,
  };
}

async function verejneNakupy(env, nakupy) {
  return Promise.all((Array.isArray(nakupy) ? nakupy : []).filter(Boolean).map((n) => verejnyNakup(env, n)));
}

/** Verejný tvar účtu pre POST /v1/ucet/over - bez interných polí (verzia je interná, slúži len tokenu) a bez session_id nákupov. */
async function verejnyUcet(env, ucet) {
  return {
    email: ucet.email,
    vytvorene: ucet.vytvorene,
    nakupy: await verejneNakupy(env, ucet.nakupy),
    predplatne: ucet.predplatne || [],
  };
}

/**
 * Bearer token z hlavičky -> { ucet } alebo { chyba: true }. Overuje podpis,
 * exp, a že token patrí k aktuálnej verzii účtu (odhlásenie "všade" zneplatní
 * všetky staršie).
 */
async function autentifikuj(request, env) {
  const hlavicka = request.headers.get('Authorization') || '';
  const zhoda = hlavicka.match(/^Bearer\s+(.+)$/i);
  if (!zhoda) return { chyba: true };
  const payload = await overToken(env, zhoda[1].trim());
  if (!payload) return { chyba: true };
  const ucet = await nacitajUcet(env.ASISTENT_CACHE, payload.e);
  if (!ucet || ucet.verzia !== payload.v) return { chyba: true };
  return { ucet };
}

/**
 * Overená e-mailová adresa z hlavičky Authorization: Bearer <token z POST
 * /v1/ucet/over>, alebo null. Pre životný cyklus Asistenta
 * (zivotny-cyklus.js): automatický e-mail ide len na adresu, ktorú majiteľ
 * potvrdil 6-miestnym kódom. Bez UCET_TAJOMSTVO vždy null. Nikdy nehádže.
 */
export async function overenyEmailZBearer(request, env) {
  try {
    if (!env || !env.UCET_TAJOMSTVO || !env.ASISTENT_CACHE) return null;
    const { ucet, chyba } = await autentifikuj(request, env);
    if (chyba || !ucet || ucet.zmazane) return null;
    return normalizujEmail(ucet.email) || null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Limity (počet kódov za hodinu, na e-mail aj na IP)
// ---------------------------------------------------------------------------

/**
 * Prečíta a pripočíta počítadlo v KV; vráti false, keď je limit už
 * vyčerpaný (a nepripočíta ďalej). Chyba KV padá na stranu prepustenia
 * (fail open), rovnako ako checkRateLimit v security.js - výpadok KV nesmie
 * zablokovať prihlásenie.
 */
async function pripocitajLimit(kv, kluc, limit) {
  let aktualne = 0;
  try {
    aktualne = parseInt((await kv.get(kluc)) || '0', 10) || 0;
  } catch (e) {
    console.warn('[arling-asistent] ucet: citanie limitu z KV zlyhalo, pokracujem:', (e && e.message) || e);
    return true;
  }
  if (aktualne >= limit) return false;
  try {
    await kv.put(kluc, String(aktualne + 1), { expirationTtl: LIMIT_OKNO_SECONDS });
  } catch (e) {
    console.warn('[arling-asistent] ucet: zapis limitu do KV zlyhal:', (e && e.message) || e);
  }
  return true;
}

function vygenerujKod() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// C. E-mail cez Resend
// ---------------------------------------------------------------------------

// Päta ako pri e-mailoch Asistenta: kto píše a prečo e-mail prišiel. Kód si
// vyžiadal ten, kto zadal adresu na arling.sk (účet alebo formulár Asistenta).
const TEXTY_KODU = {
  sk: {
    predmet: (kod) => `Váš kód: ${kod}`,
    text: (kod, odkaz) => `Váš kód: ${kod}\n\nAlebo kliknite na odkaz: ${odkaz}\n\nPlatí 15 minút. Ak ste kód nepýtali, tento e-mail ignorujte.\n\n--\nTento kód ste si vyžiadali na arling.sk. ARLing s. r. o., Bratislava.`,
    html: (kod, odkaz) => `<p>Váš kód: <strong style="font-size:24px">${kod}</strong></p><p>Alebo kliknite na odkaz: <a href="${odkaz}">${odkaz}</a></p><p>Platí 15 minút. Ak ste kód nepýtali, tento e-mail ignorujte.</p><p style="font-size:13px;color:#555555">Tento kód ste si vyžiadali na arling.sk. ARLing s. r. o., Bratislava.</p>`,
  },
  cs: {
    predmet: (kod) => `Váš kód: ${kod}`,
    text: (kod, odkaz) => `Váš kód: ${kod}\n\nNebo klikněte na odkaz: ${odkaz}\n\nPlatí 15 minut. Pokud jste o kód nežádali, tento e-mail ignorujte.\n\n--\nO tento kód jste požádali na arling.sk. ARLing s. r. o., Bratislava, Slovensko.`,
    html: (kod, odkaz) => `<p>Váš kód: <strong style="font-size:24px">${kod}</strong></p><p>Nebo klikněte na odkaz: <a href="${odkaz}">${odkaz}</a></p><p>Platí 15 minut. Pokud jste o kód nežádali, tento e-mail ignorujte.</p><p style="font-size:13px;color:#555555">O tento kód jste požádali na arling.sk. ARLing s. r. o., Bratislava, Slovensko.</p>`,
  },
  en: {
    predmet: (kod) => `Your code: ${kod}`,
    text: (kod, odkaz) => `Your code: ${kod}\n\nOr click this link: ${odkaz}\n\nValid for 15 minutes. If you did not request this code, ignore this e-mail.\n\n--\nYou requested this code at arling.sk. ARLing s. r. o., Bratislava, Slovakia.`,
    html: (kod, odkaz) => `<p>Your code: <strong style="font-size:24px">${kod}</strong></p><p>Or click this link: <a href="${odkaz}">${odkaz}</a></p><p>Valid for 15 minutes. If you did not request this code, ignore this e-mail.</p><p style="font-size:13px;color:#555555">You requested this code at arling.sk. ARLing s. r. o., Bratislava, Slovakia.</p>`,
  },
  de: {
    predmet: (kod) => `Ihr Code: ${kod}`,
    text: (kod, odkaz) => `Ihr Code: ${kod}\n\nOder klicken Sie auf den Link: ${odkaz}\n\n15 Minuten gültig. Wenn Sie diesen Code nicht angefordert haben, ignorieren Sie diese E-Mail.\n\n--\nSie haben diesen Code auf arling.sk angefordert. ARLing s. r. o., Bratislava, Slowakei.`,
    html: (kod, odkaz) => `<p>Ihr Code: <strong style="font-size:24px">${kod}</strong></p><p>Oder klicken Sie auf den Link: <a href="${odkaz}">${odkaz}</a></p><p>15 Minuten gültig. Wenn Sie diesen Code nicht angefordert haben, ignorieren Sie diese E-Mail.</p><p style="font-size:13px;color:#555555">Sie haben diesen Code auf arling.sk angefordert. ARLing s. r. o., Bratislava, Slowakei.</p>`,
  },
};

/**
 * POST https://api.resend.com/emails. Vráti true len vtedy, keď Resend
 * naozaj potvrdil odoslanie; false pri chýbajúcom kľúči aj pri akejkoľvek
 * chybe - volajúci (handleUcetKodRoute) na false zahodí uložený kód a
 * odpovie 503 mail_unavailable.
 */
export async function posliKodEmailom(env, { email, kod, jazyk }) {
  if (!env.RESEND_API_KEY) return false;
  const lang = JAZYKY.has(jazyk) ? jazyk : 'sk';
  const texty = TEXTY_KODU[lang];
  const odkaz = `https://arling.sk/ucet/?email=${encodeURIComponent(email)}&kod=${encodeURIComponent(kod)}`;
  const fetchImpl = env.fetchImpl || fetch;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Odosielacia poddoména mail.arling.sk (Resend), hlavná pošta ostáva na Zoho.
        from: 'ARLing <ucet@mail.arling.sk>',
        // Verejná podpora v jazyku kódu (25. 9. 2026): sk a cs podpora@, en a de support@.
        reply_to: lang === 'sk' || lang === 'cs' ? 'podpora@arling.sk' : 'support@arling.sk',
        to: [email],
        subject: texty.predmet(kod),
        text: texty.text(kod, odkaz),
        html: texty.html(kod, odkaz),
      }),
    });
    return !!res && res.ok !== false;
  } catch (e) {
    console.warn('[arling-asistent] ucet: odoslanie kodu cez Resend zlyhalo:', (e && e.message) || e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// A.2 / A.4: nákup zo Stripe Checkout Session -> záznam do účtu
// ---------------------------------------------------------------------------

/**
 * Jedna Stripe Checkout Session -> záznam nákupu v tvare, ktorý sa ukladá do
 * účtu. Meno produktu: názov prvej položky z (expandovaných) line_items, inak
 * metadata.produkt platobného odkazu, inak prázdny reťazec - worker si názov
 * produktu nevymýšľa.
 */
function nakupZoSession(session) {
  const polozka = session.line_items && Array.isArray(session.line_items.data) ? session.line_items.data[0] : null;
  const produkt = (polozka && polozka.description) || (session.metadata && session.metadata.produkt) || '';
  return {
    produkt,
    session_id: session.id,
    suma: typeof session.amount_total === 'number' ? session.amount_total : null,
    mena: session.currency || null,
    livemode: session.livemode !== false,
    datum: Number.isFinite(session.created) ? new Date(session.created * 1000).toISOString() : null,
  };
}

/**
 * Spätné dohľadanie nákupov v Stripe (časť A.2), volané po úspešnom overení
 * kódu. Doplní do ucet.nakupy každú zaplatenú, ostrú (livemode) session s
 * daným e-mailom, ktorá tam ešte nie je. Nikdy nehádže: chyba Stripe sa
 * nesmie prejaviť ako chyba prihlásenia, len sa nič nedoplní.
 */
export async function doplnNakupyZoStripe(env, ucet) {
  try {
    const kluc = env.STRIPE_SECRET_KEY;
    if (!kluc) return;
    const fetchImpl = env.fetchImpl || fetch;
    // spec-ucet.md pise "?expand[]=line_items", ale toto je Stripe List API:
    // kazda session sedi v poli `data`, takze pole na rozbalenie vnoreneho
    // line_items je `data.line_items`, nie holé `line_items` (to platí len
    // pri GET jednej session, ako v upload.js fetchCheckoutSession). Bez
    // "data." prefixu by Stripe expand nič nerozbalil a produkt by vždy
    // padol na metadata.produkt alebo na prázdny reťazec.
    const url = `https://api.stripe.com/v1/checkout/sessions?customer_details[email]=${encodeURIComponent(ucet.email)}&limit=100&expand[]=data.line_items`;
    const res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Basic ${btoa(`${kluc}:`)}` } });
    if (!res || res.ok === false) return;
    const data = await res.json();
    const sessions = data && Array.isArray(data.data) ? data.data : [];
    ucet.nakupy = ucet.nakupy || [];
    const zname = new Set(ucet.nakupy.map((n) => n.session_id));
    for (const session of sessions) {
      if (!session || session.payment_status !== 'paid' || session.livemode !== true) continue;
      if (zname.has(session.id)) continue;
      ucet.nakupy.push(nakupZoSession(session));
      zname.add(session.id);
    }
  } catch (e) {
    console.warn('[arling-asistent] ucet: spatne dohladanie zo Stripe zlyhalo, ucet ostava bez zmeny:', (e && e.message) || e);
  }
}

// ---------------------------------------------------------------------------
// 1. POST /v1/ucet/kod
// ---------------------------------------------------------------------------

export async function handleUcetKodRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;

  let telo;
  try {
    telo = await request.json();
  } catch (e) {
    telo = null;
  }
  const email = normalizujEmail(telo && telo.email);
  if (!jePlatnyEmail(email)) return jsonOdpoved(request, env, { error: 'bad_email' }, 400);

  const kv = env.ASISTENT_CACHE;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const jazyk = typeof (telo && telo.jazyk) === 'string' ? telo.jazyk : 'sk';
  const nowMs = Date.now();
  const teraz = Math.floor(nowMs / 1000);
  const den = new Date(nowMs).toISOString().slice(0, 10);

  const emailOk = await pripocitajLimit(kv, limitEmailKluc(email), LIMIT_EMAIL_ZA_HODINU);
  if (!emailOk) return jsonOdpoved(request, env, { error: 'rate_limited' }, 429);
  // Sieť /64, nie surová IP (O-04): kľúč nesie len odtlačok siete.
  const ipOk = await pripocitajLimit(kv, limitIpKluc(await sietIp(env, ip)), LIMIT_IP_ZA_HODINU);
  if (!ipOk) return jsonOdpoved(request, env, { error: 'rate_limited' }, 429);

  // Zamknutá adresa (10 zlých kódov za 24 h) nový kód nedostane a globálny
  // strop sa nemíňa. Potom rezervácia jedného miesta v dennom strope, až po
  // všetkých lacnejších limitoch, aby ho odmietnuté požiadavky nemíňali.
  // Potom denný limit siete (doladenie O-04, V1) a až nakoniec globálny strop:
  // keď globálny strop miesto nemá, miesto siete sa vráti.
  let rezervovane = false;
  let klucSiete = null;
  if (env.DB) {
    try {
      const zamok = await stavZamku(env, email, teraz);
      if (zamok.zamknute) return odpovedZamku(request, env, zamok.odomkne, teraz, jazyk);
      const kluc = klucKodovSiete(den, await kosIp(ip, den, env.UCET_TAJOMSTVO || ''));
      const s = await rezervuj(env.DB, kluc, den, 1, DENNY_LIMIT_KODOV_SIETE);
      if (s == null) {
        return jsonOdpoved(request, env, {
          error: 'rate_limited',
          dovod: 'siet_den',
          message: TEXTY_OCHRANY[jazykZ(jazyk)].siet,
        }, 429, { 'Retry-After': String(sekundDoPolnociUtc(nowMs)) });
      }
      klucSiete = kluc;
      const n = await rezervuj(env.DB, klucKodovDna(den), den, 1, DENNY_STROP_KODOV);
      if (n == null) {
        await vrat(env.DB, klucSiete, 1);
        klucSiete = null;
        await upozorniNaStropKodov(env, den);
        return jsonOdpoved(request, env, {
          error: 'rate_limited',
          dovod: 'denny_strop',
          message: TEXTY_OCHRANY[jazykZ(jazyk)].strop,
        }, 503, { 'Retry-After': String(sekundDoPolnociUtc(nowMs)) });
      }
      rezervovane = true;
    } catch (e) {
      console.warn('[arling-asistent] ucet: D1 pre strop kodov zlyhala, kod neposielam:', (e && e.message) || e);
      if (klucSiete) {
        try { await vrat(env.DB, klucSiete, 1); } catch (e2) { /* D1 je dole, riadok zmaže cron */ }
      }
      return jsonOdpoved(request, env, { error: 'ucet_unavailable' }, 503);
    }
  } else {
    console.warn('[arling-asistent] ucet: bez vazby DB nebezi denny strop kodov ani zamok adresy');
  }

  const kod = vygenerujKod();
  const zaznam = { kod, pokusy: 0, vytvorene: new Date(nowMs).toISOString() };
  await kv.put(kodKluc(email), JSON.stringify(zaznam), { expirationTtl: KOD_TTL_SECONDS });

  const odoslane = await posliKodEmailom(env, { email, kod, jazyk });
  if (!odoslane) {
    await kv.delete(kodKluc(email));
    // E-mail neodišiel: miesto v dennom strope aj v limite siete sa vráti.
    if (rezervovane) {
      try {
        await vrat(env.DB, klucKodovDna(den), 1);
        if (klucSiete) await vrat(env.DB, klucSiete, 1);
      } catch (e) {
        console.warn('[arling-asistent] ucet: vratenie miesta v strope kodov zlyhalo:', (e && e.message) || e);
      }
    }
    return jsonOdpoved(request, env, { error: 'mail_unavailable' }, 503);
  }

  // Odpoveď je vždy rovnaká, nech e-mail poznáme alebo nie - nič neprezrádza.
  return jsonOdpoved(request, env, { ok: true }, 200);
}

// ---------------------------------------------------------------------------
// 2. POST /v1/ucet/over
// ---------------------------------------------------------------------------

export async function handleUcetOverRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;
  const limit = await strazLimitu(request, env);
  if (limit) return limit;

  let telo;
  try {
    telo = await request.json();
  } catch (e) {
    telo = null;
  }
  const email = normalizujEmail(telo && telo.email);
  const kv = env.ASISTENT_CACHE;
  const zaznam = email ? await kv.get(kodKluc(email), 'json') : null;
  if (!zaznam) return jsonOdpoved(request, env, { error: 'no_code' }, 400);

  const vytvoreneMs = Date.parse(zaznam.vytvorene);
  const vekSekund = Number.isFinite(vytvoreneMs) ? (Date.now() - vytvoreneMs) / 1000 : Infinity;
  if (vekSekund > KOD_TTL_SECONDS) {
    await kv.delete(kodKluc(email));
    return jsonOdpoved(request, env, { error: 'no_code' }, 400);
  }

  // O-04: pokus sa zaberie atomicky v D1 PRED porovnaním. Súbežná dávka
  // (aj z mnohých adries jednej siete) porovná najviac MAX_ZLYCH_POKUSOV
  // kódov za 24 h; ďalšie dostanú zámok a kód sa zahodí.
  const jazyk = typeof (telo && telo.jazyk) === 'string' ? telo.jazyk : 'sk';
  const teraz = Math.floor(Date.now() / 1000);
  let pokusyAdresy = null;
  if (env.DB) {
    let r;
    try {
      r = await rezervujPokus(env, email, teraz);
    } catch (e) {
      console.warn('[arling-asistent] ucet: D1 pre pokusy zlyhala, kod neporovnavam:', (e && e.message) || e);
      return jsonOdpoved(request, env, { error: 'ucet_unavailable' }, 503);
    }
    if (!r.ok) {
      await kv.delete(kodKluc(email));
      return odpovedZamku(request, env, r.odomkne, teraz, jazyk);
    }
    pokusyAdresy = r.pokusy;
  }

  const zadanyKod = String((telo && telo.kod) || '').trim();
  // Porovnanie v konštantnom čase: kód je celé prihlásenie a obyčajné !==
  // prestane porovnávať na prvej rozdielnej číslici.
  if (!bezpecneRovnake(zadanyKod, zaznam.kod)) {
    const pokusy = (zaznam.pokusy || 0) + 1;
    const zostavaAdrese = pokusyAdresy == null ? Infinity : MAX_ZLYCH_POKUSOV - pokusyAdresy;
    if (pokusy >= MAX_POKUSOV || zostavaAdrese <= 0) {
      await kv.delete(kodKluc(email));
      return jsonOdpoved(request, env, { error: 'bad_code', remaining: 0 }, 400);
    }
    const zostavaTtl = Math.max(1, Math.round(KOD_TTL_SECONDS - vekSekund));
    await kv.put(kodKluc(email), JSON.stringify({ ...zaznam, pokusy }), { expirationTtl: zostavaTtl });
    return jsonOdpoved(request, env, { error: 'bad_code', remaining: Math.min(MAX_POKUSOV - pokusy, zostavaAdrese) }, 400);
  }

  await kv.delete(kodKluc(email));
  if (env.DB) await zmazPokusy(env, email);
  let ucet = await nacitajUcet(kv, email);
  if (!ucet) ucet = novyUcet(email);
  await doplnNakupyZoStripe(env, ucet);
  await ulozUcet(kv, ucet);

  const token = await vytvorToken(env, { email, verzia: ucet.verzia });
  return jsonOdpoved(request, env, { token, email, ucet: await verejnyUcet(env, ucet) }, 200);
}

// ---------------------------------------------------------------------------
// 3. GET /v1/ucet/ja
// ---------------------------------------------------------------------------

export async function handleUcetJaRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  // Nákupy bez session_id (O-04): session_id je heslo k súborom a k SEPA XML.
  return jsonOdpoved(request, env, {
    email: ucet.email,
    nakupy: await verejneNakupy(env, ucet.nakupy),
    predplatne: ucet.predplatne || [],
    portal_url: env.STRIPE_PORTAL_URL || DEFAULT_STRIPE_PORTAL_URL,
  }, 200);
}

// ---------------------------------------------------------------------------
// 3b. POST /v1/ucet/nakup-pristup  {id} -> { session_id, produkt } (Bearer)
// ---------------------------------------------------------------------------

/**
 * session_id JEDNÉHO nákupu vlastníkovi účtu, až keď klikne na stiahnutie
 * (O-04). Stránky, ktoré súbory odomykajú cez ?session_id= (tituly,
 * /kontrola-suboru/, /gdpr-dokumenty/), ho pýtajú tu podľa id z /v1/ucet/ja.
 * Bez tokenu 401, cudzie alebo neznáme id 404, minútový limit na sieť.
 */
export async function handleUcetNakupPristupRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;
  const limit = await strazLimitu(request, env);
  if (limit) return limit;

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  let telo;
  try {
    telo = await request.json();
  } catch (e) {
    telo = null;
  }
  const id = typeof (telo && telo.id) === 'string' ? telo.id : '';
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return jsonOdpoved(request, env, { error: 'bad_id' }, 400);

  for (const n of ucet.nakupy || []) {
    if (!n || !n.session_id) continue;
    if (bezpecneRovnake(await idNakupu(env, n.session_id), id)) {
      return jsonOdpoved(request, env, { session_id: n.session_id, produkt: n.produkt || '' }, 200);
    }
  }
  return jsonOdpoved(request, env, { error: 'not_found' }, 404);
}

// ---------------------------------------------------------------------------
// 3c. POST /v1/ucet/odomkni  {email} (admin, X-Admin-Token)
// ---------------------------------------------------------------------------

/**
 * Podpora odomkne jednu zamknutú adresu (doladenie O-04, nálezy D1 a D2
 * kontroly). Riadok ucet_pokusy má kľúč z odtlačku adresy s UCET_TAJOMSTVO,
 * ktoré sa z wrangler secret prečítať nedá, takže ručne by šlo zmazať len
 * všetky zámky naraz. Veta zámku preto posiela na podpora@arling.sk.
 * Odpoveď { ok, zamknute_bolo } nič iné o adrese neprezradí.
 */
export async function handleUcetOdomkniRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;
  if (!isAdmin(request, env)) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);
  if (!env.DB) return jsonOdpoved(request, env, { error: 'ucet_unavailable' }, 503);

  let telo;
  try {
    telo = await request.json();
  } catch (e) {
    telo = null;
  }
  const email = normalizujEmail(telo && telo.email);
  if (!jePlatnyEmail(email)) return jsonOdpoved(request, env, { error: 'bad_email' }, 400);

  try {
    const stav = await stavZamku(env, email, Math.floor(Date.now() / 1000));
    await zabezpecPokusy(env.DB);
    await env.DB.prepare(UCET_SQL.ZMAZ_POKUSY).bind(await klucPokusov(env, email)).run();
    return jsonOdpoved(request, env, { ok: true, zamknute_bolo: !!stav.zamknute }, 200);
  } catch (e) {
    console.warn('[arling-asistent] ucet: odomknutie adresy zlyhalo:', (e && e.message) || e);
    return jsonOdpoved(request, env, { error: 'ucet_unavailable' }, 503);
  }
}

// ---------------------------------------------------------------------------
// 4. POST /v1/ucet/nakup-session
// ---------------------------------------------------------------------------

export async function handleUcetNakupSessionRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  let telo;
  try {
    telo = await request.json();
  } catch (e) {
    telo = null;
  }
  const sessionId = typeof (telo && telo.session_id) === 'string' ? telo.session_id : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonOdpoved(request, env, { error: 'bad_session_id' }, 400);

  const check = await fetchCheckoutSession(env, sessionId);
  if (!check.ok) return jsonOdpoved(request, env, { error: 'verification_unavailable' }, 503);
  const session = check.session;
  if (session.payment_status !== 'paid') {
    return jsonOdpoved(request, env, { error: 'not_paid', payment_status: session.payment_status || 'unknown' }, 402);
  }
  const emailZoSession = normalizujEmail(session.customer_details && session.customer_details.email);
  if (emailZoSession !== ucet.email) return jsonOdpoved(request, env, { error: 'not_yours' }, 403);

  ucet.nakupy = ucet.nakupy || [];
  let nakup = ucet.nakupy.find((n) => n.session_id === sessionId);
  if (!nakup) {
    nakup = nakupZoSession(session);
    ucet.nakupy.push(nakup);
    await ulozUcet(env.ASISTENT_CACHE, ucet);
  }
  return jsonOdpoved(request, env, { ok: true, nakup }, 200);
}

// ---------------------------------------------------------------------------
// 5. PUT /v1/ucet/nakup (admin, X-Admin-Token) - volá licence-service webhook
// ---------------------------------------------------------------------------

export async function handleUcetNakupRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;
  if (!isAdmin(request, env)) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  let telo;
  try {
    telo = await request.json();
  } catch (e) {
    telo = null;
  }
  const email = normalizujEmail(telo && telo.email);
  const sessionId = typeof (telo && telo.session_id) === 'string' ? telo.session_id.trim() : '';
  if (!jePlatnyEmail(email) || !sessionId) return jsonOdpoved(request, env, { error: 'bad_request' }, 400);

  const kv = env.ASISTENT_CACHE;
  let ucet = await nacitajUcet(kv, email);
  if (!ucet) ucet = novyUcet(email);
  ucet.nakupy = ucet.nakupy || [];
  const existuje = ucet.nakupy.some((n) => n.session_id === sessionId);
  if (!existuje) {
    ucet.nakupy.push({
      produkt: typeof telo.produkt === 'string' ? telo.produkt : '',
      session_id: sessionId,
      suma: typeof telo.suma === 'number' ? telo.suma : null,
      mena: typeof telo.mena === 'string' ? telo.mena : null,
      livemode: telo.livemode !== false,
      datum: typeof telo.datum === 'string' && telo.datum ? telo.datum : new Date().toISOString(),
    });
    await ulozUcet(kv, ucet);
  }
  return jsonOdpoved(request, env, { ok: true }, 200);
}

// ---------------------------------------------------------------------------
// 6. GET / PUT /v1/ucet/hra/<hra>
// ---------------------------------------------------------------------------

export async function handleUcetHraGetRoute(request, env, hra) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;
  if (!HRA_PATTERN.test(hra || '')) return jsonOdpoved(request, env, { error: 'bad_hra' }, 400);

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  let stav = null;
  try {
    stav = await env.ASISTENT_CACHE.get(hraKluc(hra, ucet.email), 'json');
  } catch (e) {
    console.warn('[arling-asistent] ucet: citanie stavu hry z KV zlyhalo:', (e && e.message) || e);
  }
  return jsonOdpoved(request, env, stav && typeof stav === 'object' ? stav : {}, 200);
}

/**
 * Worker obsah hry NEČÍTA, len ho uloží - overí sa len veľkosť (do 64 kB) a
 * že telo je JSON objekt (nie pole, reťazec či číslo).
 */
export async function handleUcetHraPutRoute(request, env, hra) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;
  if (!HRA_PATTERN.test(hra || '')) return jsonOdpoved(request, env, { error: 'bad_hra' }, 400);
  const limit = await strazLimitu(request, env);
  if (limit) return limit;

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  // Zoznam hier účtu drží strop HRA_MAX_POCET. Je to nové pole; staršie účty
  // ho nemajú a doplní sa pri prvom zápise, takže nič netreba migrovať.
  const hry = Array.isArray(ucet.hry) ? ucet.hry : [];
  const novaHra = !hry.includes(hra);
  if (novaHra && hry.length >= HRA_MAX_POCET) {
    return jsonOdpoved(request, env, { error: 'too_many_games', max_games: HRA_MAX_POCET }, 409);
  }

  const deklarovana = Number(request.headers.get('content-length'));
  if (Number.isFinite(deklarovana) && deklarovana > HRA_MAX_BYTES) {
    return jsonOdpoved(request, env, { error: 'payload_too_large', max_bytes: HRA_MAX_BYTES }, 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > HRA_MAX_BYTES) {
    return jsonOdpoved(request, env, { error: 'payload_too_large', max_bytes: HRA_MAX_BYTES }, 413);
  }

  let stav;
  try {
    stav = JSON.parse(text);
  } catch (e) {
    return jsonOdpoved(request, env, { error: 'bad_json' }, 400);
  }
  if (!stav || typeof stav !== 'object' || Array.isArray(stav)) {
    return jsonOdpoved(request, env, { error: 'bad_json' }, 400);
  }

  await env.ASISTENT_CACHE.put(hraKluc(hra, ucet.email), JSON.stringify(stav));
  if (novaHra) {
    ucet.hry = [...hry, hra];
    await ulozUcet(env.ASISTENT_CACHE, ucet);
  }
  return jsonOdpoved(request, env, { ok: true }, 200);
}

// ---------------------------------------------------------------------------
// 7. POST /v1/ucet/odhlasit
// ---------------------------------------------------------------------------

export async function handleUcetOdhlasitRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  ucet.verzia = (ucet.verzia || 1) + 1;
  await ulozUcet(env.ASISTENT_CACHE, ucet);
  return jsonOdpoved(request, env, { ok: true }, 200);
}

// ---------------------------------------------------------------------------
// 8. DELETE /v1/ucet/ja ("zabudnite ma")
// ---------------------------------------------------------------------------

/**
 * Zmaže každý ucet:hra:<hra>:<email> záznam pre tento e-mail. Kľúče majú
 * e-mail až na konci (hra je pred ním), takže KV list ide podľa spoločného
 * predpony ucet:hra: a filtruje sa podľa prípony - rovnaký vzor ako
 * listAllKeys v upload.js.
 */
async function zmazVsetkyHry(kv, email) {
  if (!kv || typeof kv.list !== 'function') return;
  const pripona = `:${email}`;
  let cursor;
  for (let kolo = 0; kolo < 200; kolo++) {
    let stranka;
    try {
      stranka = await kv.list(cursor ? { prefix: 'ucet:hra:', cursor } : { prefix: 'ucet:hra:' });
    } catch (e) {
      console.warn('[arling-asistent] ucet: zoznam hier pre zmazanie zlyhal:', (e && e.message) || e);
      return;
    }
    const kluce = (stranka && stranka.keys) || [];
    for (const k of kluce) {
      if (k.name.endsWith(pripona)) {
        try {
          await kv.delete(k.name);
        } catch (e) {
          console.warn('[arling-asistent] ucet: zmazanie stavu hry zlyhalo:', (e && e.message) || e);
        }
      }
    }
    if (!stranka || stranka.list_complete || !stranka.cursor) break;
    cursor = stranka.cursor;
  }
}

export async function handleUcetDeleteRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  const kv = env.ASISTENT_CACHE;
  await zmazVsetkyHry(kv, ucet.email);

  // Nákupy ostávajú kvôli zákonu o účtovníctve; všetko ostatné (verzia sa
  // zvýši, aby žiadny starý token už neplatil) sa nahradí minimálnym
  // záznamom presne podľa spec-ucet.md časti A.8.
  const zmazany = {
    email: ucet.email,
    vytvorene: ucet.vytvorene,
    verzia: (ucet.verzia || 1) + 1,
    nakupy: ucet.nakupy || [],
    zmazane: true,
  };
  await ulozUcet(kv, zmazany);
  return jsonOdpoved(request, env, { ok: true }, 200);
}
