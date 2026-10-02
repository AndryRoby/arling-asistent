// kvalita-2026-10-01.test.mjs
//
// Kvalita ukážok Asistenta (1. 10. 2026, ops/asistent/kvalita-2026-10-01/DIAGNOZA.md a OPRAVA.md):
// hybridné vyhľadávanie s kategóriou a slovenskými tvarmi, vekový filter, vecná zhoda kariet, kontrola
// textu (azbuka, chyby slovenčiny, kontakt, ponuka otázok) s jedným opakovaním a bezpečnou odpoveďou,
// jazyk otázky v režime auto. Názvy, kategórie a úryvky popisov sú zo skutočných feedov ukážok z 1. 10.
// (ops/oslovenia/feedy), odpovede modelu sú zo živých behov 1. 10. (priprav-davku.py 2026-10-01 --nahlad).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  kmen, zhodaKmenov, vekZOtazky, vekProduktu, klucoveSlova, vyberKandidatov, rozdelKarty, dekodujEntity,
  textMenujeProdukt, skupinaVariantu, VAHA_SLOV,
} from '../worker/src/hladanie.js';
import { buildProductChunks, kategoriaDoTextu, CHUNK_MAX_CHARS } from '../worker/src/embed.js';
import { normaliseProduct } from '../worker/src/feed.js';
import {
  runChat, runChatBezAI, buildSystemPrompt, kontrolaTextu, bezVatyVsade, polishAnswer, urciJazykOtazky, jeMetaOtazka,
  pismoMimoLatinky, prisnyPokyn, noMatchFallback, POOL_K, TOP_K, CHAT_MODEL_OPTIONS,
} from '../worker/src/chat.js';
import { dorezervujOpakovanie } from '../worker/src/ochrana.js';
import { kluce } from '../worker/src/pocty.js';
import { dayKey, createTenant, setTenantStatus } from '../worker/src/tenants.js';
import worker from '../worker/src/index.js';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';
import { createMockD1 } from './helpers/mock-d1.mjs';

const EMBED = '@cf/baai/bge-m3';

// ---------------------------------------------------------------------------
// Pomocníci: kandidáti s rovnakým vektorom (poradie rozhodne zhoda slov), model po volaniach
// ---------------------------------------------------------------------------

function produkt(id, title, extra = {}) {
  return { productId: id, title, url: `https://obchod.sk/${id}`, price: 1.2, currency: 'EUR', availability: 'in_stock', category: '', description: '', ...extra };
}

async function vektory(tenant, produkty, skore = null) {
  const v = createMockVectorize();
  await v.upsert(produkty.map((p) => ({ id: `${tenant}::${p.productId}::0`, values: [1, 0, 0, 0], metadata: { tenant, ...p } })));
  if (skore) {
    // pevné skóre kosínusu ako z bge-m3 (lokálne 1. 10. 2026), nie z falošného vektora
    const query = v.query.bind(v);
    v.query = async (vec, opts) => {
      const { matches } = await query(vec, opts);
      return { matches: matches.map((m) => ({ ...m, score: skore[produkty.findIndex((p) => m.id.endsWith(`::${p.productId}::0`))] })).sort((a, b) => b.score - a.score) };
    };
  }
  return v;
}
// Skóre z lokálneho bge-m3 pre otázku na korenie na grilovanie (eval 1. 10. 2026): bp, gp, gu, bm, po, kn.
const SKORE_MASPOMA = [0.596, 0.537, 0.535, 0.533, 0.534, 0.518];

/** Model, ktorý na n-té volanie chatu vráti n-tú odpoveď (posledná sa opakuje). */
function model(odpovede) {
  let n = 0;
  return createMockAI({
    embedDim: 4,
    chatResponse: () => {
      const o = odpovede[Math.min(n, odpovede.length - 1)];
      n += 1;
      return typeof o === 'string' ? o : JSON.stringify(o);
    },
  });
}
const chatVolania = (ai) => ai.calls.filter((c) => c.model !== EMBED);

const MASPOMA = [
  produkt('bp', 'Bravčové pečené 30g', { description: 'Zloženie/info Soľ, cesnak, rasca, paprika sladká, koriander, korenie čierne. Recept/použitie Bravčové pečené s knedľou a kapustou Ingrediencie: 1 kg bravčového mäsa, marinádou potrieme bravčové mäso. Pečieme vo vyhriatej rúre.' }),
  produkt('gp', 'Gril party 25g', { description: 'Zloženie/info Soľ, paprika sladká, cibuľa, cesnak, korenie čierne, rozmarín. Recept/použitie Grilované mäso so zeleninou a cesnakovým dresingom Ingrediencie: 1 kg mäsa, zmes MÄSPOMA Gril-párty. Do marinády poukladáme mäso.' }),
  produkt('gu', 'Guláš 25g', { description: 'Zloženie/info Paprika sladká, soľ, rasca, korenie čierne, cibuľa, cesnak. Recept/použitie Gulášové mäsko Ingrediencie: 1 kg bravčového mäsa, zmes MÄSPOMA Guláš. Mäso dusíme domäkka.' }),
  produkt('bm', 'Bio Minútky na mäso 20g', { description: 'Univerzálna zmes korenia bez pridanej soli, vhodná na pečenie, varenie, dusenie alebo grilovanie všetkých druhov mäsa.' }),
  produkt('po', 'Polievkové korenie 170ml', { description: 'Výborné dochucovadlo pre teplú aj studenú kuchyňu. Korenie je určené na ochucovanie polievok a omáčok.' }),
  produkt('kn', 'Korenie nové celé 500g', { description: 'Nové korenie celé, korenie do omáčok a marinád k mäsu.' }),
];
const OTAZKA_MASPOMA = 'Ktoré korenie odporúčate na grilovanie bravčového mäsa?';

// ---------------------------------------------------------------------------
// 1. Slovenské tvary a kľúčové slová
// ---------------------------------------------------------------------------

