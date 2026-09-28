// widget-v2.test.mjs: nové správanie widgetu v2 (ops/asistent/v2/SPEC.md, bod 8.10).
// Upútavka raz za reláciu, úvodné dlaždice a kategórie, porovnanie, karty s fotkou,
// Obnoviť, pole na písanie nič neprekrýva, pasca fokusu, znížený pohyb, CSP, veľkosť.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spusti, makeStorage, makeElement, hodiny, tik, fetchZoznam, radky, vsetkyTexty, cssZRoot, dieta, widgetSource, widgetPath } from './helpers/widget-v2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const otvor = (root) => root.getElementById('toggle')._listeners.click[0]();
const uvod = (root) => radky(root)[0];
const klik = (el) => el._listeners.click[0]();

// ---------------------------------------------------------------------------
// 3. Upútavka (U1 až U5)
// ---------------------------------------------------------------------------

function sUpoutavkou({ storage = makeStorage(), attrs = {}, document: d = {}, window: w = {} } = {}) {
  const h = hodiny();
  const w2 = spusti({ attrs: { 'data-upoutavka-oneskorenie': '0', ...attrs }, storage, timers: h, document: d, window: w });
  return { ...w2, h, storage, teaser: w2.root.getElementById('teaser') };
}

test('U3 upútavka sa ukáže raz za reláciu: prvá stránka áno, ďalšia stránka tej istej karty už nie', () => {
  const storage = makeStorage();
  const a = sUpoutavkou({ storage });
  a.h.spusti();
  assert.equal(a.teaser.hidden, false, 'ukázaná');
  assert.equal(storage._store.get('arling_asistent_upoutavka'), 'ukazana');
  assert.equal(a.root.getElementById('teaser-otazka').textContent, 'Poradiť vám s výberom?');
  assert.equal(a.root.getElementById('teaser-riadok').textContent, 'Odpovedám z produktov tohto obchodu.');
  assert.deepEqual(a.h.cakajuce, [12000], 'zmizne sama po 12 s (počítač)');
  const b = sUpoutavkou({ storage });
  assert.equal(b.h.pocet, 0, 'nič sa ani neplánuje');
  assert.notEqual(b.teaser.hidden, false);
});

test('U3 upútavka sa neukáže po otvorení panela, pri data-upoutavka="0" ani v režime data-mount', () => {
  const s = makeStorage();
  const a = sUpoutavkou({ storage: s });
  otvor(a.root);
  a.h.spusti();
  assert.notEqual(a.teaser.hidden, false);
  assert.equal(s._store.get('arling_asistent_upoutavka'), 'otvorene');

  const b = sUpoutavkou({ attrs: { 'data-upoutavka': '0' } });
  assert.equal(b.h.pocet, 0);

  const miesto = makeElement('div');
  const h = hodiny();
  spusti({ attrs: { 'data-mount': 'miesto', 'data-upoutavka-oneskorenie': '0' }, timers: h, document: { getElementById: (id) => (id === 'miesto' ? miesto : null) } });
  const root = miesto.children[0].shadowRoot;
  assert.equal(root.getElementById('teaser'), null, 'vložený režim nemá upútavku v markupe');
  assert.equal(h.pocet, 0);
});

test('U3 Zavrieť zapíše "zatvorena" a upútavku skryje; Esc v upútavke tiež', () => {
  const a = sUpoutavkou();
  a.h.spusti();
  klik(a.root.getElementById('teaser-close'));
  assert.equal(a.storage._store.get('arling_asistent_upoutavka'), 'zatvorena');
  assert.equal(a.teaser.hidden, true);
  assert.equal(a.h.pocet, 0, 'časovač samozatvorenia zrušený');

  const b = sUpoutavkou();
  b.h.spusti();
  let zastavene = false;
  b.teaser._listeners.keydown[0]({ key: 'Escape', stopPropagation() { zastavene = true; } });
  assert.equal(b.teaser.hidden, true);
  assert.equal(zastavene, true);
});

test('U3 oneskorenie beží len pri viditeľnej stránke a nie nad fokusom v poli obchodu', () => {
  const doc = { visibilityState: 'hidden', activeElement: null };
  const a = sUpoutavkou({ attrs: { 'data-upoutavka-oneskorenie': '500' }, document: doc });
  for (let i = 0; i < 6; i++) a.h.spusti();
  assert.notEqual(a.teaser.hidden, false, 'skrytá karta: čas nebeží');
  a.documentStub.visibilityState = 'visible';
  a.documentStub.activeElement = { tagName: 'INPUT' };
  for (let i = 0; i < 4; i++) a.h.spusti();
  assert.notEqual(a.teaser.hidden, false, 'zákazník píše do vyhľadávania obchodu');
  a.documentStub.activeElement = null;
  a.h.spusti();
  assert.equal(a.teaser.hidden, false);
});

