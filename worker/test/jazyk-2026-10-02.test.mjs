// jazyk-2026-10-02.test.mjs
//
// Jazyk odpovedí Asistenta (2. 10. 2026, ops/asistent/kvalita-2026-10-02/OPRAVA-JAZYK.md).
// Náhľad dávky oslovení 2. 10. 2026 05:16 (python ops/oslovenia/priprav-davku.py 2026-10-01 --nahlad)
// ukázal „Môžete nahradiť …“ aj na otázky, ktoré sa na náhradu nepýtali, a vymyslené slovo „otázkať“.
// Príčina: vzor „môžete nahradiť“ v promptoch a v opakovaní od 1. 10. Otázky a vety odpovedí sú presne
// zo živého náhľadu (ops/oslovenia/fronta/nahlad-davka-2026-10-01.json), model je napodobený.
//
// Spustenie: v priečinku products/arling-asistent/worker príkaz `node --test` (Node 22 nájde test/ sám).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSystemPrompt, kontrolaTextu, polishAnswer, prisnyPokyn, runChat, bezPrikladovOtazok,
  jeOtazkaNaNahradu, nahradenieBezOtazky,
} from '../src/chat.js';
import { createMockAI, createMockVectorize } from '../../tests/helpers/mock-cf.mjs';

const EMBED = '@cf/baai/bge-m3';
const chatVolania = (ai) => ai.calls.filter((c) => c.model !== EMBED);
// Feed pipers.sk píše v niektorých názvoch dlhšiu pomlčku (U+2013); v zdrojáku je len ako kód znaku.
const POMLCKA = String.fromCharCode(0x2013);

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
const kandidatiZ = (produkty) => produkty.map((p) => ({ title: p.title }));

// ---------------------------------------------------------------------------
// Živé odpovede z náhľadu 2. 10. 2026
// ---------------------------------------------------------------------------

const KRUZKY = produkt('kr', 'Prvá stavebnica Krúžky 1+', { category: 'Kreatívne stavebnice pre deti' });
const MOZAIKA = produkt('mz', 'Mozaika FantaColor Baby PlayBio 1+', { category: 'Kreatívne hračky' });
const LOGICO = produkt('lp', 'Maľujeme, tvoríme a staviame s mackom - LOGICO Primo', { category: 'LOGICO Primo', description: 'Rozvíja tvorivé a logické myslenie, od 4 rokov.' });
const HOVADZIE = produkt('hv', 'PAEX - Mrazom sušené hovädzie mäso', { category: 'Mrazom sušené pamlsky pre psov a mačky' });
const PLUCA = produkt('pl', `PAEX ${POMLCKA} Mrazom sušené jahňacie pľúca`, { category: 'Mrazom sušené pamlsky pre psov a mačky' });
const OBRUSKY = produkt('vo', 'Voskové obrúsky Včelobal M - Folklór', { category: 'Voskové obrúsky', description: 'Voskový obrúsok ako alternatíva potravinovej fólie.' });
const SAMPON_1 = produkt('s40', 'Tuhý šampón Vážna známosť 40g Musk', { category: 'Tuhé šampóny' });
const SAMPON_2 = produkt('s30', 'Tuhý šampón Ponio - Šampúch citrón a rozmarín 30g', { category: 'Tuhé šampóny' });