test('kmen spojí slovenské tvary toho istého slova, aj nepravidelné (dieťa, deti, detské)', () => {
  assert.equal(kmen('bravčového'), 'bravc');
  assert.equal(kmen('Bravčové'), 'bravc');
  assert.equal(kmen('mäsa'), kmen('mäso'));
  assert.equal(kmen('fóliu'), kmen('fólie'));
  assert.equal(kmen('fóliou'), 'fol');
  assert.equal(kmen('whisky'), kmen('whiskey'));
  assert.equal(kmen('dieťa'), kmen('deti'));
  assert.equal(kmen('detské'), kmen('dieťaťa'));
  assert.equal(kmen('mačku'), kmen('mačací'));
  assert.equal(kmen('darček'), kmen('darčekové'));
  assert.equal(kmen('v60'), 'v60'); // s číslicou bez zmeny
});

test('zhodaKmenov: spoločný začiatok, prvých 5 znakov a kostra spoluhlások; káva nie je kávovar', () => {
  assert.ok(zhodaKmenov('gril', kmen('grilovanie')));
  assert.ok(zhodaKmenov(kmen('grilovanie'), kmen('grilovacia')));
  assert.ok(zhodaKmenov(kmen('filter'), kmen('filtre')));
  assert.ok(zhodaKmenov(kmen('stáčanie'), kmen('stáčacia')));
  assert.ok(zhodaKmenov(kmen('obrúsok'), kmen('obrúsky')));
  assert.ok(!zhodaKmenov(kmen('káva'), kmen('kávovar')));
  assert.ok(!zhodaKmenov(kmen('potravinovú'), kmen('potrebujete')));
  assert.ok(!zhodaKmenov('v60', 'v600'));
});

test('vek z otázky len pri otázke o deťoch; „ročné“ sa nestane kľúčovým slovom (Ročné obdobia)', () => {
  assert.equal(vekZOtazky('Čo sa hodí ako darček pre ročné dieťa?').roky, 1);
  assert.equal(vekZOtazky('Ktorá hra rozvíja logické myslenie päťročného dieťaťa?').roky, 5);
  assert.equal(vekZOtazky('Hľadám spoločenskú hru pre rodinu s deťmi od 6 rokov.').roky, 6);
  assert.equal(vekZOtazky('Hračka pre 6-mesačné bábätko?').roky, 0.5);
  assert.equal(vekZOtazky('Máte 12-ročnú whisky ako darček?'), null);
  assert.equal(vekZOtazky('Ktorá káva sa hodí na prípravu cez filter?'), null);
  const { kluce: k, vek } = klucoveSlova('Čo sa hodí ako darček pre ročné dieťa?');
  assert.equal(vek.roky, 1);
  assert.ok(k.includes(kmen('darček')));
  assert.ok(!k.some((x) => x.startsWith('rocn')), k.join(','));
});

test('vek výrobku z názvu a popisu: 3+, 18m+, od 3 do 8 rokov, nevhodné pre deti do 3 rokov; akcie a počty nie', () => {
  assert.deepEqual(vekProduktu({ title: 'Magnetibook Ročné obdobia 3+' }), { min: 3, max: null });
  assert.deepEqual(vekProduktu({ title: 'Magnetické rybičky 18m+' }), { min: 1.5, max: null });
  assert.deepEqual(vekProduktu({ title: 'Magnetibook', description: 'Hra pre deti od 3 do 8 rokov.' }), { min: 3, max: 8 });
  assert.deepEqual(vekProduktu({ title: 'Kocky', description: 'Nevhodné pre deti do 3 rokov.' }), { min: 3, max: null });
  assert.equal(vekProduktu({ title: 'Plienky 2+1 zdarma' }), null);
  assert.equal(vekProduktu({ title: 'Sada 50+ kociek' }), null);
  assert.equal(vekProduktu({ title: 'Prvá stavebnica Krúžky 1+' }).min, 1);
});

test('účel otázky: z „na grilovanie bravčového mäsa“ platí grilovanie (prvé rozlišujúce slovo)', () => {
  const { ucelSkupiny } = klucoveSlova(OTAZKA_MASPOMA);
  assert.deepEqual(ucelSkupiny, [[kmen('grilovanie'), kmen('bravčového')]]);
  const { kontext } = vyberKandidatov(OTAZKA_MASPOMA, MASPOMA.map((p) => ({ ...p, id: p.productId, score: 0.55 })));
  assert.deepEqual(kontext.ucel, [kmen('grilovanie')]);
});

test('dekodujEntity a kategória do textu vektora', () => {
  assert.equal(dekodujEntity('Doplnky &gt; Voskové obrúsky'), 'Doplnky > Voskové obrúsky');
  assert.equal(dekodujEntity('Tom &amp; Jerry &#39;s &#x41;'), "Tom & Jerry 's A");
  assert.equal(dekodujEntity('&neznama; ostane'), '&neznama; ostane');
  assert.equal(kategoriaDoTextu({ title: 'X', category: 'Doplnky &gt; Voskové obrúsky' }), 'Doplnky > Voskové obrúsky');
  assert.equal(kategoriaDoTextu({ title: 'Káva', category: 'Káva' }), '');
});

// ---------------------------------------------------------------------------
// 2. Text vektora s kategóriou (embed.js)
// ---------------------------------------------------------------------------

test('embed: kategória ide do textu vektora (káva na filter bez slova káva v názve), bez kategórie text ako doteraz', () => {
  const kava = { id: 'k1', title: 'Etiópia Keramo Adara Filter, 250g, Van Gülpen', description: '', category: 'Van Gülpen – výberová káva z Nemecka' };
  const [kus] = buildProductChunks(kava);
  assert.equal(kus.text, 'Etiópia Keramo Adara Filter, 250g, Van Gülpen\nVan Gülpen – výberová káva z Nemecka');
  assert.equal(kus.metadata.category, kava.category); // metadáta bez zmeny
  const obrus = buildProductChunks({ id: 'v', title: 'VčeloVak M - Lúčne kvety', description: 'Voskový obrúsok ako alternatíva potravinovej fólie.', category: 'Doplnky &gt; Voskové obrúsky' })[0];
  assert.equal(obrus.text, 'VčeloVak M - Lúčne kvety\nDoplnky > Voskové obrúsky\n\nVoskový obrúsok ako alternatíva potravinovej fólie.');
  const bez = buildProductChunks({ id: 'b', title: 'Modre tenisky', description: 'Pohodlne behanie.' })[0];
  assert.equal(bez.text, 'Modre tenisky\n\nPohodlne behanie.');
});

