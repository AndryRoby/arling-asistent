// ochrana-krok1.test.mjs
//
// Krok 1 plánu ops/asistent/genialny-plan.md (4.2): ochrana a presné
// počítanie. Každý test zo zoznamu kroku má tu svoj test, plus limity IP,
// výstrahy pre Fable a súkromie počítadiel. Všetko offline s mockami.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../worker/src/index.js';
import { createTenant, setTenantStatus, setTenantPlan, ensureNakladyColumns, dayKey, SQL } from '../worker/src/tenants.js';
import { vydajRelaciu, overRelaciu, MAX_OTAZOK_NA_ROZHOVOR, RELACIA_PLATNOST_S } from '../worker/src/relacia.js';
import {
  spocitajNaklady,
  tokenyOdpovede,
  neuronyZaTokeny,
  odhadTokenov,
  rozhodniRezim,
  budgetLimit,
  DENNY_STROP_OTAZOK,
  NEURONY_ZA_MILION,
  vektorMili,
} from '../worker/src/budget.js';
import { DENNY_LIMIT_IP_ROZHOVORY, DENNY_LIMIT_IP_OTAZKY } from '../worker/src/security.js';
import { pingOchrana, zaznamenajChybuAI, AI_VYPADOK_PRAH_ZA_HODINU } from '../worker/src/notify.js';
import { pripocitaj, kluce, POCTY_SQL } from '../worker/src/pocty.js';
import { CHAT_MODEL_DEFAULT } from '../worker/src/chat.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAJOMSTVO = 'dGVzdG92YWNpZS10YWpvbXN0dm8tcHJlLXJlbGFjaWU=';
const ADMIN = 'nas-admin-token';
const EMBED = '@cf/baai/bge-m3';
const ODPOVED = JSON.stringify({ answer: 'Mame kavovar Orava za 89.90 EUR.', products: [] });

function makeEnv(extra = {}) {
  const outbound = [];
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: ODPOVED }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: ADMIN,
    UCET_TAJOMSTVO: TAJOMSTVO,
    outbound,
    fetchImpl: async (url, opts) => {
      outbound.push({ url: String(url), opts });
      return { ok: true, status: 200, text: async () => '' };
    },
    ...extra,
  };
}

async function readyTenant(env, domain = 'obchod.sk', plan = 'free') {
  const tenant = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/feed.xml`, contactEmail: `majitel@${domain}` });
  await setTenantStatus(env.DB, tenant.id, 'ready');
  if (plan !== 'free') await setTenantPlan(env.DB, tenant.id, { plan });
  await env.VECTORIZE.upsert([
    { id: `${tenant.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: tenant.id, productId: 'KAV-001', title: 'Kavovar Orava', url: `https://${domain}/kavovar`, price: 89.9, currency: 'EUR', availability: 'in_stock' } },
    { id: `${tenant.id}::p2::0`, values: [0, 1, 0, 0], metadata: { tenant: tenant.id, productId: 'KAV-002', title: 'Mlynek', url: `https://${domain}/mlynek`, price: 34.9, currency: 'EUR', availability: 'in_stock' } },
  ]);
  return tenant;
}

function chatReq(tenant, { message = 'Mate kavovar?', relacia, session, ip = '9.9.9.9', origin = `https://${tenant.domain}`, headers = {} } = {}) {
  const body = { tenant: tenant.id, messages: [{ role: 'user', content: message }], lang: 'sk' };
  if (relacia !== undefined) body.relacia = relacia;
  if (session !== undefined) body.session = session;
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers };
  if (origin) h.Origin = origin;
  return new Request('https://asistent.arling.sk/v1/chat', { method: 'POST', headers: h, body: JSON.stringify(body) });
}

function giftReq(tenant, { relacia, ip = '9.9.9.9', origin = `https://${tenant.domain}`, headers = {} } = {}) {
  const body = { tenant: tenant.id, recipient: 'mama', interests: 'kava', budget_min: 0, budget_max: 100, lang: 'sk' };
  if (relacia !== undefined) body.relacia = relacia;
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers };
  if (origin) h.Origin = origin;
  return new Request('https://asistent.arling.sk/v1/gift', { method: 'POST', headers: h, body: JSON.stringify(body) });
}

const used = (env, tenant) => env.DB._tenants.get(tenant.id).used_this_month;
const counter = (env, tenant) => env.DB._counters.get(`${tenant.id}::${dayKey(new Date())}`);
const chatModelCalls = (env) => env.AI.calls.filter((c) => c.model !== EMBED).length;

// Od opravy nálezov kroku 1 sa denný strop obchodu počíta v D1 asistent_pocty
// (kľúč ai:<obchod>:<deň>, rezervovaný pred modelom), nie z counters.otazky.
async function nastavDnesneOtazky(env, tenant, otazky) {
  const den = dayKey(new Date());
  await pripocitaj(env.DB, kluce.ai(tenant.id, den), den, otazky);
}

/** Nastaví dnešnú spoločnú spotrebu (neuróny) na presnú hodnotu. */
async function nastavSpotrebu(env, neurony) {
  const den = dayKey(new Date());
  await pripocitaj(env.DB, kluce.neurony(den), den, 0);
  env.DB._pocty.get(kluce.neurony(den)).hodnota = neurony * 1000;
}

