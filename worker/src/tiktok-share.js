/*
 * tiktok-share.js
 *
 * Server half of the Puzzle video maker, https://arling.sk/puzzle-video/.
 * A visitor makes a puzzle video in their own browser, signs in to THEIR OWN
 * TikTok account with Login Kit, and this module sends the video to that
 * account's TikTok inbox as a draft (Content Posting API, Upload, source
 * FILE_UPLOAD, scope video.upload). The creator finishes and posts it in the
 * TikTok app. There is no operator key and no ARLing account in the flow.
 *
 * Why here and not in products/tiktok-service: that service was built as an
 * operator tool for one account (tokens in a file on the homelab, operator
 * token, videos from a server folder). A tool for every creator needs the
 * opposite: nothing stored, one short session per visitor, the video coming
 * from the visitor. This worker is already public, already has a KV for
 * per-IP limits, and holds no file of tokens at all.
 *
 * Routes (all POST, all only from https://arling.sk, see corsPre()):
 *   POST /v1/tiktok/start    {challenge}                 -> {state, authorizeUrl}
 *   POST /v1/tiktok/session  {code, state, verifier}     -> {session, displayName}
 *   POST /v1/tiktok/upload   body = the video, header X-TikTok-Session
 *                                                        -> {publishId, status, revoked}
 *   POST /v1/tiktok/status   {session, publishId}        -> {status, revoked}
 *   POST /v1/tiktok/cancel   {session}                   -> {revoked}
 *   OPTIONS on the same paths                            -> preflight
 * Error bodies are {error, revoked?}; `revoked` says whether this request
 * already revoked the token at TikTok, so the page knows whether to call
 * /cancel itself.
 *
 * State and PKCE. The browser makes a code_verifier and sends only its
 * SHA-256 (the challenge). /start answers with a state signed by this worker
 * (HMAC, key derived from TIKTOK_CLIENT_SECRET) that carries the challenge,
 * a nonce and the time. /session accepts the TikTok code only together with
 * that state (signature, age at most 10 minutes, nonce used once) and the
 * verifier whose hash is in it. So a code can only be redeemed by the same
 * browser tab that started the sign-in. TikTok documents code_verifier for
 * mobile and desktop only (https://developers.tiktok.com/doc/oauth-user-access-token-management:
 * "Required for mobile and desktop app only"), so by default PKCE stays
 * between the browser and this worker; TIKTOK_PKCE_UPSTREAM = "1" also sends
 * code_challenge and code_verifier to TikTok, for a sandbox try.
 *
 * Tokens. The access token never reaches the browser in readable form and is
 * never written anywhere. /session seals it with AES-GCM (key also derived
 * from the client secret) into an opaque value. The seal allows an upload for
 * 15 minutes; /status and /cancel still open it for 24 hours (the lifetime of
 * a TikTok access token), so that the token can be revoked even after the
 * upload window is over. The token is revoked at TikTok (/v2/oauth/revoke/)
 * as soon as the draft is in the inbox or the upload failed, when the page
 * cancels, when an upload fails on our side, and when our own rate limit
 * refuses an upload. Revoking while TikTok still processes the video would
 * fail the upload (the status API lists "auth_removed" as a fail reason), so
 * during processing the page keeps asking /status and decides with the
 * creator; see app.mjs.
 *
 * What is kept: per-IP rate-limit counters in KV, keyed by an HMAC of the IP
 * with a key derived from the client secret and the UTC date (so the key
 * changes every day and the IP cannot be recovered by hashing all IPv4
 * addresses without the secret; it is still pseudonymised personal data,
 * not anonymous), deleted by KV within two windows, at most two days; a
 * used-state nonce for 15 minutes; one daily count of uploads without any
 * IP or account. No video, no token, no TikTok user id. Cloudflare's own
 * request logs (observability in wrangler.toml) are outside this module.
 *
 * Memory. The worker also serves the paid chat product, and a Workers isolate
 * has 128 MB for all concurrent requests. The video is therefore streamed to
 * TikTok's upload URL and never held whole in memory when the browser sends a
 * Content-Length (browsers do for a Blob body). Without Content-Length it is
 * buffered once, at most MAX_VIDEO_BAJTOV. JSON bodies are read with a cap.
 *
 * Secrets: TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (wrangler secret put).
 * Without both every route answers 503 tiktok_unavailable (fail closed).
 * Optional vars: TIKTOK_REDIRECT_URI (default https://arling.sk/puzzle-video/),
 * TIKTOK_PKCE_UPSTREAM ("1" or unset).
 *
 * TikTok rules this follows (read 24. 9. 2026):
 *   https://developers.tiktok.com/doc/login-kit-web
 *   https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 *   https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *   https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *   https://developers.tiktok.com/doc/content-sharing-guidelines
 */

