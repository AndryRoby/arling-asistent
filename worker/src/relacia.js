/*
 * relacia.js
 *
 * Podpísaná relácia rozhovoru (ops/asistent/genialny-plan.md 2.2 bod 2, krok 1).
 *
 * Doteraz widget posielal náhodné `session` a server ho pamätal v KV: robot,
 * ktorý posielal stále to isté `session`, mal rozhovor zadarmo donekonečna
 * (NP:11). Odteraz vydáva reláciu server: prvá odpoveď nesie token `relacia`,
 * widget ho pošle s ďalšou otázkou a každá odpoveď vráti nový token s
 * počtom otázok o jednu vyšším.
 *
 * Token: "r1." + base64url(JSON {t: tenant, i: náhodné id, c: začiatok v
 * sekundách, n: počet zodpovedaných otázok}) + "." + base64url(HMAC-SHA256).
 * Kľúč je odvodený z UCET_TAJOMSTVO s predponou účelu "asistent-relacia:",
 * takže sa token relácie nedá zameniť s tokenom účtu (ucet.js) ani naopak.
 *
 * Pravidlá (plán 2.1): rozhovor = relácia do 24 hodín a najviac 10 otázok
 * (premenná ASISTENT_MAX_OTAZOK, pozri maxOtazok). Chýbajúci, podvrhnutý,
 * cudzí (iný obchod), starý alebo plný token znamená nový započítaný
 * rozhovor, nikdy chybu: zákazník pokračuje ďalej, len sa započíta ďalší
 * rozhovor.
 *
 * Opakovanie starého tokenu (oprava nálezu V1 kontroly kroku 1): token je
 * bezstavový, takže ten istý token s n=1 by inak šiel poslať dookola ako
 * jeden rozhovor. Po každej odpovedi sa preto do KV zapíše najvyššie vydané
 * n relácie pod kľúčom `relacia-n:<odtlačok>` (SHA-256 z tajomstva, obchodu a
 * id, prvých 16 znakov; nie id relácie, nie IP, nič v D1), na 25 hodín.
 * Token s n menším, ako je zapísané, je opakovanie a začne nový započítaný
 * rozhovor. KV nie je atomické: súbežné opakovanie (S9) prejde, kým sa zápis
 * nerozšíri; strop takej dávky dávajú atomické denné limity v D1 (ochrana.js).
 *
 * Bez UCET_TAJOMSTVO (lokálny vývoj, staré testy) je relácia vypnutá a
 * platí pôvodné počítanie podľa `session` v KV (tenants.js). Na živom
 * workeri je tajomstvo nastavené, lebo bez neho nefunguje ani účet.
 */

import { bezpecnePorovnaj } from './security.js';

export const MAX_OTAZOK_NA_ROZHOVOR = 10;
export const RELACIA_PLATNOST_S = 24 * 60 * 60;
export const RELACIA_PREDPONA = 'asistent-relacia:';
const VERZIA = 'r1';
// Tolerancia hodín do budúcnosti (iný izolát, posun času), potom je token neplatný.
const BUDUCNOST_TOLERANCIA_S = 300;
const ID_RE = /^[0-9a-f]{16}$/;

export function jeRelaciaZapnuta(env) {
  return Boolean(env && typeof env.UCET_TAJOMSTVO === 'string' && env.UCET_TAJOMSTVO);
}

/**
 * Najviac otázok v jednom rozhovore. Plán 2.1 hovorí 10 (predvolené), ale je
 * to bod 3.2/1 na Andrejovo schválenie a verejné texty (plugin, porovnania)
 * zatiaľ sľubujú „however many questions“. Premenná ASISTENT_MAX_OTAZOK vo
 * wrangler.toml preto dovoľuje nasadiť ochranu bez zmeny sľubu (celé číslo 1
 * až 1000); postup je v ops/asistent/stavba/krok1-ochrana.md.
 */
export function maxOtazok(env) {
  const n = Number(env && env.ASISTENT_MAX_OTAZOK);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : MAX_OTAZOK_NA_ROZHOVOR;
}

/** Ako dlho KV pamätá najvyššie n relácie (o hodinu dlhšie ako platí token). */
export const RELACIA_ZNACKA_TTL_S = RELACIA_PLATNOST_S + 60 * 60;

async function klucZnacky(env, tenantId, id) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`relacia-n|${env.UCET_TAJOMSTVO}|${tenantId}|${id}`));
  let hex = '';
  for (const b of new Uint8Array(buf).slice(0, 8)) hex += (b < 16 ? '0' : '') + b.toString(16);
  return `relacia-n:${hex}`;
}

/**
 * Je platný token opakovaním staršieho (server už vydal vyššie n)? Chyba KV
 * alebo chýbajúci záznam = nie (limity v D1 aj tak platia). Nikdy nehádže.
 */