const ZIVE = {
  rocne: {
    otazka: 'Čo sa hodí ako darček pre ročné dieťa?',
    odpoved: 'Môžete nahradiť darček pre ročné dieťa výrobkom Prvá stavebnica Krúžky 1+ alebo Mozaika FantaColor Baby PlayBio 1+, ktoré sú vhodné pre deti od 1 roka.',
    produkty: [KRUZKY, MOZAIKA],
    cista: 'Pre ročné dieťa odporúčam Prvá stavebnica Krúžky 1+ za 5,50 €, je vhodná pre deti od 1 roka.',
  },
  logika: {
    otazka: 'Ktorá hra rozvíja logické myslenie päťročného dieťaťa?',
    odpoved: 'Môžete nahradiť hru Maľujeme, tvoríme a staviame s mackom - LOGICO Primo, ktorá rozvíja tvorivé a logické myslenie.',
    produkty: [LOGICO],
    cista: 'Na rozvoj logického myslenia odporúčam hru Maľujeme, tvoríme a staviame s mackom - LOGICO Primo za 5,50 €.',
  },
  macka: {
    otazka: 'Aké mrazom sušené pamlsky máte pre mačku?',
    odpoved: `Môžete nahradiť PAEX - Mrazom sušené hovädzie mäso alebo PAEX ${POMLCKA} Mrazom sušené jahňacie pľúca.`,
    produkty: [HOVADZIE, PLUCA],
    cista: 'Pre mačku sa hodí PAEX - Mrazom sušené hovädzie mäso za 5,50 €.',
  },
  folia: {
    otazka: 'Čím nahradím potravinovú fóliu v kuchyni?',
    odpoved: 'Môžete nahradiť potravinovú fóliu voskovými obrúskami, ako napríklad Voskové obrúsky Včelobal M - Folklór.',
    produkty: [OBRUSKY],
  },
  sampon: {
    otazka: 'Máte tuhý šampón na vlasy?',
    odpoved: 'Áno, môžete si vybrať z našich tuhých šampónov, napríklad Tuhý šampón Vážna známosť 40g Musk za 5,50 € alebo Tuhý šampón Ponio - Šampúch citrón a rozmarín 30g za 5,50 €. Môžete ma otázkať napríklad čo je rozdiel medzi tuhým šampónom a klasickým šampónom, alebo ktorý tuhý šampón je vhodný pre suché vlasy.',
    produkty: [SAMPON_1, SAMPON_2],
  },
};

// ---------------------------------------------------------------------------
// 1. Príčina v promptoch
// ---------------------------------------------------------------------------

test('príčina: žiadny prompt nemá vzor „môžete nahradiť“; „môžete“ v slovenskom prompte len v zakázanej vete, v prompte auto vôbec', () => {
  const prompty = {
    sk: buildSystemPrompt('sk'), skOkno: buildSystemPrompt('sk', { autoOkno: true }), cs: buildSystemPrompt('cs'),
    csOkno: buildSystemPrompt('cs', { autoOkno: true }), en: buildSystemPrompt('en'), de: buildSystemPrompt('de'), auto: buildSystemPrompt('auto'),
  };
  for (const [kde, p] of Object.entries(prompty)) {
    assert.doesNotMatch(p, /nahradiť|nahradíte|nahradit/i, kde);
  }
  // Do 1. 10. bolo „môžete“ v slovenskom prompte 5-krát (vykanie, neurčitok, vzor), v prompte auto 3-krát.
  assert.equal((prompty.sk.match(/môžete/gi) || []).length, 1); // „Môžete sa spýtať…“ ako zakázaná veta
  assert.equal((prompty.skOkno.match(/môžete/gi) || []).length, 1);
  assert.equal((prompty.cs.match(/můžete/gi) || []).length, 1); // „Můžete se zeptat…“ ako zakázaná veta
  assert.equal((prompty.auto.match(/môžete|můžete/gi) || []).length, 0);
  assert.match(prompty.sk, /vždy vykaj, nikdy mu netykaj/);
  assert.match(prompty.cs, /vždy vykej, nikdy mu netykej/);
});

test('prompty: prirodzený začiatok odporúčania a o náhrade len pri otázke na náhradu (sk, cs, en, de, auto)', () => {
  assert.match(buildSystemPrompt('sk'), /„Odporúčam …“, „Hodí sa …“ alebo „Pozrite si …“/);
  assert.match(buildSystemPrompt('sk'), /o náhrade píš len vtedy, keď sa na ňu zákazník pýta/);
  assert.match(buildSystemPrompt('sk'), /len skutočnými slovenskými slovami/);
  assert.match(buildSystemPrompt('cs'), /„Doporučuji …“, „Hodí se …“ nebo „Podívejte se na …“/);
  assert.match(buildSystemPrompt('cs'), /o náhradě piš jen tehdy, když se na ni zákazník ptá/);
  assert.match(buildSystemPrompt('en'), /"I recommend …", "… is a good fit" or "Have a look at …"/);
  assert.match(buildSystemPrompt('en'), /only when the customer asks what to replace it with/);
  assert.match(buildSystemPrompt('de'), /"Ich empfehle …"/);
  assert.match(buildSystemPrompt('de'), /nur dann vom Ersetzen/);
  const auto = buildSystemPrompt('auto');
  assert.match(auto, /In Slovak, start a recommendation for example with "Odporúčam …", "Hodí sa …" or "Pozrite si …"/);
  assert.match(auto, /never a word made up by translating an English expression literally/);
  assert.match(auto, /the polite plural form in Slovak and Czech/);
});

