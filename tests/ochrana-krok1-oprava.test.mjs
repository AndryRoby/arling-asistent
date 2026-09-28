// ochrana-krok1-oprava.test.mjs
//
// Oprava nálezov kontroly kroku 1 (ops/asistent/stavba/krok1-ochrana.md,
// časť „Oprava nálezov kritikov“). Každý test menuje nález a scenár
// recenzenta (S1 až S11, sondy riziko1-sonda-1 až 5). Všetko offline s
// mockami; súbeh sa skúša s oneskoreným KV, D1 aj modelom, lebo mock bez
// oneskorenia súbeh nikdy neukáže.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../worker/src/index.js';
import { createTenant, setTenantStatus, setTenantPlan, dayKey, SQL } from '../worker/src/tenants.js';
import { overRelaciu, maxOtazok, MAX_OTAZOK_NA_ROZHOVOR } from '../worker/src/relacia.js';
import { budgetLimit, PODIEL_OBCHODU, MILI, obnovaZaZnaky, BEZ_AI_DENNY_STROP, REZIA_SABLONY_TOKENOV } from '../worker/src/budget.js';
import {
  normalizujIp,
  kosIp,
  MAX_MESSAGE_CHARS,
  MAX_DARCEK_POLE_CHARS,
  DENNY_LIMIT_IP_ROZHOVORY,
  DENNY_LIMIT_IP_AI,
  DENNY_LIMIT_IP_AI_SPOLU,
} from '../worker/src/security.js';
import { zaznamenajChybuAI } from '../worker/src/notify.js';
import { rezervuj, vrat, pripocitaj, citaj, zmazStare, kluce } from '../worker/src/pocty.js';
import { refreshAllFeeds } from '../worker/src/cron.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAJOMSTVO = 'dGVzdG92YWNpZS10YWpvbXN0dm8tcHJlLXJlbGFjaWU=';
const ADMIN = 'nas-admin-token';
const EMBED = '@cf/baai/bge-m3';
const ODPOVED = JSON.stringify({ answer: 'Mame kavovar Orava za 89.90 EUR.', products: [] });
const DEN = () => dayKey(new Date());

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
    AI_DAILY_NEURON_BUDGET: '20000',
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

function chatReq(tenant, { message = 'Mate kavovar?', relacia, ip = '9.9.9.9', origin = `https://${tenant.domain}`, headers = {} } = {}) {
  const body = { tenant: tenant.id, messages: [{ role: 'user', content: message }], lang: 'sk' };
  if (relacia !== undefined) body.relacia = relacia;
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers };
  if (origin) h.Origin = origin;
  return new Request('https://asistent.arling.sk/v1/chat', { method: 'POST', headers: h, body: JSON.stringify(body) });
}

function giftReq(tenant, { recipient = 'mama', interests = 'kava', ip = '9.9.9.9' } = {}) {
  const body = { tenant: tenant.id, recipient, interests, budget_min: 0, budget_max: 100, lang: 'sk' };
  return new Request('https://asistent.arling.sk/v1/gift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: `https://${tenant.domain}` },
    body: JSON.stringify(body),
  });
}

const used = (env, tenant) => env.DB._tenants.get(tenant.id).used_this_month;
const modelCalls = (env) => env.AI.calls.filter((c) => c.model !== EMBED).length;
const pocet = (env, kluc) => (env.DB._pocty.get(kluc) || { hodnota: 0 }).hodnota;
const spi = (ms) => new Promise((r) => setTimeout(r, ms));
const bezMinutovehoLimitu = (env) => {
  for (const k of [...env.ASISTENT_CACHE._store.keys()]) if (k.startsWith('ratelimit:')) env.ASISTENT_CACHE._store.delete(k);
};

/** KV s oneskorením ako skutočné Workers KV; voliteľne 1 zápis za sekundu na kľúč (inak 429). */
function pomaleKV({ getMs = 5, putMs = 20, limitZapisuNaKluc = false } = {}) {
  const base = createMockKV();
  const posledny = new Map();
  const kv = {
    _store: base._store,
    _puts: base._puts,
    chyby429: 0,
    async get(key, type) { await spi(getMs); return base.get(key, type); },
    async put(key, value, opts) {
      await spi(putMs);
      if (limitZapisuNaKluc) {
        const p = posledny.get(key);
        if (p != null && Date.now() - p < 1000) { kv.chyby429 += 1; throw new Error('KV PUT failed: 429 Too Many Requests'); }
        posledny.set(key, Date.now());
      }
      return base.put(key, value, opts);
    },
    async delete(key) { return base.delete(key); },
  };
  return kv;
}

/** D1 s oneskorením každej vety (sieť k primárnej databáze); každá veta ostáva atomická ako v D1. */
function pomalaD1(ms = 2) {
  const db = createMockD1();
  return new Proxy(db, {
    get(t, p) {
      if (p !== 'prepare') return t[p];
      return (sql) => {
        const obal = (st) => ({
          bind: (...a) => obal(st.bind(...a)),
          run: async () => { await spi(ms); return st.run(); },
          first: async () => { await spi(ms); return st.first(); },
          all: async () => { await spi(ms); return st.all(); },
        });
        return obal(t.prepare(sql));
      };
    },
  });
}

