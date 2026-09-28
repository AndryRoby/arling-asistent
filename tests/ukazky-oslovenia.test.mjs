// ukazky-oslovenia.test.mjs
//
// Ukážky pre oslovené obchody (28. 9. 2026, NALIEHAVÉ): overené odpovede bez
// AI, rezerva ukážok oddelená od našich interných behov, vecná hláška pri
// minutej rezerve. Pozdrav widgetu a tlačidlá navrhy sú v widget.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import worker from '../worker/src/index.js';
import { createTenant, setTenantStatus, setTenantPlan, dayKey } from '../worker/src/tenants.js';
import { pripocitaj, kluce } from '../worker/src/pocty.js';
import {
  neuronovePolozky,
  rozhodniRezim,
  rezervaOslovenia,
  internyLimit,
  bazenFreeLimit,
  budgetLimit,
  jeRezimUkazkyOslovenia,
  hornaHranicaMili,
  REZIA_SABLONY_TOKENOV,
  STISENIE_FREE_PODIEL,
  DEFAULT_REZERVA_OSLOVENIE,
  MILI,
} from '../worker/src/budget.js';
import { zdrojZoVstupu } from '../worker/src/zivotny-cyklus.js';
import { normalizujOtazku, najdiOverenu, validujOverene, demoVycerpane, OVERENE_MAX_BAJTOV } from '../worker/src/overene.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const TAJOMSTVO = 'dGVzdG92YWNpZS10YWpvbXN0dm8tcHJlLXJlbGFjaWU=';
const ZAPIS = 'zapis-tajne';
const MERANIE = 'meranie-tajne';
const EMBED = '@cf/baai/bge-m3';
const OTAZKA = 'Akú kávu odporúčate do moka kanvičky?';
const ODPOVED = 'Odporúčame kávu Colombia Supremo Scr.19 Sofía alebo Guatemala SHB EP, ktoré sú vhodné do moka kanvičky.';
const KARTY = [
  { title: 'Colombia Supremo Scr.19 Sofía', url: 'https://www.praziarenjolka.sk/produkt/colombia/', price: 12.5, currency: 'EUR', image: 'https://www.praziarenjolka.sk/wp-content/uploads/colombia.png' },
  { title: 'Guatemala SHB EP', url: 'https://www.praziarenjolka.sk/produkt/guatemala/', price: 13.9, currency: 'EUR', image: '' },
];

function makeEnv(extra = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ answer: 'Zivá odpoveď modelu.', products: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: 'admin-tajne',
    ASISTENT_ADMIN_ZAPIS: ZAPIS,
    MERANIE_TOKEN: MERANIE,
    UCET_TAJOMSTVO: TAJOMSTVO,
    AI_DAILY_NEURON_BUDGET: '20000',
    ...extra,
  };
}

async function obchod(env, domain, zdroj = 'oslovenie') {
  const t = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/feed.json`, contactEmail: `info@${domain}` });
  await setTenantStatus(env.DB, t.id, 'ready');
  env.DB._tenants.get(t.id).zdroj = zdroj;
  await env.VECTORIZE.upsert([
    { id: `${t.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: t.id, productId: 'p1', title: 'Colombia', url: `https://${domain}/colombia`, price: 12.5, currency: 'EUR', availability: 'in_stock' } },
  ]);
  return t;
}

function chat(tenant, { otazka = OTAZKA, origin = 'https://arling.sk', ip = '9.9.9.9', headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers };
  if (origin) h.Origin = origin;
  return new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: otazka }], lang: 'auto', session: 'abcdef0123456789' }),
  });
}