test('prisnyPokyn: opakovanie bez vzoru „nahradiť“ v žiadnom jazyku; tvar slovesa po „môžete“ len pri chybe slovenčiny', () => {
  const nalezy = ['pismo', 'chyba_sk', 'kontakt', 'otazky', 'karta_mimo', 'nahradenie'];
  for (const jazyk of ['sk', 'cs', 'en', 'de', 'auto']) {
    for (const n of nalezy) assert.doesNotMatch(prisnyPokyn(jazyk, [n]), /nahradiť|nahradíte|nahradit/i, `${jazyk} ${n}`);
    assert.doesNotMatch(prisnyPokyn(jazyk, nalezy), /nahradiť|nahradíte|nahradit/i, jazyk);
  }
  const sk = prisnyPokyn('sk', ['nahradenie']);
  assert.match(sk, /^OPRAVA: predchádzajúca odpoveď .*\(odpoveď hovorí o náhrade, hoci sa zákazník na náhradu nepýta\)/);
  assert.match(sk, /napríklad „Odporúčam …“ alebo „Hodí sa …“/);
  assert.doesNotMatch(sk, /po slove „môžete“/);
  assert.match(prisnyPokyn('sk', ['chyba_sk']), /po slove „môžete“ neurčitok; neurčitok nikdy nekončí na -íť/);
  assert.match(prisnyPokyn('auto', ['chyba_sk']), /a Slovak infinitive never ends in -íť/);
  assert.match(prisnyPokyn('cs', ['nahradenie']), /odpověď mluví o náhradě/);
  assert.match(prisnyPokyn('auto', ['nahradenie']), /^CORRECTION: .*replacing something although the customer did not ask for a replacement/);
  assert.doesNotMatch(prisnyPokyn('auto', ['otazky']), /môžete/);
});

// ---------------------------------------------------------------------------
// 2. Kontrola výstupu: náhrada bez otázky na náhradu
// ---------------------------------------------------------------------------

test('kontrolaTextu: tri vety „Môžete nahradiť …“ z náhľadu 2. 10. sú nález, lebo otázka sa na náhradu nepýta', () => {
  for (const k of ['rocne', 'logika', 'macka']) {
    const z = ZIVE[k];
    assert.equal(jeOtazkaNaNahradu(z.otazka), false, z.otazka);
    assert.deepEqual(kontrolaTextu(z.odpoved, { jazyk: 'sk', otazka: z.otazka, candidates: kandidatiZ(z.produkty) }), ['nahradenie'], k);
  }
});

test('kontrolaTextu: na otázku na náhradu smie ísť „môžete nahradiť“ (bezobalovo.sk); bez otázky ani vlastnosť výrobku nie je nález', () => {
  const f = ZIVE.folia;
  assert.ok(jeOtazkaNaNahradu(f.otazka));
  assert.deepEqual(kontrolaTextu(f.odpoved, { jazyk: 'sk', otazka: f.otazka, candidates: kandidatiZ(f.produkty) }), []);
  for (const o of ['Čo použiť namiesto alobalu?', 'Akú alternatívu k plastovým vrecúškam máte?', 'Čím môžem nahradiť cukor?', 'Treba vymeniť filter?']) {
    assert.ok(jeOtazkaNaNahradu(o), o);
  }
  // staršie volania bez otázky: nič sa nehlási (nie je s čím porovnať)
  assert.deepEqual(kontrolaTextu(ZIVE.rocne.odpoved, { jazyk: 'sk' }), []);
  assert.equal(nahradenieBezOtazky(ZIVE.rocne.odpoved, ''), false);
  // „nahradí“ (vlastnosť výrobku) a „náhradná náplň“ nie sú ponuka zákazníkovi
  assert.deepEqual(kontrolaTextu('Zmes Bio Minútky na mäso 20g nahradí soľ, je bez pridanej soli.', { jazyk: 'sk', otazka: 'Máte korenie bez soli?' }), []);
  assert.deepEqual(kontrolaTextu('Ku kávovaru máme aj náhradnú náplň za 5,50 €.', { jazyk: 'sk', otazka: 'Čo potrebujem ku kávovaru?' }), []);
  // pri pozdrave či otázke o asistentovi sa náhrada nekontroluje
  assert.deepEqual(kontrolaTextu('Som asistent obchodu, poradím, čím nahradiť fóliu.', { jazyk: 'sk', otazka: 'ako to funguje?', meta: true }), []);
});