/** Model s oneskorením (skutočný odpovedá 2 až 5 s), aby sa požiadavky prekryli. */
function pomalyAI(ms = 30, chatResponse = ODPOVED) {
  const base = createMockAI({ embedDim: 4, chatResponse });
  return {
    calls: base.calls,
    async run(model, input) {
      if (model !== EMBED) await spi(ms);
      return base.run(model, input);
    },
  };
}

function ctxWaitUntil() {
  const cakajuce = [];
  return { waitUntil: (p) => cakajuce.push(p), passThroughOnException() {}, async dokonci() { while (cakajuce.length) await Promise.allSettled(cakajuce.splice(0)); } };
}

// ---------------------------------------------------------------------------
// pocty.js: atomická rezervácia
// ---------------------------------------------------------------------------

test('oprava: pocty.js rezervuj je atomicke aj pri subehu, vrat nejde pod nulu, zmazStare maze stare dni', async () => {
  const db = pomalaD1(1);
  const vysledky = await Promise.all(Array.from({ length: 50 }, () => rezervuj(db, 'x', '2026-09-25', 1, 7)));
  assert.equal(vysledky.filter((v) => v != null).length, 7, '50 subeznych, limit 7: presne 7 prejde');
  assert.equal(await citaj(db, 'x'), 7);
  assert.equal(await rezervuj(db, 'y', '2026-09-25', 5, 4), null, 'viac ako limit sa nezapise ani do prazdneho');
  await vrat(db, 'x', 100);
  assert.equal(await citaj(db, 'x'), 0);
  await pripocitaj(db, 'stary', '2026-09-20', 3);
  await pripocitaj(db, 'vcera', '2026-09-24', 3);
  await zmazStare(db, '2026-09-25');
  assert.equal(await citaj(db, 'stary'), 0);
  assert.equal(await citaj(db, 'vcera'), 3, 'vcerajsok ostava (UTC den v kazdej zone)');
});

// ---------------------------------------------------------------------------
// Nález B1 (S11): jedna IP cez viac obchodov nezhodí platiaci obchod
// ---------------------------------------------------------------------------

test('B1/S11: jedna IP cez 2 free obchody a ukazku (pro) neminie spolocny strop, platiaci obchod z inej IP dostane AI', async () => {
  // Skutočný náklad odpovede podľa NP:9 (asi 134 neurónov): usage 3000 vstup, 200 výstup.
  const ai = createMockAI({ embedDim: 4, chatResponse: () => ({ response: ODPOVED, usage: { prompt_tokens: 3000, completion_tokens: 200 } }) });
  const env = makeEnv({ AI: ai });
  const a = await readyTenant(env, 'free-a.sk');
  const b = await readyTenant(env, 'free-b.sk');
  const ukazka = await readyTenant(env, 'ukazka.arling.sk', 'pro');
  const obet = await readyTenant(env, 'platiaci.sk', 'pro');
  const IP = '66.66.66.66';
  let aiOdpovede = 0;
  for (const t of [a, b, ukazka]) {
    let token;
    for (let i = 0; i < 60; i++) {
      bezMinutovehoLimitu(env);
      const r = await worker.fetch(chatReq(t, { ip: IP, relacia: token, message: `q${i}` }), env, {});
      assert.ok([200, 429].includes(r.status), `stav ${r.status}`);
      if (r.status !== 200) continue;
      const body = await r.json();
      if (i === 0) token = body.relacia; // opakovanie prvého tokenu ako v S11
      if (!body.meta.bezAi) aiOdpovede += 1;
    }
  }
  assert.ok(aiOdpovede <= DENNY_LIMIT_IP_AI_SPOLU, `AI odpovedi z jednej IP ${aiOdpovede}, najviac ${DENNY_LIMIT_IP_AI_SPOLU}`);
  const spolu = pocet(env, kluce.neurony(DEN())) / MILI;
  assert.ok(spolu < 0.25 * budgetLimit(env), `jedna IP minula ${spolu} neuronov`);
  const r = await worker.fetch(chatReq(obet, { ip: '1.2.3.4' }), env, {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).meta.bezAi, undefined, 'platiaci obchod odpoveda modelom');
});

test('B1: ukazka (domena v ALLOWED_ORIGINS) sa pri 80 % stisi ako bezplatny obchod, hoci ma plan pro', async () => {
  // Strop 10 000 (predtým 1 000): pred modelom sa od pokusu 2 brány ukážok
  // oslovení (28. 9.) rezervuje horná hranica volania (asi 250 neurónov), do
  // zvyšných 200 z 1 000 by sa nezmestil ani platiaci. Pravidlo 80 % ostáva.
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '10000' });
  const ukazka = await readyTenant(env, 'ukazka.arling.sk', 'pro');
  const pro = await readyTenant(env, 'pro.sk', 'pro');
  await pripocitaj(env.DB, kluce.neurony(DEN()), DEN(), 8000 * MILI);
  const u = await worker.fetch(chatReq(ukazka, { ip: '1.1.1.1' }), env, {});
  assert.equal((await u.json()).meta.bezAi, true);
  const p = await worker.fetch(chatReq(pro, { ip: '2.2.2.2' }), env, {});
  assert.equal((await p.json()).meta.bezAi, undefined);
});