// ---------------------------------------------------------------------------
// 1. Bez Origin 403, s ním 200
// ---------------------------------------------------------------------------

test('krok 1: /v1/chat bez hlavicky Origin 403 origin_required, s Origin obchodu 200', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const bez = await worker.fetch(chatReq(tenant, { origin: null }), env, {});
  assert.equal(bez.status, 403);
  assert.equal((await bez.json()).error, 'origin_required');
  assert.equal(env.AI.calls.length, 0, 'bez Origin sa nesmie volat ani vektor');
  assert.equal(used(env, tenant), 0);

  const s = await worker.fetch(chatReq(tenant), env, {});
  assert.equal(s.status, 200);
  assert.equal(used(env, tenant), 1);
});

test('krok 1: /v1/gift bez Origin 403, s Origin 200', async () => {
  const env = makeEnv({ AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ picks: [] }) }) });
  const tenant = await readyTenant(env, 'darceky.sk');
  const bez = await worker.fetch(giftReq(tenant, { origin: null }), env, {});
  assert.equal(bez.status, 403);
  assert.equal((await bez.json()).error, 'origin_required');
  const s = await worker.fetch(giftReq(tenant), env, {});
  assert.equal(s.status, 200);
});

test('krok 1: bez Origin prejde len nas test s tajomstvom X-Arling-Test (bez modelu)', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const res = await worker.fetch(chatReq(tenant, { origin: null, headers: { 'X-Arling-Test': ADMIN } }), env, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).meta.test, true);
  assert.equal(env.AI.calls.length, 0);
  const zle = await worker.fetch(chatReq(tenant, { origin: null, headers: { 'X-Arling-Test': 'hadam' } }), env, {});
  assert.equal(zle.status, 403);
});

// ---------------------------------------------------------------------------
// 2. Podpísaná relácia
// ---------------------------------------------------------------------------

test('krok 1: opakovana nepodpisana session sa pocita ako novy rozhovor; s tokenom z odpovede nie', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const a = await worker.fetch(chatReq(tenant, { session: 'a1b2c3d4e5f60718' }), env, {});
  const b = await worker.fetch(chatReq(tenant, { session: 'a1b2c3d4e5f60718' }), env, {});
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(used(env, tenant), 2, 'rovnake nepodpisane session uz nepokracuje rozhovor');

  const token = (await b.json()).relacia;
  assert.match(token, /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const c = await worker.fetch(chatReq(tenant, { session: 'a1b2c3d4e5f60718', relacia: token }), env, {});
  assert.equal(c.status, 200);
  assert.equal(used(env, tenant), 2, 'podpisany token pokracuje rozhovor');
  const dalsi = (await c.json()).relacia;
  const over = await overRelaciu(env, tenant.id, dalsi);
  assert.equal(over.stav, 'platna');
  assert.equal(over.n, 2);
});

test('krok 1: podvrhnuty, cudzi alebo stary token je novy zapocitany rozhovor, nikdy chyba', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const iny = await readyTenant(env, 'iny-obchod.sk');
  const prvy = await worker.fetch(chatReq(tenant), env, {});
  const token = (await prvy.json()).relacia;
  assert.equal(used(env, tenant), 1);

  // Zmeneny pocet otazok v tele tokenu bez noveho podpisu.
  const [v, telo, podpis] = token.split('.');
  const data = JSON.parse(Buffer.from(telo, 'base64url').toString('utf8'));
  data.n = 0;
  const podvrh = `${v}.${Buffer.from(JSON.stringify(data)).toString('base64url')}.${podpis}`;
  const r1 = await worker.fetch(chatReq(tenant, { relacia: podvrh }), env, {});
  assert.equal(r1.status, 200);
  assert.equal(used(env, tenant), 2);

  // Nahodny retazec.
  const r2 = await worker.fetch(chatReq(tenant, { relacia: 'r1.abc.def' }), env, {});
  assert.equal(r2.status, 200);
  assert.equal(used(env, tenant), 3);

  // Platny token ineho obchodu.
  const cudzi = await vydajRelaciu(env, { tenantId: iny.id, n: 1 });
  const r3 = await worker.fetch(chatReq(tenant, { relacia: cudzi }), env, {});
  assert.equal(r3.status, 200);
  assert.equal(used(env, tenant), 4);

  // Token starsi ako 24 hodin.
  const stary = await vydajRelaciu(env, { tenantId: tenant.id, n: 1, zaciatok: Math.floor(Date.now() / 1000) - RELACIA_PLATNOST_S - 10 });
  const r4 = await worker.fetch(chatReq(tenant, { relacia: stary }), env, {});
  assert.equal(r4.status, 200);
  assert.equal(used(env, tenant), 5);

  // Token podpisany inym tajomstvom.
  const inyKluc = await vydajRelaciu({ UCET_TAJOMSTVO: 'uplne-ine' }, { tenantId: tenant.id, n: 1 });
  // Iná IP: z 9.9.9.9 už je 5 nových rozhovorov, šiesty by zastavil denný limit IP.
  const r5 = await worker.fetch(chatReq(tenant, { relacia: inyKluc, ip: '9.9.9.10' }), env, {});
  assert.equal(r5.status, 200);
  assert.equal(used(env, tenant), 6);
});

