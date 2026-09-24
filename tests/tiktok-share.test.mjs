// tiktok-share.test.mjs
// Puzzle video maker: zdieľanie videa do TikTok inboxu tvorcu (worker/src/tiktok-share.js).
// TikTok je dvojník (env.fetchImpl), čas je pevný (env.teraz), čakanie okamžité (env.cakaj).
// Sieť sa nikdy nevolá.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import {
  handleTiktokRoute,
  vytvorState,
  overState,
  zapecat,
  rozpecat,
  rozdelNaKusy,
  rozsahyKusov,
  uploadUrlOk,
  typVidea,
  sha256b64url,
  base64url,
  corsPre,
  precitajKusy,
  prudVidea,
  odtlacokIp,
  TikTokChyba,
  MAX_VIDEO_BAJTOV,
  STATE_PLATNOST_MS,
  RELACIA_PLATNOST_MS,
  ZRUSENIE_PRESAH_MS,
} from '../worker/src/tiktok-share.js';
import { createMockKV } from './helpers/mock-cf.mjs';

const ORIGIN = 'https://arling.sk';
const SECRET = 'testovacie-tajomstvo-klienta-0123456789';
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const IP = '203.0.113.77';

/**
 * Dvojník TikToku. `stavy` je poradie odpovedí status/fetch. Zaznamenáva každé volanie.
 * PUT telo (prúd) naozaj dočíta, ako by to robila sieť, a zapíše jeho dĺžku do `dlzkaTela`.
 * `revokeOdpoved` je [http, telo] pre /v2/oauth/revoke/ (TikTok vracia chybu aj pri HTTP 200).
 */