export async function jeOpakovanie(env, tenantId, relacia) {
  try {
    const kv = env && env.ASISTENT_CACHE;
    if (!kv || !relacia || relacia.stav !== 'platna' || !jeRelaciaZapnuta(env)) return false;
    const ulozene = Number(await kv.get(await klucZnacky(env, tenantId, relacia.id)));
    return Number.isFinite(ulozene) && ulozene > relacia.n;
  } catch (e) {
    console.warn('[arling-asistent] relacia: KV chyba pri kontrole opakovania:', (e && e.message) || e);
    return false;
  }
}

/** Zapamätá najvyššie vydané n relácie. Nikdy nehádže. */
export async function zapamatajN(env, tenantId, id, n) {
  try {
    const kv = env && env.ASISTENT_CACHE;
    if (!kv || !id || !jeRelaciaZapnuta(env)) return;
    await kv.put(await klucZnacky(env, tenantId, id), String(n), { expirationTtl: RELACIA_ZNACKA_TTL_S });
  } catch (e) {
    console.warn('[arling-asistent] relacia: KV chyba pri zapise n:', (e && e.message) || e);
  }
}

function b64urlZBajtov(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlZTextu(text) {
  return b64urlZBajtov(new TextEncoder().encode(text));
}

function textZB64url(b64) {
  const s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Odvodený kľúč na tajomstvo, v izoláte len raz.
const klucCache = new Map();

async function kluc(tajomstvo) {
  let k = klucCache.get(tajomstvo);
  if (k) return k;
  const enc = new TextEncoder();
  const hlavny = await crypto.subtle.importKey('raw', enc.encode(tajomstvo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const odvodeny = new Uint8Array(await crypto.subtle.sign('HMAC', hlavny, enc.encode(RELACIA_PREDPONA)));
  k = await crypto.subtle.importKey('raw', odvodeny, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  if (klucCache.size > 8) klucCache.clear();
  klucCache.set(tajomstvo, k);
  return k;
}

async function podpis(tajomstvo, sprava) {
  const buf = await crypto.subtle.sign('HMAC', await kluc(tajomstvo), new TextEncoder().encode(sprava));
  return b64urlZBajtov(new Uint8Array(buf));
}

export function noveIdRelacie() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out;
}

/**
 * Vydá token relácie. `n` = počet otázok už zodpovedaných v tomto rozhovore
 * (vrátane tej, na ktorú práve odpovedáme). Bez tajomstva vráti null.
 */
export async function vydajRelaciu(env, { tenantId, id = noveIdRelacie(), zaciatok, n = 1, now = Date.now() } = {}) {
  if (!jeRelaciaZapnuta(env) || !tenantId) return null;
  const c = Number.isFinite(zaciatok) ? zaciatok : Math.floor(new Date(now).getTime() / 1000);
  const telo = b64urlZTextu(JSON.stringify({ t: String(tenantId), i: id, c, n }));
  const cast = `${VERZIA}.${telo}`;
  return `${cast}.${await podpis(env.UCET_TAJOMSTVO, cast)}`;
}

/**
 * Overí token relácie pre daný obchod. Vracia {stav, id?, zaciatok?, n?}:
 *   'platna'   pokračovanie rozhovoru (n < maxOtazok(env)),
 *   'plna'     podpis sedí, ale rozhovor už má maxOtazok(env) otázok (nový rozhovor),
 *   'stara'    podpis sedí, ale od začiatku prešlo viac ako 24 hodín,
 *   'cudzia'   podpis sedí, ale token patrí inému obchodu,
 *   'neplatna' zlý tvar alebo podpis (podvrh),
 *   'ziadna'   token nebol poslaný,
 *   'vypnuta'  bez UCET_TAJOMSTVO sa relácie nepoužívajú.
 * Nikdy nehádže.
 */
export async function overRelaciu(env, tenantId, token, { now = Date.now() } = {}) {
  if (!jeRelaciaZapnuta(env)) return { stav: 'vypnuta' };
  if (token == null || token === '') return { stav: 'ziadna' };
  try {
    if (typeof token !== 'string' || token.length > 600) return { stav: 'neplatna' };
    const casti = token.split('.');
    if (casti.length !== 3 || casti[0] !== VERZIA) return { stav: 'neplatna' };
    const ocakavany = await podpis(env.UCET_TAJOMSTVO, `${casti[0]}.${casti[1]}`);
    if (!bezpecnePorovnaj(ocakavany, casti[2])) return { stav: 'neplatna' };
    const data = JSON.parse(textZB64url(casti[1]));
    const n = Number(data && data.n);
    const c = Number(data && data.c);
    if (!data || typeof data.i !== 'string' || !ID_RE.test(data.i) || !Number.isInteger(n) || n < 0 || !Number.isFinite(c)) {
      return { stav: 'neplatna' };
    }
    if (data.t !== String(tenantId)) return { stav: 'cudzia' };
    const teraz = Math.floor(new Date(now).getTime() / 1000);
    if (c > teraz + BUDUCNOST_TOLERANCIA_S || teraz - c > RELACIA_PLATNOST_S) return { stav: 'stara' };
    if (n >= maxOtazok(env)) return { stav: 'plna', id: data.i, zaciatok: c, n };
    return { stav: 'platna', id: data.i, zaciatok: c, n };
  } catch (e) {
    return { stav: 'neplatna' };
  }
}