function admin(tenantId, method, body, token = ZAPIS) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['X-Admin-Token'] = token;
  return new Request(`https://asistent.arling.sk/v1/admin/asistent/overene/${tenantId}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}

const POLOZKY = { polozky: [{ otazka: OTAZKA, odpoved: ODPOVED, karty: KARTY }, { otazka: 'Máte kávu bez kofeínu?', odpoved: 'Áno, Decaf.', karty: [] }] };
const den = () => dayKey(new Date());
const pocet = (env, kluc) => (env.DB._pocty.get(kluc) || { hodnota: 0 }).hodnota;
async function nastav(env, kluc, neurony) {
  await pripocitaj(env.DB, kluc, den(), 0);
  env.DB._pocty.get(kluc).hodnota = neurony * MILI;
}
const modelCalls = (env) => env.AI.calls.filter((c) => c.model !== EMBED).length;

// ---------------------------------------------------------------------------
// 1. Overené odpovede
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_NORM = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/normalizacia-otazok.json'), 'utf8'));

test('overene: normalizacia otazky ignoruje diakritiku, velkost pismen, interpunkciu a medzery', () => {
  assert.equal(normalizujOtazku(OTAZKA), 'aku kavu odporucate do moka kanvicky');
  assert.equal(normalizujOtazku('  aku KAVU odporucate do moka-kanvicky  '), 'aku kavu odporucate do moka kanvicky');
  assert.ok(najdiOverenu(POLOZKY, 'Aku kavu odporucate do moka kanvicky'));
  assert.equal(najdiOverenu(POLOZKY, 'Akú kávu odporúčate na espresso?'), null);
  assert.equal(najdiOverenu(null, OTAZKA), null);
});

test('overene: validacia tela (URL karty povinna a http(s), cena cislo, najviac 3 karty, bez duplicit)', () => {
  assert.equal(validujOverene(POLOZKY).polozky[0].karty[0].price, 12.5);
  const zle = [
    {},
    { polozky: [] },
    { polozky: [{ otazka: OTAZKA, odpoved: ODPOVED, karty: [{ title: 'x', url: 'javascript:alert(1)' }] }] },
    { polozky: [{ otazka: OTAZKA, odpoved: ODPOVED, karty: [{ title: 'x', url: '' }] }] },
    { polozky: [{ otazka: OTAZKA, odpoved: ODPOVED, karty: [{ title: 'x', url: 'https://a.sk/', price: 'drahe' }] }] },
    { polozky: [{ otazka: OTAZKA, odpoved: ODPOVED, karty: [KARTY[0], KARTY[0], KARTY[1], KARTY[1]] }] },
    { polozky: [{ otazka: OTAZKA, odpoved: ODPOVED }, { otazka: 'aku kavu odporucate do moka kanvicky', odpoved: 'x' }] },
    { polozky: [{ otazka: OTAZKA, odpoved: '' }] },
  ];
  for (const telo of zle) assert.throws(() => validujOverene(telo), undefined, JSON.stringify(telo));
});

test('overene: admin cesta chce ASISTENT_ADMIN_ZAPIS, len oslovenie, uloží a vráti; DELETE zmaže', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  const platiaci = await obchod(env, 'zakaznik.sk', 'formular');
  assert.equal((await worker.fetch(admin(t.id, 'PUT', POLOZKY, null), env, {})).status, 401);
  assert.equal((await worker.fetch(admin(t.id, 'PUT', POLOZKY, 'admin-tajne'), env, {})).status, 401, 'ADMIN_TOKEN nestačí');
  assert.equal((await worker.fetch(admin(platiaci.id, 'PUT', POLOZKY), env, {})).status, 409);
  assert.equal((await worker.fetch(admin('neexistuje', 'PUT', POLOZKY), env, {})).status, 404);
  assert.equal((await worker.fetch(admin(t.id, 'PUT', { polozky: [{ otazka: OTAZKA }] }), env, {})).status, 400);
  const put = await worker.fetch(admin(t.id, 'PUT', POLOZKY), env, {});
  assert.equal(put.status, 200);
  assert.equal((await put.json()).polozky, 2);
  const get = await (await worker.fetch(admin(t.id, 'GET'), env, {})).json();
  assert.deepEqual(get.polozky[0].karty, KARTY);
  assert.equal((await worker.fetch(admin(t.id, 'DELETE'), env, {})).status, 200);
  assert.deepEqual((await (await worker.fetch(admin(t.id, 'GET'), env, {})).json()).polozky, []);
  const bezTajomstva = makeEnv({ ASISTENT_ADMIN_ZAPIS: undefined });
  assert.equal((await worker.fetch(admin(t.id, 'PUT', POLOZKY), bezTajomstva, {})).status, 503);
});

test('overene: pripravena otazka na ukazke oslovenia vrati ulozenu odpoved a plne karty bez AI, vektora, stropu a kvoty', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  await worker.fetch(admin(t.id, 'PUT', POLOZKY), env, {});
  for (const otazka of [OTAZKA, 'aku kavu odporucate do moka kanvicky']) {
    const res = await worker.fetch(chat(t, { otazka }), env, {});
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.answer, ODPOVED);
    assert.deepEqual(d.products, KARTY);
    assert.equal(d.meta.overene, true);
  }
  assert.equal(env.AI.calls.length, 0, 'ani model, ani vektor');
  assert.equal(pocet(env, kluce.neurony(den())), 0);
  assert.equal(pocet(env, kluce.neuronyOslovenie(den())), 0);
  assert.equal(env.DB._tenants.get(t.id).used_this_month, 0);
});

test('overene: ina otazka ide zivou cestou; nas interny beh (X-Arling-Meranie) dostane vzdy zivu odpoved; neosloveny obchod KV nepouzije', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  await worker.fetch(admin(t.id, 'PUT', POLOZKY), env, {});
  const ina = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu na espresso?' }), env, {})).json();
  assert.equal(ina.answer, 'Zivá odpoveď modelu.');
  assert.equal(modelCalls(env), 1);
  const nasa = await (await worker.fetch(chat(t, { headers: { 'X-Arling-Meranie': MERANIE } }), env, {})).json();
  assert.equal(nasa.answer, 'Zivá odpoveď modelu.');
  assert.equal(modelCalls(env), 2);

  const iny = await obchod(env, 'iny.sk', 'formular');
  await env.ASISTENT_CACHE.put(`overene:${iny.id}`, JSON.stringify(POLOZKY));
  const r = await (await worker.fetch(chat(iny, { origin: 'https://iny.sk' }), env, {})).json();
  assert.equal(r.answer, 'Zivá odpoveď modelu.');
});

// ---------------------------------------------------------------------------
// 2. Oddelenie stropu
// ---------------------------------------------------------------------------

test('strop: rezerva ukazok je 3 000 pri strope 20 000, najviac 20 % stropu; interny limit 4 000', () => {
  assert.equal(rezervaOslovenia(makeEnv()), DEFAULT_REZERVA_OSLOVENIE);
  assert.equal(rezervaOslovenia(makeEnv({ AI_DAILY_NEURON_BUDGET: '5000' })), 1000);
  assert.equal(rezervaOslovenia(makeEnv({ AI_REZERVA_OSLOVENIE: '1500' })), 1500);
  assert.equal(internyLimit(makeEnv()), 4000);
  assert.equal(internyLimit(makeEnv({ AI_DAILY_INTERNE_BUDGET: '800' })), 800);
});

test('strop: pocitadla podla druhu poziadavky (bezplatny, oslovenie, nas interny beh)', () => {
  const env = makeEnv();
  const t = { id: 't1', plan: 'free' };
  const d = '2026-09-28';
  const free = neuronovePolozky(env, t, d);
  assert.equal(free[0][1], 16000 * MILI, 'bezplatné stíšené pri 80 %, nikdy nad strop mínus rezerva');
  assert.deepEqual(free[1].slice(0, 2), [kluce.neuronyFree(d), 13000 * MILI], 'bazén neplatiacich = 80 % mínus rezerva');
  const osl = neuronovePolozky(env, t, d, { oslovenie: true });
  assert.deepEqual(osl.slice(0, 2).map((x) => [x[0], x[1]]), [[kluce.neurony(d), 20000 * MILI], [kluce.neuronyOslovenie(d), 3000 * MILI]]);
  const nas = neuronovePolozky(env, t, d, { meranie: true, oslovenie: true });
  assert.deepEqual(nas.map((x) => [x[0], x[1], x[2]]), [
    [kluce.neurony(d), 16000 * MILI, 'interny_strop'],
    [kluce.neuronyFree(d), 13000 * MILI, 'interny_strop'],
    [kluce.interne(d), 4000 * MILI, 'interny_strop'],
  ]);
  assert.equal(nas.some((x) => x[0] === kluce.neuronyOslovenie(d) || x[0] === kluce.mili('t1', d)), false, 'interný beh nikdy do rezervy ukážok ani podielu obchodu');
});

test('strop: pri 17 000 spotreby bezplatny obchod ide bez modelu, ukazka oslovenia stale s modelom z rezervy', async () => {
  const env = makeEnv();
  const free = await obchod(env, 'bezny.sk', 'formular');
  const t = await obchod(env, 'praziarenjolka.sk');
  await nastav(env, kluce.neurony(den()), 17000);
  const r1 = await (await worker.fetch(chat(free, { origin: 'https://bezny.sk' }), env, {})).json();
  assert.equal(r1.meta.bezAi, true);
  assert.equal(modelCalls(env), 0);
  const r2 = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?' }), env, {})).json();
  assert.equal(r2.answer, 'Zivá odpoveď modelu.');
  assert.equal(modelCalls(env), 1);
  assert.ok(pocet(env, kluce.neuronyOslovenie(den())) > 0, 'náklad sa zapísal do rezervy ukážok');
});

test('strop: nas interny beh neberie z rezervy ukazok: nad strop minus rezerva 429 interny_strop, bez modelu, bez vektora', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  await nastav(env, kluce.neurony(den()), 16900);
  const res = await worker.fetch(chat(t, { headers: { 'X-Arling-Meranie': MERANIE } }), env, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'interny_strop');
  assert.equal(env.AI.calls.length, 0);
  // Zákazník na tej istej ukážke dostane odpoveď modelom z rezervy.
  const zak = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?' }), env, {})).json();
  assert.equal(zak.answer, 'Zivá odpoveď modelu.');
});

test('strop: interny bazen (AI_DAILY_INTERNE_BUDGET) po vycerpani vrati 429 interny_strop a nic nezostane rezervovane', async () => {
  const env = makeEnv({ AI_DAILY_INTERNE_BUDGET: '1000' });
  const t = await obchod(env, 'praziarenjolka.sk');
  await nastav(env, kluce.interne(den()), 900);
  const pred = pocet(env, kluce.neurony(den()));
  const res = await worker.fetch(chat(t, { headers: { 'X-Arling-Meranie': MERANIE } }), env, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'interny_strop');
  assert.equal(pocet(env, kluce.neurony(den())), pred, 'rezervácia sa vrátila');
  assert.equal(modelCalls(env), 0);
});

test('strop: nas interny beh nemina mesacnu kvotu, denne otazky ani nove rozhovory obchodu; naklad ide do interne:', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  for (let i = 0; i < 12; i++) {
    const res = await worker.fetch(chat(t, { headers: { 'X-Arling-Meranie': MERANIE } }), env, {});
    assert.equal(res.status, 200);
  }
  assert.equal(env.DB._tenants.get(t.id).used_this_month, 0);
  assert.equal(pocet(env, kluce.ai(t.id, den())), 0);
  assert.equal(pocet(env, kluce.nove(t.id, den())), 0);
  assert.equal(pocet(env, kluce.mili(t.id, den())), 0);
  assert.equal(pocet(env, kluce.neuronyOslovenie(den())), 0);
  assert.ok(pocet(env, kluce.interne(den())) > 0);
  assert.equal(pocet(env, kluce.interne(den())), pocet(env, kluce.neurony(den())), 'doúčtovanie ide do interne: aj spoločného');
});

test('strop: rozhodniRezim pre oslovenie cita vlastny bazen, nie stisenie free', async () => {
  const env = makeEnv();
  const t = { id: 't1', plan: 'free' };
  await nastav(env, kluce.neurony(den()), 16500);
  assert.equal((await rozhodniRezim(env, t)).dovod, 'stisenie');
  assert.equal((await rozhodniRezim(env, t, { oslovenie: true })).rezim, 'ai');
  await nastav(env, kluce.neuronyOslovenie(den()), 2900);
  assert.equal((await rozhodniRezim(env, t, { oslovenie: true })).dovod, 'rezerva_oslovenia');
  // Interný beh je od pokusu 2 (nález 4) v spoločnom limite neplatiacich:
  // spoločné počítadlo najviac 16 000 a bazén neplatiacich najviac 13 000.
  await nastav(env, kluce.neurony(den()), 15500);
  assert.equal((await rozhodniRezim(env, t, { meranie: true })).rezim, 'ai');
  await nastav(env, kluce.neurony(den()), 16100);
  assert.equal((await rozhodniRezim(env, t, { meranie: true })).rezim, 'interny_strop');
  await nastav(env, kluce.neurony(den()), 1000);
  await nastav(env, kluce.neuronyFree(den()), 12950);
  assert.equal((await rozhodniRezim(env, t, { meranie: true })).rezim, 'interny_strop');
});

// ---------------------------------------------------------------------------
// 3. Hláška pri vyčerpaní
// ---------------------------------------------------------------------------

const VETA_SK = 'Táto ukážka už dnes minula svoj limit odpovedí, na ďalšie otázky teraz neodpovie. Pripravené otázky nižšie odpovedajú aj teraz.';

test('vycerpane: minuta rezerva ukazok = vecna veta a pripravene otazky ako navrhy, bez modelu aj vektora', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  await worker.fetch(admin(t.id, 'PUT', POLOZKY), env, {});
  await nastav(env, kluce.neuronyOslovenie(den()), 3000);
  const res = await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu na espresso?' }), env, {});
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.answer, VETA_SK);
  assert.deepEqual(d.navrhy, [OTAZKA, 'Máte kávu bez kofeínu?']);
  assert.deepEqual(d.products, []);
  assert.equal(d.meta.ukazkaVycerpana, 'limit');
  assert.doesNotMatch(d.answer, /oddychuje/);
  assert.equal(env.AI.calls.length, 0);
  // Pripravená otázka aj vtedy odpovie uloženou odpoveďou.
  assert.equal((await (await worker.fetch(chat(t), env, {})).json()).answer, ODPOVED);
});

test('vycerpane: tvrdy strop (503) aj mesacna kvota na ukazke oslovenia = veta s navrhmi, na beznom obchode ostava chyba', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  const free = await obchod(env, 'bezny.sk', 'formular');
  await worker.fetch(admin(t.id, 'PUT', POLOZKY), env, {});
  await nastav(env, kluce.neurony(den()), 30000);
  const d = await (await worker.fetch(chat(t, { otazka: 'Iná otázka?' }), env, {})).json();
  assert.equal(d.answer, VETA_SK);
  assert.equal(d.navrhy.length, 2);
  const b = await worker.fetch(chat(free, { origin: 'https://bezny.sk' }), env, {});
  assert.equal(b.status, 503);
  assert.equal((await b.json()).error, 'quota_exceeded');

  // Mesačná kvóta vyčerpaná našimi testami: ukážka oslovenia sa na ňu nepozerá.
  const env2 = makeEnv();
  const t2 = await obchod(env2, 'slovenskegranule.sk');
  env2.DB._tenants.get(t2.id).used_this_month = 10000;
  const r2 = await (await worker.fetch(chat(t2, { otazka: 'Aké granule pre šteňa?' }), env2, {})).json();
  assert.equal(r2.answer, 'Zivá odpoveď modelu.');
});

test('vycerpane: vypadok modelu na ukazke oslovenia = veta s navrhmi (nie 500), jazyk podla otazky', async () => {
  const env = makeEnv({
    AI: {
      calls: [],
      async run(model, input) {
        this.calls.push({ model });
        if (model === EMBED) return { data: (input.text || []).map(() => [1, 0, 0, 0]) };
        throw new Error('3036: you have used up your daily free allocation of 10,000 neurons');
      },
    },
  });
  const t = await obchod(env, 'praziarenjolka.sk');
  const d = await (await worker.fetch(chat(t, { otazka: 'Do you have coffee for a moka pot?' }), env, {})).json();
  assert.equal(d.answer, demoVycerpane('en', null, 'vypadok').answer);
  assert.equal(d.answer, 'I cannot answer further questions right now because of a technical error.');
  assert.deepEqual(d.navrhy, []);
  assert.equal(d.meta.ukazkaVycerpana, 'vypadok');
});

// ---------------------------------------------------------------------------
// Pokus 2 brány (ops/ai/kontrola/2026-09-28-ukazky-oslovenia.md): regresné
// testy všetkých 9 nálezov Astry (5 a 9 v ops/oslovenia/ukazky_brana_test.py).
// ---------------------------------------------------------------------------

/**
 * Model, ktorý stojí presne toľko, koľko smie: každý bajt promptu ako token
 * plus réžia šablóny, výstup celé max_tokens (horná hranica z budget.js
 * hornaHranicaMili). Voliteľné oneskorenie, aby sa súbežné požiadavky prekryli.
 */
function najdrahsiAI(ms = 0) {
  const base = createMockAI({
    embedDim: 4,
    chatResponse: (input) => {
      const bajty = (input.messages || []).reduce((s, m) => s + new TextEncoder().encode(m.content).length, 0);
      return {
        response: JSON.stringify({ answer: 'Zivá odpoveď modelu.', products: [] }),
        usage: { prompt_tokens: bajty + REZIA_SABLONY_TOKENOV, completion_tokens: input.max_tokens },
      };
    },
  });
  return {
    calls: base.calls,
    async run(model, input) {
      if (ms && model !== EMBED) await new Promise((r) => setTimeout(r, ms));
      return base.run(model, input);
    },
  };
}

const FEED_XML = '<products><item><id>1</id><name>Kava Colombia</name><price>6.50</price><url>https://obchod.sk/p/1</url><description>Popis kavy.</description></item></products>';

test('nalez 1: verejna registracia si rezim ukazky neprideli; zdroj oslovenie len s ASISTENT_ADMIN_ZAPIS', async () => {
  assert.equal(zdrojZoVstupu('oslovenie', ''), 'api');
  assert.equal(zdrojZoVstupu('oslovenie', 'WordPress/6.6; https://a.sk'), 'wordpress');
  assert.equal(zdrojZoVstupu('oslovenie', '', { povolitOslovenie: true }), 'oslovenie');
  assert.equal(zdrojZoVstupu('formular', ''), 'formular');

  const env = makeEnv({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => FEED_XML }) });
  const cakaj = [];
  const ctx = { waitUntil: (p) => cakaj.push(p), passThroughOnException() {} };
  const registruj = async (domain, token) => {
    const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '5.5.5.5' };
    if (token) h['X-Admin-Token'] = token;
    const body = JSON.stringify({ feed_url: `https://${domain}/feed.xml`, domain, email: `info@${domain}`, lang: 'sk', zdroj: 'oslovenie' });
    const r = await worker.fetch(new Request('https://asistent.arling.sk/v1/tenants', { method: 'POST', headers: h, body }), env, ctx);
    await Promise.allSettled(cakaj.splice(0));
    assert.equal(r.status, 201, domain);
    return env.DB._tenants.get((await r.json()).id);
  };

  // Presne sonda Astry: verejný POST bez tokenu so zdroj=oslovenie.
  const verejny = await registruj('verejny.sk');
  assert.equal(verejny.zdroj, 'api', 'verejný vstup oslovenie ignoruje');
  assert.equal(jeRezimUkazkyOslovenia(verejny), false);
  assert.equal((await worker.fetch(admin(verejny.id, 'PUT', POLOZKY), env, {})).status, 409, 'overené odpovede mu nepatria');
  assert.equal((await registruj('zly-token.sk', 'zly-token')).zdroj, 'api');
  assert.equal((await registruj('admin-token.sk', 'admin-tajne')).zdroj, 'api', 'ADMIN_TOKEN nestačí');

  // Autorizovaný postup (ops/oslovenia/vytvor-ukazku.py s ASISTENT_ADMIN_ZAPIS).
  const nas = await registruj('ukazka-obchodu.sk', ZAPIS);
  assert.equal(nas.zdroj, 'oslovenie');
  assert.equal(jeRezimUkazkyOslovenia(nas), true);

  // Bez tajomstva vo workeri nikdy, ani s prázdnou hlavičkou.
  const bez = makeEnv({ ASISTENT_ADMIN_ZAPIS: undefined, fetchImpl: env.fetchImpl });
  const r = await worker.fetch(new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': '' },
    body: JSON.stringify({ feed_url: 'https://bez.sk/feed.xml', domain: 'bez.sk', email: 'info@bez.sk', zdroj: 'oslovenie' }),
  }), bez, {});
  assert.equal(bez.DB._tenants.get((await r.json()).id).zdroj, 'api');
});