function falosnyTikTok({ scope = 'user.info.basic,video.upload', token = 'act.TAJNY-TOKEN-123', tokenChyba = false, initKod = 'ok', stavy = ['SEND_TO_USER_INBOX'], putStatus = 201, putSiet = false, revokeOdpoved = [200, {}] } = {}) {
  const volania = [];
  let stavIndex = 0;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body;
    volania.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    if (u === 'https://open.tiktokapis.com/v2/oauth/token/') {
      if (tokenChyba) return json({ error: 'invalid_grant', error_description: 'Authorization code is expired.', log_id: 'x' }, 400);
      return json({ access_token: token, open_id: 'open-1', scope, expires_in: 86400, refresh_token: 'rft.NIKDY', refresh_expires_in: 31536000, token_type: 'Bearer' });
    }
    if (u === 'https://open.tiktokapis.com/v2/oauth/revoke/') return json(revokeOdpoved[1], revokeOdpoved[0]);
    if (u.startsWith('https://open.tiktokapis.com/v2/user/info/')) {
      return json({ data: { user: { open_id: 'open-1', display_name: 'Puzzle Teacher' } }, error: { code: 'ok', message: '', log_id: 'x' } });
    }
    if (u === 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/') {
      if (initKod !== 'ok') return json({ error: { code: initKod, message: 'no', log_id: 'x' } }, 403);
      return json({ data: { publish_id: 'v_inbox_file~v2.123', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=2' }, error: { code: 'ok', message: '', log_id: 'x' } });
    }
    if (u.startsWith('https://open-upload.tiktokapis.com/')) {
      const zaznam = volania.at(-1);
      zaznam.prud = body instanceof ReadableStream;
      zaznam.dlzkaTela = new Uint8Array(await new Response(body).arrayBuffer()).length;
      if (putSiet) throw new TypeError('network connection lost');
      return new Response(null, { status: putStatus });
    }
    if (u === 'https://open.tiktokapis.com/v2/post/publish/status/fetch/') {
      const s = stavy[Math.min(stavIndex++, stavy.length - 1)];
      return json({ data: { status: s, fail_reason: s === 'FAILED' ? 'file_format_check_failed' : undefined }, error: { code: 'ok', message: '', log_id: 'x' } });
    }
    return new Response('nie je', { status: 404 });
  };
  return { fetchImpl, volania };
}

function prostredie(extra = {}) {
  const tt = falosnyTikTok(extra.tiktok || {});
  let cas = T0;
  const env = {
    TIKTOK_CLIENT_KEY: 'awtestkey',
    TIKTOK_CLIENT_SECRET: SECRET,
    ALLOWED_ORIGINS: 'arling.sk',
    ASISTENT_CACHE: createMockKV(),
    fetchImpl: tt.fetchImpl,
    teraz: () => cas,
    cakaj: async () => {},
    ...extra.env,
  };
  return { env, tt, posun: (ms) => { cas += ms; } };
}

function poziadavka(cesta, { telo, origin = ORIGIN, method = 'POST', headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': IP, ...headers };
  if (origin) h.Origin = origin;
  if (telo !== undefined && !(telo instanceof Uint8Array)) h['Content-Type'] = 'application/json';
  return new Request('https://arling-asistent.arling.workers.dev' + cesta, {
    method,
    headers: h,
    body: telo === undefined ? undefined : telo instanceof Uint8Array ? telo : JSON.stringify(telo),
  });
}

async function volaj(env, cesta, moznosti) {
  const r = await worker.fetch(poziadavka(cesta, moznosti), env, {});
  const text = await r.text();
  return { status: r.status, telo: text ? JSON.parse(text) : null, hlavicky: r.headers };
}

/** Náhodný PKCE pár ako v prehliadači. */
async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  return { verifier, challenge: await sha256b64url(verifier) };
}

/** Celé prihlásenie až po zapečatenú reláciu. */
async function prihlas(env) {
  const { verifier, challenge } = await pkce();
  const s = await volaj(env, '/v1/tiktok/start', { telo: { challenge } });
  assert.equal(s.status, 200, JSON.stringify(s.telo));
  const r = await volaj(env, '/v1/tiktok/session', { telo: { code: 'kod-z-tiktoku', state: s.telo.state, verifier } });
  return { start: s, relacia: r, verifier, challenge };
}

/** Malé „MP4“: 'ftyp' na bajtoch 4 až 7, zvyšok nuly. Na formát stačí, TikTok je dvojník. */
function falosneMp4(velkost = 64 * 1024) {
  const b = new Uint8Array(velkost);
  b.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return b;
}

// ---------------------------------------------------------------------------
// CORS a konfigurácia
// ---------------------------------------------------------------------------

test('preflight: arling.sk áno a s hlavičkou X-TikTok-Session, cudzí pôvod ani subdoména nie', async () => {
  const { env } = prostredie();
  const ok = await volaj(env, '/v1/tiktok/upload', { method: 'OPTIONS' });
  assert.equal(ok.status, 204);
  assert.equal(ok.hlavicky.get('access-control-allow-origin'), ORIGIN);
  assert.match(ok.hlavicky.get('access-control-allow-headers'), /X-TikTok-Session/);
  for (const zly of ['https://evil.example', 'https://evil.arling.sk', 'http://arling.sk']) {
    const r = await volaj(env, '/v1/tiktok/upload', { method: 'OPTIONS', origin: zly });
    assert.equal(r.status, 403, zly);
    assert.equal(r.hlavicky.get('access-control-allow-origin'), null);
  }
  assert.equal(corsPre('https://www.arling.sk')['Access-Control-Allow-Origin'], 'https://www.arling.sk');
});

test('POST bez Origin alebo z cudzieho pôvodu je 403, GET je 405', async () => {
  const { env } = prostredie();
  assert.equal((await volaj(env, '/v1/tiktok/start', { telo: {}, origin: null })).status, 403);
  assert.equal((await volaj(env, '/v1/tiktok/start', { telo: {}, origin: 'https://evil.example' })).status, 403);
  assert.equal((await volaj(env, '/v1/tiktok/start', { method: 'GET' })).status, 405);
});

test('bez TIKTOK_CLIENT_KEY alebo TIKTOK_CLIENT_SECRET je všetko 503 tiktok_unavailable', async () => {
  for (const chyba of [{ TIKTOK_CLIENT_KEY: '' }, { TIKTOK_CLIENT_SECRET: '' }]) {
    const { env } = prostredie({ env: chyba });
    const { challenge } = await pkce();
    const r = await volaj(env, '/v1/tiktok/start', { telo: { challenge } });
    assert.equal(r.status, 503);
    assert.equal(r.telo.error, 'tiktok_unavailable');
  }
});

test('ostatné cesty workera ostali: /health aj neznáma cesta', async () => {
  const { env } = prostredie();
  assert.equal((await volaj(env, '/health', { method: 'GET' })).status, 200);
  assert.equal((await volaj(env, '/v1/tiktok/nieco', { telo: {} })).status, 404);
});

// ---------------------------------------------------------------------------
// start, state a PKCE
// ---------------------------------------------------------------------------

test('start: autorizačná adresa má client_key, oba rozsahy, redirect na /puzzle-video/ a podpísaný state', async () => {
  const { env } = prostredie();
  const { challenge } = await pkce();
  const r = await volaj(env, '/v1/tiktok/start', { telo: { challenge } });
  assert.equal(r.status, 200);
  const u = new URL(r.telo.authorizeUrl);
  assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), 'awtestkey');
  assert.equal(u.searchParams.get('scope'), 'user.info.basic,video.upload');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://arling.sk/puzzle-video/');
  assert.equal(u.searchParams.get('state'), r.telo.state);
  // Web: TikTok PKCE nedokumentuje, predvolene ho neposielame.
  assert.equal(u.searchParams.get('code_challenge'), null);
  assert.ok(!JSON.stringify(r.telo).includes(SECRET));
});