test('embed: produkt z feedu ostane jedným kusom do 800 znakov aj s kategóriou, dlhý surový popis sa delí ako doteraz', () => {
  for (const dlzkaPopisu of [0, 300, 599, 600, 601, 5000]) {
    const p = normaliseProduct({ id: 'x', title: 'č'.repeat(250), description: 'p '.repeat(dlzkaPopisu), category: `Kategória ${'k'.repeat(300)}` });
    const kusy = buildProductChunks(p);
    assert.equal(kusy.length, 1, String(dlzkaPopisu));
    assert.ok(kusy[0].text.length <= CHUNK_MAX_CHARS, `${dlzkaPopisu}: ${kusy[0].text.length}`);
    assert.ok(kusy[0].text.includes('Kategória'), String(dlzkaPopisu));
  }
  const dlhy = buildProductChunks({ id: 'd', title: 'Kabat Zimny', description: 'x '.repeat(500), category: 'Oblečenie' });
  assert.ok(dlhy.length > 1);
  for (const c of dlhy) assert.match(c.text, /Kabat Zimny/);
});

// ---------------------------------------------------------------------------
// 3. Hybridný výber kandidátov
// ---------------------------------------------------------------------------

test('vyberKandidatov: vekový filter vyradí hračky 3+ pri otázke na ročné dieťa (rozumnehracky.sk 1. 10.)', () => {
  const pool = [
    { id: 'a', title: 'Magnetibook Ročné obdobia 3+', category: 'Magnetické knihy Janod Magnetibook', description: 'Pre deti od 3 do 8 rokov.', score: 0.6 },
    { id: 'b', title: 'Drevené kocky s obrázkami Krtkov rok 12 kusov 3+', category: '2kids Toys', score: 0.59 },
    { id: 'c', title: 'Prvá stavebnica Krúžky 1+', category: 'Kreatívne stavebnice pre deti', score: 0.55 },
    { id: 'd', title: 'Mozaika FantaColor Baby PlayBio 1+', category: 'Kreatívne hračky', score: 0.54 },
    { id: 'e', title: 'Senzorická busy kniha', category: '2kids Toys', score: 0.53 },
  ];
  const { kandidati, kontext } = vyberKandidatov('Čo sa hodí ako darček pre ročné dieťa?', pool, { limit: 8 });
  assert.deepEqual(kandidati.map((c) => c.id), ['c', 'd', 'e']);
  assert.equal(kontext.vek.roky, 1);
});

test('vyberKandidatov: pri rovnako blízkych vektoroch rozhodne zhoda slov aj s kategóriou (káva na filter pred papierovými filtrami)', () => {
  const pool = [
    { id: 'f1', title: 'Hario V60-02 papierové filtre 40ks - Natural', category: 'Hario V60 – kávovar (dripper) a filtre', score: 0.552 },
    { id: 'f2', title: 'Fellow - Aiden - Filter Coffee Machine', category: 'Prekvapkávacie kávovary a Drip', score: 0.551 },
    { id: 'k1', title: 'Etiópia Keramo Adara Filter, 250g, Van Gülpen', category: 'Van Gülpen – výberová káva z Nemecka', score: 0.55 },
    { id: 'e1', title: 'Pedron Caffé Supremo 70% Arabika', category: 'Káva', description: 'Zrnková káva pre espresso aj filter.', score: 0.53 },
  ];
  const { kandidati } = vyberKandidatov('Ktorá káva sa hodí na prípravu cez filter?', pool, { limit: 8 });
  assert.equal(kandidati[0].id, 'k1');
  assert.ok(VAHA_SLOV > 0 && VAHA_SLOV <= 0.12);
});

test('vyberKandidatov: tretí a ďalší variant toho istého výrobku ide za iné výrobky s takmer rovnakým skóre', () => {
  const pool = [1, 2, 3, 4, 5].map((i) => ({ id: `h${i}`, title: `Hario V60-02 dripper keramický, farba ${i}`, score: 0.6 - i * 0.001 }))
    .concat([{ id: 'x', title: 'Fellow Stagg kanvica', score: 0.585 }, { id: 'y', title: 'Hario Skerton mlynček', score: 0.584 }]);
  const { kandidati } = vyberKandidatov('Čo odporúčate?', pool, { limit: 8 }); // bez kľúčových slov rozhoduje vektor a postih variantov
  assert.deepEqual(kandidati.slice(0, 4).map((c) => c.id), ['h1', 'h2', 'x', 'y']);
  assert.equal(kandidati.length, 7); // nikto nevypadol, len poradie
  assert.equal(skupinaVariantu('Voskové obrúsky Včelobal M - Folklór'), skupinaVariantu('Voskové obrúsky Včelobal M - Turista'));
});

test('vyberKandidatov: kandidát ďaleko za najlepším ide len do počtu troch', () => {
  const pool = [0.7, 0.69, 0.68, 0.45, 0.44].map((s, i) => ({ id: `p${i}`, title: `Produkt ${i}`, score: s }));
  assert.equal(vyberKandidatov('niečo', pool).kandidati.length, 3);
  assert.equal(vyberKandidatov('niečo', pool.slice(3)).kandidati.length, 2);
});

// ---------------------------------------------------------------------------
// 4. Vecná zhoda kariet
// ---------------------------------------------------------------------------