import { checkRateLimit, SECURITY_HEADERS, bezpecnePorovnaj } from './security.js';

const API = 'https://open.tiktokapis.com';
export const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_ORIGINS = ['https://arling.sk', 'https://www.arling.sk'];
export const REDIRECT_URI_PREDVOLENE = 'https://arling.sk/puzzle-video/';
export const ROZSAHY = 'user.info.basic,video.upload';
export const CESTY = ['/v1/tiktok/start', '/v1/tiktok/session', '/v1/tiktok/upload', '/v1/tiktok/status', '/v1/tiktok/cancel'];

/** Najväčšie video, ktoré prijmeme. 30-sekundový odpočet dá 41,1 s videa, pri 4 Mbit/s a AAC okolo 21 MB. */
export const MAX_VIDEO_BAJTOV = 30 * 1024 * 1024;
export const MIN_VIDEO_BAJTOV = 16 * 1024;
export const STATE_PLATNOST_MS = 10 * 60 * 1000;
export const RELACIA_PLATNOST_MS = 15 * 60 * 1000;
/** Ako dlho po konci relácie ešte pečať otvoria /status a /cancel: životnosť access tokenu TikToku. */
export const ZRUSENIE_PRESAH_MS = 24 * 60 * 60 * 1000;
const MAX_JSON_BAJTOV = 8192;
const UPLOAD_HOSTS = ['tiktokapis.com', 'tiktok.com'];
/** Media transfer guide: kus 5 až 64 MB, posledný až 128 MB; menšie video ide celé naraz. */
const CELE_NARAZ_MAX = 64 * 1000 * 1000;
const KUS = 10 * 1024 * 1024;
const MAX_KUSOV = 1000;
/** Chyby videa, pri ktorých relácia ostáva: tvorca môže video vyrobiť znova a poslať ho. */
export const CHYBY_VIDEA = ['video_too_large', 'video_too_small', 'video_format', 'video_length_mismatch'];

/** Limity na odtlačok IP. Upload: TikTok sám dovolí 5 čakajúcich konceptov za 24 h na účet. */
export const LIMITY = {
  start: { limit: 20, windowSeconds: 3600 },
  session: { limit: 12, windowSeconds: 3600 },
  upload: { limit: 6, windowSeconds: 3600 },
  uploadDen: { limit: 15, windowSeconds: 86400 },
  status: { limit: 120, windowSeconds: 600 },
  cancel: { limit: 30, windowSeconds: 3600 },
  vsetkyUploadyDen: { limit: 500, windowSeconds: 86400 },
};

export class TikTokChyba extends Error {
  constructor(kod, status = 400) {
    super(kod);
    this.kod = kod;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Pomocné: base64url, kľúče, čas
// ---------------------------------------------------------------------------

export function base64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function zBase64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new TikTokChyba('format', 400);
  const s = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

export async function sha256b64url(text) {
  return base64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** Odvodený kľúč: HMAC(client_secret, účel). Rôzny účel dá nezávislý kľúč pre state, pečať a odtlačok IP. */
async function odvodenyKluc(secret, ucel) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(ucel)));
}

