// ucet.test.mjs
// Ucet cez e-mail (worker/src/ucet.js): 6-cislicovy kod, podpisany Bearer
// token, spatne dohladanie nakupov v Stripe, a hry ulozene po e-maile.
//
// Ako v upload.test.mjs: beží proti skutočnému default.fetch routeru
// (index.js) s Node-native Request/Response, a env.fetchImpl stojí za Stripe
// aj za Resend, takže žiadny test tu sa nedotkne siete.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import {
  normalizujEmail,
  jePlatnyEmail,
  vytvorToken,
  overToken,
  KOD_TTL_SECONDS,
  MAX_POKUSOV,
  LIMIT_EMAIL_ZA_HODINU,
  LIMIT_IP_ZA_HODINU,
  HRA_MAX_BYTES,
  DEFAULT_STRIPE_PORTAL_URL,
} from '../worker/src/ucet.js';

const API = 'https://arling-asistent.arling.workers.dev';
const ORIGIN = 'https://arling.sk';
const ADMIN = 'admin-token-pre-testy';
// base64 (nie base64url) tajomstvo, presne ako ho worker caka z wrangler secret.
const TAJOMSTVO = Buffer.from('tajny-kluc-pre-testy-ucet-2026-09-10').toString('base64');

// ---------------------------------------------------------------------------
// Mock KV (get s typom 'json', put s options, delete, list podla predpony) -
// rovnaky tvar ako createMockKv v upload.test.mjs, len bez R2-specifickeho
// arrayBuffer typu, ktory ucet.js nepotrebuje.
// ---------------------------------------------------------------------------

function createMockKv() {
  const store = new Map();
  return {
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key).value;
      if (type === 'json') {
        try { return JSON.parse(value); } catch (e) { return null; }
      }
      return value;
    },
    async put(key, value, options) {
      store.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), options: options || {} });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', cursor } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const keys = all.map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

/**
 * env.fetchImpl smerovac: Resend (api.resend.com/emails), Stripe zoznam
 * (checkout/sessions?...) pre spatne dohladanie, a Stripe jedna session
 * (checkout/sessions/<id>) pre nakup-session. Kazda cast sa da samostatne
 * nastavit/zlyhat.
 */
