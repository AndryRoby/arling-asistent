// ucet-ochrana-o04.test.mjs
// Veľký audit 30. 9. 2026, opravy O-04 a O-25
// (ops/audit/2026-09-30-velky-audit/oprava-O-04.md):
//   - 50 súbežných zlých pokusov o kód na jednu adresu porovná najviac 10,
//     potom zámok s poctivou vetou (aj pre nový kód a pre správny kód),
//   - 41. kód za UTC deň vráti 503, ntfy „asistent_strop“ práve raz,
//   - IPv6 z jednej siete /64 zdieľa hodinový limit kódov, iná /64 nie,
//   - GET /v1/ucet/ja a POST /v1/ucet/over bez session_id; session_id jedného
//     nákupu len cez POST /v1/ucet/nakup-pristup s Bearer tokenom,
//   - verejný GET /v1/tenants/:id/status bez plánu, kvóty a spotreby; plný
//     stav s admin tokenom, kľúčom obchodu alebo Bearerom majiteľa.
// Proti skutočnému routeru (index.js) s mock D1 a KV; nič nejde na sieť.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../worker/src/index.js';
import {
  vytvorToken,
  DENNY_STROP_KODOV,
  DENNY_LIMIT_KODOV_SIETE,
  MAX_ZLYCH_POKUSOV,
  LIMIT_IP_ZA_HODINU,
  zmazStarePokusy,
} from '../worker/src/ucet.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize } from './helpers/mock-cf.mjs';

const API = 'https://arling-asistent.arling.workers.dev';
const ORIGIN = 'https://arling.sk';
const ADMIN = 'admin-token-o04';
const TAJOMSTVO = Buffer.from('tajny-kluc-pre-testy-o04-2026-09-30').toString('base64');
const FEED = '<products><item><id>1</id><name>Test produkt</name><price>9.99</price><url>https://obchod-o25.sk/p/1</url><description>Popis produktu.</description></item></products>';
const POMLCKY = new RegExp('[\\u2013\\u2014]');

function createMockKv() {
  const store = new Map();
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      if (type === 'json') {
        try { return JSON.parse(value); } catch (e) { return null; }
      }
      return value;
    },
    async put(key, value) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
    _store: store,
  };
}

function makeEnv({ resend = 'ok' } = {}) {
  const resendCalls = [];
  const pingy = [];
  const env = {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKv(),
    ALLOWED_ORIGINS: 'arling.sk',
    UCET_TAJOMSTVO: TAJOMSTVO,
    RESEND_API_KEY: 'resend-test-key',
    ADMIN_TOKEN: ADMIN,
    ASISTENT_NTFY: 'zapnute',
    QUOTA_PING_URL: 'https://ping.test/subscribe/api/ping',
    fetchImpl: async (url, opts) => {
      const href = String(url);
      if (href.startsWith('https://api.resend.com/')) {
        resendCalls.push(JSON.parse(opts.body));
        if (resend === 'fail') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ id: 'email_1' }) };
      }
      if (href.startsWith('https://ping.test/')) {
        pingy.push(new URL(href));
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (href.startsWith('https://api.stripe.com/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      return { ok: true, status: 200, text: async () => FEED, json: async () => ({}) };
    },
  };
  env._resendCalls = resendCalls;
  env._pingy = pingy;
  return env;
}

