// widget-v21.test.mjs: opravy widgetu v2 po overení 1 (28. 9. 2026 večer, ops/asistent/v2/SPEC.md,
// časť 13). Pasca fokusu vo Firefoxe, „Skúsiť znova“ pri porovnaní, krátke mená v porovnaní,
// upútavka na mobile na stránke produktu, logo v tmavom režime, úvod s najviac 3 otázkami,
// hover len pri myši, zhrnutie darčeka, ikona chyby, jedno pole s odoslaním vo vnútri.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spusti, makeStorage, makeElement, hodiny, tik, fetchZoznam, radky, cssZRoot, dieta, widgetSource } from './helpers/widget-v2.mjs';

const otvor = (root) => root.getElementById('toggle')._listeners.click[0]();
const uvod = (root) => radky(root)[0];
const klik = (el) => el._listeners.click[0]();
const P = (id, cena, title) => ({ title: title || `Kávovar ${id}, 1,2 l`, url: `https://shop.example/#p-${id}`, image: `https://shop.example/img/${id}.svg`, price: cena, currency: 'EUR' });

test('A3 Firefox: fokus na posuvnom kontajneri (mimo zoznamu) pokračuje podľa polohy v DOM, nie od začiatku', () => {
  const w = spusti({});
  const panel = w.root.getElementById('panel');
  const [a, b, c, d] = ['reset', 'close', 'dlazdica', 'input'].map((n) => ({ ...makeElement('button'), n }));
  [a, b, c, d].forEach((e) => { e.focus = () => { w.root.activeElement = e; }; });
  panel.querySelectorAll = () => [a, b, c, d];
  // #messages leží medzi Zavrieť (b) a prvou dlaždicou (c).
  const messages = { compareDocumentPosition: (el) => (el === a || el === b ? 2 : 4) };
  otvor(w.root);
  const e = (shiftKey) => ({ key: 'Tab', shiftKey, preventDefault() {}, stopPropagation() {} });
  w.root.activeElement = messages;
  w.docListeners.keydown[0](e(false));
  assert.equal(w.root.activeElement, c, 'Tab z kontajnera ide na prvú dlaždicu, nie na Obnoviť');
  w.root.activeElement = messages;
  w.docListeners.keydown[0](e(true));
  assert.equal(w.root.activeElement, b, 'Shift+Tab ide na Zavrieť');
  assert.match(widgetSource, /<div id="messages" class="messages" aria-live="off" tabindex="-1">/, 'kontajner nie je zastávka Tabu');
  assert.match(widgetSource, /<div id="gift-body" class="gift-body" tabindex="-1">/);
});

test('K9 „Skúsiť znova“ po zlyhanom porovnaní posiela znova s príznakom porovnania', async () => {
  const f = fetchZoznam([
    { answer: 'Štyri.', products: [P('A', 1), P('B', 2), P('C', 3), P('D', 4)] },
    { status: 500, error: 'internal_error' },
    { answer: 'Porovnanie štyroch.', products: [P('A', 1), P('B', 2), P('C', 3), P('D', 4)] },
  ]);
  const w = spusti({ fetch: f });
  w.windowStub.ArlingAsistent.ask('Aký kávovar?');
  await tik();
  const styri = radky(w.root).find((r) => r.children[0].textContent === 'Štyri.');
  klik(dieta(styri, 'pas-akcie').children[0]);
  await tik();
  const chyba = radky(w.root).find((r) => /msg-error/.test(r.className));
  assert.ok(chyba, 'chyba s opakovaním');
  klik(dieta(chyba, 'suggestions').children[0]);
  await tik();
  assert.equal(f.poslane.length, 3);
  const r = radky(w.root).find((x) => x.children[0].textContent === 'Porovnanie štyroch.');
  assert.ok(dieta(r, 'porovnanie'), 'so 4 produktmi porovnanie len vďaka príznaku');
  assert.equal(dieta(r, 'products').children.length, 2, 'zvyšné dva ako pás');
});

test('K8 porovnanie posiela krátke mená: po prvú čiarku, najviac asi 30 znakov na hranici slova', async () => {
  const f = fetchZoznam([
    { answer: 'Dva.', products: [P('A', 24.9, 'French press 1 l z borosilikátového skla'), P('B', 89.9, 'Kapsulový kávovar Orava Mini, červený')] },
    { answer: 'ok', products: [] },
  ]);
  const w = spusti({ fetch: f });
  w.windowStub.ArlingAsistent.ask('Čo máte na kávu?');
  await tik();
  const r = radky(w.root).find((x) => x.children[0].textContent === 'Dva.');
  klik(dieta(r, 'pas-akcie').children[0]);
  await tik();
  assert.equal(f.poslane[1].body.messages.at(-1).content, 'Porovnajte mi French press a Kapsulový kávovar Orava Mini.');
});