test('U3 klik na upútavku otvorí panel a nič neposiela (nemíňa AI)', () => {
  const f = fetchZoznam([{ answer: 'x', products: [] }]);
  const h = hodiny();
  const w = spusti({ attrs: { 'data-upoutavka-oneskorenie': '0' }, timers: h, fetch: f, storage: makeStorage() });
  h.spusti();
  klik(w.root.getElementById('teaser-open'));
  assert.equal(w.root.getElementById('panel').hidden, false);
  assert.equal(w.root.getElementById('teaser').hidden, true);
  assert.equal(f.poslane.length, 0);
});

test('U4 produktový kontext z JSON-LD (aj @graph a pole @type) a z og:type', () => {
  const ld = (obj) => ({ querySelectorAll: (sel) => (sel.includes('ld+json') ? [{ textContent: JSON.stringify(obj) }] : []), querySelector: () => null });
  const pripady = [
    [ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Kávovar Orava Mini' }), 'Kávovar Orava Mini'],
    [ld({ '@graph': [{ '@type': 'WebPage', name: 'Stránka' }, { '@type': ['Product', 'Thing'], name: 'Mlynček ručný' }] }), 'Mlynček ručný'],
    [{
      querySelectorAll: (sel) => (sel.includes('ld+json') ? [{ textContent: '{zlý json' }] : []),
      querySelector: (sel) => ({ getAttribute: () => (sel.includes('og:type') ? 'product' : 'Čajník 1 l') }),
    }, 'Čajník 1 l'],
  ];
  for (const [doc, nazov] of pripady) {
    const a = sUpoutavkou({ document: doc });
    a.h.spusti();
    assert.equal(a.root.getElementById('teaser-otazka').textContent, 'Máte otázku k tomuto produktu?');
    assert.equal(a.root.getElementById('teaser-riadok').textContent, nazov);
  }
  const ina = sUpoutavkou({ attrs: { 'data-upoutavka-text': 'Hľadáte kávovar?' } });
  ina.h.spusti();
  assert.equal(ina.root.getElementById('teaser-otazka').textContent, 'Hľadáte kávovar?');
});

// ---------------------------------------------------------------------------
// 4. Rýchle voľby (dlaždice), 5. kategórie
// ---------------------------------------------------------------------------

function dlazdice(opts) {
  const w = spusti(opts);
  otvor(w.root);
  const grid = dieta(uvod(w.root), 'dlazdice');
  // v2.2 (overenie 2): na dlaždici krátky text, plné slová v aria-label (názov obsahuje viditeľný text, WCAG 2.5.3).
  const texty = grid.children.map((d) => (d === w.root.getElementById('gift-toggle') ? 'DARCEK' : d.getAttribute('aria-label') || d.children[1].textContent));
  const kratke = grid.children.map((d) => (d === w.root.getElementById('gift-toggle') ? 'DARCEK' : d.children[1].textContent));
  for (let i = 0; i < texty.length; i++) assert.ok(texty[i].toLowerCase().includes(kratke[i].toLowerCase()), `${kratke[i]} je v názve ${texty[i]}`);
  return { ...w, grid, texty, kratke };
}

test('4.3 predvolené poradie dlaždíc; darček len s data-gift="1", doprava a kontakt len s platnou konfiguráciou', () => {
  const a = dlazdice({ attrs: { 'data-gift': '1', 'data-doprava': '#doprava', 'data-kontakt': 'mailto:obchod@example.sk' } });
  assert.deepEqual(a.texty, ['DARCEK', 'Porovnať produkty', 'Doprava a vrátenie', 'Kontakt na obchod']);
  assert.deepEqual(a.kratke, ['DARCEK', 'Porovnať', 'Doprava', 'Kontakt'], 'v2.2: jeden krátky riadok na dlaždici');
  assert.equal(a.grid.children[2].tagName, 'a');
  assert.equal(a.grid.children[2].href, '#doprava');
  assert.equal(a.grid.children[3].href, 'mailto:obchod@example.sk');
  const b = dlazdice({ attrs: { 'data-gift': '1', 'data-doprava': 'javascript:alert(1)', 'data-kontakt': 'mailto:' } });
  assert.deepEqual(b.texty, ['DARCEK', 'Porovnať produkty'], 'neplatné odkazy nevytvoria dlaždicu');
});

// v2.1 (overenie 1, nález „tretia dlaždica má iné rozloženie“): žiadna široká posledná dlaždica.
// Mriežka má 6 stĺpcov: 3 dlaždice v jednom riadku, 2 a 4 ako polovice (trieda pol), z 5 posledné dve polovice.
test('4.3 dlaždica produktu len na stránke produktu; 3 dlaždice v rade, 2 a 4 ako polovice', () => {
  const produkt = { querySelectorAll: (sel) => (sel.includes('ld+json') ? [{ textContent: '{"@type":"Product","name":"Kanvica Liptov"}' }] : []), querySelector: () => null };
  const a = dlazdice({ attrs: { 'data-gift': '1' }, document: produkt });
  assert.deepEqual(a.texty, ['DARCEK', 'Porovnať produkty', 'Opýtať sa na tento produkt']);
  assert.deepEqual(a.kratke, ['DARCEK', 'Porovnať', 'Tento produkt']);
  for (const d of a.grid.children) assert.doesNotMatch(d.className, /\b(siroka|pol)\b/, 'tri rovnaké v jednom riadku');
  const b = dlazdice({ attrs: { 'data-gift': '1', 'data-doprava': '#doprava' }, document: produkt });
  assert.equal(b.grid.children.length, 4);
  for (const d of b.grid.children) assert.match(d.className, /\bpol\b/, 'štyri ako 2 x 2');
  const c = dlazdice({ attrs: { 'data-gift': '1', 'data-doprava': '#doprava', 'data-kontakt': 'tel:+421900000000' }, document: produkt });
  assert.deepEqual(c.grid.children.map((d) => /\bpol\b/.test(d.className)), [false, false, false, true, true], 'z piatich posledné dve polovice');
  assert.equal(a.grid.getAttribute('aria-label'), 'Rýchle voľby', 'názov skupiny pre čítačku namiesto verzálkového štítka');
});

test('4.3 menej ako 2 dlaždice: sekcia sa nevykreslí; neplatný data-volby widget nezhodí', () => {
  const a = dlazdice({});
  assert.equal(a.grid.hidden, true);
  assert.equal(a.grid.children.length, 0);
  const b = dlazdice({ attrs: { 'data-volby': '{nie je json', 'data-gift': '1' } });
  assert.deepEqual(b.texty, ['DARCEK', 'Porovnať produkty'], 'zlý JSON = atribút neexistuje');
  const c = dlazdice({ attrs: { 'data-volby': JSON.stringify([{ typ: 'otazka', text: 'Veľkosti', otazka: 'Ako vyberiem veľkosť?' }, { typ: 'hack' }, { typ: 'odkaz', text: 'Blog', url: 'javascript:x' }, { typ: 'odkaz', text: 'Predajne', url: 'https://shop.example/predajne' }]) } });
  assert.deepEqual(c.texty, ['Veľkosti', 'Predajne']);
});

test('4.3 Porovnať produkty bez produktov: vloží „Porovnajte mi “ do poľa a pridá radu asistenta, bez volania API', () => {
  const f = fetchZoznam([{ answer: 'x', products: [] }]);
  const a = dlazdice({ attrs: { 'data-gift': '1' }, fetch: f });
  klik(a.grid.children[1]);
  assert.equal(a.root.getElementById('input').value, 'Porovnajte mi ');
  assert.equal(f.poslane.length, 0);
  assert.equal(radky(a.root).at(-1).children[0].textContent, 'Napíšte, ktoré dva produkty chcete porovnať, a ukážem ich vedľa seba.');
});

test('4.4 kategórie: 3 platné = sekcia a klik pošle otázku; 2 platné = nič', async () => {
  const kat = [{ nazov: 'Kávovary a čaj', obrazok: 'https://shop.example/k.svg' }, { nazov: 'Záhrada', obrazok: 'https://shop.example/z.svg' }, { nazov: 'Deti' }];
  const f = fetchZoznam([{ answer: 'Tu sú.', products: [] }]);
  const a = spusti({ attrs: { 'data-kategorie': JSON.stringify(kat) }, fetch: f });
  otvor(a.root);
  const k = dieta(uvod(a.root), 'kategorie');
  assert.equal(k.children.length, 3);
  assert.equal(k.children[0].children[0].tagName, 'img');
  assert.equal(k.children[0].children[0].alt, '');
  assert.equal(k.children[2].children[0].className, 'kat-ph', 'bez obrázka písmeno');
  klik(k.children[1]);
  await tik();
  assert.equal(f.poslane[0].body.messages.at(-1).content, 'Čo mi odporučíte z kategórie Záhrada?');

  const b = spusti({ attrs: { 'data-kategorie': JSON.stringify(kat.slice(0, 2).concat([{ nazov: '' }])) } });
  otvor(b.root);
  assert.equal(dieta(uvod(b.root), 'kategorie'), undefined);
});

test('4.1 úvod: prvá veta pozdravu je nadpis, pod ním súkromie; štítok otázok zmizne, keď sú všetky položené', async () => {
  const f = fetchZoznam([{ answer: 'ok', products: [] }]);
  const a = spusti({ attrs: { 'data-greeting': 'Dobrý deň, som predavač. Poradím vám s výberom.', 'data-questions': JSON.stringify(['Prvá?']) }, fetch: f });
  otvor(a.root);
  const r = uvod(a.root);
  assert.equal(r.children[0].children[0].textContent, 'Dobrý deň, som predavač. ');
  assert.equal(r.children[0].children[1].textContent, 'Poradím vám s výberom.');
  assert.match(vsetkyTexty(dieta(r, 'sukromie')), /Rozhovor sa neukladá/);
  const stitok = r.children.filter((c) => c.className === 'uvod-stitok').at(-1);
  assert.equal(stitok.textContent, 'Môžete sa opýtať napríklad');
  klik(dieta(r, 'suggestions').children[0]);
  await tik();
  assert.equal(stitok.hidden, true);
});

// ---------------------------------------------------------------------------
// 6. Porovnanie, 7. karta s fotkou
// ---------------------------------------------------------------------------

const P = (id, cena, extra = {}) => ({ title: `Kávovar ${id}, 1,2 l`, url: `https://shop.example/#p-${id}`, image: `https://shop.example/img/${id}.svg`, price: cena, currency: 'EUR', ...extra });

async function rozhovor(odpovede, otazky, attrs = {}) {
  const f = fetchZoznam(odpovede);
  const w = spusti({ attrs, fetch: f });
  for (const q of otazky) {
    if (typeof q === 'function') q(w);
    else w.windowStub.ArlingAsistent.ask(q);
    await tik();
  }
  return { ...w, f };
}

const riadokOdpovede = (root, text) => radky(root).find((r) => r.children[0].textContent === text);

test('K9 porovnanie: čip „Porovnať prvé dva“ pošle príznak, odpoveď s 2 produktmi je vedľa seba s rozdielom ceny', async () => {
  const w = await rozhovor(
    [{ answer: 'Štyri.', products: [P('A', 49.9), P('B', 59.9), P('C', 79), P('D', 89)] }, { answer: 'Porovnanie.', products: [P('A', 49.9), P('B', 59.9)] }],
    ['Aký kávovar do 100 eur?', (x) => klik(dieta(riadokOdpovede(x.root, 'Štyri.'), 'pas-akcie').children[0])],
  );
  assert.equal(w.f.poslane[1].body.messages.at(-1).content, 'Porovnajte mi Kávovar A a Kávovar B.');
  const r = riadokOdpovede(w.root, 'Porovnanie.');
  const por = dieta(r, 'porovnanie');
  assert.ok(por, 'porovnanie vedľa seba');
  assert.equal(dieta(r, 'products'), undefined, 'bez pásu');
  assert.equal(dieta(por, 'por-mriezka').children.length, 2);
  // v2.2 (overenie 2): rozdiel nesie lacnejší stĺpec štítkom pri cene, nie samostatný riadok pod čiarou.
  const [sa, sb] = dieta(por, 'por-mriezka').children;
  assert.match(dieta(dieta(sa, 'por-cena-riadok'), 'por-lacnejsi').textContent, /^o 10,00\s€ lacnejší$/);
  assert.equal(dieta(dieta(sb, 'por-cena-riadok'), 'por-lacnejsi'), undefined, 'drahší stĺpec štítok nemá');
  assert.equal(dieta(sa, 'por-pozriet').textContent, 'Pozrieť', 'Pozrieť ako v páse kariet');
});

test('K9 príznak so 4 produktmi: porovnanie prvých dvoch a pás so zvyšnými dvoma; regex vetva bez príznaku', async () => {
  const w = await rozhovor(
    [{ answer: 'Štyri.', products: [P('A', 1), P('B', 2)] }, { answer: 'Porovnanie štyroch.', products: [P('A', 1), P('B', 2), P('C', 3), P('D', 4)] }],
    ['Máte kávovar?', (x) => klik(dieta(riadokOdpovede(x.root, 'Štyri.'), 'pas-akcie').children[0])],
  );
  const r = riadokOdpovede(w.root, 'Porovnanie štyroch.');
  assert.ok(dieta(r, 'porovnanie'));
  assert.equal(dieta(r, 'products').children.length, 2);

  const rg = await rozhovor([{ answer: 'Rozdiel.', products: [P('A', 10), P('B', 20)] }], ['Aký je rozdiel medzi A a B?']);
  assert.ok(dieta(riadokOdpovede(rg.root, 'Rozdiel.'), 'porovnanie'), 'regex vetva');
  const bez = await rozhovor([{ answer: 'Dva.', products: [P('A', 10), P('B', 20)] }], ['Aký kávovar?']);
  assert.equal(dieta(riadokOdpovede(bez.root, 'Dva.'), 'porovnanie'), undefined, 'bez príznaku a bez slova porovnania pás');
});

test('K9 rozdiel ceny len pri rovnakej mene; parametre len keď ich API pošle', async () => {
  const w = await rozhovor([{ answer: 'Meny.', products: [P('A', 10), P('B', 300, { currency: 'CZK' })] }], ['Porovnajte A a B']);
  const por = dieta(riadokOdpovede(w.root, 'Meny.'), 'porovnanie');
  assert.ok(por);
  // v2.2: pri rôznych menách žiadny štítok rozdielu.
  for (const st of dieta(por, 'por-mriezka').children) assert.equal(dieta(dieta(st, 'por-cena-riadok'), 'por-lacnejsi'), undefined);
  assert.equal(dieta(por, 'por-param'), undefined);
  const s = await rozhovor([{ answer: 'Param.', products: [P('A', 10, { params: [{ nazov: 'Objem', hodnota: '1 l' }] }), P('B', 12, { params: [{ nazov: 'Objem', hodnota: '1,5 l' }] })] }], ['Porovnajte A a B']);
  const tab = dieta(dieta(riadokOdpovede(s.root, 'Param.'), 'porovnanie'), 'por-param');
  assert.deepEqual(tab.children.map((c) => c.textContent), ['Objem', '1 l', '1,5 l']);
});

test('K6, K7 karta: rola listitem na obale, odkaz bez roly, fotka v tácke s alt="" a rozmermi, dostupnosť len z API', async () => {
  const w = await rozhovor([{ answer: 'Karty.', products: [
    P('A', 10, { availability: 'in_stock' }),
    P('B', 10, { availability: 'available_in_3_days' }),
    P('C', 10, { availability: 'available_in_1_days' }),
    P('D', 10, { availability: 'available_from_2026-10-05' }),
    P('E', 10, { availability: 'out_of_stock' }),
    P('F', 10, { availability: 'nieco_ine' }),
    P('G', 10),
  ] }], ['Karty?']);
  const r = riadokOdpovede(w.root, 'Karty.');
  const list = dieta(r, 'products');
  assert.equal(list.getAttribute('role'), 'list');
  assert.equal(list.getAttribute('aria-label'), 'Súvisiace produkty');
  assert.equal(dieta(r, 'pas-hlavicka').children[0].textContent, 'Súvisiace produkty (7)');
  const dost = list.children.map((li) => {
    assert.equal(li.getAttribute('role'), 'listitem');
    const a = li.children[0];
    assert.equal(a.tagName, 'a');
    assert.equal(a.getAttribute('role'), null, 'odkaz si nechá rolu odkazu');
    const img = a.children[0].children[0];
    assert.equal(img.tagName, 'img');
    assert.equal(img.alt, '');
    assert.equal(img.loading, 'lazy');
    assert.equal(img.getAttribute('width'), '172', 'v2.2: šírka karty 172 (časť 13)');
    assert.match(img.src, /^https:\/\/shop\.example\/img\/[A-G]\.svg$/);
    assert.match(a.getAttribute('aria-label'), /, 10,00\s€, .*Pozrieť \(otvorí sa v novom okne\)$/);
    const d = a.children[1].children.find((c) => /product-dost/.test(c.className));
    return d ? d.textContent : null;
  });
  assert.deepEqual(dost, ['Skladom', 'Do 3 dní', 'Do 1 dňa', 'Dostupné od 5. 10. 2026', 'Vypredané', null, null]);
  assert.doesNotThrow(() => klik(list.children[0].children[0]));
});

test('K7 obrázok sa po načítaní ukáže (trieda nacitane), jeden produkt je široká karta', async () => {
  const w = await rozhovor([{ answer: 'Jeden.', products: [P('A', 10)] }], ['Jeden?']);
  const list = dieta(riadokOdpovede(w.root, 'Jeden.'), 'products');
  assert.equal(list.getAttribute('data-jeden'), '');
  const tacka = list.children[0].children[0].children[0];
  tacka.children[0]._listeners.load[0]();
  assert.match(tacka.className, /\bnacitane\b/);
});

// ---------------------------------------------------------------------------
// 8. Obnoviť (P7)
// ---------------------------------------------------------------------------

test('P7 Obnoviť: rozhovor preč, úvod ostáva, položené otázky sa vrátia, token relacie ostáva', async () => {
  const storage = makeStorage();
  const f = fetchZoznam([{ answer: 'Odpoveď.', products: [P('A', 1), P('B', 2)], relacia: 'r1.abc.def' }]);
  const w = spusti({ attrs: { 'data-questions': JSON.stringify(['Prvá?', 'Druhá?']) }, fetch: f, storage });
  otvor(w.root);
  const prva = dieta(uvod(w.root), 'suggestions').children[0];
  klik(prva);
  await tik();
  assert.equal(radky(w.root).length, 3);
  assert.equal(prva.hidden, true);
  klik(w.root.getElementById('reset-btn'));
  assert.equal(radky(w.root).length, 1);
  assert.match(radky(w.root)[0].className, /msg-uvod/);
  assert.equal(prva.hidden, false);
  assert.equal(prva.disabled, false);
  assert.equal(storage._store.get('arling_asistent_relacia'), 'r1.abc.def');
  assert.equal(w.root.getElementById('live').textContent, 'Začať nový rozhovor');
  w.windowStub.ArlingAsistent.ask('Tretia?');
  await tik();
  assert.deepEqual(f.poslane[1].body.messages.map((m) => m.content), ['Tretia?'], 'nový rozhovor bez starých správ');
  assert.equal(f.poslane[1].body.relacia, 'r1.abc.def', 'server nezačne počítať nový rozhovor kvôli tlačidlu');
});

// Brána Asistenta v2 29. 9. 2026, nález 2: Obnoviť počas čakajúcej odpovede nechalo pole
// zamknuté a neskorá stará odpoveď sa objavila v novom rozhovore bez otázky.
test('P7 Obnoviť počas čakania: požiadavka sa zruší, ovládanie sa odomkne a neskorá odpoveď do nového rozhovoru nepríde', async () => {
  let pusti = null;
  const poslane = [];
  const zrusene = [];
  const f = (url, init) => {
    poslane.push(JSON.parse(init.body));
    if (init.signal && typeof init.signal.addEventListener === 'function') init.signal.addEventListener('abort', () => zrusene.push(poslane.length));
    if (poslane.length === 1) {
      // prehliadač, ktorý zrušenie neposlúchne: odpoveď príde aj tak, neskoro
      return new Promise((r) => { pusti = () => r({ status: 200, ok: true, json: async () => ({ answer: 'Stará odpoveď.', products: [P('Stará karta', 9)] }) }); });
    }
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ answer: 'Nová odpoveď.', products: [] }) });
  };
  const w = spusti({ fetch: f, sandbox: { AbortController } });
  otvor(w.root);
  w.windowStub.ArlingAsistent.ask('Stará otázka?');
  await tik();
  const send = w.root.getElementById('send-btn');
  assert.equal(send.disabled, true, 'počas čakania zamknuté');
  klik(w.root.getElementById('reset-btn'));
  assert.equal(send.disabled, false, 'Obnoviť odomkne odoslanie hneď');
  assert.equal(w.root.getElementById('input').readOnly, false);
  assert.deepEqual(zrusene, [1], 'stará požiadavka zrušená');
  pusti();
  await tik(); await tik();
  assert.equal(radky(w.root).length, 1, 'len úvod, žiadna stará odpoveď');
  assert.doesNotMatch(vsetkyTexty(w.root.getElementById('messages')), /Stará odpoveď|Stará karta/);
  assert.equal(send.disabled, false, 'neskorá odpoveď ovládanie znova nezamkne');
  w.windowStub.ArlingAsistent.ask('Nová otázka?');
  await tik(); await tik();
  assert.deepEqual(poslane[1].messages.map((m) => m.content), ['Nová otázka?']);
  assert.match(vsetkyTexty(w.root.getElementById('messages')), /Nová odpoveď\./);
  assert.equal(radky(w.root).length, 3);
});