test('kontrolaTextu: rovnaké pravidlo v češtine, angličtine a nemčine', () => {
  assert.deepEqual(kontrolaTextu('Můžete nahradit čaj Earl Grey zeleným čajem Sencha.', { jazyk: 'cs', otazka: 'Jaký čaj doporučujete na večer?' }), ['nahradenie']);
  assert.deepEqual(kontrolaTextu('Plastovou fólii můžete nahradit voskovým ubrouskem.', { jazyk: 'cs', otazka: 'Čím nahradím plastovou fólii?' }), []);
  assert.deepEqual(kontrolaTextu('You can replace your coffee with the Matcha Starter Kit.', { jazyk: 'en', otazka: 'What do I need to make matcha at home?' }), ['nahradenie']);
  assert.deepEqual(kontrolaTextu('You can replace cling film with beeswax wraps.', { jazyk: 'en', otazka: 'What can I use instead of cling film?' }), []);
  assert.deepEqual(kontrolaTextu('Sie können Ihren Kaffee durch das Matcha Starter Kit ersetzen.', { jazyk: 'de', otazka: 'Was brauche ich für Matcha zu Hause?' }), ['nahradenie']);
  assert.deepEqual(kontrolaTextu('Frischhaltefolie können Sie durch Bienenwachstücher ersetzen.', { jazyk: 'de', otazka: 'Womit kann ich Frischhaltefolie ersetzen?' }), []);
  assert.deepEqual(kontrolaTextu('Dieses Gewürz ersetzt Salz beim Grillen.', { jazyk: 'de', otazka: 'Haben Sie Gewürze ohne Salz?' }), []);
});

// ---------------------------------------------------------------------------
// 3. „otázkať“
// ---------------------------------------------------------------------------

test('polishAnswer: „Môžete ma otázkať napríklad“ opraví na „Môžete sa ma opýtať napríklad“ (sk aj auto); „otázkam“ ostáva', () => {
  assert.equal(polishAnswer('Môžete ma otázkať napríklad, ktorý šampón je vhodný pre suché vlasy.', 'sk'),
    'Môžete sa ma opýtať napríklad, ktorý šampón je vhodný pre suché vlasy.');
  assert.equal(polishAnswer(ZIVE.sampon.odpoved, 'auto'), ZIVE.sampon.odpoved.replace('Môžete ma otázkať', 'Môžete sa ma opýtať'));
  assert.equal(polishAnswer('Môžete sa ma otázkať na vôňu.', 'sk'), 'Môžete sa ma opýtať na vôňu.');
  assert.equal(polishAnswer('Otázkajte sa ma na čokoľvek.', 'sk'), 'Opýtajte sa ma na čokoľvek.');
  assert.equal(polishAnswer('Odpovede k otázkam nájdete pri výrobku.', 'sk'), 'Odpovede k otázkam nájdete pri výrobku.');
});

test('kontrolaTextu a bezPrikladovOtazok: „otázkať“ je chyba slovenčiny aj ponuka otázok; úvod príkladov sa odstrihne v každom tvare', () => {
  assert.deepEqual(kontrolaTextu('Odporúčam Tuhý šampón Vážna známosť 40g Musk. Môžete ma otázkať napríklad na vôňu.', { jazyk: 'sk', otazka: ZIVE.sampon.otazka }), ['chyba_sk', 'otazky']);
  const zaklad = 'Odporúčam Tuhý šampón Vážna známosť 40g Musk za 5,50 €, je vhodný na suché vlasy.';
  assert.equal(bezPrikladovOtazok(`${zaklad} Môžete sa ma opýtať napríklad na vôňu.`), zaklad);
  assert.equal(bezPrikladovOtazok(`${zaklad} Môžete sa ma tiež opýtať, napríklad na vôňu.`), zaklad);
  assert.equal(bezPrikladovOtazok(`${zaklad} Môžete ma otázkať napríklad na vôňu.`), zaklad);
});

// ---------------------------------------------------------------------------
// 4. runChat: celé cesty s napodobeným modelom
// ---------------------------------------------------------------------------