test('krok 1: relacia.js vydaj a over: platna, plna, cudzia, stara, neplatna, ziadna, vypnuta', async () => {
  const env = { UCET_TAJOMSTVO: TAJOMSTVO };
  const t = await vydajRelaciu(env, { tenantId: 'obchod-1', n: 3 });
  assert.deepEqual((await overRelaciu(env, 'obchod-1', t)).stav, 'platna');
  assert.equal((await overRelaciu(env, 'obchod-2', t)).stav, 'cudzia');
  const plna = await vydajRelaciu(env, { tenantId: 'obchod-1', n: MAX_OTAZOK_NA_ROZHOVOR });
  assert.equal((await overRelaciu(env, 'obchod-1', plna)).stav, 'plna');
  const buduca = await vydajRelaciu(env, { tenantId: 'obchod-1', n: 1, zaciatok: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal((await overRelaciu(env, 'obchod-1', buduca)).stav, 'stara');
  assert.equal((await overRelaciu(env, 'obchod-1', t.slice(0, -2) + 'xx')).stav, 'neplatna');
  assert.equal((await overRelaciu(env, 'obchod-1', { nie: 'retazec' })).stav, 'neplatna');
  assert.equal((await overRelaciu(env, 'obchod-1', 'x'.repeat(700))).stav, 'neplatna');
  assert.equal((await overRelaciu(env, 'obchod-1', '')).stav, 'ziadna');
  assert.equal((await overRelaciu({}, 'obchod-1', t)).stav, 'vypnuta');
  assert.equal(await vydajRelaciu({}, { tenantId: 'obchod-1' }), null);
  // Token nenesie nic o navstevnikovi: len obchod, nahodne id, cas a pocet.
  const data = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['c', 'i', 'n', 't']);
});

test('krok 1: 11. otazka zacne novy zapocitany rozhovor, bez chyby', async () => {
  const env = makeEnv();
  // Platený obchod: bezplatný má na jednu sieť IP len 10 otázok s modelom za deň.
  const tenant = await readyTenant(env, 'obchod.sk', 'starter');
  let token;
  for (let i = 1; i <= MAX_OTAZOK_NA_ROZHOVOR; i++) {
    const res = await worker.fetch(chatReq(tenant, { message: `Otazka ${i}`, relacia: token }), env, {});
    assert.equal(res.status, 200, `otazka ${i}`);
    token = (await res.json()).relacia;
  }
  assert.equal(used(env, tenant), 1, '10 otazok je jeden rozhovor');
  assert.equal((await overRelaciu(env, tenant.id, token)).stav, 'plna');

  const jedenasta = await worker.fetch(chatReq(tenant, { message: 'Otazka 11', relacia: token }), env, {});
  assert.equal(jedenasta.status, 200);
  const telo = await jedenasta.json();
  assert.equal(typeof telo.answer, 'string');
  assert.equal(used(env, tenant), 2, '11. otazka je novy rozhovor');
  const novy = await overRelaciu(env, tenant.id, telo.relacia);
  assert.equal(novy.stav, 'platna');
  assert.equal(novy.n, 1);
  assert.equal(counter(env, tenant).conversations, 2);
  assert.equal(counter(env, tenant).otazky, 11);
});

test('krok 1: chat a darcek v tej istej relacii su jeden rozhovor', async () => {
  const env = makeEnv({ AI: createMockAI({ embedDim: 4, chatResponse: (input) => (input.messages.some((m) => String(m.content).includes('<gift_request>')) ? JSON.stringify({ picks: [] }) : ODPOVED) }) });
  const tenant = await readyTenant(env);
  const g = await worker.fetch(giftReq(tenant), env, {});
  assert.equal(g.status, 200);
  const token = (await g.json()).relacia;
  assert.ok(token);
  const c = await worker.fetch(chatReq(tenant, { relacia: token }), env, {});
  assert.equal(c.status, 200);
  assert.equal(used(env, tenant), 1);
  assert.equal(counter(env, tenant).otazky, 2);
});

// ---------------------------------------------------------------------------
// 3. Denný strop na obchod a spoločný strop
// ---------------------------------------------------------------------------

test('krok 1: denny strop free 60 otazok zastavi model pre free, Pro ide dalej s modelom', async () => {
  const env = makeEnv();
  const free = await readyTenant(env, 'free-obchod.sk');
  const pro = await readyTenant(env, 'pro-obchod.sk', 'pro');
  assert.equal(DENNY_STROP_OTAZOK.free, 60);
  await nastavDnesneOtazky(env, free, 60);
  await nastavDnesneOtazky(env, pro, 60);

  const f = await worker.fetch(chatReq(free, { ip: '1.1.1.1' }), env, {});
  assert.equal(f.status, 200);
  const fb = await f.json();
  assert.equal(fb.meta.bezAi, true);
  assert.equal(chatModelCalls(env), 0, 'free nad dennym stropom nevola model');
  assert.ok(fb.products.length >= 1 && fb.products.length <= 3, 'odpoved bez AI ukaze produkty z vyhladavania');
  assert.equal(fb.answer, 'Tieto produkty najlepšie zodpovedajú vašej otázke.');
  assert.equal(counter(env, free).bez_ai, 1);

  const p = await worker.fetch(chatReq(pro, { ip: '2.2.2.2' }), env, {});
  assert.equal(p.status, 200);
  assert.equal((await p.json()).meta.bezAi, undefined);
  assert.equal(chatModelCalls(env), 1, 'Pro pod svojim stropom 1200 odpoveda modelom');
});

test('krok 1: pri 80 % spolocneho stropu free dostane odpoved bez AI, Pro s AI; pri 100 % oba bez AI; pri 150 % 503', async () => {
  // Strop 10 000 (predtým 1 000): pred modelom sa od pokusu 2 brány ukážok
  // oslovení (28. 9.) rezervuje horná hranica volania (asi 250 neurónov), do
  // zvyšných 200 z 1 000 by sa Pro nezmestil. Hranice 80, 100 a 150 % ostávajú.
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '10000' });
  const free = await readyTenant(env, 'free80.sk');
  const pro = await readyTenant(env, 'pro80.sk', 'pro');
  await nastavSpotrebu(env, 8000);

  const f = await worker.fetch(chatReq(free, { ip: '1.1.1.1' }), env, {});
  assert.equal(f.status, 200);
  assert.equal((await f.json()).meta.bezAi, true);
  assert.equal(chatModelCalls(env), 0);

  const p = await worker.fetch(chatReq(pro, { ip: '2.2.2.2' }), env, {});
  assert.equal(p.status, 200);
  assert.equal((await p.json()).meta.bezAi, undefined);
  assert.equal(chatModelCalls(env), 1);

  // Oprava nálezu B1: pri 100 % nie 503 pre všetkých, ale odpoveď bez modelu.
  await nastavSpotrebu(env, 9999);
  const plnyFree = await worker.fetch(chatReq(free, { ip: '3.3.3.3' }), env, {});
  const plnyPro = await worker.fetch(chatReq(pro, { ip: '4.4.4.4' }), env, {});
  assert.equal(plnyFree.status, 200);
  assert.equal(plnyPro.status, 200);
  assert.equal((await plnyPro.json()).meta.bezAi, true);
  assert.equal(chatModelCalls(env), 1);

  await nastavSpotrebu(env, 15000);
  const stop = await worker.fetch(chatReq(pro, { ip: '5.5.5.5' }), env, {});
  assert.equal(stop.status, 503);
  assert.equal((await stop.json()).error, 'quota_exceeded');
});