test('karty: Guláš ako druhá karta ku korenia na grilovanie vypadne, Gril party ostane (maspoma.sk 1. 10.)', () => {
  const pool = MASPOMA.map((p, i) => ({ ...p, id: p.productId, score: 0.6 - i * 0.01 }));
  const { kontext } = vyberKandidatov(OTAZKA_MASPOMA, pool);
  const karta = (id) => pool.find((p) => p.id === id);
  let r = rozdelKarty(kontext, [karta('gp'), karta('gu')]);
  assert.deepEqual(r.ok.map((k) => k.id), ['gp']);
  assert.deepEqual(r.mimo.map((k) => k.id), ['gu']);
  r = rozdelKarty(kontext, [karta('bp'), karta('gu')]);
  assert.deepEqual(r.mimo.map((k) => k.id), ['gu']);
  r = rozdelKarty(kontext, [karta('bp'), karta('gp'), karta('bm')]);
  assert.deepEqual(r.ok.map((k) => k.id), ['bp', 'gp', 'bm']);
  r = rozdelKarty(kontext, [karta('po')]);
  assert.deepEqual(r.mimo.map((k) => k.id), ['po']); // polievkové korenie nesúvisí s grilovaním ani bravčovým
});

test('karty: Glenfiddich ku whisky ako darček ostane (kategória Destiláty, „single malt whisky“ len v popise)', () => {
  const pool = [
    { id: 'g', title: 'Glenfiddich 12-ročná, tuba, 40 %, 0,7 l', category: 'Destiláty', description: 'Glenfiddich je najpopulárnejšou single malt whisky na svete.', score: 0.55 },
    { id: 't', title: 'Tariquet XO, darčekové balenie, 0,7 l', category: 'Destiláty > Armaňak', score: 0.55 },
    { id: 'l', title: 'Loch Lomond 12-ročná, darčekové balenie, 46 %, 0,7 l', category: 'Destiláty', description: 'Single malt whisky.', score: 0.6 },
  ];
  const { kontext } = vyberKandidatov('Ktorú whisky by ste odporučili ako darček?', pool);
  assert.deepEqual(rozdelKarty(kontext, [pool[0]]).ok.map((k) => k.id), ['g']);
  assert.deepEqual(rozdelKarty(kontext, [pool[2], pool[0]]).ok.map((k) => k.id), ['l', 'g']);
});

test('karty: bez dôkazu z textu (žiadny kandidát nemá slovo z otázky) sa nič nevyraďuje', () => {
  const pool = [{ id: 'a', title: 'Medovina', score: 0.5 }, { id: 'b', title: 'Sviečka', score: 0.49 }];
  const { kontext } = vyberKandidatov('Čo kúpiť otcovi, ktorý rád varí?', pool);
  assert.equal(rozdelKarty(kontext, pool).ok.length, 2);
});

test('karty: bez slova z otázky ostane karta, ktorá je vektorom tak blízko ako súvisiaci kandidát (lokálne 6 zo 43 správnych kariet by inak vypadlo)', () => {
  // wineexpert.sk: Tramín červený (biele víno) má slovo „červený“, Frankovka modrá a Cabernet nie, a vektorom sú bližšie
  const vina = [
    { id: 'tr', title: 'PD Mojmírovce, Tramín červený, 2017, 0,75 l', category: 'Víno > Slovensko > PD Mojmírovce', score: 0.553 },
    { id: 'fr', title: 'Golguz, Veselé víno Frankovka modrá, 2021, 0,75 l', category: 'Víno > Slovensko > Golguz', score: 0.565 },
    { id: 'ca', title: 'Chateau Modra, Terroir Cabernet Sauvignon, NV, 0,75 l', category: 'Víno > Slovensko > Chateau Modra', score: 0.57 },
    { id: 'sp', title: 'Nichta, Classic Sparkling Rosé, 2024, 0,75 l', category: 'Víno > Slovensko > Nichta', score: 0.5 },
    { id: 'ri', title: 'Vinárstvo Karpatská Perla, Rizling vlašský, 2022, 0,75 l', category: 'Víno > Slovensko > Karpatská Perla', score: 0.51 },
    { id: 've', title: 'Mrva & Stanko, Veltlínske zelené, 2023, 0,75 l', category: 'Víno > Slovensko > Mrva & Stanko', score: 0.505 },
  ];
  let { kontext } = vyberKandidatov('Hľadám suché červené víno zo Slovenska, čo máte?', vina);
  assert.deepEqual(rozdelKarty(kontext, [vina[1], vina[2]]).ok.map((k) => k.id), ['fr', 'ca']);
  assert.deepEqual(rozdelKarty(kontext, [vina[3]]).mimo.map((k) => k.id), ['sp']); // ďaleko a bez slova
  // rozumnehracky.sk: hračka 1+ bez slova „darček“ ostane, keď je blízko kandidáta s ním
  const hracky = [
    { id: 'ld', title: 'Little Dutch Magnetická hra - Obleč Jima a Rosu', description: 'Krásny darček.', score: 0.461 },
    { id: 'kr', title: 'Prvá stavebnica Krúžky 1+', category: 'Kreatívne stavebnice pre deti', score: 0.5 },
    { id: 'mg', title: 'Magnetibook Ročné obdobia 3+', score: 0.6 },
  ];
  ({ kontext } = vyberKandidatov('Čo sa hodí ako darček pre ročné dieťa?', hracky));
  assert.deepEqual(rozdelKarty(kontext, [hracky[1]]).ok.map((k) => k.id), ['kr']);
  assert.deepEqual(rozdelKarty(kontext, [hracky[2]]).mimo.map((k) => k.id), ['mg']); // vek 3+ nikdy
});

test('textMenujeProdukt: celý názov, časť pred čiarkou alebo prvé dve slová', () => {
  assert.ok(textMenujeProdukt('Odporúčame Gril party 25g alebo Guláš 25g.', 'Guláš 25g'));
  assert.ok(textMenujeProdukt('Skúste Glenfiddich 12-ročná, ide o klasiku.', 'Glenfiddich 12-ročná, tuba, 40 %, 0,7 l'));
  assert.ok(!textMenujeProdukt('Odporúčame Gril party 25g.', 'Guláš 25g'));
});

// ---------------------------------------------------------------------------
// 5. Kontrola textu, vata, prompty
// ---------------------------------------------------------------------------