test('A3 ťuknutá otázka v úvode zmizne, fokus ide na zoznam správ v dialógu, nie na body stránky', async () => {
  const f = fetchZoznam([{ answer: 'ok', products: [] }]);
  const w = spusti({ attrs: { 'data-questions': JSON.stringify(['Prvá?', 'Druhá?']) }, fetch: f });
  otvor(w.root);
  const b = dieta(uvod(w.root), 'suggestions').children[0];
  w.root.activeElement = b;
  const pred = w.root.getElementById('messages')._focusCalls || 0;
  klik(b);
  await tik();
  assert.equal(b.hidden, true);
  assert.equal(w.root.getElementById('messages')._focusCalls, pred + 1);
});

test('U2 na telefóne sa upútavka na stránke produktu neukáže (zakryla by cenu), na inej stránke áno', () => {
  const ld = { querySelectorAll: (sel) => (sel.includes('ld+json') ? [{ textContent: '{"@type":"Product","name":"Kávovar Orava Mini"}' }] : []), querySelector: () => null };
  const mobil = { matchMedia: (q) => ({ matches: /max-width/.test(q) }) };
  const s = makeStorage();
  const h = hodiny();
  const a = spusti({ attrs: { 'data-upoutavka-oneskorenie': '0' }, storage: s, timers: h, document: ld, window: mobil });
  h.spusti();
  assert.notEqual(a.root.getElementById('teaser').hidden, false);
  assert.equal(s._store.get('arling_asistent_upoutavka'), undefined, 'nič sa nezapíše, relácia ju ešte môže ukázať inde');
  const h2 = hodiny();
  const b = spusti({ attrs: { 'data-upoutavka-oneskorenie': '0' }, storage: makeStorage(), timers: h2, window: mobil });
  h2.spusti();
  assert.equal(b.root.getElementById('teaser').hidden, false);
});