async function hmacKluc(secret, ucel = 'arling-tiktok-state-v1') {
  const raw = await odvodenyKluc(secret, ucel);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function aesKluc(secret) {
  const raw = await odvodenyKluc(secret, 'arling-tiktok-seal-v1');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const teraz = (env) => (env && typeof env.teraz === 'function' ? env.teraz() : Date.now());

/**
 * Pseudonymizovaný odtlačok IP pre počítadlá limitov: HMAC(IP) s kľúčom odvodeným z client secret
 * a dátumu UTC. Bez tajomstva sa z neho IP nedá dopočítať ani prehľadaním celého IPv4, kľúč sa
 * mení každý deň (zhoduje sa s dennými oknami limitov, takže rotácia nič nevynuluje navyše).
 */
export async function odtlacokIp(ip, secret, now = Date.now()) {
  const den = new Date(now).toISOString().slice(0, 10);
  const kluc = await hmacKluc(secret, 'arling-tiktok-ip-v2:' + den);
  return base64url(await crypto.subtle.sign('HMAC', kluc, enc.encode(String(ip || 'unknown')))).slice(0, 22);
}

// ---------------------------------------------------------------------------
// State (podpísaný, nesie PKCE challenge)
// ---------------------------------------------------------------------------

export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export async function vytvorState(secret, challenge, now = Date.now()) {
  if (!CHALLENGE_RE.test(String(challenge || ''))) throw new TikTokChyba('challenge_invalid', 400);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const telo = base64url(enc.encode(JSON.stringify({ v: 1, n: nonce, t: now, c: challenge })));
  const podpis = base64url(await crypto.subtle.sign('HMAC', await hmacKluc(secret), enc.encode(telo)));
  return `${telo}.${podpis}`;
}

/** Overí podpis a vek statu. Vráti {n, t, c} alebo hodí TikTokChyba. */
export async function overState(secret, state, now = Date.now()) {
  const casti = String(state || '').split('.');
  if (casti.length !== 2 || !casti[0] || !casti[1] || state.length > 600) throw new TikTokChyba('state_invalid', 400);
  const [telo, podpis] = casti;
  const ocakavany = base64url(await crypto.subtle.sign('HMAC', await hmacKluc(secret), enc.encode(telo)));
  if (!bezpecnePorovnaj(ocakavany, podpis)) throw new TikTokChyba('state_invalid', 400);
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(zBase64url(telo))); } catch (e) { throw new TikTokChyba('state_invalid', 400); }
  if (!obj || obj.v !== 1 || typeof obj.t !== 'number' || !CHALLENGE_RE.test(String(obj.c || '')) || !obj.n) {
    throw new TikTokChyba('state_invalid', 400);
  }
  if (obj.t > now + 60_000) throw new TikTokChyba('state_invalid', 400);
  if (now - obj.t > STATE_PLATNOST_MS) throw new TikTokChyba('state_expired', 400);
  return obj;
}

// ---------------------------------------------------------------------------
// Pečať relácie (access token zašifrovaný, len v pamäti stránky)
// ---------------------------------------------------------------------------

export async function zapecat(secret, obsah, now = Date.now()) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify({ ...obsah, x: now + RELACIA_PLATNOST_MS }));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKluc(secret), data);
  return `${base64url(iv)}.${base64url(ct)}`;
}

/**
 * Otvorí pečať. `presah` (ms) dovolí otvoriť aj prepadnutú pečať: upload ho nemá (15 minút platí
 * presne), /status a /cancel majú ZRUSENIE_PRESAH_MS, aby sa token dal zrušiť aj po 15 minútach.
 */
export async function rozpecat(secret, pecat, now = Date.now(), { presah = 0 } = {}) {
  const casti = String(pecat || '').split('.');
  if (casti.length !== 2 || String(pecat).length > 4096) throw new TikTokChyba('session_invalid', 401);
  let obj;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: zBase64url(casti[0]) }, await aesKluc(secret), zBase64url(casti[1]));
    obj = JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    throw new TikTokChyba('session_invalid', 401);
  }
  if (!obj || typeof obj.a !== 'string' || typeof obj.x !== 'number') throw new TikTokChyba('session_invalid', 401);
  if (obj.x + presah < now) throw new TikTokChyba('session_expired', 401);
  return obj;
}

// ---------------------------------------------------------------------------
// Video: veľkosť, formát, kusy, prúd
// ---------------------------------------------------------------------------

/** MP4 má na bajtoch 4 až 7 'ftyp', WebM začína EBML hlavičkou 1A 45 DF A3. Iné nepúšťame ďalej. */
export function typVidea(bytes) {
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return null;
}

/** (chunk_size, total_chunk_count) podľa media transfer guide. */
export function rozdelNaKusy(velkost) {
  if (!Number.isInteger(velkost) || velkost <= 0) throw new TikTokChyba('video_empty', 400);
  if (velkost <= CELE_NARAZ_MAX) return { kus: velkost, pocet: 1 };
  const pocet = Math.floor(velkost / KUS);
  if (pocet > MAX_KUSOV) throw new TikTokChyba('video_too_large', 413);
  return { kus: KUS, pocet };
}