test('kontrolaTextu: azbuka v slove (pipers.sk „produkтом“), chyba „Môžete nahradíte“, kontakt a ponuka otázok', () => {
  assert.deepEqual(kontrolaTextu('Na začiatok je vhodný PAEX BARF Mix, ktorý je ideálnym produkтом na prechod.', { jazyk: 'sk' }), ['pismo']);
  assert.deepEqual(kontrolaTextu('Môžete nahradíte potravinovú fóliu voskovým obrúskom.', { jazyk: 'sk' }), ['chyba_sk']);
  assert.deepEqual(kontrolaTextu('Potravinovú fóliu môžete nahradiť voskovým obrúskom VčeloVak.', { jazyk: 'sk' }), []);
  assert.deepEqual(kontrolaTextu('Doporučujeme kávu Brazília.', { jazyk: 'sk' }), ['chyba_sk']);
  assert.deepEqual(kontrolaTextu('Na našom webe nenájdete pracovný prostriedok, ale môžete skúsiť kontaktovať našu stránku.', { jazyk: 'sk' }), ['kontakt']);
  assert.deepEqual(kontrolaTextu('Máme kontaktné šošovky aj kontaktný gril.', { jazyk: 'sk' }), []);
  assert.deepEqual(kontrolaTextu('Odporúčame Gril party. Môžete sa spýtať aj na marinády.', { jazyk: 'sk' }), ['otazky']);
  assert.deepEqual(kontrolaTextu('Som asistent obchodu. Môžete sa spýtať napríklad na marinády.', { jazyk: 'sk', meta: true }), []);
  assert.deepEqual(kontrolaTextu('Please contact the shop for details.', { jazyk: 'en' }), ['kontakt']);
});

test('kontrolaTextu: český názov výrobku na karte nie je chyba, ukrajinský zákazník smie dostať azbuku, zmiešané slovo nikdy', () => {
  assert.deepEqual(kontrolaTextu('Na zelený čaj odporúčame Konvička Kyusu Hnědá 300 ml.', { jazyk: 'sk', candidates: [{ title: 'Konvička Kyusu Hnědá 300 ml' }] }), []);
  assert.ok(!pismoMimoLatinky('Рекомендуємо каву Бразилія.', 'Яку каву ви порадите?'));
  assert.ok(pismoMimoLatinky('Рекомендуємо каву Бразилія.', 'Akú kávu odporúčate?'));
  assert.ok(pismoMimoLatinky('produkтом', 'Яку каву ви порадите?'));
});

test('bezVatyVsade odstrihne vetu s kontaktom či otázkami aj uprostred, vetu s výrobkom alebo cenou nechá', () => {
  const kandidati = [{ title: 'Gril party 25g' }];
  assert.equal(
    bezVatyVsade('Na grilovanie odporúčame Gril party 25g za 1,20 €. Ak máte ďalšie otázky, kontaktujte nás. Zmes je vhodná aj na zeleninu a hodí sa do marinády.', kandidati),
    'Na grilovanie odporúčame Gril party 25g za 1,20 €. Zmes je vhodná aj na zeleninu a hodí sa do marinády.');
  assert.equal(bezVatyVsade('Áno, máme. Ak máte ďalšie otázky, pýtajte sa.', []), 'Áno, máme. Ak máte ďalšie otázky, pýtajte sa.'); // zvyšok by bol krátky
  assert.equal(bezVatyVsade('Gril party 25g odporúčame, ak máte otázky, kontaktujte nás.', kandidati), 'Gril party 25g odporúčame, ak máte otázky, kontaktujte nás.');
});

test('polishAnswer opraví „nahradíť“ a „Obe produkty“ (živé odpovede 28. 9. a 1. 10.)', () => {
  assert.equal(polishAnswer('Fóliu nahradíť môžete voskovým obrúskom.', 'sk'), 'Fóliu nahradiť môžete voskovým obrúskom.');
  assert.equal(polishAnswer('Obe produkty sú skladom.', 'sk'), 'Oba produkty sú skladom.');
  assert.equal(polishAnswer('Fóliu nahradíť.', 'en'), 'Fóliu nahradíť.'); // iný jazyk sa neopravuje
});

