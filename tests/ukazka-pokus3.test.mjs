// ukazka-pokus3.test.mjs
//
// Regresie nálezov A až D pokusu 2 brány ukážok oslovenia (Astra 2, 28. 9. 2026,
// ops/ai/kontrola/2026-09-28-ukazky-oslovenia-pokus2.md), oprava v pokuse 3:
//   A  vektory odpovedí bez modelu sa rezervujú pred volaním (chat aj darček),
//   B  cenová kontrola predohrej-ukazky.py (Python, spúšťa sa odtiaľto),
//   C  chyba D1 pri rezervácii je technický výpadok, nie minutý limit,
//   D  normalizácia otázky zachová záporné znamienko.
// Plus prvá otázka živej ukážky „len pripravená“ (lenPripravene), ktorá nikdy nič nemíňa.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import worker from '../worker/src/index.js';
import { createTenant, setTenantStatus, setTenantPlan, dayKey } from '../worker/src/tenants.js';
import { pripocitaj, kluce, POCTY_SQL } from '../worker/src/pocty.js';
import { MILI, vektorMili, REZIA_SABLONY_TOKENOV } from '../worker/src/budget.js';
import { normalizujOtazku, najdiOverenu, demoVycerpane } from '../worker/src/overene.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMBED = '@cf/baai/bge-m3';
const ZAPIS = 'zapis-tajne';

function makeEnv(extra = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ answer: 'Zivá odpoveď modelu.', products: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: 'admin-tajne',
    ASISTENT_ADMIN_ZAPIS: ZAPIS,
    MERANIE_TOKEN: 'meranie-tajne',
    UCET_TAJOMSTVO: 'dGVzdG92YWNpZS10YWpvbXN0dm8tcHJlLXJlbGFjaWU=',
    AI_DAILY_NEURON_BUDGET: '20000',
    ...extra,
  };
}

async function obchod(env, domain, zdroj = 'formular') {
  const t = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/feed.json`, contactEmail: `info@${domain}` });
  await setTenantStatus(env.DB, t.id, 'ready');
  env.DB._tenants.get(t.id).zdroj = zdroj;
  await env.VECTORIZE.upsert([
    { id: `${t.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: t.id, productId: 'p1', title: 'Colombia', url: `https://${domain}/colombia`, price: 12.5, currency: 'EUR', availability: 'in_stock' } },
  ]);
  return t;
}

function chat(tenant, { otazka = 'Máte kávu?', origin, ip = '9.9.9.9', telo = {} } = {}) {
  return new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: origin || `https://${tenant.domain}` },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: otazka }], lang: 'auto', ...telo }),
  });
}

function darcek(tenant, { ip = '9.9.9.9', interests = 'káva' } = {}) {
  return new Request('https://asistent.arling.sk/v1/gift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: `https://${tenant.domain}` },
    body: JSON.stringify({ tenant: tenant.id, recipient: 'mama', interests, budget_min: 0, budget_max: 100, lang: 'sk' }),
  });
}

const den = () => dayKey(new Date());
const pocet = (env, kluc) => (env.DB._pocty.get(kluc) || { hodnota: 0 }).hodnota;
async function nastav(env, kluc, mili) {
  await pripocitaj(env.DB, kluc, den(), 0);
  env.DB._pocty.get(kluc).hodnota = mili;
}
const modelCalls = (env) => env.AI.calls.filter((c) => c.model !== EMBED).length;
const embedCalls = (env) => env.AI.calls.filter((c) => c.model === EMBED).length;
const dlhaOtazka = (i) => `Otázka ${i}: ${'hľadám kávu s nízkou kyslosťou do moka kanvičky, '.repeat(12)}`.slice(0, 500);

// ---------------------------------------------------------------------------
// A. Vektory odpovedí bez modelu
// ---------------------------------------------------------------------------