function makeEnv({
  resend = 'ok',
  stripeList = [],
  stripeSessions = {},
  ucetTajomstvo = TAJOMSTVO,
  resendKey = 'resend-test-key',
  stripeKey = 'sk_live_x',
  adminToken = ADMIN,
  kv = createMockKv(),
} = {}) {
  const outbound = [];
  const resendCalls = [];
  const env = {
    ASISTENT_CACHE: kv,
    ALLOWED_ORIGINS: 'arling.sk',
    UCET_TAJOMSTVO: ucetTajomstvo,
    RESEND_API_KEY: resendKey,
    STRIPE_SECRET_KEY: stripeKey,
    ADMIN_TOKEN: adminToken,
    outbound,
    fetchImpl: async (url, opts) => {
      const href = String(url);
      outbound.push({ url: href, opts });

      if (href.startsWith('https://api.resend.com/')) {
        resendCalls.push({ url: href, opts });
        if (resend === 'fail') return { ok: false, status: 500, json: async () => ({ message: 'resend down' }) };
        if (resend === 'throw') throw new Error('network down');
        return { ok: true, status: 200, json: async () => ({ id: 'email_1' }) };
      }

      if (href.startsWith('https://api.stripe.com/v1/checkout/sessions?')) {
        return { ok: true, status: 200, json: async () => ({ data: stripeList }) };
      }

      if (href.startsWith('https://api.stripe.com/v1/checkout/sessions/')) {
        const id = href.split('https://api.stripe.com/v1/checkout/sessions/')[1].split('?')[0];
        const session = stripeSessions[id];
        if (!session) return { ok: false, status: 404, json: async () => ({ error: { message: 'no such session' } }) };
        return { ok: true, status: 200, json: async () => session };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  env._resendCalls = resendCalls;
  return env;
}

function stripeSession(id, overrides = {}) {
  return {
    id,
    object: 'checkout.session',
    payment_status: 'paid',
    amount_total: 4900,
    currency: 'eur',
    livemode: true,
    created: 1757500000,
    customer_details: { email: 'zakaznik@firma.sk' },
    ...overrides,
  };
}

function req(path, { method = 'GET', origin = ORIGIN, body, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return new Request(`${API}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

async function poziadajKod(env, email, extra = {}) {
  return worker.fetch(req('/v1/ucet/kod', { method: 'POST', body: { email, ...extra } }), env, {});
}

async function overKod(env, email, kod) {
  return worker.fetch(req('/v1/ucet/over', { method: 'POST', body: { email, kod } }), env, {});
}

/** Poziada o kod a rovno precita ulozeny zaznam z KV, aby test nemusel citat e-mail. */
async function poziadajAPrecitajKod(env, email) {
  const res = await poziadajKod(env, email);
  assert.equal(res.status, 200);
  const zaznam = await env.ASISTENT_CACHE.get(`ucet:kod:${email}`, 'json');
  assert.ok(zaznam && zaznam.kod, 'kod bol ulozeny do KV');
  return zaznam.kod;
}

async function prihlas(env, email) {
  const kod = await poziadajAPrecitajKod(env, email);
  const res = await overKod(env, email, kod);
  assert.equal(res.status, 200, 'prihlasenie spravnym kodom uspeje');
  return res.json();
}

// ---------------------------------------------------------------------------
// normalizujEmail / jePlatnyEmail
// ---------------------------------------------------------------------------

test('normalizujEmail orezava a mala pismena, jePlatnyEmail overuje tvar', () => {
  assert.equal(normalizujEmail('  Zakaznik@Firma.SK '), 'zakaznik@firma.sk');
  assert.equal(jePlatnyEmail('zakaznik@firma.sk'), true);
  assert.equal(jePlatnyEmail('nie je email'), false);
  assert.equal(jePlatnyEmail(''), false);
});

// ---------------------------------------------------------------------------
// ucet_unavailable ked chyba UCET_TAJOMSTVO
// ---------------------------------------------------------------------------

test('bez UCET_TAJOMSTVO kazda /v1/ucet/* cesta odpovie 503 ucet_unavailable, aj admin PUT nakup', async () => {
  // '' (nie undefined - destrukturovany default by ho tichem nahradil skutocnym kluvom).
  const env = makeEnv({ ucetTajomstvo: '' });
  const kod = await worker.fetch(req('/v1/ucet/kod', { method: 'POST', body: { email: 'a@b.sk' } }), env, {});
  assert.equal(kod.status, 503);
  assert.deepEqual(await kod.json(), { error: 'ucet_unavailable' });

  const ja = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: 'Bearer x' } }), env, {});
  assert.equal(ja.status, 503);

  const admin = await worker.fetch(req('/v1/ucet/nakup', {
    method: 'PUT',
    headers: { 'X-Admin-Token': ADMIN },
    body: { email: 'a@b.sk', session_id: 'cs_live_x' },
  }), env, {});
  assert.equal(admin.status, 503);
});

// ---------------------------------------------------------------------------
// 1. POST /v1/ucet/kod - kod a limity
// ---------------------------------------------------------------------------

test('POST /v1/ucet/kod so zlym e-mailom vrati 400 bad_email', async () => {
  const env = makeEnv();
  const res = await poziadajKod(env, 'nie je email');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_email' });
});

test('POST /v1/ucet/kod ulozi 6-cislicovy kod do KV s pokusy:0 a posle ho cez Resend', async () => {
  const env = makeEnv();
  const email = 'zakaznik@firma.sk';
  const res = await poziadajKod(env, email);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const zaznam = await env.ASISTENT_CACHE.get(`ucet:kod:${email}`, 'json');
  assert.match(zaznam.kod, /^\d{6}$/);
  assert.equal(zaznam.pokusy, 0);
  assert.ok(zaznam.vytvorene);

  assert.equal(env._resendCalls.length, 1);
  const telo = JSON.parse(env._resendCalls[0].opts.body);
  assert.equal(telo.from, 'ARLing <ucet@mail.arling.sk>');
  assert.deepEqual(telo.to, [email]);
  assert.match(telo.subject, new RegExp(zaznam.kod));
  assert.match(telo.text, /15 min/);
  assert.equal(env._resendCalls[0].opts.headers.Authorization, 'Bearer resend-test-key');
});

test('POST /v1/ucet/kod respektuje jazyk anglicky a nemecky predmet e-mailu', async () => {
  const envEn = makeEnv();
  await poziadajKod(envEn, 'a@firma.sk', { jazyk: 'en' });
  assert.match(JSON.parse(envEn._resendCalls[0].opts.body).subject, /Your code:/);

  const envDe = makeEnv();
  await poziadajKod(envDe, 'b@firma.sk', { jazyk: 'de' });
  assert.match(JSON.parse(envDe._resendCalls[0].opts.body).subject, /Ihr Code:/);
});

test('POST /v1/ucet/kod bez RESEND_API_KEY vrati 503 mail_unavailable a zahodi ulozeny kod', async () => {
  const env = makeEnv({ resendKey: '' });
  const email = 'zakaznik@firma.sk';
  const res = await poziadajKod(env, email);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'mail_unavailable' });
  assert.equal(await env.ASISTENT_CACHE.get(`ucet:kod:${email}`, 'json'), null);
});

test('POST /v1/ucet/kod ked Resend zlyha (HTTP aj sietova chyba) vrati 503 mail_unavailable a zahodi kod', async () => {
  for (const resend of ['fail', 'throw']) {
    const env = makeEnv({ resend });
    const email = 'zakaznik@firma.sk';
    const res = await poziadajKod(env, email);
    assert.equal(res.status, 503, resend);
    assert.deepEqual(await res.json(), { error: 'mail_unavailable' });
    assert.equal(await env.ASISTENT_CACHE.get(`ucet:kod:${email}`, 'json'), null, resend);
  }
});

test(`POST /v1/ucet/kod: limit ${LIMIT_EMAIL_ZA_HODINU} kodov za hodinu na e-mail, potom 429 rate_limited`, async () => {
  const env = makeEnv();
  const email = 'zakaznik@firma.sk';
  for (let i = 0; i < LIMIT_EMAIL_ZA_HODINU; i++) {
    const res = await poziadajKod(env, email);
    assert.equal(res.status, 200, `pokus ${i + 1}`);
  }
  const blocked = await poziadajKod(env, email);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: 'rate_limited' });
  // Iny e-mail na tej istej IP este ma svoj vlastny limit.
});

test(`POST /v1/ucet/kod: limit ${LIMIT_IP_ZA_HODINU} kodov za hodinu na IP naprieč rôznymi e-mailami, potom 429`, async () => {
  const env = makeEnv();
  const ip = '9.9.9.9';
  for (let i = 0; i < LIMIT_IP_ZA_HODINU; i++) {
    const res = await worker.fetch(req('/v1/ucet/kod', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
      body: { email: `zakaznik${i}@firma.sk` },
    }), env, {});
    assert.equal(res.status, 200, `pokus ${i + 1}`);
  }
  const blocked = await worker.fetch(req('/v1/ucet/kod', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: { email: 'dalsi@firma.sk' },
  }), env, {});
  assert.equal(blocked.status, 429);
});

// ---------------------------------------------------------------------------
// 2. POST /v1/ucet/over - zle pokusy
// ---------------------------------------------------------------------------

test('POST /v1/ucet/over bez ulozeneho kodu vrati 400 no_code', async () => {
  const env = makeEnv();
  const res = await overKod(env, 'nikto@firma.sk', '123456');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'no_code' });
});

test('POST /v1/ucet/over so zlym kodom pripocitava pokusy a po 5. zlom kod zmaze', async () => {
  const env = makeEnv();
  const email = 'zakaznik@firma.sk';
  const spravnyKod = await poziadajAPrecitajKod(env, email);
  const zlyKod = spravnyKod === '000000' ? '111111' : '000000';

  for (let pokus = 1; pokus < MAX_POKUSOV; pokus++) {
    const res = await overKod(env, email, zlyKod);
    assert.equal(res.status, 400, `pokus ${pokus}`);
    const telo = await res.json();
    assert.equal(telo.error, 'bad_code');
    assert.equal(telo.remaining, MAX_POKUSOV - pokus, `pokus ${pokus}`);
  }

  // MAX_POKUSOV-ty zly pokus zmaze kod celkom.
  const posledny = await overKod(env, email, zlyKod);
  assert.equal(posledny.status, 400);
  assert.deepEqual(await posledny.json(), { error: 'bad_code', remaining: 0 });
  assert.equal(await env.ASISTENT_CACHE.get(`ucet:kod:${email}`, 'json'), null);

  // Aj spravny kod uz teraz odmietne - bol zmazany.
  const poZmazani = await overKod(env, email, spravnyKod);
  assert.equal(poZmazani.status, 400);
  assert.deepEqual(await poZmazani.json(), { error: 'no_code' });
});

test('POST /v1/ucet/over so spravnym kodom vytvori ucet, vrati token a "ucet bez internych poli" (bez verzie)', async () => {
  const env = makeEnv();
  const email = 'zakaznik@firma.sk';
  const kod = await poziadajAPrecitajKod(env, email);
  const res = await overKod(env, email, kod);
  assert.equal(res.status, 200);
  const telo = await res.json();
  assert.equal(telo.email, email);
  assert.ok(telo.token);
  assert.equal(telo.ucet.email, email);
  assert.deepEqual(telo.ucet.nakupy, []);
  assert.deepEqual(telo.ucet.predplatne, []);
  assert.equal('verzia' in telo.ucet, false, 'verzia je interne pole, nema byt vo verejnej odpovedi');

  // Kod uz nejde pouzit druhy raz.
  const znova = await overKod(env, email, kod);
  assert.equal(znova.status, 400);
  assert.deepEqual(await znova.json(), { error: 'no_code' });
});

// ---------------------------------------------------------------------------
// token: podpis a exp
// ---------------------------------------------------------------------------

test('vytvorToken/overToken: platny token sa overi, pozmeneny podpis a cudzi kluc sa odmietnu', async () => {
  const env = makeEnv();
  const token = await vytvorToken(env, { email: 'a@b.sk', verzia: 1 });
  const payload = await overToken(env, token);
  assert.deepEqual({ e: payload.e, v: payload.v }, { e: 'a@b.sk', v: 1 });
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));

  // Pozmeneny podpis (posledny znak) sa odmietne.
  const [cast1, podpis] = token.split('.');
  const zlyPodpis = podpis.slice(0, -1) + (podpis.slice(-1) === 'a' ? 'b' : 'a');
  assert.equal(await overToken(env, `${cast1}.${zlyPodpis}`), null);

  // Ten isty token pod inym tajomstvom nesedi.
  const inyEnv = makeEnv({ ucetTajomstvo: Buffer.from('celkom iny kluc').toString('base64') });
  assert.equal(await overToken(inyEnv, token), null);

  // Zjavne nezmyselne vstupy sa nikdy nehodia (nehadze vynimku).
  assert.equal(await overToken(env, ''), null);
  assert.equal(await overToken(env, 'nie je token'), null);
  assert.equal(await overToken(env, null), null);
});

test('overToken odmietne expirovany token', async () => {
  const env = makeEnv();
  const povodne = Date.now;
  try {
    Date.now = () => povodne() - 91 * 24 * 60 * 60 * 1000; // spred 91 dni
    var starýToken = await vytvorToken(env, { email: 'a@b.sk', verzia: 1 });
  } finally {
    Date.now = povodne;
  }
  assert.equal(await overToken(env, starýToken), null);
});

test('GET /v1/ucet/ja bez tokenu alebo so zlym tokenom vrati 401', async () => {
  const env = makeEnv();
  const bezHlavicky = await worker.fetch(req('/v1/ucet/ja'), env, {});
  assert.equal(bezHlavicky.status, 401);

  const zlyToken = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: 'Bearer nezmysel' } }), env, {});
  assert.equal(zlyToken.status, 401);
});

test('GET /v1/ucet/ja s platnym tokenom vrati email, nakupy, predplatne a portal_url', async () => {
  const env = makeEnv();
  const { token, email } = await prihlas(env, 'zakaznik@firma.sk');
  const res = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(res.status, 200);
  const telo = await res.json();
  assert.equal(telo.email, email);
  assert.deepEqual(telo.nakupy, []);
  assert.deepEqual(telo.predplatne, []);
  assert.equal(telo.portal_url, DEFAULT_STRIPE_PORTAL_URL);
});

// ---------------------------------------------------------------------------
// odhlasenie zneplatni
// ---------------------------------------------------------------------------

test('POST /v1/ucet/odhlasit zneplatni existujuci token (verzia+1), novy token po opatovnom prihlaseni funguje', async () => {
  const env = makeEnv();
  const { token: povodnyToken, email } = await prihlas(env, 'zakaznik@firma.sk');

  const overCheck = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: `Bearer ${povodnyToken}` } }), env, {});
  assert.equal(overCheck.status, 200, 'token funguje pred odhlasenim');

  const odhlas = await worker.fetch(req('/v1/ucet/odhlasit', { method: 'POST', headers: { Authorization: `Bearer ${povodnyToken}` } }), env, {});
  assert.equal(odhlas.status, 200);
  assert.deepEqual(await odhlas.json(), { ok: true });

  const poOdhlaseni = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: `Bearer ${povodnyToken}` } }), env, {});
  assert.equal(poOdhlaseni.status, 401, 'stary token uz nefunguje');

  // Novy kod, novy token, ten uz funguje.
  const { token: novyToken } = await prihlas(env, email);
  const novyCheck = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: `Bearer ${novyToken}` } }), env, {});
  assert.equal(novyCheck.status, 200);
});

// ---------------------------------------------------------------------------
// spatne dohladanie zo Stripe (A.2)
// ---------------------------------------------------------------------------

test('POST /v1/ucet/over doplni zaplatene, ostre Stripe sessions s tym e-mailom, vynecha nezaplatene a testovacie', async () => {
  const email = 'zakaznik@firma.sk';
  const env = makeEnv({
    stripeList: [
      stripeSession('cs_live_zaplatena', {
        line_items: { data: [{ description: 'Kontrola pain.001 XML' }] },
      }),
      stripeSession('cs_live_nezaplatena', { payment_status: 'unpaid' }),
      stripeSession('cs_test_skusobna', { livemode: false }),
    ],
  });
  const { ucet } = await prihlas(env, email);
  assert.equal(ucet.nakupy.length, 1);
  assert.equal(ucet.nakupy[0].session_id, 'cs_live_zaplatena');
  assert.equal(ucet.nakupy[0].produkt, 'Kontrola pain.001 XML');
  assert.equal(ucet.nakupy[0].suma, 4900);
  assert.equal(ucet.nakupy[0].mena, 'eur');
  assert.equal(ucet.nakupy[0].livemode, true);
});

test('POST /v1/ucet/over pouzije metadata.produkt, ked chyba nazov v line_items', async () => {
  const email = 'zakaznik@firma.sk';
  const env = makeEnv({
    stripeList: [stripeSession('cs_live_odkaz', { metadata: { produkt: 'GDPR balik SK' } })],
  });
  const { ucet } = await prihlas(env, email);
  assert.equal(ucet.nakupy[0].produkt, 'GDPR balik SK');
});

test('POST /v1/ucet/over pri zlyhani Stripe (siet aj HTTP chyba) prihlasenie nepokazi, ucet ostane bez nakupov', async () => {
  for (const stripeKey of ['', 'sk_live_x']) {
    const env = makeEnv({ stripeKey });
    env.fetchImpl = async (url) => {
      const href = String(url);
      if (href.startsWith('https://api.stripe.com/')) throw new Error('stripe je dole');
      if (href.startsWith('https://api.resend.com/')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const email = `zakaznik-${stripeKey || 'nokey'}@firma.sk`;
    const res = await prihlas(env, email);
    assert.equal(res.ucet.nakupy.length, 0);
  }
});

test('POST /v1/ucet/over nezdvoji nakup, ktory uz v ucte je (druhe prihlasenie, ten isty session_id)', async () => {
  const email = 'zakaznik@firma.sk';
  const kv = createMockKv();
  const env = makeEnv({ kv, stripeList: [stripeSession('cs_live_raz')] });
  await prihlas(env, email);
  await prihlas(env, email);
  const ucet = await kv.get(`ucet:ucet:${email}`, 'json');
  assert.equal(ucet.nakupy.length, 1);
});

// ---------------------------------------------------------------------------
// nakup-session: cudzi e-mail 403
// ---------------------------------------------------------------------------

test('POST /v1/ucet/nakup-session: session paterneho e-mailu inej osoby vrati 403 not_yours', async () => {
  const env = makeEnv({
    stripeSessions: {
      cs_live_cudzia12345678: stripeSession('cs_live_cudzia12345678', { customer_details: { email: 'niekto-iny@ina-firma.sk' } }),
    },
  });
  const { token } = await prihlas(env, 'zakaznik@firma.sk');
  const res = await worker.fetch(req('/v1/ucet/nakup-session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { session_id: 'cs_live_cudzia12345678' },
  }), env, {});
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'not_yours' });
});

test('POST /v1/ucet/nakup-session: nezaplatena session vrati 402 not_paid', async () => {
  const email = 'zakaznik@firma.sk';
  const env = makeEnv({
    stripeSessions: {
      cs_live_nezaplatena123: stripeSession('cs_live_nezaplatena123', { payment_status: 'unpaid', customer_details: { email } }),
    },
  });
  const { token } = await prihlas(env, email);
  const res = await worker.fetch(req('/v1/ucet/nakup-session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { session_id: 'cs_live_nezaplatena123' },
  }), env, {});
  assert.equal(res.status, 402);
  assert.deepEqual(await res.json(), { error: 'not_paid', payment_status: 'unpaid' });
});

test('POST /v1/ucet/nakup-session: vlastna zaplatena session sa zapise idempotentne (druhe volanie nezdvoji)', async () => {
  const email = 'zakaznik@firma.sk';
  const env = makeEnv({
    stripeSessions: { cs_live_moja1234567890: stripeSession('cs_live_moja1234567890', { customer_details: { email } }) },
  });
  const { token } = await prihlas(env, email);
  const telo = { session_id: 'cs_live_moja1234567890' };
  const prve = await worker.fetch(req('/v1/ucet/nakup-session', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: telo }), env, {});
  assert.equal(prve.status, 200);
  const prveTelo = await prve.json();
  assert.equal(prveTelo.ok, true);
  assert.equal(prveTelo.nakup.session_id, 'cs_live_moja1234567890');

  const druhe = await worker.fetch(req('/v1/ucet/nakup-session', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: telo }), env, {});
  assert.equal(druhe.status, 200);

  const ja = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  const jaTelo = await ja.json();
  assert.equal(jaTelo.nakupy.length, 1);
});

// ---------------------------------------------------------------------------
// hra PUT/GET a limit velkosti
// ---------------------------------------------------------------------------

test('GET /v1/ucet/hra/<hra> bez ulozeneho stavu vrati prazdny objekt', async () => {
  const env = makeEnv();
  const { token } = await prihlas(env, 'hrac@firma.sk');
  const res = await worker.fetch(req('/v1/ucet/hra/hedgehogs', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
});

test('PUT potom GET /v1/ucet/hra/<hra>: ulozi a vrati ten isty JSON stav, oddelene podla e-mailu', async () => {
  const env = makeEnv();
  const { token: tokenA } = await prihlas(env, 'hrac-a@firma.sk');
  const { token: tokenB } = await prihlas(env, 'hrac-b@firma.sk');
  const stav = { dni: { '2026-09-10': { done: true, cas: 42 } }, t: 1757500000 };

  const put = await worker.fetch(req('/v1/ucet/hra/hedgehogs', { method: 'PUT', headers: { Authorization: `Bearer ${tokenA}` }, body: stav }), env, {});
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { ok: true });

  const getA = await worker.fetch(req('/v1/ucet/hra/hedgehogs', { headers: { Authorization: `Bearer ${tokenA}` } }), env, {});
  assert.deepEqual(await getA.json(), stav);

  // Iny ucet nema tento stav (kluc je per-email).
  const getB = await worker.fetch(req('/v1/ucet/hra/hedgehogs', { headers: { Authorization: `Bearer ${tokenB}` } }), env, {});
  assert.deepEqual(await getB.json(), {});
});

test('PUT /v1/ucet/hra/<hra> nad 64 kB vrati 413 payload_too_large a nic sa neulozi', async () => {
  const env = makeEnv();
  const { token } = await prihlas(env, 'hrac@firma.sk');
  const velkyStav = { data: 'x'.repeat(HRA_MAX_BYTES + 100) };
  const res = await worker.fetch(req('/v1/ucet/hra/hedgehogs', { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: velkyStav }), env, {});
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'payload_too_large');

  const get = await worker.fetch(req('/v1/ucet/hra/hedgehogs', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.deepEqual(await get.json(), {});
});

test('PUT /v1/ucet/hra/<hra> s telom, ktore nie je JSON objekt (pole, cislo), vrati 400 bad_json', async () => {
  const env = makeEnv();
  const { token } = await prihlas(env, 'hrac@firma.sk');
  for (const zleTelo of ['[1,2,3]', '42', '"retazec"']) {
    const res = await worker.fetch(req('/v1/ucet/hra/hedgehogs', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: zleTelo,
    }), env, {});
    assert.equal(res.status, 400, zleTelo);
    assert.equal((await res.json()).error, 'bad_json', zleTelo);
  }
});

test('GET/PUT /v1/ucet/hra/<hra> so zlym tvarom nazvu hry vrati 400 bad_hra', async () => {
  const env = makeEnv();
  const { token } = await prihlas(env, 'hrac@firma.sk');
  const res = await worker.fetch(req('/v1/ucet/hra/Nie_Platny_Nazov!', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_hra' });
});

// ---------------------------------------------------------------------------
// admin nakup bez tokenu 401
// ---------------------------------------------------------------------------

test('PUT /v1/ucet/nakup bez X-Admin-Token (alebo so zlym) vrati 401 unauthorized', async () => {
  const env = makeEnv();
  const bezHlavicky = await worker.fetch(req('/v1/ucet/nakup', {
    method: 'PUT',
    body: { email: 'a@b.sk', produkt: 'GDPR balik', session_id: 'cs_live_x', suma: 4900, mena: 'eur', livemode: true, datum: '2026-09-10T10:00:00.000Z' },
  }), env, {});
  assert.equal(bezHlavicky.status, 401);
  assert.deepEqual(await bezHlavicky.json(), { error: 'unauthorized' });

  const zlyToken = await worker.fetch(req('/v1/ucet/nakup', {
    method: 'PUT',
    headers: { 'X-Admin-Token': 'nespravny' },
    body: { email: 'a@b.sk', session_id: 'cs_live_x' },
  }), env, {});
  assert.equal(zlyToken.status, 401);
});

test('PUT /v1/ucet/nakup so spravnym X-Admin-Token vytvori ucet (ak nejestvuje) a zapise nakup idempotentne', async () => {
  const env = makeEnv();
  const email = 'novy-zakaznik@firma.sk';
  const telo = {
    email, produkt: 'GDPR balik SK', session_id: 'cs_live_admin123456789',
    suma: 4900, mena: 'eur', livemode: true, datum: '2026-09-10T10:00:00.000Z',
  };
  const prve = await worker.fetch(req('/v1/ucet/nakup', { method: 'PUT', headers: { 'X-Admin-Token': ADMIN }, body: telo }), env, {});
  assert.equal(prve.status, 200);
  assert.deepEqual(await prve.json(), { ok: true });

  const druhe = await worker.fetch(req('/v1/ucet/nakup', { method: 'PUT', headers: { 'X-Admin-Token': ADMIN }, body: telo }), env, {});
  assert.equal(druhe.status, 200);

  const ucet = await env.ASISTENT_CACHE.get(`ucet:ucet:${email}`, 'json');
  assert.equal(ucet.nakupy.length, 1);
  assert.equal(ucet.nakupy[0].produkt, 'GDPR balik SK');
  assert.equal(ucet.nakupy[0].session_id, 'cs_live_admin123456789');
});

// ---------------------------------------------------------------------------
// zabudnite ma (DELETE /v1/ucet/ja)
// ---------------------------------------------------------------------------

test('DELETE /v1/ucet/ja zmaze stavy hier, zneplatni token a ponecha nakupy (uctovnictvo)', async () => {
  const env = makeEnv({ stripeList: [stripeSession('cs_live_ponechany')] });
  const email = 'hrac@firma.sk';
  const { token } = await prihlas(env, email);

  await worker.fetch(req('/v1/ucet/hra/hedgehogs', { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: { t: 1 } }), env, {});
  assert.notEqual(await env.ASISTENT_CACHE.get(`ucet:hra:hedgehogs:${email}`), null);

  const del = await worker.fetch(req('/v1/ucet/ja', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });

  assert.equal(await env.ASISTENT_CACHE.get(`ucet:hra:hedgehogs:${email}`), null, 'stav hry je zmazany');

  const ucet = await env.ASISTENT_CACHE.get(`ucet:ucet:${email}`, 'json');
  assert.equal(ucet.zmazane, true);
  assert.equal(ucet.nakupy.length, 1, 'nakup ostava kvoli uctovnictvu');

  const poZmazani = await worker.fetch(req('/v1/ucet/ja', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(poZmazani.status, 401, 'povodny token uz nefunguje (verzia sa zvysila)');
});

// ---------------------------------------------------------------------------
// CORS na cudzi Origin
// ---------------------------------------------------------------------------

test('OPTIONS preflight na /v1/ucet/* povoli len ALLOWED_ORIGINS a nesie Authorization aj X-Admin-Token v Allow-Headers', async () => {
  const env = makeEnv();
  const povoleny = await worker.fetch(new Request(`${API}/v1/ucet/kod`, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, {});
  assert.equal(povoleny.status, 204);
  assert.equal(povoleny.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(povoleny.headers.get('Access-Control-Allow-Headers') || '', /Authorization/);
  assert.match(povoleny.headers.get('Access-Control-Allow-Headers') || '', /X-Admin-Token/);

  const cudzi = await worker.fetch(new Request(`${API}/v1/ucet/kod`, { method: 'OPTIONS', headers: { Origin: 'https://utocnik.example' } }), env, {});
  assert.equal(cudzi.status, 403);
  assert.equal(cudzi.headers.get('Access-Control-Allow-Origin'), null);
});

test('POST /v1/ucet/kod z cudzieho Originu nedostane Access-Control-Allow-Origin (aj ked samotna odpoved prejde)', async () => {
  const env = makeEnv();
  const res = await worker.fetch(req('/v1/ucet/kod', { method: 'POST', origin: 'https://utocnik.example', body: { email: 'a@b.sk' } }), env, {});
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('GET /v1/ucet/ja z povoleneho Originu nesie Access-Control-Allow-Origin presne pre ten Origin', async () => {
  const env = makeEnv();
  const { token } = await prihlas(env, 'zakaznik@firma.sk');
  const res = await worker.fetch(req('/v1/ucet/ja', { origin: ORIGIN, headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});