test('prompty: zákaz kontaktu a „Môžete sa spýtať“, len súvisiace výrobky, latinka; auto už neposiela na kontakt', () => {
  assert.match(buildSystemPrompt('sk'), /nikdy nepíš kontakt/);
  assert.match(buildSystemPrompt('sk'), /„Môžete sa spýtať…“/);
  assert.match(buildSystemPrompt('sk'), /nikdy nie azbukou/);
  assert.doesNotMatch(buildSystemPrompt('sk'), /môžete nahradiť/); // vzor spôsoboval „Môžete nahradiť“ v odpovediach (kvalita 2. 10. 2026)
  assert.match(buildSystemPrompt('cs'), /nikdy azbukou/);
  assert.match(buildSystemPrompt('en'), /Never write the shop's contact details/);
  assert.match(buildSystemPrompt('de'), /Kontaktdaten/);
  const auto = buildSystemPrompt('auto');
  assert.doesNotMatch(auto, /point the customer to the shop contact/);
  assert.match(auto, /never claim that the shop does not sell something/);
  assert.match(auto, /Never write the shop's contact details/);
  assert.match(auto, /Latin alphabet/);
  // okno v režime auto s istou slovenčinou: pevný prompt bez sľubu „vždy po slovensky“
  assert.match(buildSystemPrompt('sk'), /v tomto okne vždy odpovedáš po slovensky/);
  assert.doesNotMatch(buildSystemPrompt('sk', { autoOkno: true }), /vždy odpovedáš po slovensky/);
  assert.match(buildSystemPrompt('sk', { autoOkno: true }), /odpovieš v jazyku, ktorým zákazník napíše/);
  assert.match(prisnyPokyn('sk', ['pismo', 'karta_mimo'], ['Guláš 25g']), /^OPRAVA:.*latinka.*neodporúčaj: Guláš 25g/s);
  assert.match(prisnyPokyn('auto', ['kontakt']), /^CORRECTION:/);
});

test('urciJazykOtazky: otázky dávky 1. 10. sú s istotou slovenské; čeština, iné jazyky, pozdrav a nejasné ostávajú na auto', () => {
  for (const o of ['Ktorú whisky by ste odporučili ako darček?', 'Čím začať s BARF stravou pre šteniatko?', 'Čím nahradím potravinovú fóliu v kuchyni?',
    'Ktoré korenie odporúčate na grilovanie bravčového mäsa?', 'Ktorý ekologický prací prostriedok sa hodí na detské oblečenie?',
    'Ktorá káva sa hodí na prípravu cez filter?', 'Čo sa hodí ako darček pre ročné dieťa?', 'Aky kavovar do 100 eur?']) {
    assert.equal(urciJazykOtazky(o), 'sk', o);
  }
  assert.equal(urciJazykOtazky('Jaký kávovar máte?'), 'cs');
  for (const o of ['Haben Sie das in Größe M?', 'Hätten Sie Käse?', 'Do you have this in blue?', 'Mate cierne tricko?', 'ahoj', 'vies po anglicky?',
    'Яку каву ви порадите?', 'Van kávé?', 'Kávovar?']) {
    assert.equal(urciJazykOtazky(o), null, o);
  }
  assert.ok(jeMetaOtazka('Dobrý deň'));
  assert.ok(jeMetaOtazka('ako to funguje?'));
  assert.ok(jeMetaOtazka('Čo všetko viete?'));
  assert.ok(jeMetaOtazka('S čím mi viete pomôcť?'));
  assert.ok(!jeMetaOtazka('Pomôžete mi vybrať kávu na filter?'));
  assert.ok(!jeMetaOtazka('Dobrý deň, aký čaj odporúčate začiatočníkovi na ráno?'));
});

// ---------------------------------------------------------------------------
// 6. runChat: opakovanie, bezpečná odpoveď, karty, jazyk, vek
// ---------------------------------------------------------------------------

const PIPERS = [
  produkt('p1', 'PAEX – BARF Mix pre šteniatka', { category: 'BARF pre šteniatka', description: 'Kompletné BARF menu pre šteniatka.' }),
  produkt('p2', 'PAEX - Junior MIX', { category: 'BARF pre šteniatka' }),
  produkt('p3', "Piper's BARF - Kuracie FRESH", { category: 'BARF krmivo pre psov a mačky' }),
];
const OTAZKA_PIPERS = 'Čím začať s BARF stravou pre šteniatko?';
const AZBUKA = { answer: 'Na začiatok odporúčame PAEX – BARF Mix pre šteniatka, ktorý je ideálnym produkтом na prechod na BARF.', products: [{ title: 'PAEX – BARF Mix pre šteniatka', url: 'https://obchod.sk/p1' }] };
const CISTA = { answer: 'Na začiatok odporúčame PAEX – BARF Mix pre šteniatka za 1,20 €, je to kompletné BARF menu pre šteniatka.', products: [{ title: 'PAEX – BARF Mix pre šteniatka', url: 'https://obchod.sk/p1' }] };

test('runChat: azbuka v odpovedi = jedno nové volanie s prísnejším pokynom, ide čistá odpoveď (pipers.sk)', async () => {
  const ai = model([AZBUKA, CISTA]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', PIPERS) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_PIPERS }], lang: 'sk' });
  assert.equal(r.answer, CISTA.answer);
  assert.deepEqual(r.products.map((p) => p.url), ['https://obchod.sk/p1']);
  assert.equal(r.meta.opravene, true);
  assert.deepEqual(r.meta.nalezy, ['pismo']);
  const volania = chatVolania(ai);
  assert.equal(volania.length, 2);
  assert.doesNotMatch(volania[0].input.messages[0].content, /OPRAVA/);
  assert.match(volania[1].input.messages[0].content, /OPRAVA: predchádzajúca odpoveď .*písmená mimo latinky/);
  assert.equal(volania[1].input.temperature, CHAT_MODEL_OPTIONS.temperature);
  assert.equal(r.meta.naklady.tokenyVstup > 0, true); // obe volania v nákladoch
});

test('runChat: azbuka aj po opakovaní = bezpečná odpoveď workera s kartami z odpovede, nikdy text s azbukou', async () => {
  const ai = model([AZBUKA, AZBUKA]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', PIPERS) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_PIPERS }], lang: 'sk' });
  assert.equal(r.answer, 'Tieto produkty najlepšie zodpovedajú vašej otázke.');
  assert.deepEqual(r.products.map((p) => p.url), ['https://obchod.sk/p1']);
  assert.equal(r.meta.bezpecna, true);
  assert.equal(chatVolania(ai).length, 2);
});

test('runChat: s rozpočtom bez predOpakovanim sa neopakuje; predOpakovanim dostane súčet oboch horných hraníc a pri „nie“ ide bezpečná odpoveď', async () => {
  let ai = model([AZBUKA, CISTA]);
  let r = await runChat({ AI: ai, VECTORIZE: await vektory('t', PIPERS) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_PIPERS }], lang: 'sk', predModelom: async () => true });
  assert.equal(chatVolania(ai).length, 1);
  assert.equal(r.meta.bezpecna, true);

  let prva = 0;
  let spolu = 0;
  ai = model([AZBUKA, CISTA]);
  r = await runChat({ AI: ai, VECTORIZE: await vektory('t', PIPERS) }, {
    tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_PIPERS }], lang: 'sk',
    predModelom: async (horna) => { prva = horna; return true; },
    predOpakovanim: async (hornaSpolu) => { spolu = hornaSpolu; return false; },
  });
  assert.equal(chatVolania(ai).length, 1);
  assert.equal(r.meta.bezpecna, true);
  assert.ok(spolu > prva * 1.5, `${spolu} > ${prva}`);

  ai = model([AZBUKA, CISTA]);
  r = await runChat({ AI: ai, VECTORIZE: await vektory('t', PIPERS) }, {
    tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_PIPERS }], lang: 'sk', predModelom: async () => true, predOpakovanim: async () => true,
  });
  assert.equal(chatVolania(ai).length, 2);
  assert.equal(r.answer, CISTA.answer);
});

