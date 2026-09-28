// widget-v22.test.mjs: opravy widgetu po overení 2 (28. 9. 2026 večer, ops/asistent/v2/SPEC.md, časť 14).
// Krátke mená variantov v porovnaní, jedna šípka späť v sprievodcovi so zhrnutím výberu, upútavka
// sleduje stránku, tichá náhrada chýbajúcej fotky, spúšťač bez iskry, posun na začiatok otázky.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spusti, makeElement, makeStorage, hodiny, tik, fetchZoznam, radky, cssZRoot, dieta, widgetSource } from './helpers/widget-v2.mjs';

const otvor = (root) => root.getElementById('toggle')._listeners.click[0]();
const klik = (el) => el._listeners.click[0]();
const P = (id, cena, title, extra = {}) => ({ title, url: `https://shop.example/#p-${id}`, image: `https://shop.example/img/${id}.svg`, price: cena, currency: 'EUR', ...extra });
const STYRI = [
  P('KAV-003', 89.9, 'Kapsulový kávovar Orava Mini, červený'),
  P('KAV-006', 24.9, 'French press 1 l z borosilikátového skla'),
  P('KAV-007', 39.9, 'Kanvica na filtrovanú kávu s dlhým hrdlom 0,9 l'),
  P('KAV-004', 89.9, 'Kapsulový kávovar Orava Mini, biely'),
];

test('K8 porovnanie: varianta za čiarkou ostane, keď rozhovor ukázal dvojníka s rovnakým základom', async () => {
  const f = fetchZoznam([{ answer: 'Štyri.', products: STYRI }, { answer: 'ok', products: [] }]);
  const w = spusti({ fetch: f });
  w.windowStub.ArlingAsistent.ask('Aký kávovar do 100 eur?');
  await tik();
  const r = radky(w.root).find((x) => x.children[0].textContent === 'Štyri.');
  klik(dieta(r, 'pas-akcie').children[0]);
  await tik();
  assert.equal(f.poslane[1].body.messages.at(-1).content, 'Porovnajte mi Kapsulový kávovar Orava Mini, červený a French press.');
});

test('K8 dlaždica Porovnať po odpovedi: posledné dve karty, desatinná čiarka „0,9 l“ nie je varianta', async () => {
  const f = fetchZoznam([{ answer: 'Štyri.', products: STYRI }, { answer: 'ok', products: [] }]);
  const w = spusti({ attrs: { 'data-gift': '1' }, fetch: f });
  otvor(w.root);
  w.windowStub.ArlingAsistent.ask('Aký kávovar do 100 eur?');
  await tik();
  const grid = dieta(radky(w.root)[0], 'dlazdice');
  const porovnat = grid.children.find((d) => d.getAttribute('aria-label') === 'Porovnať produkty');
  assert.ok(porovnat, 'dlaždica Porovnať s plným názvom pre čítačku');
  klik(porovnat);
  await tik();
  assert.equal(f.poslane[1].body.messages.at(-1).content, 'Porovnajte mi Kanvica na filtrovanú kávu a Kapsulový kávovar Orava Mini, biely.');
});

test('K8 bez dvojníka sa varianta nepridáva (krátka otázka ostáva)', async () => {
  const f = fetchZoznam([{ answer: 'Dva.', products: [STYRI[1], STYRI[3]] }, { answer: 'ok', products: [] }]);
  const w = spusti({ fetch: f });
  w.windowStub.ArlingAsistent.ask('Čo na kávu?');
  await tik();
  klik(dieta(radky(w.root).find((x) => x.children[0].textContent === 'Dva.'), 'pas-akcie').children[0]);
  await tik();
  assert.equal(f.poslane[1].body.messages.at(-1).content, 'Porovnajte mi French press a Kapsulový kávovar Orava Mini.');
});