export function rozsahyKusov(velkost, kus, pocet) {
  const out = [];
  for (let i = 0; i < pocet; i++) {
    const od = i * kus;
    const po = i === pocet - 1 ? velkost - 1 : od + kus - 1;
    out.push([od, po]);
  }
  return out;
}

export function uploadUrlOk(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && UPLOAD_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

/**
 * Prečíta prúd najviac do `max` bajtov a vráti kúsky bez ďalšieho kopírovania.
 * Viac než `max` je TikTokChyba(kod, 413) a čítanie sa zruší.
 */
export async function precitajKusy(prud, max, kod = 'video_too_large') {
  if (!prud) return { kusy: [], spolu: 0 };
  const citac = prud.getReader();
  const kusy = [];
  let spolu = 0;
  for (;;) {
    const { done, value } = await citac.read();
    if (done) break;
    spolu += value.length;
    if (spolu > max) {
      try { await citac.cancel(); } catch (e) { /* nič */ }
      throw new TikTokChyba(kod, 413);
    }
    kusy.push(value);
  }
  return { kusy, spolu };
}

function spoj(kusy, spolu) {
  if (kusy.length === 1) return kusy[0];
  const out = new Uint8Array(spolu);
  let i = 0;
  for (const k of kusy) { out.set(k, i); i += k.length; }
  return out;
}

/** Čítač nad kúskami v pamäti, s rovnakým rozhraním ako ReadableStreamDefaultReader. */
function citacZKusov(kusy) {
  let i = 0;
  return { read: async () => (i < kusy.length ? { done: false, value: kusy[i++] } : { done: true, value: undefined }), cancel: async () => { i = kusy.length; } };
}

/** Prečíta aspoň `min` bajtov zo začiatku (na určenie formátu). Vráti ich ako jeden Uint8Array. */
async function citajHlavu(citac, min) {
  const kusy = [];
  let n = 0;
  while (n < min) {
    const { done, value } = await citac.read();
    if (done) break;
    kusy.push(value);
    n += value.length;
  }
  return spoj(kusy, n);
}

/**
 * Prúd pre PUT na TikTok: najprv už prečítaná hlava, potom zvyšok tela, ťahom (pull), takže
 * v pamäti je naraz len niekoľko kúskov. Počíta bajty: viac než `dlzka` je video_too_large,
 * menej je video_length_mismatch; prúd sa vtedy preruší a PUT zlyhá.
 */
export function prudVidea(hlava, citac, dlzka) {
  let spolu = 0;
  let chyba = null;
  let prvy = hlava;
  const prud = new ReadableStream({
    async pull(c) {
      let value;
      if (prvy) {
        value = prvy;
        prvy = null;
      } else {
        const r = await citac.read();
        if (r.done) {
          if (spolu !== dlzka) {
            chyba = new TikTokChyba('video_length_mismatch', 400);
            c.error(chyba);
          } else {
            c.close();
          }
          return;
        }
        value = r.value;
      }
      spolu += value.length;
      if (spolu > dlzka) {
        chyba = new TikTokChyba('video_too_large', 413);
        try { await citac.cancel(); } catch (e) { /* nič */ }
        c.error(chyba);
        return;
      }
      c.enqueue(value);
    },
    async cancel() {
      try { await citac.cancel(); } catch (e) { /* nič */ }
    },
  }, { highWaterMark: 0 });
  return { prud, chyba: () => chyba, spolu: () => spolu };
}

// ---------------------------------------------------------------------------
// Volania TikToku
// ---------------------------------------------------------------------------

function konfiguracia(env) {
  const clientKey = String(env.TIKTOK_CLIENT_KEY || '').trim();
  const secret = String(env.TIKTOK_CLIENT_SECRET || '').trim();
  if (!clientKey || !secret) throw new TikTokChyba('tiktok_unavailable', 503);
  return {
    clientKey,
    secret,
    redirectUri: String(env.TIKTOK_REDIRECT_URI || '').trim() || REDIRECT_URI_PREDVOLENE,
    pkceUpstream: String(env.TIKTOK_PKCE_UPSTREAM || '') === '1',
    fetchImpl: env.fetchImpl || fetch.bind(globalThis),
  };
}

async function citajJson(r) {
  try { return await r.json(); } catch (e) { return {}; }
}

/** Kódy z Content Posting API, pri ktorých stránka vie povedať presnú vetu. Ostatné idú ako tiktok_error. */
const ZNAME_KODY = {
  spam_risk_too_many_pending_share: 429,
  spam_risk_user_banned_from_posting: 403,
  access_token_invalid: 401,
  scope_not_authorized: 403,
  rate_limit_exceeded: 429,
  invalid_param: 400,
};

async function apiPost(k, cesta, token, telo) {
  const r = await k.fetchImpl(API + cesta, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(telo),
  });
  const obj = await citajJson(r);
  const kod = obj && obj.error && obj.error.code;
  if (r.ok && kod === 'ok') return obj.data || {};
  if (kod && ZNAME_KODY[kod]) throw new TikTokChyba(kod, ZNAME_KODY[kod]);
  console.warn('[tiktok] API', cesta, 'http', r.status, 'kod', kod || '-', 'log_id', (obj && obj.error && obj.error.log_id) || '-');
  throw new TikTokChyba('tiktok_error', 502);
}