test('krok 1: rozhodniRezim priamo: stop (150 %), spolocny_strop, stisenie, ai', async () => {
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '1000' });
  const free = await readyTenant(env, 'rezim.sk');
  assert.equal(budgetLimit(env), 1000);
  assert.equal((await rozhodniRezim(env, { ...free })).rezim, 'ai');
  await nastavSpotrebu(env, 790);
  assert.equal((await rozhodniRezim(env, { ...free })).rezim, 'ai');
  await nastavSpotrebu(env, 800);
  assert.equal((await rozhodniRezim(env, { ...free })).dovod, 'stisenie');
  assert.equal((await rozhodniRezim(env, { ...free, plan: 'starter' })).rezim, 'ai');
  assert.equal((await rozhodniRezim(env, { ...free, plan: 'starter' }, { ukazka: true })).dovod, 'stisenie', 'ukazka sa stisi ako free');
  await nastavSpotrebu(env, 900);
  assert.deepEqual([(await rozhodniRezim(env, { ...free, plan: 'pro' })).rezim, (await rozhodniRezim(env, { ...free, plan: 'pro' })).dovod], ['bez_ai', 'spolocny_strop']);
  await nastavSpotrebu(env, 1500);
  assert.equal((await rozhodniRezim(env, { ...free, plan: 'pro' })).rezim, 'stop');
});

test('krok 1: gift pri dennom strope free odpovie bez modelu vyberom z dat', async () => {
  const env = makeEnv({ AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ picks: [] }) }) });
  const tenant = await readyTenant(env, 'darcek-strop.sk');
  await nastavDnesneOtazky(env, tenant, 60);
  const res = await worker.fetch(giftReq(tenant), env, {});
  assert.equal(res.status, 200);
  const telo = await res.json();
  assert.equal(telo.meta.bezAi, true);
  assert.ok(telo.picks.length >= 1);
  assert.equal(chatModelCalls(env), 0);
});

// ---------------------------------------------------------------------------
// 4. Kvóta až po úspešnej odpovedi
// ---------------------------------------------------------------------------

test('krok 1: chyba modelu kvotu neodrata a pocita sa do ai_vypadok', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const embedAI = createMockAI({ embedDim: 4 });
  env.AI = {
    calls: [],
    async run(model, input) {
      if (model === EMBED) return embedAI.run(model, input);
      throw new Error('3040: Capacity temporarily exceeded, please try again.');
    },
  };
  const res = await worker.fetch(chatReq(tenant), env, {});
  assert.equal(res.status, 500);
  assert.equal(used(env, tenant), 0, 'rozhovor sa nezapocital');
  const c = counter(env, tenant);
  assert.ok(!c || (c.conversations === 0 && !c.otazky), 'ziadna otazka ani rozhovor v counters');
  const hodina = new Date().toISOString().slice(0, 13);
  assert.equal(env.DB._pocty.get(kluce.aiChyby(hodina)).hodnota, 1, 'pocitadlo chyb je v D1');
  // Všetky rezervácie sa vrátili (kvóta, stropy, denné limity IP) okrem ceny vektora otázky, ktorý
  // pred chybou modelu naozaj bežal: tá ostane v počítadlách neurónov (krok 1 asistenta 28. 9., W1;
  // predtým tento test žiadal vrátenie aj vykonaného vektora, čo bola práve chyba W1).
  const den = dayKey(new Date());
  const neuronove = new Set([kluce.neurony(den), kluce.neuronyFree(den), kluce.mili(tenant.id, den)]);
  const vektor = vektorMili(['Mate kavovar?']);
  for (const [k, v] of env.DB._pocty) {
    if (k.startsWith('aichyby:')) continue;
    assert.equal(v.hodnota, neuronove.has(k) ? vektor : 0, `vratene ${k}`);
  }
});