test('nalez 2: po prechode free na starter aj pro ide oslovenie beznou platenou cestou, aj pri vycerpanej rezerve', async () => {
  for (const plan of ['starter', 'pro']) {
    const env = makeEnv();
    const t = await obchod(env, 'praziarenjolka.sk');
    await worker.fetch(admin(t.id, 'PUT', POLOZKY), env, {});
    await nastav(env, kluce.neuronyOslovenie(den()), 3000);
    // Kým neplatí: režim ukážky.
    assert.equal((await (await worker.fetch(chat(t, { ip: '8.8.8.0' }), env, {})).json()).meta.overene, true);
    assert.equal((await (await worker.fetch(chat(t, { otazka: 'Iná otázka?', ip: '8.8.8.0' }), env, {})).json()).meta.ukazkaVycerpana, 'limit');
    assert.equal(modelCalls(env), 0);

    await setTenantPlan(env.DB, t.id, { plan });
    const row = env.DB._tenants.get(t.id);
    row.quota_month = new Date().toISOString().slice(0, 7);
    assert.equal(row.zdroj, 'oslovenie', 'zdroj registrácie ostáva ako história');
    assert.equal(jeRezimUkazkyOslovenia(row), false, plan);
    const pred = row.used_this_month;

    const pripravena = await (await worker.fetch(chat(t, { ip: '8.8.8.1' }), env, {})).json();
    assert.equal(pripravena.answer, 'Zivá odpoveď modelu.', 'platiaci nedostane pevnú odpoveď ukážky');
    assert.equal(pripravena.meta.overene, undefined);
    assert.equal(pripravena.meta.bezAi, undefined, 'minutá rezerva ukážok platiaceho neobmedzuje');
    const ina = await (await worker.fetch(chat(t, { otazka: 'Iná otázka?', ip: '8.8.8.2' }), env, {})).json();
    assert.equal(ina.answer, 'Zivá odpoveď modelu.');
    assert.equal(ina.meta.ukazkaVycerpana, undefined);
    assert.equal(modelCalls(env), 2);
    assert.equal(pocet(env, kluce.neuronyOslovenie(den())), 3000 * MILI, 'rezervu ukážok nečerpá');
    assert.equal(env.DB._tenants.get(t.id).used_this_month, pred + 2, 'mesačná kvóta sa počíta ako u každého platiaceho');
    assert.equal((await worker.fetch(admin(t.id, 'PUT', POLOZKY), env, {})).status, 409, 'admin zápis overených odpovedí len pre ukážku');

    // Vyčerpaná mesačná kvóta platiaceho: bežná chyba, nie veta ukážky.
    env.DB._tenants.get(t.id).used_this_month = env.DB._tenants.get(t.id).monthly_quota;
    const q = await worker.fetch(chat(t, { otazka: 'Tretia?', ip: '8.8.8.3' }), env, {});
    assert.equal(q.status, 429);
    assert.equal((await q.json()).error, 'quota_exceeded');
  }
});