test('runChat: „Môžete nahradiť …“ na otázku bez náhrady = jedno opakovanie s pokynom bez vzoru, ide prirodzená odpoveď (tri vety z náhľadu)', async () => {
  for (const k of ['rocne', 'logika', 'macka']) {
    const z = ZIVE[k];
    const prva = { answer: z.odpoved, products: z.produkty.map(karta) };
    const druha = { answer: z.cista, products: [karta(z.produkty[0])] };
    const ai = model([prva, druha]);
    const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', z.produkty) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: z.otazka }], lang: 'sk' });
    assert.equal(r.answer, z.cista, k);
    assert.doesNotMatch(r.answer, /nahrad/i, k);
    assert.deepEqual(r.products.map((p) => p.url), [z.produkty[0].url], k);
    assert.equal(r.meta.opravene, true, k);
    assert.deepEqual(r.meta.nalezy, ['nahradenie'], k);
    const volania = chatVolania(ai);
    assert.equal(volania.length, 2, k);
    assert.doesNotMatch(volania[0].input.messages[0].content, /nahradiť|OPRAVA/, k);
    assert.match(volania[1].input.messages[0].content, /OPRAVA: predchádzajúca odpoveď .*odpoveď hovorí o náhrade/, k);
    assert.doesNotMatch(volania[1].input.messages[0].content, /nahradiť/, k);
  }
});

test('runChat: keď model ani po opakovaní nenechá „Môžete nahradiť“, ide veta workera s kartami, nikdy chybná veta (pipers.sk, režim auto)', async () => {
  const z = ZIVE.macka;
  const zla = { answer: z.odpoved, products: z.produkty.map(karta) };
  const ai = model([zla, zla]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', z.produkty) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: z.otazka }], lang: 'auto' });
  assert.equal(r.answer, 'Tieto produkty najlepšie zodpovedajú vašej otázke.');
  assert.deepEqual(r.products.map((p) => p.url), z.produkty.map((p) => p.url));
  assert.equal(r.meta.bezpecna, true);
  const volania = chatVolania(ai);
  assert.equal(volania.length, 2);
  // slovenská otázka v režime auto ide pevným slovenským promptom (urciJazykOtazky), bez vzoru
  assert.match(volania[0].input.messages[0].content, /Odpovedaj výhradne po slovensky/);
  assert.doesNotMatch(volania[0].input.messages[0].content, /nahradiť/);
});

test('runChat: na otázku na náhradu ostane „Môžete nahradiť …“ bez opakovania (bezobalovo.sk)', async () => {
  const z = ZIVE.folia;
  const ai = model([{ answer: z.odpoved, products: z.produkty.map(karta) }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', z.produkty) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: z.otazka }], lang: 'sk' });
  assert.equal(r.answer, z.odpoved);
  assert.deepEqual(r.products.map((p) => p.url), [OBRUSKY.url]);
  assert.equal(chatVolania(ai).length, 1);
  assert.equal(r.meta.opravene, undefined);
});

test('runChat: „Môžete ma otázkať napríklad …“ v odpovedi o výrobkoch zmizne bez opakovania (bezobalovo.sk, režim auto)', async () => {
  const z = ZIVE.sampon;
  const ai = model([{ answer: z.odpoved, products: z.produkty.map(karta) }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', z.produkty) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: z.otazka }], lang: 'auto' });
  assert.equal(r.answer, 'Áno, môžete si vybrať z našich tuhých šampónov, napríklad Tuhý šampón Vážna známosť 40g Musk za 5,50 € alebo Tuhý šampón Ponio - Šampúch citrón a rozmarín 30g za 5,50 €.');
  assert.doesNotMatch(r.answer, /otázk|opýtať/);
  assert.deepEqual(r.products.map((p) => p.url), [SAMPON_1.url, SAMPON_2.url]);
  const volania = chatVolania(ai);
  assert.equal(volania.length, 1);
  // otázka bez istého jazyka ostáva v režime auto: anglický prompt bez slovenských tvarov s „môžete“
  assert.match(volania[0].input.messages[0].content, /Most important rule/);
  assert.doesNotMatch(volania[0].input.messages[0].content, /môžete/);
});

test('runChat: pri otázke o asistentovi príklady otázok ostanú, ale so správnym „Môžete sa ma opýtať“', async () => {
  const ai = model([{ answer: 'Som asistent tohto obchodu a odporúčam výrobky z jeho katalógu. Môžete ma otázkať napríklad, ktorý tuhý šampón je vhodný pre suché vlasy.', products: [] }]);
  const r = await runChat({ AI: ai, VECTORIZE: await vektory('t', [SAMPON_1, SAMPON_2]) }, { tenant: { id: 't' }, messages: [{ role: 'user', content: 'ako to funguje?' }], lang: 'sk' });
  assert.equal(r.answer, 'Som asistent tohto obchodu a odporúčam výrobky z jeho katalógu. Môžete sa ma opýtať napríklad, ktorý tuhý šampón je vhodný pre suché vlasy.');
  assert.equal(chatVolania(ai).length, 1);
});
