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

import { corsHeaders, parseAllowedOrigins } from './security.js';
import { fetchCheckoutSession, isAdmin, SESSION_ID_PATTERN } from './upload.js';

// ---------------------------------------------------------------------------
// Konštanty
// ---------------------------------------------------------------------------

export const KOD_TTL_SECONDS = 900; // 15 minut, ako v e-maile
export const MAX_POKUSOV = 5;
export const LIMIT_EMAIL_ZA_HODINU = 3;
export const LIMIT_IP_ZA_HODINU = 10;
export const LIMIT_OKNO_SECONDS = 3600;
export const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 dni
export const HRA_MAX_BYTES = 64 * 1024;
export const HRA_PATTERN = /^[a-z0-9-]{1,32}$/;

// Konštanta zo špecifikácie (časť A.3); env.STRIPE_PORTAL_URL ju môže
// prepísať, keby sa Stripe portál niekedy presunul.
export const DEFAULT_STRIPE_PORTAL_URL = 'https://billing.stripe.com/p/login/3cIaER9M63hNeFcg8B4ko00';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JAZYKY = new Set(['sk', 'en', 'de']);

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

function jsonOdpoved(request, env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...corsFor(request, env),
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

/** Verejný tvar účtu pre POST /v1/ucet/over - bez interných polí (verzia je interná, slúži len tokenu). */
function verejnyUcet(ucet) {
  return {
    email: ucet.email,
    vytvorene: ucet.vytvorene,
    nakupy: ucet.nakupy || [],
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

const TEXTY_KODU = {
  sk: {
    predmet: (kod) => `Váš kód: ${kod}`,
    text: (kod, odkaz) => `Váš kód: ${kod}\n\nAlebo kliknite na odkaz: ${odkaz}\n\nAk ste kód nepýtali, tento e-mail ignorujte. Platí 15 minút.`,
    html: (kod, odkaz) => `<p>Váš kód: <strong style="font-size:24px">${kod}</strong></p><p>Alebo kliknite na odkaz: <a href="${odkaz}">${odkaz}</a></p><p>Ak ste kód nepýtali, tento e-mail ignorujte. Platí 15 minút.</p>`,
  },
  en: {
    predmet: (kod) => `Your code: ${kod}`,
    text: (kod, odkaz) => `Your code: ${kod}\n\nOr click this link: ${odkaz}\n\nIf you did not request this code, ignore this e-mail. Valid for 15 minutes.`,
    html: (kod, odkaz) => `<p>Your code: <strong style="font-size:24px">${kod}</strong></p><p>Or click this link: <a href="${odkaz}">${odkaz}</a></p><p>If you did not request this code, ignore this e-mail. Valid for 15 minutes.</p>`,
  },
  de: {
    predmet: (kod) => `Ihr Code: ${kod}`,
    text: (kod, odkaz) => `Ihr Code: ${kod}\n\nOder klicken Sie auf den Link: ${odkaz}\n\nWenn Sie diesen Code nicht angefordert haben, ignorieren Sie diese E-Mail. 15 Minuten gültig.`,
    html: (kod, odkaz) => `<p>Ihr Code: <strong style="font-size:24px">${kod}</strong></p><p>Oder klicken Sie auf den Link: <a href="${odkaz}">${odkaz}</a></p><p>Wenn Sie diesen Code nicht angefordert haben, ignorieren Sie diese E-Mail. 15 Minuten gültig.</p>`,
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
        reply_to: 'andrej@arling.sk',
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

  const emailOk = await pripocitajLimit(kv, limitEmailKluc(email), LIMIT_EMAIL_ZA_HODINU);
  if (!emailOk) return jsonOdpoved(request, env, { error: 'rate_limited' }, 429);
  const ipOk = await pripocitajLimit(kv, limitIpKluc(ip), LIMIT_IP_ZA_HODINU);
  if (!ipOk) return jsonOdpoved(request, env, { error: 'rate_limited' }, 429);

  const kod = vygenerujKod();
  const zaznam = { kod, pokusy: 0, vytvorene: new Date().toISOString() };
  await kv.put(kodKluc(email), JSON.stringify(zaznam), { expirationTtl: KOD_TTL_SECONDS });

  const jazyk = typeof (telo && telo.jazyk) === 'string' ? telo.jazyk : 'sk';
  const odoslane = await posliKodEmailom(env, { email, kod, jazyk });
  if (!odoslane) {
    await kv.delete(kodKluc(email));
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

  const zadanyKod = String((telo && telo.kod) || '').trim();
  if (zadanyKod !== zaznam.kod) {
    const pokusy = (zaznam.pokusy || 0) + 1;
    if (pokusy >= MAX_POKUSOV) {
      await kv.delete(kodKluc(email));
      return jsonOdpoved(request, env, { error: 'bad_code', remaining: 0 }, 400);
    }
    const zostavaTtl = Math.max(1, Math.round(KOD_TTL_SECONDS - vekSekund));
    await kv.put(kodKluc(email), JSON.stringify({ ...zaznam, pokusy }), { expirationTtl: zostavaTtl });
    return jsonOdpoved(request, env, { error: 'bad_code', remaining: MAX_POKUSOV - pokusy }, 400);
  }

  await kv.delete(kodKluc(email));
  let ucet = await nacitajUcet(kv, email);
  if (!ucet) ucet = novyUcet(email);
  await doplnNakupyZoStripe(env, ucet);
  await ulozUcet(kv, ucet);

  const token = await vytvorToken(env, { email, verzia: ucet.verzia });
  return jsonOdpoved(request, env, { token, email, ucet: verejnyUcet(ucet) }, 200);
}

// ---------------------------------------------------------------------------
// 3. GET /v1/ucet/ja
// ---------------------------------------------------------------------------

export async function handleUcetJaRoute(request, env) {
  const straz = strazSecretu(request, env);
  if (straz) return straz;

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

  return jsonOdpoved(request, env, {
    email: ucet.email,
    nakupy: ucet.nakupy || [],
    predplatne: ucet.predplatne || [],
    portal_url: env.STRIPE_PORTAL_URL || DEFAULT_STRIPE_PORTAL_URL,
  }, 200);
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

  const { ucet, chyba } = await autentifikuj(request, env);
  if (chyba) return jsonOdpoved(request, env, { error: 'unauthorized' }, 401);

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
