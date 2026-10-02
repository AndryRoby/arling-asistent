// zhoda-2026-10-02.test.mjs
//
// Zhoda podmetu a prísudku v odpovediach Asistenta (2. 10. 2026, ops/asistent/kvalita-2026-10-02/OPRAVA-ZHODA.md).
// Náhľad dávky oslovení 2. 10. 2026 05:45, po nasadení opravy jazyka 9ceaec36
// (python ops/oslovenia/priprav-davku.py 2026-10-01 --nahlad, ops/oslovenia/fronta/nahlad-davka-2026-10-01.json):
// „Hodí sa PAEX - …, PAEX - …, PAEX - … a PAEX - …“ (pipers.sk) a „Hodí sa Voskové obrúsky Včelobal M - Folklór,
// ktoré slúžia …“ (bezobalovo.sk). Príčina: vzor „Hodí sa …“ v promptoch z rána 2. 10. Vety a otázky sú presne zo
// živého náhľadu, „Jemne štipľavé chilli je …“ z fronty 28. 9. (ops/oslovenia/fronta/dnes-2026-09-28.json); model je
// napodobený. Popisy Kloboučku hop 4+ a Klobúčik hop 4+ sú doslova z ops/oslovenia/feedy/rozumnehracky.sk.json.
//
// Spustenie: v priečinku products/arling-asistent/worker príkaz `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, kontrolaTextu, polishAnswer, prisnyPokyn, runChat, opravZhodu, zhodaPrisudku } from '../src/chat.js';
import { createMockAI, createMockVectorize } from '../../tests/helpers/mock-cf.mjs';

const EMBED = '@cf/baai/bge-m3';
const chatVolania = (ai) => ai.calls.filter((c) => c.model !== EMBED);
// Feed pipers.sk píše v názvoch PAEX 2 až 4 dlhšiu pomlčku (U+2013), v zdrojáku je len ako kód znaku.
const P = String.fromCharCode(0x2013);

function produkt(id, title, extra = {}) {
  return { productId: id, title, url: `https://obchod.sk/${id}`, price: 5.5, currency: 'EUR', availability: 'in_stock', category: '', description: '', ...extra };
}

async function vektory(tenant, produkty) {
  const v = createMockVectorize();
  await v.upsert(produkty.map((p) => ({ id: `${tenant}::${p.productId}::0`, values: [1, 0, 0, 0], metadata: { tenant, ...p } })));
  return v;
}

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

const karta = (p) => ({ title: p.title, url: p.url });
const nazvy = (...t) => t.map((title) => ({ title }));

// ---------------------------------------------------------------------------
// Živé odpovede náhľadu 2. 10. 2026 05:45 (všetkých 8)
// ---------------------------------------------------------------------------

const PAMLSKY = 'Mrazom sušené pamlsky pre psov a mačky';
const HOVADZIE = produkt('hov', 'PAEX - Mrazom sušené hovädzie mäso', { category: PAMLSKY });
const KOZIE = produkt('koz', `PAEX ${P} Kozie mäso sušené mrazom`, { category: PAMLSKY });
const PLUCA = produkt('plu', `PAEX ${P} Mrazom sušené jahňacie pľúca`, { category: PAMLSKY });
const PECEN = produkt('pec', `PAEX ${P} Konská pečeň sušená mrazom`, { category: PAMLSKY });
const OBRUSKY = produkt('vo', 'Voskové obrúsky Včelobal M - Folklór', { category: 'Voskové obrúsky', description: 'Voskový obrúsok ako alternatíva potravinovej fólie.' });
const KLOBOUCKU = produkt('kh', 'Kloboučku hop 4+', {
  price: 6.54, category: 'Najlepšie spoločenské hry pre deti',
  description: 'Retro hra zabaví nielen pamätníkov čias socializmu. Hra pre celú rodinu, pre ľubovoľný počet hráčov. Tradičný český výrobca.',
});
const KLOBUCIK = produkt('kc', 'Klobúčik hop 4+', {
  price: 10.33, category: 'Najlepšie spoločenské hry pre deti',
  description: 'Máte presnú mušku? Dokážte to v tradičnej zábavnej hre Klobúčik hop, pri ktorej sa pobaví celá rodina.',
});