async function vymenKod(k, code, verifier) {
  const telo = new URLSearchParams({
    client_key: k.clientKey,
    client_secret: k.secret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: k.redirectUri,
  });
  if (k.pkceUpstream) telo.set('code_verifier', verifier);
  const r = await k.fetchImpl(API + '/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: telo.toString(),
  });
  const obj = await citajJson(r);
  if (!r.ok || !obj.access_token || obj.error) {
    console.warn('[tiktok] token exchange odmietnutý, http', r.status, 'error', (obj && obj.error) || '-');
    throw new TikTokChyba('code_rejected', 400);
  }
  return obj;
}

/** Pole error v odpovedi TikToku: reťazec (OAuth) alebo objekt s code (ostatné API); 'ok' a prázdne nie sú chyba. */
function jeChybaTikToku(obj) {
  const e = obj && obj.error;
  if (!e) return false;
  if (typeof e === 'string') return e !== '' && e !== 'ok';
  if (typeof e === 'object') return !!e.code && e.code !== 'ok';
  return true;
}

/**
 * Zruší token u TikToku. Pravda len vtedy, keď TikTok odpovie 2xx a telo nenesie chybu:
 * OAuth endpointy vracajú chybu ako JSON {error, error_description} aj pri HTTP 200.
 */
export async function zrusToken(k, token) {
  try {
    const r = await k.fetchImpl(API + '/v2/oauth/revoke/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({ client_key: k.clientKey, client_secret: k.secret, token }).toString(),
    });
    if (!r.ok) {
      console.warn('[tiktok] revoke http', r.status);
      return false;
    }
    const text = await r.text();
    let obj = {};
    if (text.trim()) {
      try { obj = JSON.parse(text); } catch (e) { obj = {}; }
    }
    if (jeChybaTikToku(obj)) {
      const e = obj.error;
      console.warn('[tiktok] revoke odmietnutý', typeof e === 'string' ? e : e.code, 'log_id', obj.log_id || (e && e.log_id) || '-');
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function menoTvorcu(k, token) {
  const r = await k.fetchImpl(API + '/v2/user/info/?fields=open_id,display_name', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token },
  });
  const obj = await citajJson(r);
  const kod = obj && obj.error && obj.error.code;
  if (!r.ok || kod !== 'ok') throw new TikTokChyba(kod === 'scope_not_authorized' ? 'scope_missing' : 'tiktok_error', kod === 'scope_not_authorized' ? 403 : 502);
  const u = (obj.data && obj.data.user) || {};
  return String(u.display_name || '').slice(0, 80);
}

const HOTOVE = new Set(['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE']);
const KONCOVE = new Set([...HOTOVE, 'FAILED']);

async function stavNahratia(k, token, publishId) {
  const data = await apiPost(k, '/v2/post/publish/status/fetch/', token, { publish_id: publishId });
  return { status: String(data.status || 'UNKNOWN'), failReason: data.fail_reason ? String(data.fail_reason) : null };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function corsPre(origin) {
  if (!TIKTOK_ORIGINS.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TikTok-Session',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function odpoved(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...(cors || {}) },
  });
}

async function limit(env, kto, meno) {
  const kv = env.ASISTENT_CACHE;
  if (!kv) return true;
  const { limit: l, windowSeconds } = LIMITY[meno];
  const r = await checkRateLimit(kv, kto, { limit: l, windowSeconds, name: 'tt' + meno, now: teraz(env) });
  return r.allowed;
}

