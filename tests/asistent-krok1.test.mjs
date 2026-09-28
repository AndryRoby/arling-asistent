// asistent-krok1.test.mjs
//
// Krok 1 asistenta (Andrej 28. 9. 2026), nález W1 posudku
// ops/ai/kontrola/2026-09-28-ukazka-pokus3.md: vykonaný platený výpočet
// (vektor, model) sa nesmie z počítadiel neurónov vrátiť pri neskoršej chybe
// ani pri internom odmietnutí, a nesmie sa započítať dvakrát.
//
// Invariant pre celú triedu: po každej požiadavke sa každé počítadlo neurónov
// zmení presne o cenu úspešne vykonaných volaní (spocitajNaklady nad tým, čo
// naozaj prebehlo). Testuje sa matica vetiev (chat, darček) × (chyba Vectorize,
// chyba modelu, chyba po modeli, interné odmietnutie, bežná odpoveď).

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import { createTenant, setTenantStatus, setTenantPlan, dayKey } from '../worker/src/tenants.js';
import { pripocitaj, kluce } from '../worker/src/pocty.js';
import { MILI, vektorMili, spocitajNaklady } from '../worker/src/budget.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const EMBED = '@cf/baai/bge-m3';
const MERANIE = 'meranie-tajne';

function makeEnv(extra = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ answer: 'Zivá odpoveď modelu.', products: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: 'admin-tajne',
    MERANIE_TOKEN: MERANIE,
    UCET_TAJOMSTVO: 'dGVzdG92YWNpZS10YWpvbXN0dm8tcHJlLXJlbGFjaWU=',
    AI_DAILY_NEURON_BUDGET: '20000',
    ...extra,
  };
}

async function obchod(env, domain, { plan = null, popis = '' } = {}) {
  const t = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/feed.json`, contactEmail: `info@${domain}` });
  await setTenantStatus(env.DB, t.id, 'ready');
  if (plan) await setTenantPlan(env.DB, t.id, { plan });
  await env.VECTORIZE.upsert([
    { id: `${t.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: t.id, productId: 'p1', title: 'Colombia', url: `https://${domain}/colombia`, price: 12.5, currency: 'EUR', availability: 'in_stock', description: popis } },
  ]);
  return t;
}

function chat(tenant, { otazka = 'Máte kávu?', ip = '9.9.9.9', hlavicky = {} } = {}) {
  return new Request('https://asistent.arling.sk/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: `https://${tenant.domain}`, ...hlavicky },
    body: JSON.stringify({ tenant: tenant.id, messages: [{ role: 'user', content: otazka }], lang: 'sk' }),
  });
}

function darcek(tenant, { ip = '9.9.9.9', interests = 'káva', hlavicky = {} } = {}) {
  return new Request('https://asistent.arling.sk/v1/gift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: `https://${tenant.domain}`, ...hlavicky },
    body: JSON.stringify({ tenant: tenant.id, recipient: 'mama', interests, budget_min: 0, budget_max: 100, lang: 'sk' }),
  });
}

const den = () => dayKey(new Date());
const pocet = (env, kluc) => (env.DB._pocty.get(kluc) || { hodnota: 0 }).hodnota;
async function nastav(env, kluc, mili) {
  await pripocitaj(env.DB, kluc, den(), 0);
  env.DB._pocty.get(kluc).hodnota = mili;
}
const embedy = (env) => env.AI.calls.filter((c) => c.model === EMBED);
const modely = (env) => env.AI.calls.filter((c) => c.model !== EMBED);
/** Cena všetkých úspešne vrátených vektorov v tisícinách, presne ako spocitajNaklady. */
const cenaVektorov = (texty) => spocitajNaklady({ vektory: texty }).mili;

const ZDROJE = {
  chat: (t, o = {}) => chat(t, { otazka: `Máte kávu číslo ${o.i ?? 0}?`, ...o }),
  darcek: (t, o = {}) => darcek(t, { interests: `káva ${o.i ?? 0}`, ...o }),
};

// ---------------------------------------------------------------------------
// 1. Výnimka Vectorize po úspešnom vektore (sonda Astry 1)
// ---------------------------------------------------------------------------