const MACKA = {
  otazka: 'Aké mrazom sušené pamlsky máte pre mačku?',
  odpoved: `Hodí sa PAEX - Mrazom sušené hovädzie mäso, PAEX ${P} Kozie mäso sušené mrazom, PAEX ${P} Mrazom sušené jahňacie pľúca a PAEX ${P} Konská pečeň sušená mrazom.`,
  karty: [HOVADZIE.title, KOZIE.title, PLUCA.title], // náhľad ukázal tri karty (MAX_PRODUCTS_IN_ANSWER), pečeň len v texte
};
const FOLIA = {
  otazka: 'Čím nahradím potravinovú fóliu v kuchyni?',
  odpoved: 'Hodí sa Voskové obrúsky Včelobal M - Folklór, ktoré slúžia ako alternatíva k potravinovej fólii.',
  karty: [OBRUSKY.title],
  cista: 'Odporúčam: Voskové obrúsky Včelobal M - Folklór, ktoré slúžia ako alternatíva k potravinovej fólii.',
};
const BEZ_NALEZU = [
  { otazka: 'Čím začať s BARF stravou pre šteniatko?', odpoved: `Odporúčam PAEX ${P} BARF Mix pre šteniatka, ktorý je jemný BARF mix pre šteniatka z mäsa z krku a zelených držiek.`, karty: [`PAEX ${P} BARF Mix pre šteniatka`] },
  { otazka: 'Máte tuhý šampón na vlasy?', odpoved: 'Áno, máme tuhý šampón na vlasy. Odporúčam Tuhý šampón Vážna známosť 40g Musk, ktorý stojí 5,50 €.', karty: ['Tuhý šampón Vážna známosť 40g Musk'] },
  { otazka: 'Ktorá hra rozvíja logické myslenie päťročného dieťaťa?', odpoved: 'Hodí sa Maľujeme, tvoríme a staviame s mackom - LOGICO Primo, ktorá rozvíja tvorivé a logické myslenie.', karty: ['Maľujeme, tvoríme a staviame s mackom - LOGICO Primo'] },
  { otazka: 'Čo je bambinoLÜK a od akého veku je?', odpoved: 'BambinoLÜK je autokorektívna hra pre deti, ktorá rozvíja logické myslenie. Zošit Múdra víla - bambinoLÜK je vhodný pre deti od 3 rokov.', karty: ['Múdra víla - bambinoLÜK'] },
  { otazka: 'Čo sa hodí ako darček pre ročné dieťa?', odpoved: 'Hodí sa Prvá stavebnica Krúžky 1+ alebo Mozaika FantaColor Baby PlayBio 1+, ktoré sú vhodné pre deti od 1 roka.', karty: ['Prvá stavebnica Krúžky 1+', 'Mozaika FantaColor Baby PlayBio 1+'] },
  { otazka: 'Hľadám spoločenskú hru pre rodinu s deťmi od 6 rokov.', odpoved: 'Hodí sa Kloboučku hop 4+, ktorá je vhodná pre celú rodinu a môže sa hrať s ľubovoľným počtom hráčov.', karty: ['Kloboučku hop 4+'] },
];

/** Ako ops/asistent/kvalita-2026-10-02/skontroluj-nahlad.mjs: režim auto, kandidáti sú len názvy kariet. */
const kontrolaNahladu = (z) => kontrolaTextu(z.odpoved, { jazyk: 'auto', otazka: z.otazka, candidates: nazvy(...z.karty) });

// ---------------------------------------------------------------------------
// 1. Príčina v promptoch
// ---------------------------------------------------------------------------