function req(path, { method = 'POST', body, ip = '203.0.113.7', token, headers = {} } = {}) {
  return new Request(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Origin: ORIGIN,
      'CF-Connecting-IP': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const poziadaj = (env, email, ip, jazyk) => worker.fetch(req('/v1/ucet/kod', { body: { email, ...(jazyk ? { jazyk } : {}) }, ip }), env, {});
const over = (env, email, kod, ip) => worker.fetch(req('/v1/ucet/over', { body: { email, kod }, ip }), env, {});
const kodZKv = async (env, email) => (await env.ASISTENT_CACHE.get(`ucet:kod:${email}`, 'json'))?.kod;
// Súčet denných limitov sietí (doladenie O-04, V1) za deň, cez všetky koše.
const sucetSieti = (env, den) => [...env.DB._pocty.entries()]
  .filter(([k]) => k.startsWith(`ucetsiet:${den}:`))
  .reduce((s, [, r]) => s + (Number(r.hodnota) || 0), 0);

// ---------------------------------------------------------------------------
// 2. Zlé pokusy na adresu atomicky v D1
// ---------------------------------------------------------------------------

test('O-04: 50 súbežných zlých pokusov na jednu adresu porovná najviac 10, potom zámok aj pre nový a správny kód', async () => {
  const env = makeEnv();
  const email = 'obet@firma-o04.sk';
  assert.equal((await poziadaj(env, email, '198.51.100.1')).status, 200);
  const spravny = await kodZKv(env, email);
  const zly = spravny === '000000' ? '111111' : '000000';

  // Každý pokus z inej IPv4, aby ho nezastavil minútový limit siete: zastaviť ho musí D1.
  const odpovede = await Promise.all(Array.from({ length: 50 }, (_, i) => over(env, email, zly, `192.0.2.${i + 1}`)));
  const tela = await Promise.all(odpovede.map((r) => r.json()));

  const porovnane = tela.filter((t) => t.error === 'bad_code').length;
  assert.ok(porovnane <= MAX_ZLYCH_POKUSOV, `porovnaných ${porovnane}, najviac ${MAX_ZLYCH_POKUSOV}`);
  assert.ok(porovnane >= 1);
  assert.equal(odpovede.filter((r) => r.status === 200).length, 0);
  const zamky = tela.filter((t) => t.dovod === 'zamok');
  assert.ok(zamky.length >= 50 - MAX_ZLYCH_POKUSOV - 5, 'zvyšok odmietne zámok (alebo no_code po zahodení kódu)');
  for (const t of zamky) {
    assert.equal(t.error, 'rate_limited');
    assert.match(t.message, /prihlásenie zastavili najviac na 24 hodín, do \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    // Doladenie D2: vetu číta aj obeť, preto nie „nič netreba robiť“, ale kam písať.
    assert.doesNotMatch(t.message, /nič netreba/);
    assert.match(t.message, /napíšte na podpora@arling\.sk/);
    assert.doesNotMatch(t.message, POMLCKY);
    assert.ok(Date.parse(t.until) > Date.now() + 23 * 3600 * 1000);
  }
  const riadky = [...env.DB._ucetPokusy.values()];
  assert.equal(riadky.length, 1);
  assert.ok(riadky[0].pokusy <= MAX_ZLYCH_POKUSOV);
  assert.equal(JSON.stringify(riadky).includes(email), false, 'v D1 je len odtlačok adresy');

  // Zamknutá adresa nový kód nedostane (e-mail sa neminie) ...
  const posielaniePred = env._resendCalls.length;
  const novy = await poziadaj(env, email, '198.51.100.2', 'en');
  assert.equal(novy.status, 429);
  const novyTelo = await novy.json();
  assert.equal(novyTelo.dovod, 'zamok');
  assert.match(novyTelo.message, /^Too many wrong codes/);
  assert.doesNotMatch(novyTelo.message, /do not need to do anything/);
  assert.match(novyTelo.message, /write to support@arling\.sk/);
  assert.ok(Number(novy.headers.get('Retry-After')) > 23 * 3600);
  assert.equal(env._resendCalls.length, posielaniePred);

  // ... a ani správny kód (keby ho útočník medzitým uhádol) už neprihlási.
  await env.ASISTENT_CACHE.put(`ucet:kod:${email}`, JSON.stringify({ kod: '123456', pokusy: 0, vytvorene: new Date().toISOString() }));
  const spravnyPoZamku = await over(env, email, '123456', '198.51.100.3');
  assert.equal(spravnyPoZamku.status, 429);
  assert.equal((await spravnyPoZamku.json()).dovod, 'zamok');
});

test('O-04: zlé pokusy sa rátajú na adresu naprieč kódmi; úspešné prihlásenie počítadlo zmaže; po 24 h sa okno začne znova', async () => {
  const env = makeEnv();
  const email = 'zakaznik@firma-o04.sk';
  // Dva kódy po 4 zlé pokusy (pod stropom 5 na kód) = 8 na adresu.
  for (let kolo = 0; kolo < 2; kolo++) {
    assert.equal((await poziadaj(env, email, `198.51.100.${10 + kolo}`)).status, 200);
    for (let i = 0; i < 4; i++) {
      const r = await over(env, email, 'abcdef', `192.0.2.${100 + kolo * 10 + i}`);
      assert.equal(r.status, 400);
    }
  }
  assert.equal([...env.DB._ucetPokusy.values()][0].pokusy, 8);
  // Zostávajúce pokusy berú do úvahy aj adresu: 10 - 9 = 1.
  assert.equal((await poziadaj(env, email, '198.51.100.12')).status, 200);
  const r9 = await (await over(env, email, 'abcdef', '192.0.2.200')).json();
  assert.equal(r9.error, 'bad_code');
  assert.equal(r9.remaining, 1);
  // Správny kód (10. pokus) prihlási a počítadlo zmaže.
  const ok = await over(env, email, await kodZKv(env, email), '192.0.2.201');
  assert.equal(ok.status, 200);
  assert.equal(env.DB._ucetPokusy.size, 0);

  // Staré okno: riadok s okno_od pred 25 h sa pri ďalšom pokuse začne od 1 a cron ho zmaže.
  assert.equal((await poziadaj(env, email, '198.51.100.13')).status, 200);
  await over(env, email, 'abcdef', '192.0.2.202');
  const riadok = [...env.DB._ucetPokusy.values()][0];
  riadok.pokusy = MAX_ZLYCH_POKUSOV;
  riadok.okno_od -= 25 * 3600;
  const po = await (await over(env, email, 'abcdef', '192.0.2.203')).json();
  assert.equal(po.error, 'bad_code');
  assert.equal([...env.DB._ucetPokusy.values()][0].pokusy, 1);
  [...env.DB._ucetPokusy.values()][0].okno_od -= 25 * 3600;
  await zmazStarePokusy(env.DB);
  assert.equal(env.DB._ucetPokusy.size, 0);
});

// ---------------------------------------------------------------------------
// 1. Globálny denný strop kódov
// ---------------------------------------------------------------------------

test('O-04: 45 súbežných žiadostí o kód z rôznych adries a sietí pošle presne 40 e-mailov, ďalšie 503 s poctivou vetou a jeden ping (nie platba)', async () => {
  const env = makeEnv();
  const odpovede = await Promise.all(Array.from({ length: 45 }, (_, i) => poziadaj(env, `clovek${i}@firma${i}.sk`, `192.0.2.${i + 1}`)));
  assert.equal(odpovede.filter((r) => r.status === 200).length, DENNY_STROP_KODOV);
  const odmietnute = odpovede.filter((r) => r.status === 503);
  assert.equal(odmietnute.length, 45 - DENNY_STROP_KODOV);
  assert.equal(env._resendCalls.length, DENNY_STROP_KODOV);
  const telo = await odmietnute[0].json();
  assert.equal(telo.dovod, 'denny_strop');
  assert.match(telo.message, /Dnes sme už poslali najviac prihlasovacích kódov/);
  assert.doesNotMatch(telo.message, POMLCKY);
  assert.ok(Number(odmietnute[0].headers.get('Retry-After')) >= 1);
  const pingy = env._pingy.filter((u) => u.searchParams.get('e') === 'asistent_strop');
  assert.equal(pingy.length, 1, 'raz za deň, aj pri súbežnej dávke');
  assert.match(pingy[0].searchParams.get('d'), /kody uctu: 40 prihlasovacich kodov/);
  // 41. kód neskôr v ten istý deň: znova 503, ďalší ping nie.
  const r41 = await poziadaj(env, 'neskorsi@firma-o04.sk', '198.51.100.99');
  assert.equal(r41.status, 503);
  assert.equal(env._pingy.filter((u) => u.searchParams.get('e') === 'asistent_strop').length, 1);
  // Odmietnuté globálnym stropom nemíňajú ani denný limit svojej siete.
  assert.equal(sucetSieti(env, new Date().toISOString().slice(0, 10)), DENNY_STROP_KODOV);
});

test('O-04: keď Resend zlyhá, miesto v dennom strope sa vráti', async () => {
  const env = makeEnv({ resend: 'fail' });
  for (let i = 0; i < 3; i++) assert.equal((await poziadaj(env, `a${i}@firma-o04.sk`, `192.0.2.${i + 1}`)).status, 503);
  const den = new Date().toISOString().slice(0, 10);
  assert.equal(env.DB._pocty.get(`ucetkody:${den}`).hodnota, 0);
  assert.equal(sucetSieti(env, den), 0, 'aj miesto v dennom limite siete sa vráti');
});

test('O-04: chyba D1 pri strope alebo pokusoch je 503 bez odoslania a bez porovnania kódu', async () => {
  const env = makeEnv();
  assert.equal((await poziadaj(env, 'd1@firma-o04.sk', '192.0.2.1')).status, 200);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/ucet_pokusy|asistent_pocty/.test(sql)) throw new Error('D1 dole'); return prepare(sql); };
  const pred = env._resendCalls.length;
  const r = await poziadaj(env, 'd1b@firma-o04.sk', '192.0.2.2');
  assert.equal(r.status, 503);
  assert.equal(env._resendCalls.length, pred);
  const o = await over(env, 'd1@firma-o04.sk', '000000', '192.0.2.3');
  assert.equal(o.status, 503);
});

// ---------------------------------------------------------------------------
// 3. Limity na sieť /64
// ---------------------------------------------------------------------------

test('O-04 doladenie V1: jedna sieť dostane najviac 5 kódov za UTC deň (IPv6 celá /64 aj /56, IPv4 adresa), iná sieť má vlastný limit', async () => {
  const env = makeEnv();
  const den = new Date().toISOString().slice(0, 10);
  assert.ok(DENNY_LIMIT_KODOV_SIETE < LIMIT_IP_ZA_HODINU, 'denný limit siete je prísnejší než hodinový');
  assert.ok(DENNY_STROP_KODOV / DENNY_LIMIT_KODOV_SIETE >= 8, 'na minutie stropu treba aspoň 8 sietí');
  for (let i = 0; i < DENNY_LIMIT_KODOV_SIETE; i++) {
    const r = await poziadaj(env, `v6-${i}@firma-o04.sk`, `2001:db8:1:2::${(i + 1).toString(16)}`);
    assert.equal(r.status, 200, `žiadosť ${i}`);
  }
  const posielaniePred = env._resendCalls.length;
  // Iná adresa tej istej /64 aj iná /64 tej istej /56 (jedna domáca prípojka): 429.
  for (const ip of ['2001:db8:1:2:ffff:eeee:dddd:cccc', '2001:db8:1:7f::1']) {
    const r = await poziadaj(env, 'v6-dalsi@firma-o04.sk', ip);
    assert.equal(r.status, 429, ip);
    const t = await r.json();
    assert.equal(t.error, 'rate_limited');
    assert.equal(t.dovod, 'siet_den');
    assert.match(t.message, /Do tejto siete sme dnes poslali najviac prihlasovacích kódov/);
    assert.doesNotMatch(t.message, POMLCKY);
    assert.ok(Number(r.headers.get('Retry-After')) >= 1);
  }
  assert.equal(env._resendCalls.length, posielaniePred, 'nad limitom siete žiadny e-mail');
  // Globálny strop sa odmietnutými nemíňa.
  assert.equal(env.DB._pocty.get(`ucetkody:${den}`).hodnota, DENNY_LIMIT_KODOV_SIETE);
  // Iná /56 má vlastný limit.
  assert.equal((await poziadaj(env, 'v6-ina@firma-o04.sk', '2001:db8:2:100::1')).status, 200);
  // IPv4: jedna adresa 5, šiesty kód 429 v jazyku žiadosti, iná adresa prejde.
  for (let i = 0; i < DENNY_LIMIT_KODOV_SIETE; i++) assert.equal((await poziadaj(env, `v4-${i}@firma-o04.sk`, '198.51.100.77')).status, 200);
  const v4 = await poziadaj(env, 'v4-dalsi@firma-o04.sk', '198.51.100.77', 'en');
  assert.equal(v4.status, 429);
  assert.match((await v4.json()).message, /^We have already sent as many sign-in codes to this network today/);
  assert.equal((await poziadaj(env, 'v4-ina@firma-o04.sk', '198.51.100.78')).status, 200);
  // Kľúč KV ani D1 nenesie holú IP.
  assert.equal([...env.ASISTENT_CACHE._store.keys()].some((k) => k.includes('2001:db8') || k.includes('198.51')), false);
  assert.equal([...env.DB._pocty.keys()].some((k) => k.includes('2001:db8') || k.includes('198.51')), false);
  for (const k of env.DB._pocty.keys()) if (k.startsWith('ucetsiet:')) assert.match(k, /^ucetsiet:\d{4}-\d{2}-\d{2}:\d{1,5}$/);
});

test('O-04 doladenie V1: 12 súbežných žiadostí z jednej siete pošle presne 5 kódov', async () => {
  const env = makeEnv();
  const odpovede = await Promise.all(Array.from({ length: 12 }, (_, i) => poziadaj(env, `sub-${i}@firma-o04.sk`, `2001:db8:5:5::${(i + 1).toString(16)}`)));
  assert.equal(odpovede.filter((r) => r.status === 200).length, DENNY_LIMIT_KODOV_SIETE);
  assert.equal(odpovede.filter((r) => r.status === 429).length, 12 - DENNY_LIMIT_KODOV_SIETE);
  assert.equal(env._resendCalls.length, DENNY_LIMIT_KODOV_SIETE);
});

test('O-04 doladenie D1/D2: podpora odomkne jednu zamknutú adresu (len s admin tokenom), iné zámky ostanú', async () => {
  const env = makeEnv();
  const obet = 'zamknuta@firma-o04.sk';
  const ina = 'ina-zamknuta@firma-o04.sk';
  for (const [j, email] of [obet, ina].entries()) {
    assert.equal((await poziadaj(env, email, `198.51.100.${120 + j}`)).status, 200);
    for (let i = 0; i < MAX_ZLYCH_POKUSOV + 1; i++) {
      if (!(await kodZKv(env, email))) await env.ASISTENT_CACHE.put(`ucet:kod:${email}`, JSON.stringify({ kod: '654321', pokusy: 0, vytvorene: new Date().toISOString() }));
      await over(env, email, '000001', `192.0.2.${10 + j * 20 + i}`);
    }
  }
  assert.equal((await poziadaj(env, obet, '198.51.100.130')).status, 429);

  const odomkni = (headers) => worker.fetch(req('/v1/ucet/odomkni', { body: { email: obet }, headers }), env, {});
  assert.equal((await odomkni({})).status, 401);
  assert.equal((await odomkni({ 'X-Admin-Token': 'zly' })).status, 401);
  const ok = await odomkni({ 'X-Admin-Token': ADMIN });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, zamknute_bolo: true });

  assert.equal((await poziadaj(env, obet, '198.51.100.131')).status, 200, 'odomknutá adresa dostane kód');
  assert.equal((await poziadaj(env, ina, '198.51.100.132')).status, 429, 'iná zamknutá adresa ostáva zamknutá');
  const zlyEmail = await worker.fetch(req('/v1/ucet/odomkni', { body: { email: 'nie-je-email' }, headers: { 'X-Admin-Token': ADMIN } }), env, {});
  assert.equal(zlyEmail.status, 400);
});