test('krok 1: gift pri chybe modelu kvotu neodrata', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env, 'gift-chyba.sk');
  const embedAI = createMockAI({ embedDim: 4 });
  env.AI = {
    async run(model, input) {
      if (model === EMBED) return embedAI.run(model, input);
      throw new Error('3007: model error');
    },
  };
  const res = await worker.fetch(giftReq(tenant), env, {});
  assert.equal(res.status, 500);
  assert.equal(used(env, tenant), 0);
});

// ---------------------------------------------------------------------------
// 5. Neuróny a D1 counters
// ---------------------------------------------------------------------------

test('krok 1: neurony z poľa usage, ak je, inak z dlzky textu', () => {
  const s = tokenyOdpovede({ response: 'x', usage: { prompt_tokens: 1000, completion_tokens: 100 } }, 'a'.repeat(35), 'b'.repeat(7));
  assert.deepEqual(s, { vstup: 1000, vystup: 100, odhad: false });
  const bez = tokenyOdpovede({ response: 'x' }, 'a'.repeat(35), 'b'.repeat(7));
  assert.deepEqual(bez, { vstup: 10, vystup: 2, odhad: true });
  assert.equal(odhadTokenov(''), 0);
  assert.equal(odhadTokenov('abcd'), 2);
  const cena = NEURONY_ZA_MILION[CHAT_MODEL_DEFAULT];
  assert.equal(neuronyZaTokeny(CHAT_MODEL_DEFAULT, 1e6, 0), cena.vstup);
  assert.equal(neuronyZaTokeny(CHAT_MODEL_DEFAULT, 0, 1e6), cena.vystup);
  const n = spocitajNaklady({ volania: [{ model: CHAT_MODEL_DEFAULT, modelResponse: { usage: { prompt_tokens: 1000, completion_tokens: 100 } } }], vektory: ['kavovar'] });
  // 1000 * 26668 / 1e6 + 100 * 204805 / 1e6 + 2 * 1075 / 1e6 = 47.15065:
  // do prehľadu v counters zaokrúhlené 47, do stropov presne v tisícinách nahor 47 151.
  assert.deepEqual(n, { tokenyVstup: 1000, tokenyVystup: 100, neurony: 47, mili: 47151, odhad: false });
});

test('krok 1: D1 counters ma po otazkach spravne sucty (otazky, tokeny, neurony, bez_ai, rozhovory)', async () => {
  const env = makeEnv();
  env.AI = createMockAI({ embedDim: 4, chatResponse: () => ({ response: ODPOVED, usage: { prompt_tokens: 1000, completion_tokens: 100 } }) });
  const tenant = await readyTenant(env);
  const prvy = await worker.fetch(chatReq(tenant, { message: 'kavovar' }), env, {});
  const token = (await prvy.json()).relacia;
  await worker.fetch(chatReq(tenant, { message: 'kavovar', relacia: token }), env, {});
  const c = counter(env, tenant);
  assert.equal(c.conversations, 1);
  assert.equal(c.otazky, 2);
  assert.equal(c.tokeny_vstup, 2000);
  assert.equal(c.tokeny_vystup, 200);
  assert.equal(c.neurony, 94, '2 x 47 neuronov (model z usage + vektor otazky)');
  assert.equal(c.bez_ai, 0);
  // Stropy v D1 asistent_pocty sú po doúčtovaní presné v tisícinách.
  const den = dayKey(new Date());
  assert.equal(env.DB._pocty.get(kluce.neurony(den)).hodnota, 2 * 47151);
  assert.equal(env.DB._pocty.get(kluce.mili(tenant.id, den)).hodnota, 2 * 47151);
  assert.equal(env.DB._pocty.get(kluce.ai(tenant.id, den)).hodnota, 2);
});

test('krok 1: bez pola usage sa tokeny odhadnu z dlzky promptu a odpovede', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  await worker.fetch(chatReq(tenant), env, {});
  const c = counter(env, tenant);
  const volanie = env.AI.calls.find((x) => x.model !== EMBED);
  const vstup = volanie.input.messages.map((m) => m.content).join('');
  assert.equal(c.tokeny_vstup, Math.ceil(vstup.length / 3.5));
  assert.equal(c.tokeny_vystup, Math.ceil(ODPOVED.length / 3.5));
  assert.ok(c.neurony > 0);
});