test('runChat: nesúvisiaci výrobok v texte (Guláš ku grilovaniu) = opakovanie len so súvisiacimi kandidátmi (maspoma.sk)', async () => {
  const zla = { answer: 'Odporúčame korenie Gril party 25g za 1,20 € alebo Guláš 25g za 1,20 €, ktoré sú vhodné na grilovanie.', products: [{ title: 'Gril party 25g', url: 'https://obchod.sk/gp' }, { title: 'Guláš 25g', url: 'https://obchod.sk/gu' }] };
  const dobra = { answer: 'Na grilovanie bravčového mäsa odporúčame Gril party 25g za 1,20 €; vhodné na grilovanie je aj Bio Minútky na mäso 20g.', products: [{ title: 'Gril party 25g', url: 'https://obchod.sk/gp' }, { title: 'Bio Minútky na mäso 20g', url: 'https://obchod.sk/bm' }] };
  const ai = model([zla, dobra]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', MASPOMA, SKORE_MASPOMA) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_MASPOMA }], lang: 'sk' });
  const volania = chatVolania(ai);
  assert.equal(volania.length, 2);
  assert.match(volania[0].input.messages[1].content, /Guláš 25g/);
  assert.doesNotMatch(volania[1].input.messages[1].content, /Guláš 25g/); // druhé zadanie bez nesúvisiaceho
  assert.match(volania[1].input.messages[0].content, /neodporúčaj: Guláš 25g/);
  assert.deepEqual(r.products.map((p) => p.url), ['https://obchod.sk/gp', 'https://obchod.sk/bm']);
  assert.equal(r.meta.opravene, true);
});

test('runChat: nesúvisiaca karta, ktorú text nemenuje, len zmizne, bez ďalšieho volania', async () => {
  const ai = model([{ answer: 'Na grilovanie bravčového mäsa odporúčame Gril party 25g za 1,20 €.', products: [{ title: 'Gril party 25g', url: 'https://obchod.sk/gp' }, { title: 'Guláš 25g', url: 'https://obchod.sk/gu' }] }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', MASPOMA, SKORE_MASPOMA) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_MASPOMA }], lang: 'sk' });
  assert.deepEqual(r.products.map((p) => p.url), ['https://obchod.sk/gp']);
  assert.equal(chatVolania(ai).length, 1);
  assert.equal(r.meta.opravene, undefined);
});

test('runChat: veta s kontaktom uprostred sa odstrihne bez opakovania', async () => {
  const ai = model([{ answer: 'Na grilovanie odporúčame Gril party 25g za 1,20 €. Ak máte ďalšie otázky, kontaktujte nás. Zmes sa hodí aj do marinády na bravčové mäso.', products: [{ title: 'Gril party 25g', url: 'https://obchod.sk/gp' }] }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', MASPOMA, SKORE_MASPOMA) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_MASPOMA }], lang: 'sk' });
  assert.equal(r.answer, 'Na grilovanie odporúčame Gril party 25g za 1,20 €. Zmes sa hodí aj do marinády na bravčové mäso.');
  assert.equal(chatVolania(ai).length, 1);
});

test('runChat: režim auto so slovenskou otázkou ide pevným slovenským promptom; odmietnutie modelom nahradí veta workera (bior.sk)', async () => {
  const BIOR = [produkt('b1', 'ALGA CICOSA mlieko', { category: 'Prírodné telové hojivé mlieka| BIOR' }), produkt('b2', 'Teens MINI Gentle Day ekologické vložky', { category: 'Dámska intímna kozmetika' })];
  const otazka = 'Ktorý ekologický prací prostriedok sa hodí na detské oblečenie?';
  let ai = model([{ answer: '', products: [] }]);
  let r = await runChat({ AI: ai, VECTORIZE: await vektory('t', BIOR) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: otazka }], lang: 'auto' });
  const system = chatVolania(ai)[0].input.messages[0].content;
  assert.match(system, /Odpovedaj výhradne po slovensky/);
  assert.match(system, /odpovieš v jazyku, ktorým zákazník napíše/);
  assert.doesNotMatch(chatVolania(ai)[0].input.messages[1].content, /Reminder: answer in the same language/);
  assert.equal(r.answer, noMatchFallback('sk').answer);

  ai = model([{ answer: 'Na našom webe nenájdete pracovný prostriedok, ale môžete skúsiť kontaktovať našu stránku na tejto adrese.', products: [] }]);
  r = await runChat({ AI: ai, VECTORIZE: await vektory('t', BIOR) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: otazka }], lang: 'auto' });
  assert.equal(r.answer, noMatchFallback('sk').answer);
  assert.equal(r.meta.odmietnutie, true);
  assert.deepEqual(r.products, []);
  assert.equal(chatVolania(ai).length, 1);
});

test('runChat: otázka s vekom pošle modelu len výrobky pre ten vek (rozumnehracky.sk)', async () => {
  const HRACKY = [
    produkt('m', 'Magnetibook Ročné obdobia 3+', { description: 'Pre deti od 3 do 8 rokov.' }),
    produkt('k', 'Drevené kocky s obrázkami Krtkov rok 12 kusov 3+'),
    produkt('s', 'Prvá stavebnica Krúžky 1+', { category: 'Kreatívne stavebnice pre deti' }),
  ];
  const ai = model([{ answer: 'Pre ročné dieťa sa hodí Prvá stavebnica Krúžky 1+ za 1,20 €.', products: [{ title: 'Prvá stavebnica Krúžky 1+', url: 'https://obchod.sk/s' }] }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', HRACKY) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: 'Čo sa hodí ako darček pre ročné dieťa?' }], lang: 'sk' });
  const zadanie = chatVolania(ai)[0].input.messages[1].content;
  assert.match(zadanie, /Prvá stavebnica Krúžky 1\+/);
  assert.doesNotMatch(zadanie, /Magnetibook|Krtkov rok/);
  assert.deepEqual(r.products.map((p) => p.url), ['https://obchod.sk/s']);

  // žiadny výrobok pre ten vek: poctivé „neviem“, model sa nevolá
  const ai2 = model([{ answer: 'x', products: [] }]);
  const r2 = await runChat({ AI: ai2, VECTORIZE: await vektory('t', HRACKY.slice(0, 2)) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: 'Čo sa hodí ako darček pre ročné dieťa?' }], lang: 'sk' });
  assert.equal(r2.answer, noMatchFallback('sk').answer);
  assert.equal(chatVolania(ai2).length, 0);
});

test('runChat: kategórie obchodu idú do zadania len pri pozdrave či otázke o asistentovi; tam príkladové otázky nie sú nález', async () => {
  const ai = model([{ answer: 'Som asistent tohto obchodu. Môžete sa spýtať napríklad, ktoré korenie sa hodí na grilovanie.', products: [] }]);
  const produkty = MASPOMA.map((p) => ({ ...p, category: 'Koreniny' }));
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', produkty) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: 'ako to funguje?' }], lang: 'sk' });
  assert.match(chatVolania(ai)[0].input.messages[1].content, /shop_categories: Koreniny/);
  assert.match(r.answer, /Môžete sa spýtať napríklad/);
  assert.equal(chatVolania(ai).length, 1);

  const ai2 = model([{ answer: 'Na grilovanie odporúčame Gril party 25g za 1,20 €.', products: [{ title: 'Gril party 25g', url: 'https://obchod.sk/gp' }] }]);
  await runChat({ AI: ai2, VECTORIZE: await vektory('t', produkty) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: OTAZKA_MASPOMA }], lang: 'sk' });
  assert.doesNotMatch(chatVolania(ai2)[0].input.messages[1].content, /shop_categories/);
});