test('O-04: minútový limit ciest účtu (over) platí na sieť /64, nie na jednu IPv6 adresu', async () => {
  const env = makeEnv();
  let prvy429 = -1;
  for (let i = 0; i < 40; i++) {
    const r = await over(env, 'nikto@firma-o04.sk', '000000', `2001:db8:9:9::${(i + 1).toString(16)}`);
    if (r.status === 429) { prvy429 = i; break; }
  }
  assert.equal(prvy429, 30, '31. požiadavka z tej istej /64 v minúte je 429');
});

// ---------------------------------------------------------------------------
// 4. /v1/ucet/ja bez session_id
// ---------------------------------------------------------------------------

async function ucetSNakupmi(env, email, nakupy) {
  await env.ASISTENT_CACHE.put(`ucet:ucet:${email}`, JSON.stringify({ email, vytvorene: new Date().toISOString(), verzia: 1, nakupy, predplatne: [] }));
  return vytvorToken(env, { email, verzia: 1 });
}

test('O-04: GET /v1/ucet/ja nevracia session_id; POST /v1/ucet/nakup-pristup ho vydá len majiteľovi s Bearer tokenom', async () => {
  const env = makeEnv();
  const token = await ucetSNakupmi(env, 'kupec@firma-o04.sk', [
    { produkt: 'Ben-Hur', session_id: 'cs_live_tajna_session_1', suma: 490, mena: 'eur', livemode: true, datum: '2026-09-28T10:00:00.000Z' },
    { produkt: 'Kontrola pain.001 XML', session_id: 'cs_live_tajna_session_2', suma: 14900, mena: 'eur', livemode: true, datum: '2026-09-29T10:00:00.000Z' },
  ]);
  const ja = await worker.fetch(req('/v1/ucet/ja', { method: 'GET', token }), env, {});
  assert.equal(ja.status, 200);
  const text = await ja.text();
  assert.equal(text.includes('session_id'), false);
  assert.equal(text.includes('cs_live_tajna'), false);
  const telo = JSON.parse(text);
  assert.deepEqual(Object.keys(telo.nakupy[0]).sort(), ['datum', 'id', 'livemode', 'mena', 'produkt', 'suma']);
  assert.equal(telo.nakupy[1].suma, 14900);

  const pristup = await worker.fetch(req('/v1/ucet/nakup-pristup', { body: { id: telo.nakupy[1].id }, token }), env, {});
  assert.equal(pristup.status, 200);
  assert.deepEqual(await pristup.json(), { session_id: 'cs_live_tajna_session_2', produkt: 'Kontrola pain.001 XML' });

  const bezTokenu = await worker.fetch(req('/v1/ucet/nakup-pristup', { body: { id: telo.nakupy[1].id } }), env, {});
  assert.equal(bezTokenu.status, 401);

  // Iný účet s tým istým id nákupu nedostane nič.
  const cudziToken = await ucetSNakupmi(env, 'cudzi@firma-o04.sk', []);
  const cudzi = await worker.fetch(req('/v1/ucet/nakup-pristup', { body: { id: telo.nakupy[1].id }, token: cudziToken }), env, {});
  assert.equal(cudzi.status, 404);
  const zlyTvar = await worker.fetch(req('/v1/ucet/nakup-pristup', { body: { id: 'cs_live_tajna_session_2' }, token }), env, {});
  assert.equal(zlyTvar.status, 400);
});