/** Content-Length ako celé číslo, alebo null, keď chýba. Nezmysel je 400. */
function dlzkaZHlavicky(request) {
  const h = request.headers.get('Content-Length');
  if (h === null || h === '') return null;
  const n = Number(h);
  if (!Number.isSafeInteger(n) || n < 0) throw new TikTokChyba('bad_length', 400);
  return n;
}

/** JSON telo: najprv Content-Length, potom čítanie s limitom, takže veľké telo sa do pamäte nedostane. */
async function jsonTelo(request) {
  const dlzka = dlzkaZHlavicky(request);
  if (dlzka !== null && dlzka > MAX_JSON_BAJTOV) {
    try { if (request.body) await request.body.cancel(); } catch (e) { /* nič */ }
    throw new TikTokChyba('payload_too_large', 413);
  }
  const { kusy, spolu } = await precitajKusy(request.body, MAX_JSON_BAJTOV, 'payload_too_large');
  const text = new TextDecoder().decode(spoj(kusy, spolu));
  try {
    const obj = JSON.parse(text || '{}');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('nie objekt');
    return obj;
  } catch (e) {
    throw new TikTokChyba('bad_json', 400);
  }
}

async function start(request, env, k) {
  const telo = await jsonTelo(request);
  const now = teraz(env);
  const state = await vytvorState(k.secret, telo.challenge, now);
  const q = new URLSearchParams({
    client_key: k.clientKey,
    scope: ROZSAHY,
    response_type: 'code',
    redirect_uri: k.redirectUri,
    state,
  });
  if (k.pkceUpstream) {
    q.set('code_challenge', telo.challenge);
    q.set('code_challenge_method', 'S256');
  }
  return { state, authorizeUrl: `${AUTHORIZE_URL}?${q.toString()}`, redirectUri: k.redirectUri, scopes: ROZSAHY.split(',') };
}

async function relacia(request, env, k) {
  const telo = await jsonTelo(request);
  const now = teraz(env);
  const code = String(telo.code || '');
  if (!code || code.length > 1024) throw new TikTokChyba('code_missing', 400);
  if (!VERIFIER_RE.test(String(telo.verifier || ''))) throw new TikTokChyba('verifier_invalid', 400);
  const st = await overState(k.secret, telo.state, now);
  if ((await sha256b64url(telo.verifier)) !== st.c) throw new TikTokChyba('pkce_mismatch', 400);

  // Nonce len raz: ten istý state sa nedá použiť na druhú výmenu.
  const kv = env.ASISTENT_CACHE;
  if (kv) {
    const kluc = 'tiktok:nonce:' + st.n;
    if (await kv.get(kluc)) throw new TikTokChyba('state_used', 409);
    await kv.put(kluc, '1', { expirationTtl: Math.ceil((STATE_PLATNOST_MS + 5 * 60 * 1000) / 1000) });
  }

  const tok = await vymenKod(k, code, telo.verifier);
  const rozsahy = String(tok.scope || '').split(/[,\s]+/).filter(Boolean);
  if (!rozsahy.includes('video.upload')) {
    const e = new TikTokChyba('scope_missing', 403);
    e.revoked = await zrusToken(k, tok.access_token);
    throw e;
  }
  let meno;
  try {
    meno = await menoTvorcu(k, tok.access_token);
  } catch (e) {
    const chyba = e instanceof TikTokChyba ? e : new TikTokChyba('tiktok_error', 502);
    chyba.revoked = await zrusToken(k, tok.access_token);
    throw chyba;
  }
  const session = await zapecat(k.secret, { a: tok.access_token }, now);
  return { session, displayName: meno, expiresInSeconds: RELACIA_PLATNOST_MS / 1000 };
}

async function cakaj(env, ms) {
  if (env && typeof env.cakaj === 'function') return env.cakaj(ms);
  return new Promise((r) => setTimeout(r, ms));
}