test('P6 tmavý režim: logo bez bielej nálepky, namiesto neho meno obchodu, alebo svetlé logo z data-logo-tmave', () => {
  const a = spusti({ attrs: { 'data-obchod': 'Dobrá domácnosť', 'data-logo': 'https://shop.example/logo.svg' } });
  assert.match(a.root.innerHTML, /<img class="h-logo" src="https:\/\/shop\.example\/logo\.svg" alt="Dobrá domácnosť"><span class="h-meno h-meno-tmave">Dobrá domácnosť<\/span>/);
  const b = spusti({ attrs: { 'data-obchod': 'Dobrá domácnosť', 'data-logo': 'https://shop.example/logo.svg', 'data-logo-tmave': 'https://shop.example/logo-biele.svg' } });
  assert.match(b.root.innerHTML, /<img class="h-logo-tmave" src="https:\/\/shop\.example\/logo-biele\.svg" alt="Dobrá domácnosť">/);
  const css = cssZRoot(a.root);
  assert.match(css, /:host\(\.rezim-tmavy\) \.h-logo\{display:none\}/);
  assert.doesNotMatch(css, /\.h-logo\{[^}]*background/, 'žiadna biela podložka loga');
  // v2.2 (overenie 2): jeden riadok 64 px, logo 28 px a štítok vedľa neho (72 px s logom 7 px od hrany bolo stiesnené).
  assert.match(css, /\.hlavicka\{flex:none;min-height:64px;display:flex;align-items:center;/, 'hlavička nesie značku v jednom riadku');
  assert.match(css, /\.h-obchod\{flex:1;min-width:0;display:flex;align-items:center;gap:10px\}/);
  assert.match(css, /\.h-logo,\.h-logo-tmave\{display:block;flex:0 1 auto;min-width:0;height:28px;width:auto;max-width:156px;/);
  assert.match(css, /@container \(max-width:339px\)\{\.h-obchod\{flex-direction:column;/, 'len v úzkej hlavičke dva riadky');
});

test('4.5 úvod má najviac 3 otázky, pod odpoveďou najviac 2 čipy; štítky vetou, nie verzálkami', async () => {
  const q = ['Prvá?', 'Druhá?', 'Tretia?', 'Štvrtá?', 'Piata?', 'Šiesta?'];
  const f = fetchZoznam([{ answer: 'Odpoveď.', products: [] }]);
  const w = spusti({ attrs: { 'data-questions': JSON.stringify(q), 'data-kategorie': JSON.stringify([{ nazov: 'A' }, { nazov: 'B' }, { nazov: 'C' }]) }, fetch: f });
  otvor(w.root);
  const u = uvod(w.root);
  assert.equal(dieta(u, 'suggestions').children.length, 3);
  assert.equal(u.children.find((c) => /uvod-nadpis/.test(c.className)).textContent, 'Čo hľadáte?');
  klik(dieta(u, 'suggestions').children[0]);
  await tik();
  const odp = radky(w.root).find((r) => r.children[0].textContent === 'Odpoveď.');
  assert.deepEqual(dieta(odp, 'suggestions').children.map((b) => b.textContent), ['Druhá?', 'Tretia?']);
  const css = cssZRoot(w.root);
  assert.doesNotMatch(css.match(/\.uvod-stitok,\.pas-stitok,\.por-stitok\{[^}]*\}/)[0], /uppercase/);
});

test('hover len pri skutočnom ukazovateli: mimo @media (hover:hover) and (pointer:fine) nie je žiadne :hover pravidlo', () => {
  const css = cssZRoot(spusti({}).root);
  const bloky = ['@media (hover:hover) and (pointer:fine){', '@media (prefers-reduced-motion: reduce){'];
  let zvysok = css;
  for (const zac of bloky) {
    const i = zvysok.indexOf(zac);
    assert.ok(i >= 0, zac);
    let hlbka = 0;
    let j = i + zac.length - 1;
    for (; j < zvysok.length; j++) {
      if (zvysok[j] === '{') hlbka += 1;
      else if (zvysok[j] === '}' && --hlbka === 0) break;
    }
    zvysok = zvysok.slice(0, i) + zvysok.slice(j + 1);
  }
  assert.doesNotMatch(zvysok.replace(/\(hover:hover\)/g, ''), /:hover/);
});

test('5.8 výsledky darčeka majú zhrnutie výberu a Zmeniť vráti na prvý krok', async () => {
  const f = fetchZoznam([{ picks: [], candidates: [] }]);
  const w = spusti({ attrs: { 'data-gift': '1' }, fetch: f });
  otvor(w.root);
  klik(w.root.getElementById('gift-toggle'));
  klik(w.root.getElementById('gift-recipient-chips').children[1]);
  klik(w.root.getElementById('gift-budget-chips').children[1]);
  klik(w.root.getElementById('gift-submit-btn'));
  await tik();
  assert.equal(w.root.getElementById('gift-vyber').textContent, 'Mama · do 50 €');
  assert.equal(w.root.getElementById('gift-zhrnutie').hidden, false);
  klik(w.root.getElementById('gift-zmenit'));
  assert.equal(w.root.getElementById('gift-step-recipient').hidden, false);
  assert.equal(w.root.getElementById('gift-step-results').hidden, true);
  assert.match(widgetSource, /<p class="d-tip">/, 'pod voľbami veta, čo sa stane ďalej');
});

test('K4 chyba má ikonu upozornenia z prílohy C, nie znak výkričníka v CSS', () => {
  assert.match(widgetSource, /upozornenie: '<circle cx="12" cy="12" r="8\.5"\/><path d="M12 7\.8v5"\/><path d="M12 16h\.01"\/>'/);
  assert.match(widgetSource, /ik\.innerHTML = ikona\('upozornenie'\)/);
  assert.doesNotMatch(widgetSource, /content:"!"/);
});

// v2.2 (overenie 2): fokus neutrálny (farba obchodu patrí Odoslať), prázdne Odoslať sivé, po prvom znaku farba obchodu.
test('P10 jedno pole s odoslaním vo vnútri: neutrálny fokus na obale, prázdne Odoslať sivé', () => {
  const w = spusti({});
  assert.match(w.root.innerHTML, /<form id="form" class="composer"><div class="pole">.*<textarea id="input".*<button id="send-btn" type="submit" data-prazdne="" aria-label="Odoslať"><span><svg/);
  const css = cssZRoot(w.root);
  assert.match(css, /\.pole:focus-within\{/);
  assert.match(css, /\.pole:focus-within\{border-color:var\(--a-jemny\);box-shadow:0 0 0 3px var\(--a-prstenec\)\}/);
  assert.match(css, /#send-btn\[data-prazdne\] span\{background:var\(--a-povrch-2\);color:var\(--a-jemny\);animation:none\}/);
  assert.doesNotMatch(css, /#input:focus/, 'pole po otvorení nesvieti ako chyba');
});

test('K6 karta: fotka po hrany karty (tácka bez paspartu), Pozrieť je textový riadok so šípkou', async () => {
  const f = fetchZoznam([{ answer: 'Dva.', products: [P('A', 1), P('B', 2)] }]);
  const w = spusti({ fetch: f });
  w.windowStub.ArlingAsistent.ask('Kávovar?');
  await tik();
  const css = cssZRoot(w.root);
  assert.match(css, /\.product-tacka\{flex:none;display:block;aspect-ratio:1;overflow:hidden;background:var\(--a-tacka\)\}/);
  assert.doesNotMatch(css.match(/\.product-view\{[^}]*\}/)[0], /border:1px/);
  const r = radky(w.root).find((x) => x.children[0].textContent === 'Dva.');
  assert.equal(dieta(r, 'products').getAttribute('tabindex'), '-1');
});