test('nalez 3: subeh platiacich pri zvysku stropu: horna hranica sa rezervuje pred modelom, strop sa neprekroci', async () => {
  const env = makeEnv({ AI: najdrahsiAI(25) });
  const t = await obchod(env, 'platiaci.sk', 'formular');
  await setTenantPlan(env.DB, t.id, { plan: 'starter' });
  await nastav(env, kluce.neurony(den()), 19500);
  const odp = await Promise.all(Array.from({ length: 10 }, (_, i) => worker.fetch(chat(t, { origin: 'https://platiaci.sk', ip: `70.0.0.${i}`, otazka: `Máte kávu číslo ${i}?` }), env, {})));
  const tela = await Promise.all(odp.map((r) => r.json()));
  assert.ok(odp.every((r) => r.status === 200));
  const spolu = pocet(env, kluce.neurony(den()));
  assert.ok(spolu <= 20000 * MILI, `spoločné ${spolu / MILI} nad strop 20 000`);
  const sAi = tela.filter((b) => !b.meta.bezAi).length;
  assert.equal(sAi, modelCalls(env), 'každá odpoveď s modelom mala rezervu');
  assert.ok(sAi >= 1 && sAi < 10, `modelom ${sAi}`);
  assert.equal(pocet(env, kluce.mili(t.id, den())) + 19500 * MILI, spolu, 'rezervácie sa po súbehu doúčtovali na skutočnosť');
});