test('krok 1: spolocna spotreba sa berie z D1 asistent_pocty (nie z horuceho KV kluca) a chat uz nepise neurons: do KV', async () => {
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '1000' });
  const tenant = await readyTenant(env, 'obchod.sk', 'pro');
  await nastavSpotrebu(env, 900);
  const res = await worker.fetch(chatReq(tenant), env, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).meta.bezAi, true, '900 v D1 + odhad 150 je nad stropom 1000: odpoved bez modelu');
  assert.equal(chatModelCalls(env), 0);
  const env2 = makeEnv();
  const t2 = await readyTenant(env2);
  await worker.fetch(chatReq(t2), env2, {});
  assert.equal(env2.ASISTENT_CACHE._puts.some((p) => p.key.startsWith('neurons:')), false);
});

test('krok 1: counters ani KV nenesu text otazky, IP ani id relacie (uroven A)', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const otazka = 'Hladam specialny cajnik pre babku Evu';
  const res = await worker.fetch(chatReq(tenant, { message: otazka, ip: '203.0.113.77' }), env, {});
  const token = (await res.json()).relacia;
  const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).i;
  const c = counter(env, tenant);
  const povolene = ['bez_ai', 'conversations', 'day', 'neurony', 'otazky', 'product_clicks', 'tenant_id', 'tokeny_vstup', 'tokeny_vystup', 'web_conversations'];
  for (const k of Object.keys(c)) assert.ok(povolene.includes(k), `neznamy stlpec counters ${k}`);
  const d1 = JSON.stringify([...env.DB._counters.values(), ...env.DB._tenants.values(), ...env.DB._udalosti, ...env.DB._pocty.values()]);
  for (const zakazane of ['cajnik', 'babku', '203.0.113.77', '203.0.113', id]) {
    assert.equal(d1.includes(zakazane), false, `v D1 je ${zakazane}`);
  }
  // Limity IP v D1 nesú len číslo koša 0 až 65 535.
  for (const k of env.DB._pocty.keys()) {
    if (/^ip[qra]:/.test(k)) assert.match(k, /:\d{1,5}$/, k);
  }
  // KV: text otázky, IP (ani v minútovom limite) ani id relácie nikde.
  const kv = JSON.stringify([...env.ASISTENT_CACHE._store.entries()]);
  for (const zakazane of ['cajnik', 'babku', '203.0.113.77', '203.0.113', id]) {
    assert.equal(kv.includes(zakazane), false, `v KV je ${zakazane}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Denný limit IP a obchod
// ---------------------------------------------------------------------------

test('krok 1: denny limit IP a obchod: 6. novy rozhovor z tej istej IP dostane odpoved bez modelu a nezapocita sa, ina IP ide', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  for (let i = 0; i < DENNY_LIMIT_IP_ROZHOVORY; i++) {
    assert.equal((await worker.fetch(chatReq(tenant, { ip: '7.7.7.7' }), env, {})).status, 200);
  }
  // Oprava nálezov: nad limitom nie 429 (zákazník za zdieľanou IP by nemal
  // nič), ale odpoveď bez modelu, ktorá sa do mesačnej kvóty nezapočíta.
  const siesty = await worker.fetch(chatReq(tenant, { ip: '7.7.7.7' }), env, {});
  assert.equal(siesty.status, 200);
  const telo = await siesty.json();
  assert.equal(telo.meta.bezAi, true);
  assert.equal(telo.relacia, undefined, 'nezapocitany rozhovor nedostane token');
  assert.equal(used(env, tenant), DENNY_LIMIT_IP_ROZHOVORY);
  assert.equal(chatModelCalls(env), DENNY_LIMIT_IP_ROZHOVORY);
  const ina = await worker.fetch(chatReq(tenant, { ip: '8.8.8.8' }), env, {});
  assert.equal(ina.status, 200);
  assert.equal((await ina.json()).meta.bezAi, undefined);
  assert.equal(used(env, tenant), DENNY_LIMIT_IP_ROZHOVORY + 1);
});

test('krok 1: nase meranie s X-Arling-Meranie (vlastne tajomstvo MERANIE_TOKEN) obide len denne limity IP', async () => {
  const env = makeEnv({ MERANIE_TOKEN: 'meranie-tajne' });
  const tenant = await readyTenant(env);
  const pocet = DENNY_LIMIT_IP_ROZHOVORY + 3;
  for (let i = 0; i < pocet; i++) {
    const res = await worker.fetch(chatReq(tenant, { ip: '7.7.7.7', headers: { 'X-Arling-Meranie': 'meranie-tajne' } }), env, {});
    assert.equal(res.status, 200, `otazka ${i + 1}`);
    assert.equal((await res.json()).meta.bezAi, undefined);
  }
  // Od 28. 9. 2026 náš interný beh nemíňa mesačnú kvótu obchodu (inak príprava
  // ukážky vyčerpala kvótu osloveného obchodu a ukážka hlásila „oddychuje“).
  assert.equal(used(env, tenant), 0);
  assert.equal(chatModelCalls(env), pocet);
  assert.equal(counter(env, tenant).otazky, pocet);
  // ADMIN_TOKEN (smie meniť plány) meranie neotvorí, ani zlé tajomstvo.
  for (const zle of [ADMIN, 'hadam']) {
    for (let i = 0; i < DENNY_LIMIT_IP_ROZHOVORY; i++) await worker.fetch(chatReq(tenant, { ip: '7.7.7.8', headers: { 'X-Arling-Meranie': zle } }), env, {});
  }
  const nad = await worker.fetch(chatReq(tenant, { ip: '7.7.7.8', headers: { 'X-Arling-Meranie': ADMIN } }), env, {});
  assert.equal((await nad.json()).meta.bezAi, true, 'nad 5 rozhovormi z 7.7.7.8 bez modelu');
  // Bez Origin nepomôže ani meranie.
  const bezOrigin = await worker.fetch(chatReq(tenant, { origin: null, headers: { 'X-Arling-Meranie': 'meranie-tajne' } }), env, {});
  assert.equal(bezOrigin.status, 403);
});

test('krok 1: denny limit IP: 60 otazok za den na obchod (s modelom aj bez), 61. je 429; iny obchod ide', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  const iny = await readyTenant(env, 'iny.sk');
  let token;
  for (let i = 0; i < DENNY_LIMIT_IP_OTAZKY; i++) {
    for (const k of [...env.ASISTENT_CACHE._store.keys()]) if (k.startsWith('ratelimit:')) env.ASISTENT_CACHE._store.delete(k);
    const res = await worker.fetch(chatReq(tenant, { ip: '1.2.3.4', relacia: token }), env, {});
    assert.equal(res.status, 200, `otazka ${i + 1}`);
    const b = await res.json();
    if (b.relacia) token = b.relacia;
  }
  const nad = await worker.fetch(chatReq(tenant, { ip: '1.2.3.4', relacia: token }), env, {});
  assert.equal(nad.status, 429);
  assert.equal((await nad.json()).error, 'rate_limited');
  assert.equal((await worker.fetch(chatReq(iny, { ip: '1.2.3.4' }), env, {})).status, 200, 'iny obchod ma vlastny limit');
});

// ---------------------------------------------------------------------------
// 7. Výstrahy pre Fable (ntfy)
// ---------------------------------------------------------------------------

// Em dash a en dash, zapísané kódom, aby tento súbor sám žiadnu nemal.
const POMLCKY = new RegExp('[\\u2013\\u2014]');

const pingy = (env, e) => env.outbound.filter((o) => o.url.includes(`e=${e}&`));

test('krok 1: vystrahy ochrany sa neposielaju, kym je ASISTENT_NTFY_OCHRANA vypnute', async () => {
  const env = makeEnv();
  const tenant = await readyTenant(env);
  for (let i = 0; i < DENNY_LIMIT_IP_ROZHOVORY + 1; i++) await worker.fetch(chatReq(tenant, { ip: '7.7.7.7' }), env, {});
  assert.equal(pingy(env, 'zneuzitie').length, 0);
  assert.equal(await pingOchrana(env, { event: 'naklady_den', percent: 90, kluc: 'x' }), false);
});

test('krok 1: zneuzitie pri limite IP, raz za den a obchod', async () => {
  const env = makeEnv({ ASISTENT_NTFY_OCHRANA: 'zapnute' });
  const tenant = await readyTenant(env);
  for (let i = 0; i < DENNY_LIMIT_IP_ROZHOVORY + 3; i++) await worker.fetch(chatReq(tenant, { ip: '7.7.7.7' }), env, {});
  const z = pingy(env, 'zneuzitie');
  assert.equal(z.length, 1);
  assert.equal(z[0].url, `https://server.invalid/subscribe/api/ping?e=zneuzitie&t=${tenant.id}&p=0`);
});