test('5.8 sprievodca: jedna šípka späť ide o krok späť, z prvého kroku na rozhovor; nad otázkou je doterajší výber', () => {
  const w = spusti({ attrs: { 'data-gift': '1' } });
  otvor(w.root);
  const $ = (id) => w.root.getElementById(id);
  klik($('gift-toggle'));
  assert.equal($('gift-kontext').hidden, true, 'v prvom kroku nie je čo zhrnúť');
  klik($('gift-recipient-chips').children[1]);
  assert.equal($('gift-step-budget').hidden, false);
  assert.equal($('gift-kontext').hidden, false);
  assert.equal($('gift-kontext').textContent, 'Pre: Mama');
  klik($('gift-budget-chips').children[1]);
  assert.equal($('gift-kontext').textContent, 'Pre: Mama · do 50 €');
  klik($('gift-close-btn'));
  assert.equal($('gift-step-budget').hidden, false, 'šípka vráti na rozpočet, nie na rozhovor');
  assert.equal($('gift-panel').hidden, false);
  klik($('gift-close-btn'));
  assert.equal($('gift-step-recipient').hidden, false);
  klik($('gift-close-btn'));
  assert.equal($('gift-panel').hidden, true, 'z prvého kroku späť na rozhovor');
  assert.equal($('messages').hidden, false);
  // Textové Späť v krokoch sú skryté (id ostávajú kvôli SPEC 8.9), tip je hneď pod otázkou.
  assert.match(widgetSource, /tlacidlo\('gift-budget-back', 'gift-btn-secondary', 'giftBack', true\)/);
  assert.match(widgetSource, /tlacidlo\('gift-interests-back', 'gift-btn-secondary', 'giftBack', true\)/);
  assert.match(w.root.innerHTML, /<p class="gift-question">Pre koho hľadáte darček\?<\/p><p class="d-tip">/);
  const css = cssZRoot(w.root);
  assert.match(css, /\.d-rozpocet\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:10px\}/, 'rozpočet 2 x 2');
});

test('5.8 dôvod darčeka je obyčajný text bez iskry', async () => {
  const f = fetchZoznam([{ picks: [P('DAR-001', 34.9, 'Med z podhoria', { why: 'Mama rada varí čaj.' })], candidates: [] }]);
  const w = spusti({ attrs: { 'data-gift': '1' }, fetch: f });
  otvor(w.root);
  klik(w.root.getElementById('gift-toggle'));
  klik(w.root.getElementById('gift-recipient-chips').children[1]);
  klik(w.root.getElementById('gift-budget-chips').children[1]);
  klik(w.root.getElementById('gift-submit-btn'));
  await tik();
  const karta = w.root.getElementById('gift-results-list').children[0].children[0];
  const why = dieta(karta.children[1], 'gift-why');
  assert.equal(why.textContent, 'Mama rada varí čaj.');
  assert.equal(why.children.length, 0);
});

test('K7 chýbajúca fotka: sivá tácka s obrysom tašky, nie písmeno vo farbe obchodu', async () => {
  const f = fetchZoznam([{ answer: 'Bez fotky.', products: [P('A', 10, 'Kanvica', { image: '' }), P('B', 12, 'Hrniec', { image: '' })] }]);
  const w = spusti({ fetch: f });
  w.windowStub.ArlingAsistent.ask('Máte?');
  await tik();
  const karta = dieta(radky(w.root).find((x) => x.children[0].textContent === 'Bez fotky.'), 'products').children[0].children[0];
  const ph = karta.children[0].children[0];
  assert.equal(ph.className, 'product-ph');
  assert.match(ph.children[0].innerHTML, /<path d="M5\.5 8\.5h13l-1 11h-11z"\/>/, 'ikona tašky');
  const css = cssZRoot(w.root);
  assert.match(css, /\.product-ph\{[^}]*color:var\(--a-jemny\);font-size:0\}/, 'písmeno sa neukazuje, farba nie je akcent');
  assert.match(css, /\.product-tacka:has\(\.product-ph\)\{background:var\(--a-povrch-2\);/);
  assert.match(css, /\.kat-ph\{display:grid;place-items:center;color:var\(--a-jemny\);font-size:0\}/);
});