// ---------------------------------------------------------------------------
// Nález V1 (S1, S9): opakovanie podpísaného tokenu
// ---------------------------------------------------------------------------

test('V1/S1: ten isty token poslany znova je novy zapocitany rozhovor; opakovanie neobide mesacnu kvotu ani limity', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'replay.sk', 'starter');
  const prvy = await worker.fetch(chatReq(t), env, {});
  const token = (await prvy.json()).relacia;
  assert.equal((await overRelaciu(env, t.id, token)).n, 1);
  // Poctivé pokračovanie: ten istý rozhovor.
  const druhy = await worker.fetch(chatReq(t, { relacia: token }), env, {});
  assert.equal(used(env, t), 1);
  assert.equal((await overRelaciu(env, t.id, (await druhy.json()).relacia)).n, 2);
  // Opakovanie tokenu n=1 (server už vydal n=2): nový rozhovor, aj z inej IP.
  const opak = await worker.fetch(chatReq(t, { relacia: token, ip: '9.9.9.10' }), env, {});
  assert.equal(opak.status, 200);
  assert.equal(used(env, t), 2, 'opakovany token = novy zapocitany rozhovor');
  // S1: ďalších 13 opakovaní z jednej IP. Každé je nový rozhovor, takže ich
  // zastaví limit 5 nových rozhovorov na sieť; ďalej len odpovede bez modelu.
  for (let i = 0; i < 13; i++) {
    const r = await worker.fetch(chatReq(t, { relacia: token, message: `replay ${i}` }), env, {});
    assert.equal(r.status, 200);
  }
  assert.equal(used(env, t), 1 + DENNY_LIMIT_IP_ROZHOVORY, '9.9.9.9 zapocitala najviac 5 rozhovorov, 9.9.9.10 jeden');
  assert.equal(modelCalls(env), 2 + DENNY_LIMIT_IP_ROZHOVORY, 'model len pre zapocitane rozhovory a poctive pokracovanie');
});

test('V1/S9: subezne opakovanie tokenu n=9 z 5 IP: KV ho nezastavi, ale atomicky denny strop obchodu ano', async () => {
  const env = makeEnv({ ASISTENT_CACHE: pomaleKV(), DB: pomalaD1(), AI: pomalyAI(20) });
  const t = await readyTenant(env, 'n9.sk', 'starter');
  let token;
  for (let i = 1; i <= 9; i++) {
    const r = await worker.fetch(chatReq(t, { relacia: token, ip: `12.0.0.${i}` }), env, {});
    token = (await r.json()).relacia;
  }
  assert.equal((await overRelaciu(env, t.id, token)).n, 9);
  // Do denného stropu obchodu (starter 400) ostávajú 2 otázky s modelom.
  const ai = kluce.ai(t.id, DEN());
  env.DB._pocty.get(ai).hodnota = 398;
  const pred = modelCalls(env);
  const odp = await Promise.all([1, 2, 3, 4, 5].map((i) => worker.fetch(chatReq(t, { relacia: token, ip: `13.0.0.${i}` }), env, {})));
  const tela = await Promise.all(odp.map((r) => r.json()));
  assert.ok(odp.every((r) => r.status === 200));
  assert.equal(modelCalls(env) - pred, 2, 'nad stropom obchodu nič, ani pri súbehu');
  assert.equal(tela.filter((b) => b.meta.bezAi).length, 3);
  assert.equal(pocet(env, ai), 400);
});

// ---------------------------------------------------------------------------
// Nález 1 riziko (V2, S2, S3, S10b, sonda 1): súbeh
// ---------------------------------------------------------------------------

test('sonda 1/S10b: 120 subeznych poziadaviek z jednej IP s pomalym KV, D1 aj modelom: model najviac 10-krat, rozhovorov najviac 5', async () => {
  const env = makeEnv({ ASISTENT_CACHE: pomaleKV(), DB: pomalaD1(), AI: pomalyAI(30) });
  const t = await readyTenant(env, 'ludovka-test.sk');
  const ctx = ctxWaitUntil();
  const odp = await Promise.all(Array.from({ length: 120 }, (_, i) => worker.fetch(chatReq(t, { ip: '77.77.77.77', message: `davka ${i}` }), env, ctx)));
  await ctx.dokonci();
  const statusy = odp.map((r) => r.status);
  assert.ok(modelCalls(env) <= DENNY_LIMIT_IP_AI.free, `volani modelu ${modelCalls(env)}`);
  assert.equal(used(env, t), DENNY_LIMIT_IP_ROZHOVORY, 'presne 5 zapocitanych rozhovorov, nie 100 zo 100');
  assert.ok(statusy.every((s) => s === 200 || s === 429), JSON.stringify([...new Set(statusy)]));
});