test('nalez 3: drahy prompt (dlhy popis vo feede) pri nedostatku model nezavola: ukazka oslovenia (sonda 330 neuronov) aj platiaci', async () => {
  const dlhy = 'Káva s veľmi dlhým popisom z vlastného feedu. '.repeat(300);
  const pridajDrahy = (env, t, domain) => env.VECTORIZE.upsert([
    { id: `${t.id}::p2::0`, values: [1, 0, 0, 0], metadata: { tenant: t.id, productId: 'p2', title: 'Drahá káva', url: `https://${domain}/draha`, price: 9, currency: 'EUR', availability: 'in_stock', description: dlhy } },
  ]);

  // Sonda Astry: spoločné 19 800, rezerva 2 800. Predtým model bežal a spotreba skončila 20 130 a 3 130.
  const env = makeEnv({ AI: najdrahsiAI() });
  const t = await obchod(env, 'praziarenjolka.sk');
  await pridajDrahy(env, t, 'praziarenjolka.sk');
  await nastav(env, kluce.neurony(den()), 19800);
  await nastav(env, kluce.neuronyOslovenie(den()), 2800);
  const d = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?' }), env, {})).json();
  assert.equal(modelCalls(env), 0, 'model nebežal');
  assert.equal(d.meta.ukazkaVycerpana, 'limit');
  assert.ok(pocet(env, kluce.neurony(den())) < 19801 * MILI, 'len vektor otázky');
  assert.ok(pocet(env, kluce.neuronyOslovenie(den())) < 2801 * MILI);

  // Platiaci pri tom istom zvyšku: bez modelu, nie nad strop.
  const env2 = makeEnv({ AI: najdrahsiAI() });
  const p = await obchod(env2, 'platiaci.sk', 'formular');
  await setTenantPlan(env2.DB, p.id, { plan: 'pro' });
  await pridajDrahy(env2, p, 'platiaci.sk');
  await nastav(env2, kluce.neurony(den()), 19800);
  const b = await (await worker.fetch(chat(p, { origin: 'https://platiaci.sk', otazka: 'Máte zrnkovú kávu?' }), env2, {})).json();
  assert.equal(modelCalls(env2), 0);
  assert.equal(b.meta.bezAi, true);
  assert.ok(pocet(env2, kluce.neurony(den())) < 19801 * MILI);

  // S miestom model beží a skutočný náklad nikdy nepresiahne rezervovanú hornú hranicu.
  await nastav(env2, kluce.neurony(den()), 0);
  const ok = await (await worker.fetch(chat(p, { origin: 'https://platiaci.sk', otazka: 'Máte zrnkovú kávu?', ip: '9.9.9.8' }), env2, {})).json();
  assert.equal(ok.meta.bezAi, undefined);
  const volanie = env2.AI.calls.find((c) => c.model !== EMBED);
  const vstup = volanie.input.messages.map((m) => m.content).join('');
  const horna = hornaHranicaMili({ model: volanie.model, vstupText: vstup, maxTokens: volanie.input.max_tokens, vektory: ['Máte zrnkovú kávu?'] });
  assert.ok(pocet(env2, kluce.neurony(den())) <= horna + 1, `skutočnosť ${pocet(env2, kluce.neurony(den()))} nad hranicou ${horna}`);
  assert.ok(horna > 400 * MILI, 'drahý prompt má naozaj vysokú hranicu');

  // /v1/gift má tú istú rezerváciu hornej hranice pred modelom.
  const env3 = makeEnv({ AI: najdrahsiAI() });
  const g = await obchod(env3, 'darcek.sk', 'formular');
  await setTenantPlan(env3.DB, g.id, { plan: 'pro' });
  await pridajDrahy(env3, g, 'darcek.sk');
  await nastav(env3, kluce.neurony(den()), 19700);
  const gr = await worker.fetch(new Request('https://asistent.arling.sk/v1/gift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.7', Origin: 'https://darcek.sk' },
    body: JSON.stringify({ tenant: g.id, recipient: 'mama', interests: 'káva', budget_min: 0, budget_max: 100, lang: 'sk' }),
  }), env3, {});
  assert.equal(gr.status, 200);
  assert.equal((await gr.json()).meta.bezAi, true);
  assert.equal(modelCalls(env3), 0, 'darček: model nebežal');
  assert.ok(pocet(env3, kluce.neurony(den())) < 19701 * MILI);
});