test('start s TIKTOK_PKCE_UPSTREAM=1 pošle aj code_challenge S256', async () => {
  const { env } = prostredie({ env: { TIKTOK_PKCE_UPSTREAM: '1' } });
  const { challenge } = await pkce();
  const u = new URL((await volaj(env, '/v1/tiktok/start', { telo: { challenge } })).telo.authorizeUrl);
  assert.equal(u.searchParams.get('code_challenge'), challenge);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

test('start odmietne zlý challenge a príliš veľké telo', async () => {
  const { env } = prostredie();
  for (const c of [undefined, '', 'kratky', 'x'.repeat(43) + '!', 'a'.repeat(44)]) {
    const r = await volaj(env, '/v1/tiktok/start', { telo: { challenge: c } });
    assert.equal(r.status, 400, String(c));
    assert.equal(r.telo.error, 'challenge_invalid');
  }
  const velke = await volaj(env, '/v1/tiktok/start', { telo: { challenge: 'a'.repeat(43), vata: 'x'.repeat(9000) } });
  assert.equal(velke.status, 413);
});

test('state: podpis, vek a formát sa overujú', async () => {
  const { challenge } = await pkce();
  const st = await vytvorState(SECRET, challenge, T0);
  assert.equal((await overState(SECRET, st, T0 + 1000)).c, challenge);
  await assert.rejects(overState('ine-tajomstvo-xxxxxxxxxxxxxxxxxxxxxxx', st, T0), (e) => e instanceof TikTokChyba && e.kod === 'state_invalid');
  await assert.rejects(overState(SECRET, st, T0 + STATE_PLATNOST_MS + 1), (e) => e.kod === 'state_expired');
  const [telo, podpis] = st.split('.');
  const zmenene = base64url(new TextEncoder().encode(JSON.stringify({ v: 1, n: 'x', t: T0, c: 'b'.repeat(43) })));
  await assert.rejects(overState(SECRET, `${zmenene}.${podpis}`, T0), (e) => e.kod === 'state_invalid');
  await assert.rejects(overState(SECRET, telo, T0), (e) => e.kod === 'state_invalid');
  await assert.rejects(overState(SECRET, '', T0), (e) => e.kod === 'state_invalid');
});

test('session: celý tok vráti zapečatenú reláciu a meno tvorcu, nikdy nie token', async () => {
  const { env, tt } = prostredie();
  const { relacia } = await prihlas(env);
  assert.equal(relacia.status, 200, JSON.stringify(relacia.telo));
  assert.equal(relacia.telo.displayName, 'Puzzle Teacher');
  assert.ok(relacia.telo.session);
  const text = JSON.stringify(relacia.telo);
  assert.ok(!text.includes('TAJNY-TOKEN'), 'access token nesmie odísť do prehliadača');
  assert.ok(!text.includes('rft.NIKDY'), 'refresh token nesmie odísť do prehliadača');
  // Výmena kódu: client_secret a redirect_uri na serveri, code_verifier predvolene nie.
  const vymena = tt.volania.find((v) => v.url.endsWith('/v2/oauth/token/'));
  const p = new URLSearchParams(vymena.body);
  assert.equal(p.get('client_secret'), SECRET);
  assert.equal(p.get('grant_type'), 'authorization_code');
  assert.equal(p.get('redirect_uri'), 'https://arling.sk/puzzle-video/');
  assert.equal(p.get('code_verifier'), null);
  // Relácia sa dá rozpečatiť len kľúčom workera a nesie token.
  const rel = await rozpecat(SECRET, relacia.telo.session, T0);
  assert.equal(rel.a, 'act.TAJNY-TOKEN-123');
  assert.equal(rel.x, T0 + RELACIA_PLATNOST_MS);
});

test('session s TIKTOK_PKCE_UPSTREAM=1 pošle TikToku code_verifier', async () => {
  const { env, tt } = prostredie({ env: { TIKTOK_PKCE_UPSTREAM: '1' } });
  const { relacia, verifier } = await prihlas(env);
  assert.equal(relacia.status, 200);
  const p = new URLSearchParams(tt.volania.find((v) => v.url.endsWith('/v2/oauth/token/')).body);
  assert.equal(p.get('code_verifier'), verifier);
});

test('session: cudzí verifier je pkce_mismatch a TikTok sa vôbec nevolá', async () => {
  const { env, tt } = prostredie();
  const { challenge } = await pkce();
  const cudzi = await pkce();
  const s = await volaj(env, '/v1/tiktok/start', { telo: { challenge } });
  const r = await volaj(env, '/v1/tiktok/session', { telo: { code: 'k', state: s.telo.state, verifier: cudzi.verifier } });
  assert.equal(r.status, 400);
  assert.equal(r.telo.error, 'pkce_mismatch');
  assert.equal(tt.volania.length, 0);
});

test('session: ten istý state druhýkrát je state_used, starý state je state_expired', async () => {
  const { env, posun } = prostredie();
  const { verifier, challenge } = await pkce();
  const s = await volaj(env, '/v1/tiktok/start', { telo: { challenge } });
  assert.equal((await volaj(env, '/v1/tiktok/session', { telo: { code: 'k', state: s.telo.state, verifier } })).status, 200);
  const znova = await volaj(env, '/v1/tiktok/session', { telo: { code: 'k', state: s.telo.state, verifier } });
  assert.equal(znova.status, 409);
  assert.equal(znova.telo.error, 'state_used');

  const dalsi = await pkce();
  const s2 = await volaj(env, '/v1/tiktok/start', { telo: { challenge: dalsi.challenge } });
  posun(STATE_PLATNOST_MS + 1000);
  const stary = await volaj(env, '/v1/tiktok/session', { telo: { code: 'k', state: s2.telo.state, verifier: dalsi.verifier } });
  assert.equal(stary.telo.error, 'state_expired');
});

test('session: chýbajúci kód, zlý verifier a TikTok odmietnutý kód', async () => {
  const { env } = prostredie({ tiktok: { tokenChyba: true } });
  const { verifier, challenge } = await pkce();
  const s = await volaj(env, '/v1/tiktok/start', { telo: { challenge } });
  assert.equal((await volaj(env, '/v1/tiktok/session', { telo: { state: s.telo.state, verifier } })).telo.error, 'code_missing');
  assert.equal((await volaj(env, '/v1/tiktok/session', { telo: { code: 'k', state: s.telo.state, verifier: 'kratky' } })).telo.error, 'verifier_invalid');
  const r = await volaj(env, '/v1/tiktok/session', { telo: { code: 'k', state: s.telo.state, verifier } });
  assert.equal(r.status, 400);
  assert.equal(r.telo.error, 'code_rejected');
  assert.equal((await volaj(env, '/v1/tiktok/session', { telo: 'nie json' })).status, 400);
});

test('session: bez rozsahu video.upload je 403 scope_missing a token sa hneď zruší', async () => {
  const { env, tt } = prostredie({ tiktok: { scope: 'user.info.basic' } });
  const { relacia } = await prihlas(env);
  assert.equal(relacia.status, 403);
  assert.equal(relacia.telo.error, 'scope_missing');
  assert.ok(tt.volania.some((v) => v.url.endsWith('/v2/oauth/revoke/')));
});

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

async function posliVideo(env, session, bajty = falosneMp4()) {
  return volaj(env, '/v1/tiktok/upload', {
    telo: bajty,
    headers: { 'Content-Type': 'video/mp4', 'X-TikTok-Session': session, 'Content-Length': String(bajty.length) },
  });
}

test('upload: koncept do inboxu (FILE_UPLOAD, jeden kus), stav SEND_TO_USER_INBOX a token zrušený', async () => {
  const { env, tt } = prostredie();
  const { relacia } = await prihlas(env);
  const video = falosneMp4(200 * 1024);
  const r = await posliVideo(env, relacia.telo.session, video);
  assert.equal(r.status, 200, JSON.stringify(r.telo));
  assert.deepEqual({ publishId: r.telo.publishId, status: r.telo.status, revoked: r.telo.revoked }, {
    publishId: 'v_inbox_file~v2.123', status: 'SEND_TO_USER_INBOX', revoked: true,
  });
  const init = tt.volania.find((v) => v.url.endsWith('/inbox/video/init/'));
  assert.equal(init.headers.Authorization, 'Bearer act.TAJNY-TOKEN-123');
  assert.deepEqual(JSON.parse(init.body), { source_info: { source: 'FILE_UPLOAD', video_size: video.length, chunk_size: video.length, total_chunk_count: 1 } });
  const put = tt.volania.find((v) => v.method === 'PUT');
  assert.equal(put.headers['Content-Range'], `bytes 0-${video.length - 1}/${video.length}`);
  assert.equal(put.headers['Content-Type'], 'video/mp4');
  assert.equal(put.headers['Content-Length'], String(video.length));
  assert.equal(put.dlzkaTela, video.length);
  assert.ok(put.prud, 'video ide na TikTok ako prúd, nie celé v pamäti');
  // Priama publikácia (video.publish) sa nikdy nevolá.
  assert.ok(!tt.volania.some((v) => v.url.includes('/v2/post/publish/video/init/')));
  // Poradie: init, PUT, status, až potom revoke.
  const poradie = tt.volania.map((v) => v.url.replace(/\?.*$/, '')).filter((u) => !u.endsWith('/token/') && !u.includes('/user/info/'));
  assert.deepEqual(poradie, [
    'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    'https://open-upload.tiktokapis.com/video/',
    'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
    'https://open.tiktokapis.com/v2/oauth/revoke/',
  ]);
});

test('upload: kým TikTok spracúva, token sa neruší; /status ho zruší, keď je koncept v inboxe', async () => {
  // Upload sa spýta štyrikrát, piata odpoveď patrí prvému volaniu /status.
  const stavy = ['PROCESSING_UPLOAD', 'PROCESSING_UPLOAD', 'PROCESSING_UPLOAD', 'PROCESSING_UPLOAD', 'SEND_TO_USER_INBOX'];
  const { env, tt } = prostredie({ tiktok: { stavy } });
  const { relacia } = await prihlas(env);
  const r = await posliVideo(env, relacia.telo.session);
  assert.equal(r.telo.status, 'PROCESSING_UPLOAD');
  assert.equal(r.telo.revoked, false);
  assert.ok(!tt.volania.some((v) => v.url.endsWith('/revoke/')));
  const s1 = await volaj(env, '/v1/tiktok/status', { telo: { session: relacia.telo.session, publishId: r.telo.publishId } });
  assert.deepEqual([s1.telo.status, s1.telo.revoked], ['SEND_TO_USER_INBOX', true]);
});

test('upload: bez relácie 401, prepadnutá relácia 401 session_expired', async () => {
  const { env, posun } = prostredie();
  const bez = await posliVideo(env, '');
  assert.equal(bez.status, 401);
  assert.equal(bez.telo.error, 'session_invalid');
  const falosna = await posliVideo(env, 'abc.def');
  assert.equal(falosna.telo.error, 'session_invalid');
  const { relacia } = await prihlas(env);
  posun(RELACIA_PLATNOST_MS + 1000);
  const stara = await posliVideo(env, relacia.telo.session);
  assert.equal(stara.status, 401);
  assert.equal(stara.telo.error, 'session_expired');
});

test('upload: veľkosť nad limit je 413 skôr, než sa telo číta; malé a nie-video odmietnuté', async () => {
  const { env, tt } = prostredie();
  const { relacia } = await prihlas(env);
  const pred = tt.volania.length;
  const velke = await volaj(env, '/v1/tiktok/upload', {
    telo: falosneMp4(32 * 1024),
    headers: { 'X-TikTok-Session': relacia.telo.session, 'Content-Length': String(MAX_VIDEO_BAJTOV + 1) },
  });
  assert.equal(velke.status, 413);
  assert.equal(velke.telo.error, 'video_too_large');
  assert.equal((await posliVideo(env, relacia.telo.session, falosneMp4(1000))).telo.error, 'video_too_small');
  const obrazok = new Uint8Array(64 * 1024).fill(0x89);
  const zly = await posliVideo(env, relacia.telo.session, obrazok);
  assert.equal(zly.status, 415);
  assert.equal(zly.telo.error, 'video_format');
  // Žiadne z toho nedošlo k TikToku.
  assert.equal(tt.volania.length, pred);
});

test('upload: TikTok limit čakajúcich konceptov je 429 spam_risk_too_many_pending_share a token sa zruší', async () => {
  const { env, tt } = prostredie({ tiktok: { initKod: 'spam_risk_too_many_pending_share' } });
  const { relacia } = await prihlas(env);
  const r = await posliVideo(env, relacia.telo.session);
  assert.equal(r.status, 429);
  assert.equal(r.telo.error, 'spam_risk_too_many_pending_share');
  assert.ok(tt.volania.some((v) => v.url.endsWith('/revoke/')));
});

test('upload: zlyhaný PUT je 502 upload_failed', async () => {
  const { env } = prostredie({ tiktok: { putStatus: 500 } });
  const { relacia } = await prihlas(env);
  const r = await posliVideo(env, relacia.telo.session);
  assert.equal(r.status, 502);
  assert.equal(r.telo.error, 'upload_failed');
});

test('limit: siedme nahratie z jednej IP za hodinu je 429; KV nedrží samotnú IP', async () => {
  const { env } = prostredie();
  const { relacia } = await prihlas(env);
  for (let i = 0; i < 6; i++) {
    const r = await posliVideo(env, relacia.telo.session);
    assert.notEqual(r.status, 429, `pokus ${i + 1}`);
  }
  const siedmy = await posliVideo(env, relacia.telo.session);
  assert.equal(siedmy.status, 429);
  assert.equal(siedmy.telo.error, 'rate_limited');
  for (const kluc of env.ASISTENT_CACHE._store.keys()) assert.ok(!kluc.includes(IP), kluc);
});

test('limit: start z jednej IP najviac 20 za hodinu', async () => {
  const { env } = prostredie();
  const { challenge } = await pkce();
  let posledny;
  for (let i = 0; i < 21; i++) posledny = await volaj(env, '/v1/tiktok/start', { telo: { challenge } });
  assert.equal(posledny.status, 429);
});

test('cancel: zruší token platnej relácie aj relácie po 15 minútach; až po 24 h je len expired', async () => {
  const { env, tt, posun } = prostredie();
  const { relacia } = await prihlas(env);
  const r = await volaj(env, '/v1/tiktok/cancel', { telo: { session: relacia.telo.session } });
  assert.deepEqual([r.status, r.telo.revoked], [200, true]);
  assert.equal(tt.volania.filter((v) => v.url.endsWith('/revoke/')).length, 1);
  // Po 15 minútach sa už nahrať nedá, ale zrušiť áno: token u TikToku platí 24 h.
  posun(RELACIA_PLATNOST_MS + 60 * 1000);
  const neskoro = await volaj(env, '/v1/tiktok/cancel', { telo: { session: relacia.telo.session } });
  assert.deepEqual([neskoro.status, neskoro.telo.revoked], [200, true]);
  assert.equal(tt.volania.filter((v) => v.url.endsWith('/revoke/')).length, 2);
  posun(ZRUSENIE_PRESAH_MS);
  const stara = await volaj(env, '/v1/tiktok/cancel', { telo: { session: relacia.telo.session } });
  assert.deepEqual([stara.status, stara.telo.expired, stara.telo.revoked], [200, true, false]);
  assert.equal(tt.volania.filter((v) => v.url.endsWith('/revoke/')).length, 2);
});

test('cancel: HTTP 200 s poľom error od TikToku nie je zrušenie', async () => {
  for (const telo of [{ error: 'invalid_request', error_description: 'token not found', log_id: 'x' }, { error: { code: 'access_token_invalid', message: '', log_id: 'x' } }]) {
    const { env } = prostredie({ tiktok: { revokeOdpoved: [200, telo] } });
    const { relacia } = await prihlas(env);
    const r = await volaj(env, '/v1/tiktok/cancel', { telo: { session: relacia.telo.session } });
    assert.deepEqual([r.status, r.telo.revoked], [200, false], JSON.stringify(telo));
  }
  const { env } = prostredie({ tiktok: { revokeOdpoved: [200, { error: { code: 'ok', message: '' } }] } });
  const { relacia } = await prihlas(env);
  assert.equal((await volaj(env, '/v1/tiktok/cancel', { telo: { session: relacia.telo.session } })).telo.revoked, true);
  const { env: env5 } = prostredie({ tiktok: { revokeOdpoved: [500, {}] } });
  const r5 = await prihlas(env5);
  assert.equal((await volaj(env5, '/v1/tiktok/cancel', { telo: { session: r5.relacia.telo.session } })).telo.revoked, false);
});

test('status: po 15 minútach relácie sa stav ešte dá zistiť a token sa zruší, nahrať už nie', async () => {
  const stavy = ['PROCESSING_UPLOAD', 'PROCESSING_UPLOAD', 'PROCESSING_UPLOAD', 'PROCESSING_UPLOAD', 'SEND_TO_USER_INBOX'];
  const { env, posun } = prostredie({ tiktok: { stavy } });
  const { relacia } = await prihlas(env);
  const r = await posliVideo(env, relacia.telo.session);
  assert.equal(r.telo.revoked, false);
  posun(RELACIA_PLATNOST_MS + 5 * 60 * 1000);
  const s = await volaj(env, '/v1/tiktok/status', { telo: { session: relacia.telo.session, publishId: r.telo.publishId } });
  assert.deepEqual([s.status, s.telo.status, s.telo.revoked], [200, 'SEND_TO_USER_INBOX', true]);
  assert.equal((await posliVideo(env, relacia.telo.session)).telo.error, 'session_expired');
});

test('upload odmietnutý naším limitom zruší token a povie to v odpovedi', async () => {
  const { env, tt } = prostredie();
  const { relacia } = await prihlas(env);
  for (let i = 0; i < 6; i++) await posliVideo(env, relacia.telo.session);
  const pred = tt.volania.filter((v) => v.url.endsWith('/revoke/')).length;
  const r = await posliVideo(env, relacia.telo.session);
  assert.deepEqual([r.status, r.telo.error, r.telo.revoked], [429, 'rate_limited', true]);
  assert.equal(tt.volania.filter((v) => v.url.endsWith('/revoke/')).length, pred + 1);
});

test('upload odmietnutý denným stropom nástroja zruší token', async () => {
  const { env } = prostredie();
  const { relacia } = await prihlas(env);
  // Denný strop celého nástroja je vyčerpaný (kľúč počítadla ako v security.js).
  const den = Math.floor(T0 / 86400000);
  await env.ASISTENT_CACHE.put(`ratelimit:ttvsetkyUploadyDen:vsetci:${den}`, '500');
  const r = await posliVideo(env, relacia.telo.session);
  assert.deepEqual([r.status, r.telo.error, r.telo.revoked], [503, 'daily_cap', true]);
});

test('upload: výpadok siete pri PUT je upload_failed a token sa zruší', async () => {
  const { env, tt } = prostredie({ tiktok: { putSiet: true } });
  const { relacia } = await prihlas(env);
  const r = await posliVideo(env, relacia.telo.session);
  assert.deepEqual([r.status, r.telo.error, r.telo.revoked], [502, 'upload_failed', true]);
  assert.ok(tt.volania.some((v) => v.url.endsWith('/revoke/')));
});

test('upload: Content-Length menší než telo je 413, väčší je 400; relácia ostáva', async () => {
  const { env, tt } = prostredie();
  const { relacia } = await prihlas(env);
  const video = falosneMp4(100 * 1024);
  const klame = await volaj(env, '/v1/tiktok/upload', {
    telo: video,
    headers: { 'X-TikTok-Session': relacia.telo.session, 'Content-Length': String(64 * 1024) },
  });
  assert.deepEqual([klame.status, klame.telo.error], [413, 'video_too_large']);
  const kratke = await volaj(env, '/v1/tiktok/upload', {
    telo: video,
    headers: { 'X-TikTok-Session': relacia.telo.session, 'Content-Length': String(120 * 1024) },
  });
  assert.deepEqual([kratke.status, kratke.telo.error], [400, 'video_length_mismatch']);
  assert.ok(!tt.volania.some((v) => v.url.endsWith('/revoke/')), 'chyba videa reláciu nezruší');
  assert.equal((await posliVideo(env, relacia.telo.session)).status, 200);
});

test('upload bez Content-Length: telo sa prečíta raz s limitom a pošle celé', async () => {
  const { env, tt } = prostredie();
  const { relacia } = await prihlas(env);
  const video = falosneMp4(80 * 1024);
  const r = await volaj(env, '/v1/tiktok/upload', { telo: video, headers: { 'X-TikTok-Session': relacia.telo.session } });
  assert.equal(r.status, 200, JSON.stringify(r.telo));
  const put = tt.volania.find((v) => v.method === 'PUT');
  assert.equal(put.dlzkaTela, video.length);
  assert.equal(JSON.parse(tt.volania.find((v) => v.url.endsWith('/inbox/video/init/')).body).source_info.video_size, video.length);
});

test('limit videa je 30 MB a JSON telo sa nečíta, keď Content-Length hlási viac než 8 kB', async () => {
  assert.equal(MAX_VIDEO_BAJTOV, 30 * 1024 * 1024);
  const { env } = prostredie();
  const r = await volaj(env, '/v1/tiktok/start', { telo: { challenge: 'a'.repeat(43) }, headers: { 'Content-Length': String(100 * 1024 * 1024) } });
  assert.deepEqual([r.status, r.telo.error], [413, 'payload_too_large']);
});

test('odtlačok IP: HMAC s tajomstvom, každý deň iný, bez tajomstva nedopočítateľný', async () => {
  const a = await odtlacokIp(IP, SECRET, T0);
  assert.equal(a, await odtlacokIp(IP, SECRET, T0 + 1000));
  assert.notEqual(a, await odtlacokIp(IP, SECRET, T0 + 86400000), 'iný deň, iný kľúč');
  assert.notEqual(a, await odtlacokIp(IP, 'ine-tajomstvo-zzzzzzzzzzzzzzzzzzzzzzzz', T0));
  assert.notEqual(a, await odtlacokIp('203.0.113.78', SECRET, T0));
  // Pôvodný odtlačok bez kľúča (sha256 s pevnou predponou) sa už nepoužíva.
  assert.notEqual(a, (await sha256b64url('arling-tiktok-ip:' + IP)).slice(0, 22));
  const { env } = prostredie();
  await prihlas(env);
  const kluce = [...env.ASISTENT_CACHE._store.keys()].filter((k) => k.startsWith('ratelimit:'));
  assert.ok(kluce.length > 0);
  for (const k of kluce) assert.ok(k.includes(a) && !k.includes(IP), k);
});

// ---------------------------------------------------------------------------
// Čisté pomocné funkcie
// ---------------------------------------------------------------------------

test('kusy podľa media transfer guide', () => {
  assert.deepEqual(rozdelNaKusy(1000), { kus: 1000, pocet: 1 });
  assert.deepEqual(rozdelNaKusy(40 * 1024 * 1024), { kus: 40 * 1024 * 1024, pocet: 1 });
  const velke = 100 * 1000 * 1000;
  const { kus, pocet } = rozdelNaKusy(velke);
  assert.equal(kus, 10 * 1024 * 1024);
  assert.equal(pocet, Math.floor(velke / kus));
  const r = rozsahyKusov(velke, kus, pocet);
  assert.equal(r[0][0], 0);
  assert.equal(r.at(-1)[1], velke - 1);
  assert.ok(r.at(-1)[1] - r.at(-1)[0] + 1 <= 128 * 1000 * 1000);
  assert.throws(() => rozdelNaKusy(0), TikTokChyba);
});

test('upload_url len https na doméne TikToku, typ videa podľa bajtov', () => {
  assert.ok(uploadUrlOk('https://open-upload.tiktokapis.com/video/?a=1'));
  assert.ok(!uploadUrlOk('http://open-upload.tiktokapis.com/video/'));
  assert.ok(!uploadUrlOk('https://tiktokapis.com.evil.example/'));
  assert.ok(!uploadUrlOk('nie url'));
  assert.equal(typVidea(falosneMp4()), 'video/mp4');
  assert.equal(typVidea(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), 'video/webm');
  assert.equal(typVidea(new Uint8Array(16)), null);
});

test('pečať: iný kľúč ani zmenený bajt ju neotvorí', async () => {
  const p = await zapecat(SECRET, { a: 'tok' }, T0);
  assert.equal((await rozpecat(SECRET, p, T0)).a, 'tok');
  await assert.rejects(rozpecat('ine-tajomstvo-yyyyyyyyyyyyyyyyyyyyyyyyy', p, T0), (e) => e.kod === 'session_invalid');
  const [iv, ct] = p.split('.');
  const zmenene = ct.slice(0, -2) + (ct.at(-2) === 'A' ? 'B' : 'A') + ct.at(-1);
  await assert.rejects(rozpecat(SECRET, `${iv}.${zmenene}`, T0), (e) => e.kod === 'session_invalid');
});

test('telo bez Content-Length sa číta len po limit', async () => {
  const r = (n) => new Request('https://x.example/', { method: 'POST', body: new Uint8Array(n) });
  assert.equal((await precitajKusy(r(100).body, 100)).spolu, 100);
  await assert.rejects(precitajKusy(r(101).body, 100), (e) => e.kod === 'video_too_large' && e.status === 413);
  await assert.rejects(precitajKusy(r(9000).body, 8192, 'payload_too_large'), (e) => e.kod === 'payload_too_large');
});

test('prúd videa počíta bajty: presne, viac, menej', async () => {
  const citac = (kusy) => { let i = 0; return { read: async () => (i < kusy.length ? { done: false, value: kusy[i++] } : { done: true }), cancel: async () => {} }; };
  const hlava = new Uint8Array(12);
  const presne = prudVidea(hlava, citac([new Uint8Array(20)]), 32);
  assert.equal((await new Response(presne.prud).arrayBuffer()).byteLength, 32);
  const viac = prudVidea(hlava, citac([new Uint8Array(30)]), 32);
  await assert.rejects(new Response(viac.prud).arrayBuffer());
  assert.equal(viac.chyba().kod, 'video_too_large');
  const menej = prudVidea(hlava, citac([new Uint8Array(5)]), 32);
  await assert.rejects(new Response(menej.prud).arrayBuffer());
  assert.equal(menej.chyba().kod, 'video_length_mismatch');
});

test('handleTiktokRoute vráti null pre cudzie cesty', async () => {
  const { env } = prostredie();
  assert.equal(await handleTiktokRoute(poziadavka('/v1/chat', { telo: {} }), env), null);
});
