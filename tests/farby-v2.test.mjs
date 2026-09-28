// farby-v2.test.mjs: farba obchodu jedným parametrom (SPEC T3, T4, A6).
// Widget sa naozaj spustí (falošný DOM) a test číta, čo zapísal cez host.style.setProperty.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spusti, kontrastWcag } from './helpers/widget-v2.mjs';

function odtiene(attrs, extra = {}) {
  const { host } = spusti({ attrs, ...extra });
  const s = host._styl;
  return {
    tmavy: / rezim-tmavy|^rezim-tmavy/.test(host.className),
    plna: s['--a-farba-plna'],
    na: s['--a-na-farbe'],
    text: s['--a-farba-text'],
    ikona: s['--a-farba-ikona'],
    jemna: s['--a-farba-jemna'],
  };
}

// Testovacie vektory zo špecifikácie (tabuľka T3), overené pri jej písaní.
const VEKTORY = [
  ['#E0582A', 'svetly', '#CA4F26', '#FFFFFF', '#B84822', '#E0582A', '#FCEEEA'],
  ['#E0582A', 'tmavy', '#CA4F26', '#FFFFFF', '#E5734C', '#E0582A', '#3E2621'],
  ['#1F6FEB', 'svetly', '#1F6FEB', '#FFFFFF', '#1D68DD', '#1F6FEB', '#E9F1FD'],
  ['#1F6FEB', 'tmavy', '#1F6FEB', '#FFFFFF', '#5592F0', '#1F6FEB', '#1C2A44'],
  ['#B23A1D', 'svetly', '#B23A1D', '#FFFFFF', '#B23A1D', '#B23A1D', '#F7EBE8'],
  ['#B23A1D', 'tmavy', '#B23A1D', '#FFFFFF', '#CB7965', '#BA4E34', '#36211F'],
  ['#FFD000', 'svetly', '#FFD000', '#111113', '#856C00', '#A88900', '#FFFAE6'],
  ['#8B1E2B', 'tmavy', '#A04751', '#FFFFFF', '#B97880', '#A7545E', '#2F1C21'],
  ['#18181B', 'tmavy', '#626264', '#FFFFFF', '#878788', '#676769', '#1A1A1E'],
];

for (const [z, rezim, plna, na, text, ikona, jemna] of VEKTORY) {
  test(`T3 vektor ${z} ${rezim}: plná ${plna}, text ${text}, ikona ${ikona}, jemná ${jemna}`, () => {
    const o = odtiene({ 'data-farba': z, 'data-rezim': rezim });
    assert.deepEqual([o.plna, o.na, o.text, o.ikona, o.jemna], [plna, na, text, ikona, jemna]);
    assert.equal(o.tmavy, rezim === 'tmavy');
  });
}

test('T3 krátky zápis #RGB a malé písmená dávajú to isté ako #RRGGBB', () => {
  assert.deepEqual(odtiene({ 'data-farba': '#fd0', 'data-rezim': 'svetly' }), odtiene({ 'data-farba': '#FFDD00', 'data-rezim': 'svetly' }));
  assert.deepEqual(odtiene({ 'data-farba': '#e0582a' }), odtiene({ 'data-farba': '#E0582A' }));
});

test('T3 chybný vstup (red, #12, 1F6FEB bez mriežky) = záloha #B23A1D', () => {
  const zaloha = odtiene({ 'data-farba': '#B23A1D' });
  for (const zly of ['red', '#12', '1F6FEB', '#GGGGGG', '']) {
    assert.deepEqual(odtiene({ 'data-farba': zly }), zaloha, `data-farba="${zly}"`);
  }
});

// Pevné semeno (mulberry32): 200 farieb, oba režimy, všetky dvojice AA.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('T3 200 náhodných farieb (semeno 28092026) v oboch režimoch: text na plnej >= 4,5, farba-text >= 4,5 voči pozadiu, povrchu aj jemnej, ikona >= 3 voči povrchu', () => {
  const rnd = mulberry32(28092026);
  const POZ = { svetly: { pozadie: '#F7F7F5', povrch: '#FFFFFF' }, tmavy: { pozadie: '#121214', povrch: '#1B1B1F' } };
  let pocet = 0;
  for (let i = 0; i < 200; i++) {
    const z = '#' + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('').toUpperCase();
    for (const rezim of ['svetly', 'tmavy']) {
      const o = odtiene({ 'data-farba': z, 'data-rezim': rezim });
      const P = POZ[rezim];
      const k = (a, b) => kontrastWcag(a, b);
      assert.ok(k(o.plna, o.na) >= 4.5, `${z} ${rezim}: text na plnej ${k(o.plna, o.na).toFixed(2)}`);
      for (const pod of [P.pozadie, P.povrch, o.jemna]) assert.ok(k(o.text, pod) >= 4.5, `${z} ${rezim}: farba-text na ${pod}`);
      assert.ok(k(o.ikona, P.povrch) >= 3, `${z} ${rezim}: ikona`);
      if (rezim === 'tmavy') assert.ok(k(o.plna, P.pozadie) >= 3, `${z}: plná na tmavom pozadí`);
      pocet += 1;
    }
  }
  assert.equal(pocet, 400);
});