test('nalez 4: neplatiaci a interny beh spolu nezjedia kapacitu platiacich (tvrdy spolocny limit 80 %)', async () => {
  for (const b of ['2000', '9500', '20000']) {
    const e = makeEnv({ AI_DAILY_NEURON_BUDGET: b });
    assert.equal(bazenFreeLimit(e) + rezervaOslovenia(e), budgetLimit(e) * STISENIE_FREE_PODIEL, `strop ${b}`);
  }
  const env = makeEnv({ AI: najdrahsiAI(), AI_DAILY_NEURON_BUDGET: '2000' });
  assert.equal(rezervaOslovenia(env), 400);
  assert.equal(bazenFreeLimit(env), 1200);
  const osl = await obchod(env, 'praziarenjolka.sk');
  const free = [await obchod(env, 'free1.sk', 'formular'), await obchod(env, 'free2.sk', 'formular')];
  const platiaci = await obchod(env, 'platiaci.sk', 'formular');
  await setTenantPlan(env.DB, platiaci.id, { plan: 'starter' });

  let interne429 = 0;
  for (let i = 0; i < 15; i++) {
    const r = await worker.fetch(chat(osl, { headers: { 'X-Arling-Meranie': MERANIE }, otazka: `Interná otázka ${i}?` }), env, {});
    if (r.status === 429) interne429 += 1;
  }
  for (let i = 0; i < 20; i++) {
    const t = free[i % 2];
    await worker.fetch(chat(t, { origin: `https://${t.domain}`, ip: `80.0.${i}.1`, otazka: `Bezplatná otázka ${i}?` }), env, {});
  }
  for (let i = 0; i < 10; i++) await worker.fetch(chat(osl, { ip: `81.0.${i}.1`, otazka: `Otázka ukážky ${i}?` }), env, {});

  assert.ok(interne429 > 0, 'interný beh narazil na spoločný limit');
  const spolu = pocet(env, kluce.neurony(den())) / MILI;
  assert.ok(spolu <= 1600.01, `neplatiaci spolu ${spolu} z 2 000`);
  assert.ok(pocet(env, kluce.neuronyFree(den())) <= 1200 * MILI + 10);
  assert.ok(pocet(env, kluce.neuronyOslovenie(den())) <= 400 * MILI + 10);
  const pred = modelCalls(env);
  const p = await (await worker.fetch(chat(platiaci, { origin: 'https://platiaci.sk', ip: '90.0.0.1', otazka: 'Otázka platiaceho?' }), env, {})).json();
  assert.equal(p.meta.bezAi, undefined, 'platiaci dostane model');
  assert.equal(modelCalls(env), pred + 1);
});