test('sonda 1: 121 subeznych otazok s jednym tokenom neprekroci limit otazok s modelom na siet', async () => {
  const env = makeEnv({ ASISTENT_CACHE: pomaleKV(), DB: pomalaD1(), AI: pomalyAI(30) });
  const t = await readyTenant(env, 'token-davka.sk');
  const prvy = await worker.fetch(chatReq(t, { ip: '78.0.0.1' }), env, {});
  const token = (await prvy.json()).relacia;
  const ctx = ctxWaitUntil();
  await Promise.all(Array.from({ length: 120 }, () => worker.fetch(chatReq(t, { ip: '78.0.0.1', relacia: token }), env, ctx)));
  await ctx.dokonci();
  assert.ok(modelCalls(env) <= DENNY_LIMIT_IP_AI.free, `volani modelu ${modelCalls(env)}`);
  assert.equal(used(env, t), 1);
});

test('sonda 1 s KV limitom 1 zapis za sekundu: chyby zapisu KV limity neotvoria (su v D1)', async () => {
  const kv = pomaleKV({ limitZapisuNaKluc: true });
  const env = makeEnv({ ASISTENT_CACHE: kv, DB: pomalaD1(), AI: pomalyAI(30) });
  const t = await readyTenant(env, 'kv429.sk');
  const ctx = ctxWaitUntil();
  await Promise.all(Array.from({ length: 60 }, () => worker.fetch(chatReq(t, { ip: '79.0.0.1' }), env, ctx)));
  await ctx.dokonci();
  assert.ok(kv.chyby429 > 0, 'KV naozaj hadzalo 429');
  assert.ok(modelCalls(env) <= DENNY_LIMIT_IP_ROZHOVORY);
  assert.ok(used(env, t) <= DENNY_LIMIT_IP_ROZHOVORY);
});

test('S2: 5 subeznych novych rozhovorov pri kvote 99/100: jeden dostane AI a zapocita sa, ostatni 429 quota_exceeded', async () => {
  const env = makeEnv({ DB: pomalaD1(), AI: pomalyAI(20) });
  const t = await readyTenant(env, 'posledne-miesto.sk');
  env.DB._tenants.get(t.id).used_this_month = 99;
  env.DB._tenants.get(t.id).quota_month = new Date().toISOString().slice(0, 7);
  const odp = await Promise.all([1, 2, 3, 4, 5].map((i) => worker.fetch(chatReq(t, { ip: `10.0.0.${i}` }), env, {})));
  const statusy = odp.map((r) => r.status).sort();
  assert.deepEqual(statusy, [200, 429, 429, 429, 429]);
  assert.equal(used(env, t), 100);
  assert.equal(modelCalls(env), 1);
  // Prehraté požiadavky vrátili všetky rezervácie (strop obchodu ukazuje 1 otázku).
  assert.equal(pocet(env, kluce.ai(t.id, DEN())), 1);
});

test('S3: pri 59/60 otazkach obchodu 10 subeznych otazok z roznych IP zavola model raz', async () => {
  const env = makeEnv({ DB: pomalaD1(), AI: pomalyAI(30), AI_DAILY_NEURON_BUDGET: '150000' });
  const t = await readyTenant(env, 'strop60.sk');
  await pripocitaj(env.DB, kluce.ai(t.id, DEN()), DEN(), 59);
  const ctx = ctxWaitUntil();
  const odp = await Promise.all(Array.from({ length: 10 }, (_, i) => worker.fetch(chatReq(t, { ip: `11.0.0.${i}` }), env, ctx)));
  await ctx.dokonci();
  assert.ok(odp.every((r) => r.status === 200));
  assert.equal(modelCalls(env), 1);
  assert.equal(pocet(env, kluce.ai(t.id, DEN())), 60);
});

// ---------------------------------------------------------------------------
// Nález 2 riziko: izolácia obchodov v neurónoch
// ---------------------------------------------------------------------------

/**
 * Model, ktorý vždy stojí najviac, koľko smie: vstup = každý bajt promptu ako
 * token plus réžia šablóny, výstup = celé max_tokens. To je presne horná
 * hranica, ktorú ochrana rezervuje pred volaním (budget.js hornaHranicaMili).
 */
function najdrahsiAI() {
  return createMockAI({
    embedDim: 4,
    chatResponse: (input) => {
      const bajty = (input.messages || []).reduce((s, m) => s + new TextEncoder().encode(m.content).length, 0);
      return { response: ODPOVED, usage: { prompt_tokens: bajty + REZIA_SABLONY_TOKENOV, completion_tokens: input.max_tokens } };
    },
  });
}