test('krok 1: naklady_den pri 80 % stropu a obchod_marza pre platiaci obchod nad 50 % denneho prijmu', async () => {
  const env = makeEnv({ ASISTENT_NTFY_OCHRANA: 'zapnute', AI_DAILY_NEURON_BUDGET: '100000' });
  env.AI = createMockAI({ embedDim: 4, chatResponse: () => ({ response: ODPOVED, usage: { prompt_tokens: 1000, completion_tokens: 100 } }) });
  const tenant = await readyTenant(env, 'starter.sk', 'starter');
  await ensureNakladyColumns(env.DB);
  const den = dayKey(new Date());
  // Starter: 13.81 EUR / 30 = 0.46 EUR denne; 50 % je asi 0.23 USD, teda asi 20 900 neuronov.
  env.DB._counters.set(`${tenant.id}::${den}`, { tenant_id: tenant.id, day: den, conversations: 1, product_clicks: 0, otazky: 1, tokeny_vstup: 0, tokeny_vystup: 0, neurony: 25000, bez_ai: 0 });
  await pripocitaj(env.DB, kluce.mili(tenant.id, den), den, 25000 * 1000);
  const res = await worker.fetch(chatReq(tenant), env, {});
  assert.equal(res.status, 200);
  assert.equal(pingy(env, 'obchod_marza').length, 1);
  assert.match(pingy(env, 'obchod_marza')[0].url, new RegExp(`t=${tenant.id}&p=\\d+$`));
  assert.equal(pingy(env, 'naklady_den').length, 0, '25 048 neuronov je pod prahom 50 000');
  // Druha otazka v ten isty den: ziadna druha vystraha.
  await worker.fetch(chatReq(tenant, { ip: '5.5.5.5' }), env, {});
  assert.equal(pingy(env, 'obchod_marza').length, 1);
});