// ---------------------------------------------------------------------------
// 5. O-25: verejný stav obchodu bez plánu
// ---------------------------------------------------------------------------

const TAJNE_POLIA = ['plan', 'monthly_quota', 'conversations_used', 'usage_percent', 'used_this_month', 'valid_until', 'period_start', 'period_end', 'last_ingest', 'last_ingested_at', 'last_error', 'billing_ref'];

async function zalozObchod(env, { token } = {}) {
  const r = await worker.fetch(req('/v1/tenants', { body: { feed_url: 'https://obchod-o25.sk/feed.xml', domain: 'obchod-o25.sk', email: 'majitel@obchod-o25.sk', lang: 'sk' }, token }), env, {});
  return { status: r.status, telo: await r.json() };
}

const stav = (env, id, headers = {}, token) => worker.fetch(req(`/v1/tenants/${id}/status`, { method: 'GET', headers, token }), env, {});

test('O-25: verejný GET /v1/tenants/:id/status nemá plán, kvótu ani spotrebu; plný stav s admin tokenom, kľúčom obchodu alebo Bearerom majiteľa', async () => {
  const env = makeEnv();
  const { status, telo } = await zalozObchod(env);
  assert.equal(status, 201);
  assert.match(telo.kluc_stavu, /^[A-Za-z0-9_-]{32}$/);
  env.DB._tenants.get(telo.id).plan = 'pro';
  env.DB._tenants.get(telo.id).monthly_quota = 3000;

  const verejny = await (await stav(env, telo.id)).json();
  for (const k of ['id', 'status', 'product_count', 'live_demo']) assert.ok(k in verejny, `chýba ${k}`);
  for (const k of TAJNE_POLIA) assert.equal(k in verejny, false, `verejne je ${k}`);
  assert.equal(JSON.stringify(verejny).includes('3000'), false);

  const admin = await (await stav(env, telo.id, { 'X-Admin-Token': ADMIN })).json();
  assert.equal(admin.plan, 'pro');
  assert.equal(admin.monthly_quota, 3000);

  const kluc = await (await stav(env, telo.id, { 'X-Arling-Kluc': telo.kluc_stavu })).json();
  assert.equal(kluc.plan, 'pro');
  const zlyKluc = await (await stav(env, telo.id, { 'X-Arling-Kluc': telo.kluc_stavu.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) })).json();
  assert.equal('plan' in zlyKluc, false);

  await env.ASISTENT_CACHE.put('ucet:ucet:majitel@obchod-o25.sk', JSON.stringify({ email: 'majitel@obchod-o25.sk', verzia: 1, nakupy: [] }));
  const majitel = await (await stav(env, telo.id, {}, await vytvorToken(env, { email: 'majitel@obchod-o25.sk', verzia: 1 }))).json();
  assert.equal(majitel.plan, 'pro');
  await env.ASISTENT_CACHE.put('ucet:ucet:cudzi@firma-o04.sk', JSON.stringify({ email: 'cudzi@firma-o04.sk', verzia: 1, nakupy: [] }));
  const cudzi = await (await stav(env, telo.id, {}, await vytvorToken(env, { email: 'cudzi@firma-o04.sk', verzia: 1 }))).json();
  assert.equal('plan' in cudzi, false);

  // Prechodný vypínač pre doplnok WordPress 0.4.0 a starší.
  env.ASISTENT_STATUS_VEREJNY = 'plny';
  assert.equal((await (await stav(env, telo.id)).json()).plan, 'pro');
});