async function nahraj(request, env, k) {
  const pecat = request.headers.get('X-TikTok-Session') || '';
  const now = teraz(env);
  const rel = await rozpecat(k.secret, pecat, now);
  try {
    return await nahrajSTokenom(request, env, k, rel, now);
  } catch (e) {
    // Po zlyhaní nenecháme platný prístup visieť: tvorca sa pri ďalšom pokuse prihlási znova.
    // Pri chybe samotného videa relácia ostáva (stránka ju zruší pri odchode alebo tlačidlom).
    const chyba = e instanceof TikTokChyba ? e : new TikTokChyba('upload_failed', 502);
    if (!CHYBY_VIDEA.includes(chyba.kod)) chyba.revoked = await zrusToken(k, rel.a);
    throw chyba;
  }
}

async function nahrajSTokenom(request, env, k, rel, now) {
  // Content-Length odmietne zlú veľkosť skôr, než sa číta. Bez neho sa telo prečíta raz s limitom.
  let dlzka = dlzkaZHlavicky(request);
  if (dlzka !== null && dlzka > MAX_VIDEO_BAJTOV) throw new TikTokChyba('video_too_large', 413);
  if (dlzka !== null && dlzka < MIN_VIDEO_BAJTOV) throw new TikTokChyba('video_too_small', 400);
  if (!request.body) throw new TikTokChyba('video_too_small', 400);

  let citac;
  if (dlzka === null) {
    const { kusy, spolu } = await precitajKusy(request.body, MAX_VIDEO_BAJTOV);
    if (spolu < MIN_VIDEO_BAJTOV) throw new TikTokChyba('video_too_small', 400);
    dlzka = spolu;
    citac = citacZKusov(kusy);
  } else {
    citac = request.body.getReader();
  }

  const hlava = await citajHlavu(citac, 12);
  const mime = typVidea(hlava);
  if (!mime) {
    try { await citac.cancel(); } catch (e) { /* nič */ }
    throw new TikTokChyba('video_format', 415);
  }
  const { kus, pocet } = rozdelNaKusy(dlzka);
  if (pocet !== 1) throw new TikTokChyba('video_too_large', 413);

  const init = await apiPost(k, '/v2/post/publish/inbox/video/init/', rel.a, {
    source_info: { source: 'FILE_UPLOAD', video_size: dlzka, chunk_size: kus, total_chunk_count: pocet },
  });
  const publishId = String(init.publish_id || '');
  if (!publishId || !uploadUrlOk(init.upload_url)) {
    try { await citac.cancel(); } catch (e) { /* nič */ }
    throw new TikTokChyba('tiktok_error', 502);
  }

  // Video ide na TikTok ako prúd. FixedLengthStream (Workers) pošle presný Content-Length;
  // mimo Workers (testy) ostane obyčajný prúd.
  const video = prudVidea(hlava, citac, dlzka);
  const telo = typeof globalThis.FixedLengthStream === 'function'
    ? video.prud.pipeThrough(new globalThis.FixedLengthStream(dlzka))
    : video.prud;
  let r;
  try {
    r = await k.fetchImpl(init.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'Content-Length': String(dlzka), 'Content-Range': `bytes 0-${dlzka - 1}/${dlzka}` },
      body: telo,
    });
  } catch (e) {
    if (video.chyba()) throw video.chyba();
    console.warn('[tiktok] PUT zlyhal', (e && e.message) || e);
    throw new TikTokChyba('upload_failed', 502);
  }
  if (video.chyba()) throw video.chyba();
  if (![200, 201, 206].includes(r.status)) {
    console.warn('[tiktok] PUT zlyhal, http', r.status);
    throw new TikTokChyba('upload_failed', 502);
  }

  const kv = env.ASISTENT_CACHE;
  if (kv) {
    // Denný počet nahratí, bez IP a bez účtu.
    try {
      const den = new Date(now).toISOString().slice(0, 10);
      const kluc = 'tiktok:pocet:' + den;
      const n = parseInt((await kv.get(kluc)) || '0', 10) + 1;
      await kv.put(kluc, String(n), { expirationTtl: 60 * 60 * 24 * 120 });
    } catch (e) { /* počítadlo nesmie zhodiť nahratie */ }
  }

  // Krátko počkáme na TikTok. Ak je koncept v inboxe alebo nahratie zlyhalo, token hneď zrušíme;
  // inak to spraví /status alebo /cancel (rozhoduje stránka s tvorcom, pozri app.mjs).
  let st = { status: 'PROCESSING_UPLOAD', failReason: null };
  for (let i = 0; i < 4; i++) {
    await cakaj(env, 2000);
    try { st = await stavNahratia(k, rel.a, publishId); } catch (e) { break; }
    if (KONCOVE.has(st.status)) break;
  }
  const revoked = KONCOVE.has(st.status) ? await zrusToken(k, rel.a) : false;
  return { publishId, status: st.status, failReason: st.failReason, revoked, bytes: dlzka };
}