test('A: sonda Astry: bezplatny obchod pri plnom bazene 2 700 odpovedi bez modelu nepohne ziadnym pocitadlom, Starter potom dostane model', async () => {
  // Strop 2 000: spoločné 80 % = 1 600, bazén neplatiacich 1 200, rezerva ukážok 400.
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '2000' });
  const free = await obchod(env, 'free.sk');
  const starter = await obchod(env, 'platiaci.sk');
  await setTenantPlan(env.DB, starter.id, { plan: 'starter' });
  await nastav(env, kluce.neurony(den()), 1600 * MILI);
  await nastav(env, kluce.neuronyFree(den()), 1200 * MILI);

  for (let i = 0; i < 2700; i += 1) {
    const r = await worker.fetch(chat(free, { otazka: dlhaOtazka(i), ip: `10.${(i >> 8) & 255}.${i & 255}.1` }), env, {});
    assert.equal(r.status, 200, `otázka ${i}`);
    if (i === 0) {
      const d = await r.json();
      assert.equal(d.meta.bezAi, true);
      assert.equal(d.meta.bezVypoctu, true, 'bez vektora');
      assert.deepEqual(d.products, []);
      assert.match(d.answer, /info@free\.sk/);
    }
  }
  assert.equal(embedCalls(env), 0, 'ani jeden vektor');
  assert.equal(modelCalls(env), 0);
  assert.equal(pocet(env, kluce.neurony(den())), 1600 * MILI, 'spoločné presne 1 600');
  assert.equal(pocet(env, kluce.neuronyFree(den())), 1200 * MILI, 'bazén presne 1 200');
  assert.equal(pocet(env, kluce.neuronyOslovenie(den())), 0);

  const p = await (await worker.fetch(chat(starter, { otazka: 'Otázka platiaceho?', ip: '90.0.0.1' }), env, {})).json();
  assert.equal(p.meta.bezAi, undefined, 'Starter dostal model');
  assert.equal(modelCalls(env), 1);
});

test('A: subeh odpovedi bez modelu tesne pod bazenom: vektorov len toľko, koľko sa zmestí, bazen ani spolocne nikdy nad limit', async () => {
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '2000' });
  const free = await obchod(env, 'free.sk');
  const jeden = vektorMili([dlhaOtazka(0)]);
  // Spoločné pri 80 % (stíšenie, režim bez modelu), bazén s miestom na 3 vektory.
  await nastav(env, kluce.neurony(den()), 1600 * MILI - 3 * jeden);
  await nastav(env, kluce.neuronyFree(den()), 1200 * MILI - 3 * jeden);
  // Rozhodnutie čítania chce aspoň odhad 150 pod stropom, inak bez modelu hneď.
  const odp = await Promise.all(Array.from({ length: 40 }, (_, i) => worker.fetch(chat(free, { otazka: dlhaOtazka(i), ip: `20.0.${i}.1` }), env, {})));
  const tela = await Promise.all(odp.map((r) => r.json()));
  assert.ok(odp.every((r) => r.status === 200));
  assert.equal(modelCalls(env), 0);
  const sVektorom = tela.filter((d) => !d.meta.bezVypoctu).length;
  assert.equal(sVektorom, embedCalls(env), 'každý vektor mal rezerváciu');
  assert.equal(sVektorom, 3, `vektorov ${sVektorom}, miesto presne na 3`);
  assert.ok(pocet(env, kluce.neuronyFree(den())) <= 1200 * MILI, `bazén ${pocet(env, kluce.neuronyFree(den())) / MILI}`);
  assert.ok(pocet(env, kluce.neurony(den())) <= 1600 * MILI, `spoločné ${pocet(env, kluce.neurony(den())) / MILI}`);
});

test('A: opakovane odpovede bez modelu (limit siete) s miestom v strope: kazdy vektor sa zapocita presne raz, nic sa nepripocita bez limitu', async () => {
  const env = makeEnv();
  const free = await obchod(env, 'free.sk');
  // Po piatich nových rozhovoroch z jednej siete ide obchod bez modelu (limit siete), strop má miesto.
  const tela = [];
  for (let i = 0; i < 16; i += 1) tela.push(await (await worker.fetch(chat(free, { otazka: `Otázka ${i}?`, ip: '30.0.0.1' }), env, {})).json());
  assert.equal(modelCalls(env), 5);
  const bez = tela.filter((d) => d.meta.bezAi);
  assert.equal(bez.length, 11);
  assert.ok(bez.every((d) => !d.meta.bezVypoctu && d.products.length === 1), 's miestom odpoveď bez modelu má vektor a produkty');
  const spolu = pocet(env, kluce.neurony(den()));
  const bazen = pocet(env, kluce.neuronyFree(den()));
  assert.equal(spolu, bazen, 'bazén a spoločné dostali to isté');
  assert.equal(embedCalls(env), 16, 'odpovede bez modelu mali vektor');
  assert.ok(spolu > 0);
});