test('nalez 6: vety rozlisuju denny limit, technicky vypadok a pripravene otazky; nic nesluboju', () => {
  const data = { polozky: [{ otazka: 'Akú kávu?' }] };
  for (const l of ['sk', 'cs', 'en', 'de']) {
    const limitS = demoVycerpane(l, data, 'limit');
    const limitBez = demoVycerpane(l, null, 'limit');
    const vypadokBez = demoVycerpane(l, null, 'vypadok');
    const vypadokS = demoVycerpane(l, data, 'vypadok');
    assert.notEqual(limitBez.answer, vypadokBez.answer, l);
    assert.ok(limitS.answer.startsWith(limitBez.answer) && limitS.answer.length > limitBez.answer.length, l);
    assert.ok(vypadokS.answer.startsWith(vypadokBez.answer) && vypadokS.answer.length > vypadokBez.answer.length, l);
    assert.deepEqual(limitS.navrhy, ['Akú kávu?']);
    for (const x of [limitS, limitBez, vypadokBez, vypadokS]) assert.doesNotMatch(x.answer, /zajtra|zítř|tomorrow|morgen|oddychuje/i);
    for (const x of [limitBez, vypadokBez]) {
      assert.doesNotMatch(x.answer, /nižšie|níže|below|unten|priprav|připrav|prepared|vorbereitet/i, `${l}: bez pripravených otázok ich nespomína`);
      assert.deepEqual(x.navrhy, []);
    }
  }
  assert.match(demoVycerpane('sk', null, 'limit').answer, /limit/);
  assert.match(demoVycerpane('sk', null, 'vypadok').answer, /technická chyba/);
});