function sMetou(metas) {
  return {
    document: {
      querySelectorAll: (sel) => (sel.includes('theme-color') ? metas.map((m) => ({ getAttribute: (a) => (a === 'content' ? m.content : a === 'media' ? m.media || null : null) })) : []),
    },
  };
}

test('T3 data-farba="auto" (aj bez atribútu): sýta theme-color sa prevezme, šedá a chybná nie', () => {
  const modra = odtiene({ 'data-farba': '#1F6FEB', 'data-rezim': 'svetly' });
  const zaloha = odtiene({ 'data-farba': '#B23A1D', 'data-rezim': 'svetly' });
  assert.deepEqual(odtiene({ 'data-farba': 'auto' }, sMetou([{ content: '#1f6feb' }])), modra);
  assert.deepEqual(odtiene({}, sMetou([{ content: '#1F6FEB' }])), modra, 'bez data-farba platí auto');
  assert.deepEqual(odtiene({}, sMetou([{ content: '#808080' }])), zaloha, 'šedá (sýtosť 0)');
  assert.deepEqual(odtiene({}, sMetou([{ content: '#0a0908' }])), zaloha, 'skoro čierna (svetlosť pod 0,15)');
  assert.deepEqual(odtiene({}, sMetou([{ content: 'rebeccapurple' }])), zaloha, 'nie hex');
  assert.deepEqual(odtiene({}, sMetou([])), zaloha, 'stránka bez theme-color');
  assert.deepEqual(odtiene({}, sMetou([{ content: '#808080', media: '(prefers-color-scheme: dark)' }, { content: '#1F6FEB' }])), modra, 'prvá bez media');
});

test('T4 režim: bez atribútov svetlý, data-color="dark" tmavý, data-rezim má prednosť, auto podľa systému', () => {
  assert.equal(odtiene({}).tmavy, false);
  assert.equal(odtiene({ 'data-color': 'dark' }).tmavy, true);
  assert.equal(odtiene({ 'data-color': 'light' }).tmavy, false);
  assert.equal(odtiene({ 'data-rezim': 'svetly', 'data-color': 'dark' }).tmavy, false, 'data-rezim má prednosť');
  assert.equal(odtiene({ 'data-rezim': 'tmavy', 'data-color': 'light' }).tmavy, true);
  const tmavySystem = { window: { matchMedia: (q) => ({ matches: q.includes('dark'), addEventListener() {} }) } };
  assert.equal(odtiene({ 'data-rezim': 'auto' }, tmavySystem).tmavy, true);
  assert.equal(odtiene({ 'data-color': 'auto' }, tmavySystem).tmavy, true, 'staré auto');
  assert.equal(odtiene({ 'data-rezim': 'auto' }).tmavy, false, 'bez matchMedia svetlý');
  assert.equal(odtiene({ 'data-rezim': 'svetly' }, tmavySystem).tmavy, false, 'svetlý aj pri tmavom systéme');
});

test('A6 neutrálne tokeny T1 a T2 v zdroji majú kontrast zo špecifikácie', async () => {
  const { widgetSource } = await import('./helpers/widget-v2.mjs');
  for (const [meno, poz, pov] of [['SVETLY', '#F7F7F5', '#FFFFFF'], ['TMAVY', '#121214', '#1B1B1F']]) {
    const riadok = widgetSource.match(new RegExp(`var ${meno} = '([^']+)'`))[1];
    const v = (k) => riadok.match(new RegExp(`--a-${k}:(#[0-9A-F]{6})`))[1];
    assert.equal(v('pozadie'), poz);
    assert.equal(v('povrch'), pov);
    for (const t of ['text', 'text-2', 'jemny']) {
      for (const pod of ['pozadie', 'povrch', 'povrch-2']) assert.ok(kontrastWcag(v(t), v(pod)) >= 4.5, `${meno} ${t} na ${pod}`);
    }
    for (const t of ['ok', 'caka', 'nie']) assert.ok(kontrastWcag(v(t), v('povrch')) >= 4.5, `${meno} ${t}`);
    assert.ok(kontrastWcag(v('ciara-pole'), v('povrch')) >= 3, `${meno} rám poľa`);
    assert.ok(kontrastWcag(v('ciara-pole'), v('pozadie')) >= 3, `${meno} rám poľa na pozadí`);
    assert.ok(kontrastWcag(v('bodka'), v('povrch-2')) >= 3, `${meno} bodka`);
  }
});