test('S5 spúšťač nesie bublinu, nie iskru; dlaždice bez tónovaného štvorca pod ikonou', () => {
  const w = spusti({});
  const css = cssZRoot(w.root);
  assert.doesNotMatch(widgetSource, /M12 3\.5c\.5 3\.9/, 'iskra zo spúšťača aj z dôvodov darčeka zmizla');
  assert.match(w.root.innerHTML, /<button id="toggle"[^>]*><span class="iskra"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"[^>]*><path d="M4 5\.5h16v11H10l-4\.5 3\.5v-3\.5H4z"\/>/);
  assert.match(css, /\.dl-ikona\{flex:none;display:block;color:var\(--a-farba-ikona\)\}\.dl-ikona svg\{width:22px;height:22px\}/);
  assert.doesNotMatch(css.match(/\.dl-ikona\{[^}]*\}/)[0], /background/);
});

test('K10 po odpovedi je začiatok otázky 16 px pod hlavičkou (mobil 12), bez vplyvu vstupnej animácie', async () => {
  const merania = [];
  for (const mobil of [false, true]) {
    const vytvor = (tag) => {
      const e = makeElement(tag);
      e.offsetTop = 400;
      return e;
    };
    const w = spusti({ createElement: vytvor, fetch: fetchZoznam([{ answer: 'ok', products: [] }]), window: { matchMedia: (q) => ({ matches: mobil && /max-width/.test(q) }) } });
    const box = w.root.getElementById('messages');
    box.scrollHeight = 3000;
    box.clientHeight = 600;
    box.scrollTo = (o) => merania.push(o.top);
    w.windowStub.ArlingAsistent.ask('Otázka?');
    await tik();
  }
  assert.deepEqual(merania, [384, 388]);
  assert.match(widgetSource, /'\.messages\{position:relative;/, 'offsetTop sa meria voči #messages');
});

test('U4 viditeľná upútavka sleduje stránku pri hashchange (SPA prechod na produkt)', () => {
  let produkt = false;
  const d = {
    querySelectorAll: (sel) => (produkt && sel.includes('ld+json') ? [{ textContent: '{"@type":"Product","name":"Kávovar Orava Mini"}' }] : []),
    querySelector: () => null,
  };
  const pocuvaj = {};
  const win = { addEventListener: (u, f) => { (pocuvaj[u] = pocuvaj[u] || []).push(f); }, removeEventListener() {} };
  const h = hodiny();
  const w = spusti({ attrs: { 'data-upoutavka-oneskorenie': '0' }, storage: makeStorage(), timers: h, document: d, window: win });
  h.spusti();
  const $ = (id) => w.root.getElementById(id);
  assert.equal($('teaser').hidden, false);
  assert.equal($('teaser-otazka').textContent, 'Poradiť vám s výberom?');
  produkt = true;
  pocuvaj.hashchange.forEach((f) => f());
  assert.equal($('teaser-otazka').textContent, 'Máte otázku k tomuto produktu?');
  assert.equal($('teaser-riadok').textContent, 'Kávovar Orava Mini');
  assert.match($('teaser').className, /\bprodukt\b/, 'na stránke produktu užšia karta');
  assert.match(cssZRoot(w.root), /#teaser\.produkt\{width:256px\}/);
});

test('P3 mobil: panel nechá nad sebou len 12 px, silnejšie stmavenie; P6 v tmavom režime tiež bez nálepky', () => {
  const css = cssZRoot(spusti({}).root);
  assert.match(css, /height:var\(--a-vv,calc\(100dvh - 12px\)\)/);
  assert.match(css, /#scrim\{background:var\(--a-clona-mobil\)\}/);
  assert.match(widgetSource, /--a-clona-mobil:rgba\(16,16,20,\.5\)/);
  assert.match(widgetSource, /\(window\.innerHeight \|\| vv\.height\) - 12, vv\.height - 8/);
});