test('riziko 2: bezplatny obchod s najdrahsimi otazkami minie najviac svoj podiel 30 % zakladneho stropu, bez odpovede navyse', async () => {
  // Schválené pravidlo (budget.js PODIEL_OBCHODU, tretie kolo K2): bezplatný
  // obchod 30 % základného stropu. Pôvodný test čakal 10 % a „jednu odpoveď
  // navyše“; od pokusu 2 brány ukážok oslovení (28. 9., nález 3) sa horná
  // hranica rezervuje pred modelom, takže navyše nejde nič. Strop 5 000:
  // podiel 1 500 sa minie skôr ako denný strop 10 nových rozhovorov.
  const env = makeEnv({ AI: najdrahsiAI(), AI_DAILY_NEURON_BUDGET: '5000' });
  const t = await readyTenant(env, 'drahy.sk');
  const odpovede = [];
  for (let i = 0; i < 40; i++) {
    bezMinutovehoLimitu(env);
    odpovede.push(await (await worker.fetch(chatReq(t, { ip: `20.0.${Math.floor(i / 200)}.${i % 200}` }), env, {})).json());
  }
  const strop = 5000 * PODIEL_OBCHODU.free;
  const minul = pocet(env, kluce.mili(t.id, DEN())) / MILI;
  assert.ok(minul <= strop, `obchod minul ${minul}, podiel ${strop}`);
  assert.ok(minul > strop * 0.6, `podiel sa naozaj míňal: ${minul}`);
  assert.ok(modelCalls(env) >= 4 && modelCalls(env) < 10, `volani modelu ${modelCalls(env)} (strop podielu, nie nových rozhovorov)`);
  assert.ok(odpovede.slice(-5).every((o) => o.meta.bezAi === true), 'po podiele len odpovede bez modelu');
  assert.equal(pocet(env, kluce.neurony(DEN())), pocet(env, kluce.mili(t.id, DEN())), 'spoločné počítadlo = skutočnosť obchodu');
});

// ---------------------------------------------------------------------------
// Nález 3 riziko: limit otázok s modelom na sieť je zlomok stropu obchodu
// ---------------------------------------------------------------------------

test('riziko 3: jedna IP dostane u bezplatneho obchodu 10 odpovedi modelom, zakaznik z inej IP potom stale AI', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'ip-limit.sk');
  let token;
  const bezAi = [];
  for (let i = 0; i < 25; i++) {
    bezMinutovehoLimitu(env);
    const r = await worker.fetch(chatReq(t, { ip: '30.0.0.1', relacia: token }), env, {});
    const b = await r.json();
    if (b.relacia) token = b.relacia;
    bezAi.push(Boolean(b.meta.bezAi));
  }
  assert.equal(bezAi.filter((x) => !x).length, DENNY_LIMIT_IP_AI.free);
  assert.equal(modelCalls(env), DENNY_LIMIT_IP_AI.free);
  const zakaznik = await worker.fetch(chatReq(t, { ip: '31.0.0.1' }), env, {});
  assert.equal((await zakaznik.json()).meta.bezAi, undefined);
});

// ---------------------------------------------------------------------------
// Nález 4 riziko: dĺžka otázky na serveri
// ---------------------------------------------------------------------------

test('riziko 4: otazka 7 700 znakov ide do vektora aj modelu skratena na 500; darcek recipient a interests na 200', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'dlha.sk');
  const dlha = 'hrncek keramika '.repeat(500).slice(0, 7700);
  const r = await worker.fetch(chatReq(t, { message: dlha }), env, {});
  assert.equal(r.status, 200);
  const vektor = env.AI.calls.find((c) => c.model === EMBED);
  assert.equal(vektor.input.text[0].length, MAX_MESSAGE_CHARS);
  const prompt = env.AI.calls.find((c) => c.model !== EMBED).input.messages.map((m) => m.content).join('\n');
  assert.equal(prompt.includes(dlha.slice(0, MAX_MESSAGE_CHARS)), true);
  assert.equal(prompt.includes(dlha.slice(0, MAX_MESSAGE_CHARS + 1)), false);

  const env2 = makeEnv({ AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ picks: [] }) }) });
  const t2 = await readyTenant(env2, 'darcek-dlhy.sk');
  const pole = 'x'.repeat(3700); // dve polia spolu tesne pod limitom tela darčeka
  const g = await worker.fetch(giftReq(t2, { recipient: pole, interests: pole }), env2, {});
  assert.equal(g.status, 200);
  const giftPrompt = env2.AI.calls.find((c) => c.model !== EMBED).input.messages.map((m) => m.content).join('\n');
  assert.ok(giftPrompt.includes(`recipient: ${'x'.repeat(MAX_DARCEK_POLE_CHARS)}\n`));
  assert.equal(giftPrompt.includes('x'.repeat(MAX_DARCEK_POLE_CHARS + 1)), false);
  for (const c of env2.AI.calls.filter((x) => x.model === EMBED)) {
    for (const text of c.input.text) assert.ok(text.length <= 2 * MAX_DARCEK_POLE_CHARS + 2);
  }
});