test('A: darcek bez modelu pri plnom bazene nevola vektor a nic nezapocita', async () => {
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '2000' });
  const free = await obchod(env, 'free.sk');
  await nastav(env, kluce.neurony(den()), 1600 * MILI);
  await nastav(env, kluce.neuronyFree(den()), 1200 * MILI);
  for (let i = 0; i < 30; i += 1) {
    const r = await worker.fetch(darcek(free, { ip: `40.0.${i}.1`, interests: `káva ${i}` }), env, {});
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.deepEqual(d.picks, []);
    assert.equal(d.meta.bezAi, true);
  }
  assert.equal(embedCalls(env), 0);
  assert.equal(pocet(env, kluce.neurony(den())), 1600 * MILI);
  assert.equal(pocet(env, kluce.neuronyFree(den())), 1200 * MILI);
});

test('A: neuspesne dorezervovanie modelu (drahy prompt) necha vektor otazky zapocitany v rezervacii, nie nad strop', async () => {
  const dlhy = 'Káva s veľmi dlhým popisom z vlastného feedu. '.repeat(300);
  const AI = createMockAI({
    embedDim: 4,
    chatResponse: (input) => ({
      response: JSON.stringify({ answer: 'Zivá odpoveď modelu.', products: [] }),
      usage: { prompt_tokens: (input.messages || []).reduce((s, m) => s + new TextEncoder().encode(m.content).length, 0) + REZIA_SABLONY_TOKENOV, completion_tokens: input.max_tokens },
    }),
  });
  const env = makeEnv({ AI });
  const p = await obchod(env, 'platiaci.sk');
  await setTenantPlan(env.DB, p.id, { plan: 'pro' });
  await env.VECTORIZE.upsert([{ id: `${p.id}::p2::0`, values: [1, 0, 0, 0], metadata: { tenant: p.id, productId: 'p2', title: 'Drahá káva', url: 'https://platiaci.sk/draha', price: 9, currency: 'EUR', availability: 'in_stock', description: dlhy } }]);
  await nastav(env, kluce.neurony(den()), 19800 * MILI);
  const otazka = 'Máte zrnkovú kávu?';
  const d = await (await worker.fetch(chat(p, { otazka }), env, {})).json();
  assert.equal(modelCalls(env), 0);
  assert.equal(d.meta.bezAi, true);
  assert.equal(pocet(env, kluce.neurony(den())), 19800 * MILI + vektorMili([otazka]), 'presne vektor otázky');
  assert.equal(pocet(env, kluce.mili(p.id, den())), vektorMili([otazka]));
});

// ---------------------------------------------------------------------------
// C. Chyba D1 nie je minutý limit
// ---------------------------------------------------------------------------

function zlyhajRezervaciu(env, kedy) {
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql === POCTY_SQL.PRIDAJ_AK_POD && kedy()) throw new Error('D1_ERROR: simulovaný výpadok');
    return prepare(sql);
  };
}

const POLOZKY = { polozky: [{ otazka: 'Akú kávu odporúčate do moka kanvičky?', odpoved: 'Colombia.', karty: [] }] };

test('C: vypadok D1 pri prvotnej rezervacii: ukazka povie technicku chybu, nie limit (s pripravenymi otazkami aj bez nich)', async () => {
  for (const sPripravenymi of [true, false]) {
    const env = makeEnv();
    const t = await obchod(env, 'praziarenjolka.sk', 'oslovenie');
    if (sPripravenymi) await env.ASISTENT_CACHE.put(`overene:${t.id}`, JSON.stringify(POLOZKY));
    zlyhajRezervaciu(env, () => true);
    const d = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?', origin: 'https://arling.sk' }), env, {})).json();
    assert.equal(d.meta.ukazkaVycerpana, 'vypadok', `s pripravenými: ${sPripravenymi}`);
    assert.equal(d.answer, demoVycerpane('sk', sPripravenymi ? POLOZKY : null, 'vypadok').answer);
    assert.doesNotMatch(d.answer, /limit/);
    assert.equal(pocet(env, kluce.neurony(den())), 0);
    assert.equal(pocet(env, kluce.neuronyOslovenie(den())), 0);
  }
});

test('C: vypadok D1 pri dorezervovani pred modelom: technicka chyba, nie limit, model nebezal', async () => {
  for (const sPripravenymi of [true, false]) {
    const env = makeEnv();
    const t = await obchod(env, 'praziarenjolka.sk', 'oslovenie');
    if (sPripravenymi) await env.ASISTENT_CACHE.put(`overene:${t.id}`, JSON.stringify(POLOZKY));
    // Zlyhá až rezervácia po vektore otázky, teda dorezervovanie hornej hranice.
    zlyhajRezervaciu(env, () => embedCalls(env) > 0);
    const d = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?', origin: 'https://arling.sk' }), env, {})).json();
    assert.equal(modelCalls(env), 0);
    assert.equal(d.meta.ukazkaVycerpana, 'vypadok', `s pripravenými: ${sPripravenymi}`);
    assert.doesNotMatch(d.answer, /limit/);
  }
});