test('nalez 6: ukazka bez ulozenych odpovedi pri minutej rezerve nespomina pripravene otazky', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  await nastav(env, kluce.neuronyOslovenie(den()), 3000);
  const d = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?' }), env, {})).json();
  assert.equal(d.answer, demoVycerpane('sk', null, 'limit').answer);
  assert.deepEqual(d.navrhy, []);
  assert.doesNotMatch(d.answer, /nižšie/);
});

test('nalez 7: normalizacia zachova vyznam cisel (1,5 kg a 1-5 kg), rovnake kluce ako Python predohrej-ukazky.py', (t) => {
  for (const [vstup, kluc] of FIXTURE_NORM.pripady) assert.equal(normalizujOtazku(vstup), kluc, vstup);
  for (const [a, b] of FIXTURE_NORM.rozne) assert.notEqual(normalizujOtazku(a), normalizujOtazku(b), `${a} / ${b}`);
  assert.equal(najdiOverenu({ polozky: [{ otazka: 'Máte balenie 1,5 kg?' }] }, 'Máte balenie 1-5 kg?'), null, 'sonda Astry');
  assert.ok(najdiOverenu({ polozky: [{ otazka: 'Máte balenie 1,5 kg?' }] }, 'mate balenie 1.5 kg'));

  // Tá istá funkcia v Pythone (ops/oslovenia) na rovnakých aj ďalších vstupoch.
  const skript = path.join(__dirname, '../../../ops/oslovenia/predohrej-ukazky.py');
  if (!fs.existsSync(skript)) return t.skip('ops/oslovenia nie je vedľa produktu');
  const vstupy = [...FIXTURE_NORM.pripady.map((p) => p[0]), ...FIXTURE_NORM.rozne.flat(), 'Balenie ½ kg', '１,５ kg', 'x² + 2 %', 'Cena 1 200,50 €', 'ŽLUŤOUČKÝ kůň 3×4'];
  const kod = [
    'import importlib.util, json, sys',
    'sys.stdin.reconfigure(encoding="utf-8")',
    'spec = importlib.util.spec_from_file_location("p", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'print(json.dumps([m.normalizuj(x) for x in json.load(sys.stdin)]))',
  ].join('\n');
  const r = spawnSync('python', ['-c', kod, skript], { input: JSON.stringify(vstupy), encoding: 'utf8' });
  if (r.error) return t.skip(`python sa nedá spustiť: ${r.error.code}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), vstupy.map(normalizujOtazku));
});

test('nalez 8: admin PUT ma limit celeho tela v bajtoch, 413 aj bez Content-Length, citanie prudu sa zastavi', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk');
  const url = `https://asistent.arling.sk/v1/admin/asistent/overene/${t.id}`;
  const hlavicky = { 'Content-Type': 'application/json', 'X-Admin-Token': ZAPIS };
  const bajty = (s) => new TextEncoder().encode(s).length;

  // Sonda Astry: milión znakov v neznámom poli.
  const velke = JSON.stringify({ ...POLOZKY, padding: 'x'.repeat(1000000) });
  const r1 = await worker.fetch(new Request(url, { method: 'PUT', headers: { ...hlavicky, 'Content-Length': String(bajty(velke)) }, body: velke }), env, {});
  assert.equal(r1.status, 413);
  assert.equal((await r1.json()).error, 'body_too_large');

  // Bez Content-Length (prúd): 413 a z prúdu sa nečíta ďalej ako treba.
  let vydane = 0;
  const kus = new TextEncoder().encode('x'.repeat(16 * 1024));
  const prud = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"polozky":[],"padding":"')); },
    pull(c) { vydane += 1; if (vydane > 200) c.close(); else c.enqueue(kus); },
  });
  const req2 = new Request(url, { method: 'PUT', headers: hlavicky, body: prud, duplex: 'half' });
  assert.equal(req2.headers.get('content-length'), null);
  const r2 = await worker.fetch(req2, env, {});
  assert.equal(r2.status, 413);
  assert.ok(vydane < 20, `prečítaných kúskov ${vydane}, nie celé 3 MB`);

  // Presne na hranici prejde (neznáme pole sa ignoruje), o bajt viac nie.
  const zaklad = JSON.stringify({ ...POLOZKY, padding: '' });
  const naHranici = JSON.stringify({ ...POLOZKY, padding: 'x'.repeat(OVERENE_MAX_BAJTOV - bajty(zaklad)) });
  assert.equal(bajty(naHranici), OVERENE_MAX_BAJTOV);
  assert.equal((await worker.fetch(new Request(url, { method: 'PUT', headers: hlavicky, body: naHranici }), env, {})).status, 200);
  const nad = JSON.stringify({ ...POLOZKY, padding: 'x'.repeat(OVERENE_MAX_BAJTOV - bajty(zaklad) + 1) });
  assert.equal((await worker.fetch(new Request(url, { method: 'PUT', headers: hlavicky, body: nad }), env, {})).status, 413);
  assert.equal((await (await worker.fetch(admin(t.id, 'GET'), env, {})).json()).polozky.length, 2, 'uložené ostalo z platného PUT');
});