test('riziko 4: widget ma maxlength 500 na otazke a 200 na poliach darceka', () => {
  const src = fs.readFileSync(path.join(__dirname, '../widget/widget.js'), 'utf8');
  assert.match(src, /var MAX_QUESTION_CHARS = 500;/);
  assert.match(src, /var MAX_GIFT_FIELD_CHARS = 200;/);
  assert.match(src, /<textarea id="input"[^']*maxlength="' \+ MAX_QUESTION_CHARS/);
  assert.equal((src.match(/maxlength="' \+ MAX_GIFT_FIELD_CHARS/g) || []).length, 2);
  assert.equal(MAX_MESSAGE_CHARS, 500);
  assert.equal(MAX_DARCEK_POLE_CHARS, 200);
});

// ---------------------------------------------------------------------------
// Nález 5 riziko: IPv6 /64 a denný strop nových rozhovorov obchodu
// ---------------------------------------------------------------------------

test('riziko 5: normalizujIp skrati IPv6 na /64, IPv4 v IPv6 na IPv4', async () => {
  assert.equal(normalizujIp('2001:db8:1234:5678:1::9'), '2001:db8:1234:5678::/64');
  assert.equal(normalizujIp('2001:0db8:1234:5678:ffff:ffff:ffff:ffff'), '2001:db8:1234:5678::/64');
  assert.equal(normalizujIp('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(normalizujIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizujIp('1.2.3.4'), '1.2.3.4');
  assert.equal(normalizujIp('nezmysel'), 'nezmysel');
  const den = '2026-09-25';
  assert.equal(await kosIp('2001:db8:1234:5678::1', den, 's'), await kosIp('2001:db8:1234:5678:aaaa::2', den, 's'));
  const k = await kosIp('1.2.3.4', den, 's');
  assert.ok(Number.isInteger(k) && k >= 0 && k < 65536);
});

test('riziko 5: 105 novych rozhovorov z adries jednej IPv6 /64 minie najviac 5 rozhovorov, zakaznik potom AI', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'ipv6.sk');
  for (let i = 1; i <= 105; i++) {
    bezMinutovehoLimitu(env);
    const r = await worker.fetch(chatReq(t, { ip: `2001:db8:1234:5678::${i.toString(16)}` }), env, {});
    assert.ok([200, 429].includes(r.status));
  }
  assert.equal(used(env, t), DENNY_LIMIT_IP_ROZHOVORY);
  const zakaznik = await worker.fetch(chatReq(t, { ip: '203.0.113.9' }), env, {});
  assert.equal(zakaznik.status, 200);
  assert.equal((await zakaznik.json()).meta.bezAi, undefined);
  assert.equal(used(env, t), DENNY_LIMIT_IP_ROZHOVORY + 1);
});

test('riziko 5: minutovy limit plati na celu /64 a kluc nenesie IP', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'minuta6.sk', 'pro');
  const stavy = [];
  for (let i = 1; i <= 31; i++) stavy.push((await worker.fetch(chatReq(t, { ip: `2001:db8:aaaa:bbbb::${i.toString(16)}` }), env, {})).status);
  assert.equal(stavy[30], 429);
  for (const k of env.ASISTENT_CACHE._store.keys()) assert.equal(k.includes('2001:db8'), false, k);
});

test('riziko 5: denny strop novych rozhovorov obchodu (free 10) z roznych IP, dalej bez modelu a bez zapocitania, vystraha zneuzitie', async () => {
  const env = makeEnv({ ASISTENT_NTFY_OCHRANA: 'zapnute' });
  const t = await readyTenant(env, 'nove-strop.sk');
  for (let i = 1; i <= 14; i++) await worker.fetch(chatReq(t, { ip: `40.0.0.${i}` }), env, {});
  assert.equal(used(env, t), 10);
  assert.equal(modelCalls(env), 10);
  const z = env.outbound.filter((o) => o.url.includes('e=zneuzitie&'));
  assert.equal(z.length, 1);
});

// ---------------------------------------------------------------------------
// Nález 6 riziko: Origin je len filter, texty to hovoria poctivo
// ---------------------------------------------------------------------------

test('riziko 6: komentare a README nepodavaju Origin ako ochranu pred skriptom', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../worker/src/chat.js'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  assert.equal(chat.includes('ktorý by inak minul strop'), false);
  assert.match(chat, /len\s*(?:\/\/\s*)?filter neúmyselných klientov/);
  assert.match(readme, /Origin[^\n]*len filtruje neúmyselných klientov/);
});

// ---------------------------------------------------------------------------
// Nález 7 riziko: odpovede bez AI v tisícinách a pod vlastným stropom
// ---------------------------------------------------------------------------

test('riziko 7: odpoved bez AI s kratkou otazkou prida do stropu tisiciny, nie cely neuron', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'bezai-mili.sk');
  await pripocitaj(env.DB, kluce.ai(t.id, DEN()), DEN(), 60);
  const r = await worker.fetch(chatReq(t, { message: 'Mate kavovar?' }), env, {});
  assert.equal((await r.json()).meta.bezAi, true);
  const mili = pocet(env, kluce.neurony(DEN()));
  assert.ok(mili > 0 && mili < MILI, `pripocitane ${mili} tisicin`);
});