test('krok 1: naklady_den ide raz za den, ked spotreba prekroci mensi z prahov', async () => {
  const env = makeEnv({ ASISTENT_NTFY_OCHRANA: 'zapnute', AI_DAILY_NEURON_BUDGET: '20000' });
  const tenant = await readyTenant(env);
  await nastavSpotrebu(env, 16000);
  await worker.fetch(chatReq(tenant, { ip: '1.1.1.1' }), env, {});
  await worker.fetch(chatReq(tenant, { ip: '2.2.2.2' }), env, {});
  assert.equal(pingy(env, 'naklady_den').length, 1);
  assert.match(pingy(env, 'naklady_den')[0].url, /t=asistent&p=8\d/);
});

test('krok 1: ai_vypadok az pri 10. chybe modelu v hodine, raz', async () => {
  const env = makeEnv({ ASISTENT_NTFY_OCHRANA: 'zapnute' });
  for (let i = 1; i <= AI_VYPADOK_PRAH_ZA_HODINU + 2; i++) {
    assert.equal(await zaznamenajChybuAI(env), i);
    assert.equal(pingy(env, 'ai_vypadok').length, i >= AI_VYPADOK_PRAH_ZA_HODINU ? 1 : 0);
  }
});

// ---------------------------------------------------------------------------
// 8. Migrácia, wrangler.toml a texty
// ---------------------------------------------------------------------------

test('krok 1: migracia 0003 obsahuje presne ALTER vety z tenants.js a schema.sql ma nove stlpce', () => {
  const migracia = fs.readFileSync(path.join(__dirname, '../worker/migrations/0003_genialny.sql'), 'utf8');
  for (const sql of [SQL.ADD_COUNTER_OTAZKY, SQL.ADD_COUNTER_TOKENY_VSTUP, SQL.ADD_COUNTER_TOKENY_VYSTUP, SQL.ADD_COUNTER_NEURONY, SQL.ADD_COUNTER_BEZ_AI]) {
    assert.ok(migracia.includes(`${sql};`), sql);
  }
  const schema = fs.readFileSync(path.join(__dirname, '../worker/schema.sql'), 'utf8');
  for (const stlpec of ['otazky', 'tokeny_vstup', 'tokeny_vystup', 'neurony', 'bez_ai']) assert.match(schema, new RegExp(`${stlpec} INTEGER NOT NULL DEFAULT 0`));
  // Oprava nálezov: tabuľka atomických počítadiel, tá istá veta v migrácii, schéme aj v pocty.js.
  for (const sql of [POCTY_SQL.CREATE_POCTY, POCTY_SQL.CREATE_POCTY_INDEX]) {
    assert.ok(migracia.includes(`${sql};`), sql);
    assert.ok(schema.includes(`${sql};`), sql);
  }
  // CREATE vety sú pred prvým ALTER (ALTER vie skončiť chybou duplicate column).
  assert.ok(migracia.indexOf('\nCREATE TABLE IF NOT EXISTS asistent_pocty') < migracia.indexOf('\nALTER TABLE'));
});

test('krok 1: wrangler.toml ma strop 20000 skutocnych neuronov, rozpocet obnovy, max otazok a vystrahy ochrany vypnute', () => {
  const toml = fs.readFileSync(path.join(__dirname, '../worker/wrangler.toml'), 'utf8');
  assert.match(toml, /^AI_DAILY_NEURON_BUDGET = "20000"$/m);
  assert.match(toml, /^AI_DAILY_OBNOVA_BUDGET = "5000"$/m);
  // Kým Andrej neschváli 3.2 bod 1 a nezmenia sa verejné texty, sľub „however many questions“ platí.
  assert.match(toml, /^ASISTENT_MAX_OTAZOK = "1000"$/m);
  assert.match(toml, /^ASISTENT_NTFY_OCHRANA = "vypnute"$/m);
  assert.match(toml, /^ASISTENT_EMAILY = "vypnute"$/m);
});

test('krok 1: nove subory a odpovede bez AI nemaju pomlcky U+2014 ani U+2013', async () => {
  for (const subor of ['relacia.js', 'ochrana.js', 'budget.js', 'security.js', 'notify.js', 'chat.js', 'gift.js', 'tenants.js', 'pocty.js', 'cron.js', 'onboarding.js', 'embed.js']) {
    const text = fs.readFileSync(path.join(__dirname, '../worker/src', subor), 'utf8');
    assert.equal(POMLCKY.test(text), false, subor);
  }
  const migracia = fs.readFileSync(path.join(__dirname, '../worker/migrations/0003_genialny.sql'), 'utf8');
  assert.equal(POMLCKY.test(migracia), false);
  // Pevné vety odpovede bez AI (chat.js BEZ_AI_VETA) cez skutočnú odpoveď.
  const env = makeEnv();
  const tenant = await readyTenant(env, 'vety.sk');
  await nastavDnesneOtazky(env, tenant, 60);
  for (const [lang, otazka] of [['sk', 'kávovar'], ['cs', 'kávovar'], ['en', 'coffee'], ['de', 'Kaffee']]) {
    const req = new Request('https://asistent.arling.sk/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://vety.sk', 'CF-Connecting-IP': `6.6.6.${lang.length}${lang.charCodeAt(0)}` },
      body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: otazka }], lang }),
    });
    const telo = await (await worker.fetch(req, env, {})).json();
    assert.equal(telo.meta.bezAi, true, lang);
    assert.equal(POMLCKY.test(telo.answer), false, lang);
  }
});