test('príčina: žiadny prompt ani opakovanie nemá vzor s prísudkom, ktorý sa musí zhodovať; pravidlo o zhode a začiatok s dvojbodkou áno', () => {
  const prompty = {
    sk: buildSystemPrompt('sk'), skOkno: buildSystemPrompt('sk', { autoOkno: true }), cs: buildSystemPrompt('cs'),
    csOkno: buildSystemPrompt('cs', { autoOkno: true }), en: buildSystemPrompt('en'), de: buildSystemPrompt('de'), auto: buildSystemPrompt('auto'),
  };
  for (const [kde, p] of Object.entries(prompty)) {
    // „Hodí sa …“ model prevzal ako začiatok odpovede (5 z 8) a nechal ho v jednotnom čísle aj pri štyroch výrobkoch
    assert.doesNotMatch(p, /[„"]Hodí s[ae](?!\p{L})/u, kde);
    assert.doesNotMatch(p, /is a good fit|Gut geeignet ist/, kde);
    // „Pozrite si …“ a „Podívejte se na …“ by chceli názov v 4. páde („Pozrite si Prvú stavebnicu“), model ho necháva v 1.
    assert.doesNotMatch(p, /[„"]Pozrite si|[„"]Podívejte se na/, kde);
  }
  assert.match(prompty.sk, /Prísudok sa vždy zhoduje s podmetom v čísle: pri viacerých výrobkoch alebo pri výrobku s názvom v množnom čísle je sloveso aj prídavné meno v množnom čísle\./);
  assert.match(prompty.sk, /napríklad „Odporúčam: …“/);
  assert.match(prompty.cs, /Přísudek se vždy shoduje s podmětem v čísle/);
  assert.match(prompty.cs, /například „Doporučuji: …“/);
  assert.match(prompty.en, /Make every verb agree with its subject in number: several products, or one product whose title is plural, take a plural verb\./);
  assert.match(prompty.de, /Das Verb richtet sich in der Zahl immer nach dem Subjekt/);
  assert.match(prompty.auto, /Make every verb agree with its subject in number/);
  assert.match(prompty.auto, /"Odporúčam: …" in Slovak or "Doporučuji: …" in Czech/);
  for (const jazyk of ['sk', 'cs', 'en', 'de', 'auto']) {
    for (const n of ['pismo', 'chyba_sk', 'kontakt', 'otazky', 'karta_mimo', 'nahradenie', 'zhoda']) {
      assert.doesNotMatch(prisnyPokyn(jazyk, [n]), /Hodí s[ae](?!\p{L})/u, `${jazyk} ${n}`);
    }
  }
});

test('prisnyPokyn: dôvod a pravidlo zhody len pri náleze zhoda (sk, cs, auto); vzor začiatku je „Odporúčam: …“', () => {
  const sk = prisnyPokyn('sk', ['zhoda']);
  assert.match(sk, /^OPRAVA: predchádzajúca odpoveď na túto otázku sa nedala použiť \(prísudok nesúhlasí s podmetom v čísle\)/);
  assert.match(sk, /prísudok aj prídavné meno v rovnakom čísle ako podmet \(pri viacerých výrobkoch alebo pri výrobku s názvom v množnom čísle množné číslo\)/);
  assert.match(sk, /výrobky s presnými názvami za dvojbodkou, napríklad „Odporúčam: …“/);
  assert.doesNotMatch(prisnyPokyn('sk', ['otazky']), /prísudok aj prídavné meno/);
  const cs = prisnyPokyn('cs', ['zhoda']);
  assert.match(cs, /\(přísudek nesouhlasí s podmětem v čísle\)/);
  assert.match(cs, /přísudek i přídavné jméno ve stejném čísle jako podmět/);
  assert.match(cs, /například „Doporučuji: …“/);
  const auto = prisnyPokyn('auto', ['zhoda']);
  assert.match(auto, /^CORRECTION: .*\(a verb does not agree with its subject in number\)/);
  assert.match(auto, /every verb and adjective agreeing in number with its subject/);
  assert.doesNotMatch(prisnyPokyn('auto', ['kontakt']), /agreeing in number/);
});

// ---------------------------------------------------------------------------
// 2. Kontrola: presné vety náhľadu 2. 10. 05:45
// ---------------------------------------------------------------------------

test('kontrolaTextu: dve vety z náhľadu 2. 10. 05:45 sú nález zhoda (pipers.sk štyri výrobky, bezobalovo.sk obrúsky, ktoré slúžia)', () => {
  assert.deepEqual(kontrolaNahladu(MACKA), ['zhoda']);
  assert.deepEqual(kontrolaTextu(MACKA.odpoved, { jazyk: 'sk', otazka: MACKA.otazka, candidates: [HOVADZIE, KOZIE, PLUCA, PECEN] }), ['zhoda']);
  // otázka sa na náhradu pýta, takže nahradenie nie, len zhoda
  assert.deepEqual(kontrolaNahladu(FOLIA), ['zhoda']);
  assert.deepEqual(kontrolaTextu(FOLIA.odpoved, { jazyk: 'sk', otazka: FOLIA.otazka, candidates: [OBRUSKY] }), ['zhoda']);
});

test('kontrolaTextu: zvyšných šesť odpovedí náhľadu 05:45 je bez nálezu (jeden výrobok, „alebo“, čiarka a „a“ vnútri názvu, Kloboučku hop)', () => {
  for (const z of BEZ_NALEZU) {
    assert.deepEqual(kontrolaNahladu(z), [], z.otazka);
    assert.equal(polishAnswer(z.odpoved, 'auto', nazvy(...z.karty)), z.odpoved, z.otazka);
  }
  // „Hodí sa A alebo B“: pri vylučovacej spojke je jednotné číslo správne, worker ho nemení
  assert.equal(opravZhodu(BEZ_NALEZU[4].odpoved, nazvy(...BEZ_NALEZU[4].karty)), BEZ_NALEZU[4].odpoved);
});

// ---------------------------------------------------------------------------
// 3. Oprava „Hodí sa“ na „Hodia sa“ (polishAnswer, slovenčina)
// ---------------------------------------------------------------------------

test('polishAnswer: „Hodí sa A, B, C a D“ (pipers.sk) opraví na „Hodia sa …“; s tromi kartami aj so štyrmi kandidátmi', () => {
  const opravena = MACKA.odpoved.replace(/^Hodí sa /, 'Hodia sa ');
  assert.equal(polishAnswer(MACKA.odpoved, 'sk', [HOVADZIE, KOZIE, PLUCA, PECEN]), opravena);
  assert.equal(polishAnswer(MACKA.odpoved, 'auto', nazvy(...MACKA.karty)), opravena);
  assert.deepEqual(kontrolaTextu(opravena, { jazyk: 'sk', otazka: MACKA.otazka, candidates: [HOVADZIE, KOZIE, PLUCA, PECEN] }), []);
  // pomlčka v názve a v odpovedi sa môže líšiť, značka „PAEX“ v odpovedi môže chýbať
  assert.equal(polishAnswer('Hodí sa PAEX - Kozie mäso sušené mrazom a PAEX - Konská pečeň sušená mrazom.', 'sk', [KOZIE, PECEN]),
    'Hodia sa PAEX - Kozie mäso sušené mrazom a PAEX - Konská pečeň sušená mrazom.');
  assert.equal(polishAnswer('Hodí sa Kozie mäso sušené mrazom a Konská pečeň sušená mrazom.', 'sk', [KOZIE, PECEN]),
    'Hodia sa Kozie mäso sušené mrazom a Konská pečeň sušená mrazom.');
});

test('polishAnswer: „sa hodí“ pred aj za reťazou, s príslovkou; jeden výrobok, „alebo“, predložka, čeština a text bez kandidátov ostávajú', () => {
  const k = [HOVADZIE, KOZIE, PLUCA];
  assert.equal(polishAnswer('Pre mačku sa hodí PAEX - Mrazom sušené hovädzie mäso a PAEX - Mrazom sušené jahňacie pľúca.', 'sk', k),
    'Pre mačku sa hodia PAEX - Mrazom sušené hovädzie mäso a PAEX - Mrazom sušené jahňacie pľúca.');
  assert.equal(polishAnswer('PAEX - Mrazom sušené hovädzie mäso a PAEX - Mrazom sušené jahňacie pľúca sa výborne hodí ako odmena.', 'sk', k),
    'PAEX - Mrazom sušené hovädzie mäso a PAEX - Mrazom sušené jahňacie pľúca sa výborne hodia ako odmena.');
  assert.equal(polishAnswer('Hodí sa napríklad PAEX - Mrazom sušené hovädzie mäso, PAEX - Kozie mäso sušené mrazom a PAEX - Mrazom sušené jahňacie pľúca.', 'sk', k),
    'Hodia sa napríklad PAEX - Mrazom sušené hovädzie mäso, PAEX - Kozie mäso sušené mrazom a PAEX - Mrazom sušené jahňacie pľúca.');
  const ostava = [
    ['Hodí sa PAEX - Mrazom sušené hovädzie mäso, ktoré obsahuje len hovädzie mäso.', 'sk'],
    ['Hodí sa PAEX - Mrazom sušené hovädzie mäso alebo PAEX - Kozie mäso sušené mrazom.', 'sk'],
    ['Táto omáčka sa hodí k PAEX - Mrazom sušené hovädzie mäso a PAEX - Kozie mäso sušené mrazom.', 'sk'],
    ['Zmes je vhodná aj na zeleninu a hodí sa do marinády.', 'sk'],
    ['Pro kočku se hodí PAEX - Mrazom sušené hovädzie mäso a PAEX - Kozie mäso sušené mrazom.', 'cs'],
  ];
  for (const [veta, jazyk] of ostava) assert.equal(polishAnswer(veta, jazyk, k), veta, veta);
  assert.equal(polishAnswer(MACKA.odpoved, 'sk'), MACKA.odpoved); // bez kandidátov nič
  // živá odpoveď 27. 9. (fronta/davka-2.json): „alebo“, ostáva
  const ryba = 'K rybe sa hodí napríklad Tramín červený 2024 alebo Sauvignon blanc 2023 Mavín.';
  assert.equal(polishAnswer(ryba, 'sk', nazvy('Tramín červený 2024', 'Sauvignon blanc 2023 Mavín')), ryba);
});

// ---------------------------------------------------------------------------
// 4. Kontrola: iné slovesá, iné jazyky, bez falošných poplachov
// ---------------------------------------------------------------------------

test('kontrolaTextu: jednotné číslo pri viacerých výrobkoch aj inými slovesami (sk), vrátane živej vety z 28. 9.', () => {
  const chilli = nazvy('Guajillo chilli', 'Pasilla chilli');
  const hracky = nazvy('Prvá stavebnica Krúžky 1+', 'Mozaika FantaColor Baby PlayBio 1+');
  const zle = [
    ['Jemne štipľavé chilli je Guajillo chilli a Pasilla chilli.', chilli], // fronta/dnes-2026-09-28.json
    ['Guajillo chilli a Pasilla chilli stojí spolu 3,75 €.', chilli],
    ['Pre ročné dieťa je vhodná Prvá stavebnica Krúžky 1+ a Mozaika FantaColor Baby PlayBio 1+.', hracky],
    ['Prvá stavebnica Krúžky 1+ a Mozaika FantaColor Baby PlayBio 1+ je vhodná pre deti od 1 roka.', hracky],
    ['Áno, Prvá stavebnica Krúžky 1+ a Mozaika FantaColor Baby PlayBio 1+ je skladom.', hracky],
  ];
  for (const [veta, c] of zle) {
    assert.deepEqual(kontrolaTextu(veta, { jazyk: 'sk', otazka: 'x', candidates: c }), ['zhoda'], veta);
    assert.equal(zhodaPrisudku(veta, { jazyk: 'auto', candidates: c }), true, veta);
  }
});

test('kontrolaTextu: prívlastky pred názvom v zozname (pripravená odpoveď cerstvekorenie.sk, odoslaná e-mailom 30. 9.) sú nález, oprava ich nemení', () => {
  // ops/oslovenia/overene/cerstvekorenie.sk.json, citát v e-maile info@mikori.sk 30. 9. 2026 09:02 (odoslane.csv)
  const korenie = 'Na vianočné pečenie máme hotovú zmes Perníkové korenie, jemne pikantnú, so zázvorom a citrusovou kôrou. Ak si zmes miešate sami, hodí sa lahodne sladká Cejlónska škorica a veľké voňavé klinčeky z Madagaskaru.';
  const karty = nazvy('Perníkové korenie', 'Cejlónska škorica', 'Klinčeky');
  assert.deepEqual(kontrolaTextu(korenie, { jazyk: 'auto', otazka: 'Aké korenie odporúčate na vianočné pečenie?', candidates: karty }), ['zhoda']);
  assert.equal(polishAnswer(korenie, 'sk', karty), korenie); // oprava len pri názvoch hneď za spojkou, tu opakovanie
  assert.deepEqual(kontrolaTextu(korenie.replace('hodí sa lahodne', 'hodia sa lahodne'), { jazyk: 'sk', otazka: 'x', candidates: karty }), []);
  const chilli = nazvy('Guajillo chilli', 'Chipotle chilli');
  assert.deepEqual(kontrolaTextu('Guajillo chilli a údené Chipotle chilli je vhodné do omáčky.', { jazyk: 'sk', otazka: 'x', candidates: chilli }), ['zhoda']);
  // sloveso medzi názvami reťaz preruší: rozkaz, 1. osoba, predložka
  for (const veta of ['Hodí sa Guajillo chilli a potom pridajte Chipotle chilli.', 'Hodí sa Guajillo chilli a ponúkame aj Chipotle chilli.',
    'Hodí sa Guajillo chilli a k mäsu Chipotle chilli.']) {
    assert.deepEqual(kontrolaTextu(veta, { jazyk: 'sk', otazka: 'x', candidates: chilli }), [], veta);
    assert.equal(polishAnswer(veta, 'sk', chilli), veta, veta);
  }
});

test('kontrolaTextu: bez nálezu zhoda pri množnom čísle, „Odporúčam:“, predložke, neosobnom „je vhodné …“ a „ktoré milujú deti“ (sk)', () => {
  const chilli = nazvy('Guajillo chilli', 'Pasilla chilli');
  const pamlsky = [HOVADZIE, KOZIE, PLUCA];
  const dobre = [
    ['Pre mačku sú vhodné PAEX - Mrazom sušené hovädzie mäso a PAEX - Kozie mäso sušené mrazom.', pamlsky],
    [MACKA.odpoved.replace(/^Hodí sa /, 'Hodia sa '), pamlsky],
    ['Odporúčam: PAEX - Mrazom sušené hovädzie mäso, PAEX - Kozie mäso sušené mrazom a PAEX - Mrazom sušené jahňacie pľúca.', pamlsky],
    [FOLIA.cista, [OBRUSKY]],
    ['Rozdiel medzi Guajillo chilli a Pasilla chilli je v štipľavosti.', chilli],
    ['Guajillo chilli a Pasilla chilli je vhodné skombinovať.', chilli],
    ['Guajillo chilli a Pasilla chilli je lepšie si pomlieť doma.', chilli],
    ['Hodí sa PAEX - Mrazom sušené hovädzie mäso, ktoré obsahuje len hovädzie mäso.', pamlsky],
    ['Hodí sa Puzzle Zvieratká, ktoré milujú deti.', nazvy('Puzzle Zvieratká')],
    // dve vety spojené čiarkou: dva názvy len s čiarkou, bez spojky, nie sú viacnásobný podmet
    ['Na grilovanie máme Guajillo chilli, Pasilla chilli je vypredané.', chilli],
    ['Na grilovanie sa hodí Guajillo chilli, Pasilla chilli je vypredané.', chilli],
  ];
  for (const [veta, c] of dobre) assert.deepEqual(kontrolaTextu(veta, { jazyk: 'sk', otazka: 'x', candidates: c }), [], veta);
  assert.equal(polishAnswer('Na grilovanie sa hodí Guajillo chilli, Pasilla chilli je vypredané.', 'sk', chilli), 'Na grilovanie sa hodí Guajillo chilli, Pasilla chilli je vypredané.');
  // podmet je druh tovaru, názvy za „napríklad“ sú príklady; spoločná časť názvov („Drevené puzzle“) nie je výrobok
  const puzzle = nazvy('Panda - Drevené puzzle', 'Líška - Drevené puzzle');
  const priklad = 'Hodí sa drevené puzzle, napríklad Panda - Drevené puzzle a Líška - Drevené puzzle.';
  assert.deepEqual(kontrolaTextu(priklad, { jazyk: 'sk', otazka: 'x', candidates: puzzle }), []);
  assert.equal(polishAnswer(priklad, 'sk', puzzle), priklad);
});

test('kontrolaTextu: zhoda v češtine, angličtine a nemčine len za reťazou (pred ňou smie byť jednotné číslo)', () => {
  const cs = nazvy('Kozí maso sušené mrazem', 'Koňská játra sušená mrazem');
  assert.deepEqual(kontrolaTextu('Kozí maso sušené mrazem a Koňská játra sušená mrazem je vhodné pro kočky.', { jazyk: 'cs', otazka: 'x', candidates: cs }), ['zhoda']);
  for (const veta of ['Pro kočky je vhodné Kozí maso sušené mrazem a Koňská játra sušená mrazem.', 'Pro kočku se hodí Kozí maso sušené mrazem a Koňská játra sušená mrazem.',
    'Kozí maso sušené mrazem a Koňská játra sušená mrazem jsou vhodné pro kočky.', 'Doporučuji: Kozí maso sušené mrazem a Koňská játra sušená mrazem.']) {
    assert.deepEqual(kontrolaTextu(veta, { jazyk: 'cs', otazka: 'x', candidates: cs }), [], veta);
  }
  const en = nazvy('Matcha Bowl Chawan', 'Bamboo Whisk Chasen');
  for (const jazyk of ['en', 'auto']) {
    assert.deepEqual(kontrolaTextu('Matcha Bowl Chawan and Bamboo Whisk Chasen is a good fit.', { jazyk, otazka: 'x', candidates: en }), ['zhoda'], jazyk);
    for (const veta of ['A good fit is Matcha Bowl Chawan and Bamboo Whisk Chasen.', 'I recommend Matcha Bowl Chawan and Bamboo Whisk Chasen.',
      'Matcha Bowl Chawan or Bamboo Whisk Chasen is a good fit.', 'Matcha Bowl Chawan and Bamboo Whisk Chasen are a good fit.']) {
      assert.deepEqual(kontrolaTextu(veta, { jazyk, otazka: 'x', candidates: en }), [], `${jazyk}: ${veta}`);
    }
  }
  const de = nazvy('Matcha Schale Chawan', 'Bambusbesen Chasen');
  assert.deepEqual(kontrolaTextu('Matcha Schale Chawan und Bambusbesen Chasen ist gut geeignet.', { jazyk: 'de', otazka: 'x', candidates: de }), ['zhoda']);
  for (const veta of ['Gut geeignet ist Matcha Schale Chawan und Bambusbesen Chasen.', 'Ich empfehle Matcha Schale Chawan und Bambusbesen Chasen.',
    'Matcha Schale Chawan oder Bambusbesen Chasen ist gut geeignet.', 'Matcha Schale Chawan und Bambusbesen Chasen sind gut geeignet.']) {
    assert.deepEqual(kontrolaTextu(veta, { jazyk: 'de', otazka: 'x', candidates: de }), [], veta);
  }
});

// ---------------------------------------------------------------------------
// 5. runChat: celé cesty s napodobeným modelom
// ---------------------------------------------------------------------------

test('runChat: „Hodí sa“ pred štyrmi výrobkami (pipers.sk, živá veta 05:45) opraví worker sám, bez ďalšieho volania modelu', async () => {
  const produkty = [HOVADZIE, KOZIE, PLUCA, PECEN];
  const ai = model([{ answer: MACKA.odpoved, products: produkty.map(karta) }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', produkty) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: MACKA.otazka }], lang: 'auto' });
  assert.equal(r.answer, MACKA.odpoved.replace(/^Hodí sa /, 'Hodia sa '));
  assert.equal(r.products.length, 3);
  assert.equal(chatVolania(ai).length, 1);
  assert.equal(r.meta.opravene, undefined);
  assert.equal(r.meta.bezpecna, undefined);
});

test('runChat: „Hodí sa Voskové obrúsky …, ktoré slúžia“ (bezobalovo.sk) = jedno opakovanie s dôvodom zhoda a vzorom „Odporúčam: …“', async () => {
  const ai = model([{ answer: FOLIA.odpoved, products: [karta(OBRUSKY)] }, { answer: FOLIA.cista, products: [karta(OBRUSKY)] }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', [OBRUSKY]) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: FOLIA.otazka }], lang: 'auto' });
  assert.equal(r.answer, FOLIA.cista);
  assert.deepEqual(r.products.map((p) => p.url), [OBRUSKY.url]);
  assert.equal(r.meta.opravene, true);
  assert.deepEqual(r.meta.nalezy, ['zhoda']);
  const volania = chatVolania(ai);
  assert.equal(volania.length, 2);
  assert.doesNotMatch(volania[0].input.messages[0].content, /[„"]Hodí sa|OPRAVA/);
  const druhy = volania[1].input.messages[0].content;
  assert.match(druhy, /OPRAVA: predchádzajúca odpoveď na túto otázku sa nedala použiť \(prísudok nesúhlasí s podmetom v čísle\)/);
  assert.match(druhy, /prísudok aj prídavné meno v rovnakom čísle ako podmet/);
  assert.doesNotMatch(druhy, /Hodí sa/);
});

test('runChat: keď model ani po opakovaní nezhodne prísudok, ide veta workera s kartou, nikdy chybná veta (bezobalovo.sk)', async () => {
  const zla = { answer: FOLIA.odpoved, products: [karta(OBRUSKY)] };
  const ai = model([zla, zla]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', [OBRUSKY]) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: FOLIA.otazka }], lang: 'sk' });
  assert.equal(r.answer, 'Tieto produkty najlepšie zodpovedajú vašej otázke.');
  assert.deepEqual(r.products.map((p) => p.url), [OBRUSKY.url]);
  assert.equal(r.meta.bezpecna, true);
  assert.deepEqual(r.meta.nalezy, ['zhoda']);
  assert.equal(chatVolania(ai).length, 2);
});

test('runChat: Kloboučku hop 4+ (rozumnehracky.sk) bez nálezu a bez opakovania; počet hráčov model dostal v popise z feedu', async () => {
  const z = BEZ_NALEZU[5];
  const ai = model([{ answer: z.odpoved, products: [karta(KLOBOUCKU)] }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', [KLOBOUCKU, KLOBUCIK]) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: z.otazka }], lang: 'auto' });
  assert.equal(r.answer, z.odpoved);
  assert.deepEqual(r.products.map((p) => p.url), [KLOBOUCKU.url]);
  const volania = chatVolania(ai);
  assert.equal(volania.length, 1);
  // údaj „ľubovoľný počet hráčov“ je doslova v popise toho istého výrobku, ktorý model dostal; podobný Klobúčik hop ho nemá
  const zadanie = volania[0].input.messages[1].content;
  assert.ok(zadanie.includes(`title: Kloboučku hop 4+\n  price: 6.54 EUR\n  availability: in_stock\n  category: Najlepšie spoločenské hry pre deti\n  url: ${KLOBOUCKU.url}\n  description: Retro hra zabaví nielen pamätníkov čias socializmu. Hra pre celú rodinu, pre ľubovoľný počet hráčov. Tradičný český výrobca.`));
  assert.doesNotMatch(KLOBUCIK.description, /hráč/);
});