test('riziko 7: odpovede bez AI maju denny strop obchodu (free 3 000), nad nim 429 obchod_limit', async () => {
  // Schválené pravidlo (budget.js BEZ_AI_DENNY_STROP, tretie kolo, nález 4):
  // free 3 000 odpovedí bez modelu za deň a nad nimi 429 `obchod_limit`
  // (widget ukáže vetu s kontaktom obchodu, nie „príliš veľa správ“).
  // Pôvodný test čakal starý strop 300 a kód rate_limited.
  const env = makeEnv();
  const t = await readyTenant(env, 'bezai-strop.sk');
  await pripocitaj(env.DB, kluce.ai(t.id, DEN()), DEN(), 60);
  await pripocitaj(env.DB, kluce.bezAi(t.id, DEN()), DEN(), BEZ_AI_DENNY_STROP.free - 1);
  const posledna = await worker.fetch(chatReq(t, { ip: '50.0.0.1' }), env, {});
  assert.equal(posledna.status, 200);
  assert.equal((await posledna.json()).meta.bezAi, true);
  assert.equal(pocet(env, kluce.bezAi(t.id, DEN())), BEZ_AI_DENNY_STROP.free);
  const nad = await worker.fetch(chatReq(t, { ip: '50.0.0.2' }), env, {});
  assert.equal(nad.status, 429);
  assert.equal((await nad.json()).error, 'obchod_limit');
  assert.equal(pocet(env, kluce.bezAi(t.id, DEN())), BEZ_AI_DENNY_STROP.free, 'nad stropom sa nič nepripočítalo');
  assert.equal(pocet(env, kluce.ipOtazky(t.id, DEN(), await kosIp('50.0.0.2', DEN(), TAJOMSTVO))), 0, '429 vratil aj limit IP');
});

// ---------------------------------------------------------------------------
// Nález 8 riziko: načítanie feedov má vlastný rozpočet a neaktívne obchody týždenne
// ---------------------------------------------------------------------------

function feedXml(n, prefix) {
  const polozky = Array.from({ length: n }, (_, i) => `<item><id>${prefix}-${i}</id><name>Produkt ${prefix} ${i}</name><price>10.00</price><url>https://${prefix}.sk/p/${i}</url><description>${'Popis produktu. '.repeat(20)}</description></item>`);
  return `<products>${polozky.join('')}</products>`;
}

test('riziko 8: cron so 4 cudzimi feedmi mini len rozpocet obnovy, chat ludovky dalej odpoveda modelom', async () => {
  const env = makeEnv({ fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => feedXml(40, String(url).includes('ludovka') ? 'ludovka' : 'cudzi') }) });
  const ludovka = await readyTenant(env, 'ludovka.sk');
  for (let i = 0; i < 4; i++) {
    const c = await createTenant(env.DB, { domain: `cudzi${i}.sk`, feedUrl: `https://cudzi${i}.sk/feed.xml`, contactEmail: `x@cudzi${i}.sk` });
    await setTenantStatus(env.DB, c.id, 'ready');
  }
  const vysledky = await refreshAllFeeds(env);
  assert.ok(vysledky.filter((v) => v.ok).length >= 4);
  const obnova = pocet(env, kluce.obnova(DEN()));
  assert.ok(obnova > 0);
  assert.equal(obnova, vysledky.filter((v) => v.ok).reduce((s, v) => s + obnovaZaZnaky(v.znakov), 0));
  assert.equal(pocet(env, kluce.neurony(DEN())), 0, 'spolocny strop chatu sa nepohol');
  const r = await worker.fetch(chatReq(ludovka), env, {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).meta.bezAi, undefined);
});

test('riziko 8: vycerpany rozpocet obnovy preskoci dalsie obchody bez zmeny stavu; neaktivny stary obchod len v nedelu', async () => {
  const env = makeEnv({ AI_DAILY_OBNOVA_BUDGET: '1', fetchImpl: async () => ({ ok: true, status: 200, text: async () => feedXml(40, 'x') }) });
  const aktivny = await readyTenant(env, 'aktivny.sk');
  const stary = await readyTenant(env, 'stary.sk');
  env.DB._tenants.get(stary.id).created_at = '2026-01-01T00:00:00.000Z';
  env.DB._tenants.get(aktivny.id).created_at = '2026-01-01T00:00:00.000Z';
  // aktívny mal rozhovor pred 3 dňami
  const pondelok = new Date('2026-09-28T03:00:00Z');
  const predTromi = new Date(pondelok);
  predTromi.setUTCDate(predTromi.getUTCDate() - 3);
  await env.DB.prepare(SQL.UPSERT_COUNTER_CONVERSATION).bind(aktivny.id, dayKey(predTromi)).run();
  const v = await refreshAllFeeds(env, { now: pondelok });
  const podla = Object.fromEntries(v.map((x) => [x.tenantId, x]));
  assert.equal(podla[stary.id].preskocene, 'neaktivny');
  assert.equal(podla[aktivny.id].ok, true, 'prvy sa este zmesti');
  // Rozpočet 1 neurón je po prvom feede preč: ďalší aktívny by sa preskočil bez chyby.
  const druhy = await readyTenant(env, 'druhy.sk');
  const v2 = await refreshAllFeeds(env, { now: pondelok });
  const d = v2.find((x) => x.tenantId === druhy.id);
  assert.equal(d.preskocene, 'rozpocet_obnovy');
  assert.equal(env.DB._tenants.get(druhy.id).status, 'ready');
  // Nedeľa: aj neaktívny starý obchod.
  const nedela = new Date('2026-09-27T03:00:00Z');
  const env2 = makeEnv({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => feedXml(5, 'y') }) });
  const s2 = await readyTenant(env2, 'stary2.sk');
  env2.DB._tenants.get(s2.id).created_at = '2026-01-01T00:00:00.000Z';
  const v3 = await refreshAllFeeds(env2, { now: nedela });
  assert.equal(v3[0].ok, true);
});