test('C: skutocne minuta rezerva ostava limit', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk', 'oslovenie');
  await nastav(env, kluce.neuronyOslovenie(den()), 3000 * MILI);
  const d = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?', origin: 'https://arling.sk' }), env, {})).json();
  assert.equal(d.meta.ukazkaVycerpana, 'limit');
});

// ---------------------------------------------------------------------------
// D. Záporné znamienko
// ---------------------------------------------------------------------------

test('D: -5 °C a 5 °C su rozne otazky, pripravena odpoved pre kladnu teplotu sa na zapornu nepouzije', () => {
  assert.equal(normalizujOtazku('Funguje pri -5 °C?'), 'funguje pri -5 c');
  assert.notEqual(normalizujOtazku('Funguje pri -5 °C?'), normalizujOtazku('Funguje pri 5 °C?'));
  assert.equal(normalizujOtazku('Funguje pri −10 °C?'), 'funguje pri -10 c', 'znak mínus U+2212');
  const kladna = { polozky: [{ otazka: 'Funguje pri 5 °C?' }] };
  assert.equal(najdiOverenu(kladna, 'Funguje pri -5 °C?'), null, 'sonda Astry');
  assert.ok(najdiOverenu(kladna, 'funguje pri 5 c'));
  const zaporna = { polozky: [{ otazka: 'Funguje pri -5 °C?' }] };
  assert.equal(najdiOverenu(zaporna, 'Funguje pri 5 °C?'), null);
  assert.ok(najdiOverenu(zaporna, 'Funguje pri −5 °C'));
  assert.equal(normalizujOtazku('Model X-5'), 'model x 5', 'pomlčka po písmene nie je znamienko');
});

// ---------------------------------------------------------------------------
// B. Cenová kontrola v Pythone (predohrej-ukazky.py)
// ---------------------------------------------------------------------------

test('B: predohrej-ukazky.py zastavi davku pri cene v beznom zapise (€3.90, 1 005.00 EUR): kod 1, nula PUT (Python)', (t) => {
  const skript = path.join(__dirname, 'predohrej_ceny_test.py');
  if (!fs.existsSync(path.join(__dirname, '../../../ops/oslovenia/predohrej-ukazky.py'))) return t.skip('ops/oslovenia nie je vedľa produktu');
  const r = spawnSync('python', ['-X', 'utf8', '-B', skript], { encoding: 'utf8' });
  if (r.error) return t.skip(`python sa nedá spustiť: ${r.error.code}`);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /Ran \d+ tests[\s\S]*OK/);
});

// ---------------------------------------------------------------------------
// Prvá otázka živej ukážky: len pripravená odpoveď, nikdy nič nemíňa
// ---------------------------------------------------------------------------

test('lenPripravene: pripravena otazka vrati ulozenu odpoved; nepripravena prazdnu bez modelu, vektora a pocitadiel', async () => {
  const env = makeEnv();
  const t = await obchod(env, 'praziarenjolka.sk', 'oslovenie');
  await env.ASISTENT_CACHE.put(`overene:${t.id}`, JSON.stringify(POLOZKY));
  const ok = await (await worker.fetch(chat(t, { otazka: 'Akú kávu odporúčate do moka kanvičky?', origin: 'https://arling.sk', telo: { lenPripravene: true } }), env, {})).json();
  assert.equal(ok.answer, 'Colombia.');
  assert.equal(ok.meta.overene, true);
  const nie = await (await worker.fetch(chat(t, { otazka: 'Máte zrnkovú kávu?', origin: 'https://arling.sk', telo: { lenPripravene: true } }), env, {})).json();
  assert.equal(nie.answer, '');
  assert.equal(nie.meta.nepripravene, true);
  const iny = await obchod(env, 'iny.sk');
  const nie2 = await (await worker.fetch(chat(iny, { telo: { lenPripravene: true } }), env, {})).json();
  assert.equal(nie2.meta.nepripravene, true);
  assert.equal(env.AI.calls.length, 0);
  assert.equal(pocet(env, kluce.neurony(den())), 0);
  assert.equal(env.DB._tenants.get(iny.id).used_this_month, 0);
});