test('O-25: opakované POST /v1/tenants so zhodným e-mailom bez overenia nevráti plán, kvótu ani kľúč; s Bearerom majiteľa áno', async () => {
  const env = makeEnv();
  const { telo } = await zalozObchod(env);
  env.DB._tenants.get(telo.id).plan = 'pro';
  const znova = await zalozObchod(env);
  assert.equal(znova.status, 200);
  assert.equal(znova.telo.existing, true);
  for (const k of ['plan', 'monthly_quota', 'kluc_stavu']) assert.equal(k in znova.telo, false, k);

  await env.ASISTENT_CACHE.put('ucet:ucet:majitel@obchod-o25.sk', JSON.stringify({ email: 'majitel@obchod-o25.sk', verzia: 1, nakupy: [] }));
  const overeny = await zalozObchod(env, { token: await vytvorToken(env, { email: 'majitel@obchod-o25.sk', verzia: 1 }) });
  assert.equal(overeny.telo.overeny, true);
  assert.equal(overeny.telo.plan, 'pro');
  assert.equal(overeny.telo.kluc_stavu, telo.kluc_stavu);
});

test('O-04: migrácia 0004 a schema.sql vytvárajú ucet_pokusy len s IF NOT EXISTS', () => {
  const migracia = readFileSync(new URL('../worker/migrations/0004_ucet_ochrana.sql', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  for (const s of [migracia, schema]) {
    assert.match(s, /CREATE TABLE IF NOT EXISTS ucet_pokusy \(kluc TEXT PRIMARY KEY, pokusy INTEGER NOT NULL DEFAULT 0, okno_od INTEGER NOT NULL\);/);
    assert.match(s, /CREATE INDEX IF NOT EXISTS idx_ucet_pokusy_okno ON ucet_pokusy \(okno_od\);/);
  }
  const prikazy = migracia.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(prikazy, /\bDROP\b|\bALTER\b/);
});

test('O-25: stránka obchodu (demo/tenant) posiela Bearer majiteľa z localStorage, ak ho má', async () => {
  const { ownerToken } = await import('../demo/tenant/tenant.js');
  const pamat = (obj) => ({ getItem: (k) => (k in obj ? obj[k] : null) });
  assert.equal(ownerToken(pamat({})), '');
  assert.equal(ownerToken(null), '');
  assert.equal(ownerToken(pamat({ 'arling:ucet': JSON.stringify({ token: 't-ucet', email: 'a@b.sk' }) })), 't-ucet');
  assert.equal(ownerToken(pamat({ arling_asistent_overenie: JSON.stringify({ token: 't-skuska', email: 'a@b.sk' }) })), 't-skuska');
  assert.equal(ownerToken(pamat({ 'arling:ucet': 'nie json' })), '');
  const src = readFileSync(new URL('../demo/tenant/tenant.js', import.meta.url), 'utf8');
  assert.match(src, /init\.headers = \{ Authorization: 'Bearer ' \+ token \}/);
});