// ---------------------------------------------------------------------------
// Nález 9 riziko: ai_vypadok pri súbehu chýb
// ---------------------------------------------------------------------------

test('riziko 9: 20 subeznych chyb modelu da pocitadlo 20 a presne jednu vystrahu ai_vypadok', async () => {
  const env = makeEnv({ ASISTENT_NTFY_OCHRANA: 'zapnute', DB: pomalaD1(2) });
  const now = new Date();
  const pocty = await Promise.all(Array.from({ length: 20 }, () => zaznamenajChybuAI(env, { now })));
  assert.equal(Math.max(...pocty), 20);
  assert.equal(pocet(env, kluce.aiChyby(now.toISOString().slice(0, 13))), 20);
  assert.equal(env.outbound.filter((o) => o.url.includes('e=ai_vypadok&')).length, 1);
});

// ---------------------------------------------------------------------------
// Nález 10 riziko: výpadok modelu nezamkne zákazníka
// ---------------------------------------------------------------------------

test('riziko 10: po 65 chybach modelu z jednej IP dostane zakaznik po obnove odpoved modelom, nie 429', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'vypadok.sk');
  const zdravy = env.AI;
  env.AI = { calls: [], async run(model, input) { if (model === EMBED) return zdravy.run(model, input); throw new Error('3040: Capacity temporarily exceeded'); } };
  for (let i = 0; i < 65; i++) {
    bezMinutovehoLimitu(env);
    assert.equal((await worker.fetch(chatReq(t, { ip: '60.0.0.1' }), env, {})).status, 500);
  }
  env.AI = zdravy;
  bezMinutovehoLimitu(env);
  const r = await worker.fetch(chatReq(t, { ip: '60.0.0.1' }), env, {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).meta.bezAi, undefined);
  assert.equal(used(env, t), 1);
});

// ---------------------------------------------------------------------------
// Drobné: nález 12 riziko, ASISTENT_MAX_OTAZOK (V3)
// ---------------------------------------------------------------------------

test('riziko 12: chyba zapisu rozhovoru po odpovedi modelu odpoved nezahodi a naklad sa zapise', async () => {
  const env = makeEnv();
  const t = await readyTenant(env, 'd1-chyba.sk');
  const povodne = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => (sql === SQL.UPSERT_COUNTER_CONVERSATION ? { bind: () => ({ run: async () => { throw new Error('D1 overloaded'); } }) } : povodne(sql));
  const r = await worker.fetch(chatReq(t), env, {});
  assert.equal(r.status, 200);
  assert.equal(typeof (await r.json()).answer, 'string');
  assert.equal(used(env, t), 1);
  assert.ok(pocet(env, kluce.neurony(DEN())) > 0);
});

test('V3: ASISTENT_MAX_OTAZOK meni pravidlo 10 otazok (kym Andrej neschvali 3.2/1, wrangler.toml ma 1000)', async () => {
  assert.equal(maxOtazok({}), MAX_OTAZOK_NA_ROZHOVOR);
  assert.equal(maxOtazok({ ASISTENT_MAX_OTAZOK: '1000' }), 1000);
  assert.equal(maxOtazok({ ASISTENT_MAX_OTAZOK: 'x' }), MAX_OTAZOK_NA_ROZHOVOR);
  assert.equal(maxOtazok({ ASISTENT_MAX_OTAZOK: '0' }), MAX_OTAZOK_NA_ROZHOVOR);
  const env = makeEnv({ ASISTENT_MAX_OTAZOK: '1000' });
  const t = await readyTenant(env, 'bez-limitu.sk', 'starter');
  let token;
  for (let i = 1; i <= 12; i++) {
    const r = await worker.fetch(chatReq(t, { relacia: token }), env, {});
    token = (await r.json()).relacia;
  }
  assert.equal(used(env, t), 1, '12 otazok je stale jeden rozhovor');
});