for (const [druh, poziadavka] of Object.entries(ZDROJE)) {
  for (const plan of [null, 'starter']) {
    test(`W1 ${druh} (${plan || 'free'}): Vectorize zlyha po uspesnom vektore, 5 x 500, cena 5 vektorov ostane v kazdom pocitadle`, async () => {
      const env = makeEnv();
      const t = await obchod(env, `${druh}-v.sk`, { plan });
      env.VECTORIZE.query = async () => { throw new Error('Vectorize: simulovaný výpadok'); };
      for (let i = 0; i < 5; i += 1) {
        const r = await worker.fetch(poziadavka(t, { i, ip: `11.0.${i}.1` }), env, {});
        assert.equal(r.status, 500, `požiadavka ${i}`);
      }
      assert.equal(embedy(env).length, 5);
      assert.equal(modely(env).length, 0);
      const cena = cenaVektorov(embedy(env).flatMap((c) => c.input.text));
      assert.ok(cena > 0);
      // Každý vektor sa počíta samostatne (každá požiadavka má svoj ceil).
      const poPoziadavkach = embedy(env).reduce((s, c) => s + cenaVektorov(c.input.text), 0);
      assert.equal(pocet(env, kluce.neurony(den())), poPoziadavkach, 'spoločné');
      assert.equal(pocet(env, kluce.mili(t.id, den())), poPoziadavkach, 'podiel obchodu');
      assert.equal(pocet(env, kluce.neuronyFree(den())), plan ? 0 : poPoziadavkach, 'bazén neplatiacich len pre free');
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Interné odmietnutie dorezervovania (sonda Astry 2): náš beh X-Arling-Meranie
// ---------------------------------------------------------------------------

for (const [druh, poziadavka] of Object.entries(ZDROJE)) {
  test(`W1 ${druh}: interny beh, dorezervovanie odmietnute, 40 x 429 a 40 vektorov ostane v spolocnom, bazene aj internom`, async () => {
    const env = makeEnv();
    const t = await obchod(env, `${druh}-m.sk`, { popis: 'Káva s veľmi dlhým popisom z vlastného feedu. '.repeat(300) });
    // Sonda Astry: 3 800 (chat, odhad 150). Darček má odhad 200 a pri 3 800 by ho
    // odmietlo už čítanie pred vektorom, preto 3 700: vektor prejde, model nie.
    const start = (druh === 'chat' ? 3800 : 3700) * MILI;
    for (const kluc of [kluce.neurony(den()), kluce.neuronyFree(den()), kluce.interne(den())]) await nastav(env, kluc, start);
    for (let i = 0; i < 40; i += 1) {
      const r = await worker.fetch(poziadavka(t, { i, ip: `13.0.${i}.1`, hlavicky: { 'X-Arling-Meranie': MERANIE } }), env, {});
      assert.equal(r.status, 429, `požiadavka ${i}`);
      assert.equal((await r.json()).error, 'interny_strop');
    }
    assert.equal(modely(env).length, 0, 'model nebežal');
    const n = embedy(env).length;
    assert.equal(n, 40, 'každá požiadavka vykonala vektor');
    const cena = embedy(env).reduce((s, c) => s + cenaVektorov(c.input.text), 0);
    for (const kluc of [kluce.neurony(den()), kluce.neuronyFree(den()), kluce.interne(den())]) {
      assert.equal(pocet(env, kluc), start + cena, kluc);
    }
    assert.equal(pocet(env, kluce.mili(t.id, den())), 0, 'podiel obchodu náš beh neberie');
  });
}

// ---------------------------------------------------------------------------
// 3. Chyba samotného modelu: vektor ostane, model sa neúčtuje
// ---------------------------------------------------------------------------

for (const [druh, poziadavka] of Object.entries(ZDROJE)) {
  test(`W1 ${druh}: model hodi vynimku, ostane presne cena vektorov`, async () => {
    const AI = createMockAI({ embedDim: 4, chatResponse: () => { throw new Error('4006: daily limit'); } });
    const env = makeEnv({ AI });
    const t = await obchod(env, `${druh}-e.sk`);
    const r = await worker.fetch(poziadavka(t), env, {});
    assert.equal(r.status, 500);
    const cena = cenaVektorov(embedy(env).flatMap((c) => c.input.text));
    assert.equal(pocet(env, kluce.neurony(den())), cena);
    assert.equal(pocet(env, kluce.neuronyFree(den())), cena);
    assert.equal(pocet(env, kluce.mili(t.id, den())), cena);
  });
}

// ---------------------------------------------------------------------------
// 4. Model prebehol, zlyhá až spracovanie odpovede: vektor aj model ostanú
// ---------------------------------------------------------------------------

for (const [druh, poziadavka] of Object.entries(ZDROJE)) {
  test(`W1 ${druh}: vynimka az po modeli, ostane cena vektorov aj modelu (z usage)`, async () => {
    const usage = { prompt_tokens: 900, completion_tokens: 120 };
    const AI = createMockAI({
      embedDim: 4,
      chatResponse: () => ({ usage, get response() { throw new Error('rozbitá odpoveď'); } }),
    });
    const env = makeEnv({ AI });
    const t = await obchod(env, `${druh}-p.sk`);
    const r = await worker.fetch(poziadavka(t), env, {});
    assert.equal(r.status, 500);
    assert.equal(modely(env).length, 1);
    const ocakavane = spocitajNaklady({
      vektory: embedy(env).flatMap((c) => c.input.text),
      volania: [{ model: modely(env)[0].model, modelResponse: { usage }, vstupText: '', vystupText: '' }],
    }).mili;
    assert.ok(ocakavane > cenaVektorov(embedy(env).flatMap((c) => c.input.text)));
    assert.equal(pocet(env, kluce.neurony(den())), ocakavane);
    assert.equal(pocet(env, kluce.mili(t.id, den())), ocakavane);
  });
}

// ---------------------------------------------------------------------------
// 5. Nie dvakrát: chyba, potom bežná odpoveď; súčet presne sedí
// ---------------------------------------------------------------------------

for (const [druh, poziadavka] of Object.entries(ZDROJE)) {
  test(`W1 ${druh}: chyba Vectorize a potom bezna odpoved, pocitadlo = presne sucet vykonanych volani`, async () => {
    const env = makeEnv();
    const t = await obchod(env, `${druh}-d.sk`);
    const query = env.VECTORIZE.query.bind(env.VECTORIZE);
    let zlyhaj = true;
    env.VECTORIZE.query = async (...a) => { if (zlyhaj) throw new Error('výpadok'); return query(...a); };
    assert.equal((await worker.fetch(poziadavka(t, { i: 1, ip: '12.0.0.1' }), env, {})).status, 500);
    const poChybe = pocet(env, kluce.neurony(den()));
    assert.equal(poChybe, cenaVektorov(embedy(env).flatMap((c) => c.input.text)));
    zlyhaj = false;
    const pred = env.AI.calls.length;
    const r = await worker.fetch(poziadavka(t, { i: 2, ip: '12.0.0.2' }), env, {});
    assert.equal(r.status, 200);
    const nove = env.AI.calls.slice(pred);
    // Druhá požiadavka: jej skutočná cena z mocku (bez usage sa počíta z textu).
    const druha = spocitajNaklady({
      vektory: nove.filter((c) => c.model === EMBED).flatMap((c) => c.input.text),
      volania: nove.filter((c) => c.model !== EMBED).map((c) => ({
        model: c.model,
        modelResponse: { response: JSON.stringify(druh === 'chat' ? { answer: 'Zivá odpoveď modelu.', products: [] } : { answer: 'Zivá odpoveď modelu.', products: [] }) },
        vstupText: c.input.messages.map((m) => m.content).join(''),
        vystupText: JSON.stringify({ answer: 'Zivá odpoveď modelu.', products: [] }),
      })),
    }).mili;
    assert.equal(pocet(env, kluce.neurony(den())), poChybe + druha, 'spoločné = chyba + bežná, nič navyše ani menej');
    assert.equal(pocet(env, kluce.neuronyFree(den())), poChybe + druha);
  });
}

// ---------------------------------------------------------------------------
// 6. Bez modelu (bazén plný): vektor rezervovaný, potom zlyhá Vectorize
// ---------------------------------------------------------------------------

test('W1 chat bez modelu: rezervovany vektor a zlyhany Vectorize, vektor ostane raz, nie dvakrat', async () => {
  const env = makeEnv({ AI_DAILY_NEURON_BUDGET: '2000' });
  const t = await obchod(env, 'bez.sk');
  // Spoločné pri 80 %: bezplatný obchod ide bez modelu, bazén má miesto.
  await nastav(env, kluce.neurony(den()), 1600 * MILI - 10 * MILI);
  env.VECTORIZE.query = async () => { throw new Error('výpadok'); };
  const r = await worker.fetch(chat(t, { otazka: 'Máte kávu?' }), env, {});
  assert.equal(r.status, 500);
  assert.equal(embedy(env).length, 1);
  assert.equal(pocet(env, kluce.neurony(den())), 1600 * MILI - 10 * MILI + vektorMili(['Máte kávu?']));
  assert.equal(pocet(env, kluce.neuronyFree(den())), vektorMili(['Máte kávu?']));
});