test('runChat: Vectorize sa pýta POOL_K kusov, do zadania ide najviac TOP_K; bez AI ten istý výber', async () => {
  const vela = Array.from({ length: 30 }, (_, i) => produkt(`x${i}`, `Korenie číslo ${i}`));
  const v = await vektory('t', vela);
  const dotazy = [];
  const query = v.query.bind(v);
  v.query = async (vec, opts) => { dotazy.push(opts.topK); return query(vec, opts); };
  const ai = model([{ answer: 'Odporúčame Korenie číslo 1.', products: [] }]);
  const r = await runChat({ AI: ai, VECTORIZE: v }, { tenant: { id: 't' }, messages: [{ role: 'user', content: 'Aké korenie máte?' }], lang: 'sk' });
  assert.deepEqual(dotazy, [POOL_K]);
  assert.equal(r.meta.candidateCount, TOP_K);
  assert.equal((chatVolania(ai)[0].input.messages[1].content.match(/- id: /g) || []).length, TOP_K);
  const bez = await runChatBezAI({ AI: createMockAI({ embedDim: 4 }), VECTORIZE: v }, { tenant: { id: 't' }, messages: [{ role: 'user', content: 'Aké korenie máte?' }], lang: 'sk' });
  assert.equal(bez.products.length, 3);
});

// ---------------------------------------------------------------------------
// 7. Rozpočet druhého volania a cesta /v1/chat
// ---------------------------------------------------------------------------

test('dorezervujOpakovanie: rezervuje rozdiel; keď sa nezmestí, nič nemení a vráti false', async () => {
  const db = createMockD1();
  const den = dayKey(new Date());
  const kluc = kluce.neurony(den);
  const k = { test: false, rezim: { rezim: 'ai' }, odhadMili: 1000, neuronove: [[kluc, 5000, 'spolocny_strop']], rezervacie: [], den, tenant: { id: 't' } };
  assert.equal(await dorezervujOpakovanie({ DB: db }, k, 3000), true);
  assert.equal(k.odhadMili, 3000);
  assert.equal(db._pocty.get(kluc).hodnota, 2000);
  assert.equal(await dorezervujOpakovanie({ DB: db }, k, 9000), false);
  assert.equal(k.odhadMili, 3000);
  assert.equal(k.rezim.rezim, 'ai');
  assert.equal(db._pocty.get(kluc).hodnota, 2000);
  assert.equal(await dorezervujOpakovanie({ DB: db }, { ...k, test: true }, 1e9), true);
});

test('POST /v1/chat: opravená odpoveď má meta.opravene, bezpečná meta.bezpecna; model sa volá najviac dvakrát', async () => {
  for (const [odpovede, ocakavane] of [[[AZBUKA, CISTA], 'opravene'], [[AZBUKA, AZBUKA], 'bezpecna']]) {
    const env = {
      DB: createMockD1(), AI: model(odpovede), VECTORIZE: createMockVectorize(), ASISTENT_CACHE: createMockKV(),
      ALLOWED_ORIGINS: 'arling.sk', UCET_TAJOMSTVO: 'dGVzdG92YWNpZS10YWpvbXN0dm8tcHJlLXJlbGFjaWU=', AI_DAILY_NEURON_BUDGET: '20000',
    };
    const t = await createTenant(env.DB, { domain: 'pipers-test.sk', feedUrl: 'https://pipers-test.sk/feed.json', contactEmail: 'info@pipers-test.sk' });
    await setTenantStatus(env.DB, t.id, 'ready');
    env.VECTORIZE = await vektory(t.id, PIPERS);
    const res = await worker.fetch(new Request('https://asistent.arling.sk/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://arling.sk', 'CF-Connecting-IP': '198.51.100.7' },
      body: JSON.stringify({ tenant: t.id, messages: [{ role: 'user', content: OTAZKA_PIPERS }], lang: 'auto', session: 'abcdef0123456789' }),
    }), env, {});
    assert.equal(res.status, 200);
    const telo = await res.json();
    assert.equal(telo.meta[ocakavane], true, JSON.stringify(telo.meta));
    assert.doesNotMatch(telo.answer, /том/);
    assert.equal(chatVolania(env.AI).length, 2);
  }
});