// ---------------------------------------------------------------------------
// 9. Pole na písanie nikdy prekryté (P9) a darček ako pohľad v paneli (5.8)
// ---------------------------------------------------------------------------

function pravidla(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ sel: m[1].trim(), dekl: m[2] });
  return out;
}

test('P9 pole na písanie nič neprekrýva: #gift-toggle ani dlaždice nie sú absolute/fixed, v paneli je absolute len sr-only a ikona Zavrieť upútavky', () => {
  const w = spusti({ attrs: { 'data-gift': '1' } });
  const css = cssZRoot(w.root);
  assert.ok(css.length > 10000);
  const pozicne = pravidla(css).filter((p) => /position:\s*(absolute|fixed)/.test(p.dekl));
  // v2.2: .telo::after je prechod nad lištou (leží v .telo, lištu nepretína, pointer-events:none).
  const dovolene = ['.sr-only', '#toggle', '#teaser', '#scrim', '#panel', '.u-zavriet', '#toggle .spustac-text', '.telo::after'];
  assert.match(css, /\.telo::after\{[^}]*pointer-events:none/);
  for (const p of pozicne) {
    for (const s of p.sel.split(',').map((x) => x.trim())) {
      assert.ok(dovolene.includes(s), `nečakané position v „${s}“`);
    }
  }
  assert.doesNotMatch(css, /#gift-toggle[^{]*\{[^}]*position/);
  assert.doesNotMatch(css, /\.dlazdica[^{]*\{[^}]*position/);
  assert.doesNotMatch(widgetSource, /right:70px/, 'stará plávajúca pilulka zanikla');
  assert.match(css, /\.composer\{flex:none;display:flex/, 'lišta s poľom je v toku (flex)');
  assert.match(w.root.innerHTML, /<div class="telo"><div id="messages"[^>]*><\/div><div id="gift-panel"/, 'sprievodca je pohľad v tele panela, nie druhý dialóg');
  assert.doesNotMatch(w.root.innerHTML, /id="gift-panel"[^>]*role="dialog"/);
});

test('5.8 sprievodca: otvorí sa v paneli namiesto rozhovoru, krok a postup sa menia, napísaná otázka ho zavrie', async () => {
  const f = fetchZoznam([{ answer: 'ok', products: [] }]);
  const w = spusti({ attrs: { 'data-gift': '1' }, fetch: f });
  klik(w.root.getElementById('gift-toggle'));
  assert.equal(w.root.getElementById('panel').hidden, false);
  assert.equal(w.root.getElementById('messages').hidden, true);
  assert.equal(w.root.getElementById('gift-krok').textContent, 'Krok 1 z 3');
  klik(w.root.getElementById('gift-recipient-chips').children[1]);
  assert.equal(w.root.getElementById('gift-krok').textContent, 'Krok 2 z 3');
  assert.equal(w.root.getElementById('gift-postup').getAttribute('data-krok'), '2');
  assert.equal(w.root.getElementById('gift-recipient-chips').children[1].getAttribute('aria-pressed'), 'true');
  w.root.getElementById('input').value = 'Máte kávu?';
  w.root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
  await tik();
  assert.equal(w.root.getElementById('gift-panel').hidden, true);
  assert.equal(w.root.getElementById('messages').hidden, false);
  assert.equal(f.poslane[0].url.endsWith('/v1/chat'), true);
});

// ---------------------------------------------------------------------------
// Pasca fokusu (A3, A4) a znížený pohyb (M3)
// ---------------------------------------------------------------------------

test('A3 pasca fokusu: Tab z posledného ide na prvý, Shift+Tab z prvého na posledný; A4 Esc zavrie a vráti fokus na spúšťač', () => {
  const w = spusti({});
  const panel = w.root.getElementById('panel');
  const [a, b, c] = ['input', 'send', 'close'].map((n) => ({ ...makeElement('button'), n }));
  [a, b, c].forEach((e) => { e.focus = () => { w.root.activeElement = e; e._f = (e._f || 0) + 1; }; });
  panel.querySelectorAll = () => [a, b, c];
  otvor(w.root);
  const keydown = w.docListeners.keydown;
  assert.equal(keydown.length, 1, 'počúva len kým je otvorený');
  let zabranene = 0;
  const e = (key, shiftKey = false) => ({ key, shiftKey, preventDefault() { zabranene += 1; }, stopPropagation() {} });
  w.root.activeElement = c;
  keydown[0](e('Tab'));
  assert.equal(w.root.activeElement, a);
  keydown[0](e('Tab', true));
  assert.equal(w.root.activeElement, c);
  w.root.activeElement = b;
  keydown[0](e('Tab'));
  assert.equal(w.root.activeElement, b, 'v strede nechá prehliadač');
  assert.equal(zabranene, 2);
  w.root.activeElement = null;
  keydown[0](e('Tab'));
  assert.equal(w.root.activeElement, a, 'fokus mimo panela sa vráti dnu');
  const pred = w.root.getElementById('toggle')._focusCalls || 0;
  keydown[0](e('Escape'));
  assert.equal(panel.hidden, true);
  assert.ok(w.root.getElementById('toggle')._focusCalls > pred);
  assert.equal(w.docListeners.keydown.length, 0, 'po zatvorení nepočúva');
  assert.match(w.root.innerHTML, /<div id="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title"/);
  assert.match(w.root.innerHTML, /aria-haspopup="dialog" aria-expanded="false" aria-controls="panel"/);
});

test('A2 na telefóne (hrubý ukazovateľ) dostane fokus panel, nie pole: klávesnica neprekryje úvod', () => {
  const w = spusti({ window: { matchMedia: (q) => ({ matches: q.includes('coarse') }) } });
  otvor(w.root);
  assert.ok(w.root.getElementById('panel')._focusCalls > 0);
  assert.equal(w.root.getElementById('input')._focusCalls || 0, 0);
});

test('M3 znížený pohyb: úvod bez postupného nástupu, posun rozhovoru bez plynulosti, v CSS len priehľadnosť', async () => {
  const redukovany = { matchMedia: (q) => ({ matches: q.includes('reduce'), addEventListener() {} }) };
  const spravanie = async (w) => {
    const box = w.root.getElementById('messages');
    const volania = [];
    box.scrollTo = (o) => volania.push(o.behavior);
    box.getBoundingClientRect = () => ({ top: 0 });
    w.windowStub.ArlingAsistent.ask('Otázka?');
    await tik();
    return volania;
  };
  const f = () => fetchZoznam([{ answer: 'ok', products: [] }]);
  const r = spusti({ window: redukovany, fetch: f() });
  otvor(r.root);
  assert.doesNotMatch(uvod(r.root).className, /\bvstup\b/);
  assert.deepEqual(await spravanie(r), ['auto']);
  const n = spusti({ fetch: f() });
  otvor(n.root);
  assert.match(uvod(n.root).className, /\bvstup\b/);
  assert.deepEqual(await spravanie(n), ['smooth']);

  const css = cssZRoot(n.root);
  const blok = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(blok, /#panel,#panel\[data-stav="otvoreny"\][^{]*\{transform:none;transition:opacity \.15s linear\}/);
  assert.match(blok, /animation:a-fade \.15s linear both/);
  assert.match(blok, /#toggle \.iskra[^{]*\{animation:none\}/);
  assert.match(blok, /\.dots i\{animation-name:a-bodka-rm\}/);
  assert.match(css, /#toggle \.iskra\{[^}]*animation:a-dych 2\.8s ease-in-out 1\.2s 3\}/, 'tri nádychy a stop (S5)');
});

test('M4 animuje sa len transform a opacity; žiadny backdrop-filter ani blur; výnimky len farby pri hoveri', () => {
  const css = cssZRoot(spusti({}).root);
  assert.doesNotMatch(css, /backdrop-filter|filter:\s*blur/);
  const prechody = css.match(/transition:[^;}]+/g) || [];
  for (const p of prechody) {
    for (const cast of p.replace('transition:', '').split(',')) {
      const vlastnost = cast.trim().split(/\s+/)[0];
      assert.ok(['transform', 'opacity', 'background-color', 'border-color', 'color', 'none'].includes(vlastnost), `animuje sa ${vlastnost}`);
    }
  }
  assert.doesNotMatch(css, /transition:[^;}]*(box-shadow|width|height|top|filter)/);
});

// ---------------------------------------------------------------------------
// 10. CSP a 11. veľkosť, texty, adresy
// ---------------------------------------------------------------------------

test('8.2 CSP: v markupe nie je style="", pri dostupnom CSSStyleSheet sa použije adoptedStyleSheets bez <style>', () => {
  const w = spusti({ attrs: { 'data-gift': '1', 'data-logo': 'https://shop.example/logo.svg' } });
  assert.doesNotMatch(w.root.innerHTML, /style="/);
  assert.doesNotMatch(widgetSource, /style="/);
  assert.ok(w.root.children.some((c) => c.tagName === 'style'), 'záloha <style> bez CSSStyleSheet');

  class CSSStyleSheet { replaceSync(t) { this.text = t; } }
  const vytvor = (tag) => {
    const el = makeElement(tag);
    const povodny = el.attachShadow;
    el.attachShadow = () => { const s = povodny(); s.adoptedStyleSheets = []; return s; };
    return el;
  };
  const k = spusti({ sandbox: { CSSStyleSheet }, createElement: vytvor });
  assert.equal(k.root.adoptedStyleSheets.length, 1);
  assert.match(k.root.adoptedStyleSheets[0].text, /#panel\[hidden\]\{display:none\}/);
  assert.equal(k.root.children.some((c) => c.tagName === 'style'), false);
  assert.doesNotMatch(widgetSource, /\beval\(|new Function\(/);
});

// v2.1 (overenie 1, nález „widget má 99 % limitu“): limit 120 KiB, zdôvodnenie v SPEC 8.1.
test('8.1 a 8.8 widget.js má najviac 124 000 B, texty bez pomlčiek, žiadna domáca adresa v widgete, ukážke ani skriptoch', () => {
  assert.ok(fs.statSync(widgetPath).size <= 124000, `veľkosť ${fs.statSync(widgetPath).size} B`);
  const strings = widgetSource.slice(widgetSource.indexOf('var STRINGS'), widgetSource.indexOf('var LOCALES'));
  assert.ok(strings.length > 5000);
  assert.doesNotMatch(strings, /[—–]/);
  const subory = [widgetPath];
  const ukazka = path.join(__dirname, '../../arling-sk/asistent/ukazka');
  for (const f of fs.readdirSync(ukazka)) if (/\.(html|js|css)$/.test(f)) subory.push(path.join(ukazka, f));
  const skripty = path.join(__dirname, '../scripts');
  for (const f of fs.readdirSync(skripty)) if (/\.mjs$/.test(f)) subory.push(path.join(skripty, f));
  for (const s of subory) {
    const t = fs.readFileSync(s, 'utf8');
    assert.doesNotMatch(t, /192\.168\.|\.lan\b|homelab|tailscale/i, s);
  }
});

test('A9 a S4: jazyk panela, meno na spúšťači v dostupnom názve, logo s alt podľa obchodu', () => {
  const w = spusti({ attrs: { 'data-meno': 'Predavač', 'data-obchod': 'Dobrá domácnosť', 'data-logo': 'img/logo.svg' }, window: { location: { href: 'https://shop.example/ukazka/' } } });
  assert.equal(w.root.getElementById('panel').getAttribute('lang'), 'sk');
  assert.match(w.root.innerHTML, /aria-label="Otvoriť chat s asistentom: Predavač"/);
  assert.match(w.root.innerHTML, /<span class="spustac-text">Predavač<\/span>/);
  assert.match(w.root.innerHTML, /<img class="h-logo" src="https:\/\/shop\.example\/ukazka\/img\/logo\.svg" alt="Dobrá domácnosť">/);
  assert.match(w.root.innerHTML, /<span id="panel-title" class="sr-only">Dobrá domácnosť: Odpovedá AI<\/span>/);
  const bez = spusti({});
  assert.match(bez.root.innerHTML, /<span class="spustac-text">Odpovedá AI<\/span>/);
  assert.match(bez.root.innerHTML, /aria-label="Otvoriť chat s asistentom"/);
});

test('S3 data-odsadenie 0 až 200 posunie spúšťač aj upútavku, mimo rozsahu sa ignoruje; data-pismo system', () => {
  assert.equal(spusti({ attrs: { 'data-odsadenie': '64' } }).host._styl['--a-odsadenie'], '64px');
  assert.equal(spusti({ attrs: { 'data-odsadenie': '400' } }).host._styl['--a-odsadenie'], undefined);
  assert.equal(spusti({ attrs: { 'data-odsadenie': '-5' } }).host._styl['--a-odsadenie'], undefined);
  const serif = { getComputedStyle: () => ({ fontFamily: 'Times New Roman, serif' }) };
  const obchod = { getComputedStyle: () => ({ fontFamily: '"Shop Sans", Arial, sans-serif' }) };
  assert.match(spusti({ window: serif }).host._styl['--a-pismo'], /^ui-sans-serif/);
  assert.equal(spusti({ window: obchod }).host._styl['--a-pismo'], '"Shop Sans", Arial, sans-serif');
  assert.match(spusti({ window: obchod, attrs: { 'data-pismo': 'system' } }).host._styl['--a-pismo'], /^ui-sans-serif/);
});