async function stav(request, env, k) {
  const telo = await jsonTelo(request);
  const rel = await rozpecat(k.secret, telo.session, teraz(env), { presah: ZRUSENIE_PRESAH_MS });
  const publishId = String(telo.publishId || '');
  if (!publishId || publishId.length > 64) throw new TikTokChyba('publish_id_invalid', 400);
  const st = await stavNahratia(k, rel.a, publishId);
  const revoked = KONCOVE.has(st.status) ? await zrusToken(k, rel.a) : false;
  return { status: st.status, failReason: st.failReason, revoked };
}

async function zrus(request, env, k) {
  const telo = await jsonTelo(request);
  let rel;
  try {
    rel = await rozpecat(k.secret, telo.session, teraz(env), { presah: ZRUSENIE_PRESAH_MS });
  } catch (e) {
    // Pečať staršia než 24 h: token u TikToku už sám vypršal, nie je čo rušiť.
    if (e instanceof TikTokChyba && e.kod === 'session_expired') return { revoked: false, expired: true };
    throw e;
  }
  return { revoked: await zrusToken(k, rel.a) };
}

/**
 * Upload odmietnutý naším limitom: tvorca musí čakať dlhšie, než relácia platí, preto token
 * zrušíme hneď, ak hlavička nesie platnú pečať. Telo videa sa nečíta.
 */
async function zrusPriOdmietnuti(request, env, k) {
  try { if (request.body) await request.body.cancel(); } catch (e) { /* nič */ }
  try {
    const rel = await rozpecat(k.secret, request.headers.get('X-TikTok-Session') || '', teraz(env), { presah: ZRUSENIE_PRESAH_MS });
    return await zrusToken(k, rel.a);
  } catch (e) {
    return false;
  }
}

const OBSLUHA = {
  '/v1/tiktok/start': [start, 'start'],
  '/v1/tiktok/session': [relacia, 'session'],
  '/v1/tiktok/upload': [nahraj, 'upload'],
  '/v1/tiktok/status': [stav, 'status'],
  '/v1/tiktok/cancel': [zrus, 'cancel'],
};

/**
 * Vstup z index.js. Vráti Response pre cesty /v1/tiktok/*, inak null.
 */
export async function handleTiktokRoute(request, env) {
  const cesta = new URL(request.url).pathname;
  if (!OBSLUHA[cesta]) return null;
  const origin = request.headers.get('Origin') || '';
  const cors = corsPre(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
  }
  if (!cors) return odpoved({ error: 'origin_not_allowed' }, 403, null);
  if (request.method !== 'POST') return odpoved({ error: 'method_not_allowed' }, 405, cors);

  try {
    const k = konfiguracia(env);
    const [fn, meno] = OBSLUHA[cesta];
    const kto = await odtlacokIp(request.headers.get('CF-Connecting-IP'), k.secret, teraz(env));
    let odmietnutie = null;
    if (!(await limit(env, kto, meno))) odmietnutie = ['rate_limited', 429];
    else if (meno === 'upload' && !(await limit(env, kto, 'uploadDen'))) odmietnutie = ['rate_limited', 429];
    else if (meno === 'upload' && !(await limit(env, 'vsetci', 'vsetkyUploadyDen'))) odmietnutie = ['daily_cap', 503];
    if (odmietnutie) {
      const revoked = meno === 'upload' ? await zrusPriOdmietnuti(request, env, k) : false;
      return odpoved({ error: odmietnutie[0], revoked }, odmietnutie[1], cors);
    }
    return odpoved({ ok: true, ...(await fn(request, env, k)) }, 200, cors);
  } catch (e) {
    if (e instanceof TikTokChyba) {
      return odpoved({ error: e.kod, ...(typeof e.revoked === 'boolean' ? { revoked: e.revoked } : {}) }, e.status, cors);
    }
    console.error('[tiktok] neočakávaná chyba:', e && e.stack ? e.stack : e);
    return odpoved({ error: 'internal_error' }, 500, cors);
  }
}
