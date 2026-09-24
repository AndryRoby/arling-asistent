// eshop-predvyplnenie.test.mjs
// Skript products/arling-sk/gdpr-dokumenty/gdpr-dokumenty-eshop/predvyplnenie.js,
// ktorý balík GDPR predvyplní službami z kontroly e-shopu. Beží vo vm s malým
// dvojníkom prehliadača (window, localStorage, history, document).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { skontrolujEshop } from '../worker/src/eshop-kontrola.js';

const KOREN = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CESTA_SKRIPTU = join(KOREN, 'arling-sk', 'gdpr-dokumenty', 'gdpr-dokumenty-eshop', 'predvyplnenie.js');
// Repozitár arling-asistent sa dá stiahnuť aj samostatne, bez webu arling-sk.
// Vtedy tieto testy preskočí, namiesto aby padli na chýbajúcom súbore.
const MAME_WEB = existsSync(CESTA_SKRIPTU);
const SKRIPT = MAME_WEB ? readFileSync(CESTA_SKRIPTU, 'utf8') : '';
const t = MAME_WEB ? test : test.skip;

function spusti(hash, { ulozene = null, bezUloziska = false } = {}) {
  const store = new Map();
  if (ulozene) store.set('gdpr:formular:sk', JSON.stringify(ulozene));
  const localStorage = {
    getItem(k) { if (bezUloziska) throw new Error('blokovane'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (bezUloziska) throw new Error('blokovane'); store.set(k, String(v)); },
  };
  const zmenyAdresy = [];
  const location = { hash, pathname: '/gdpr-dokumenty/gdpr-dokumenty-eshop/', search: '' };
  const window = { location, localStorage };
  const context = {
    window,
    history: { replaceState: (a, b, url) => zmenyAdresy.push(url) },
    document: { readyState: 'loading', addEventListener() {} },
    URL, URLSearchParams, JSON, setTimeout, Event: class {},
  };
  vm.createContext(context);
  vm.runInContext(SKRIPT, context);
  const s = store.get('gdpr:formular:sk');
  return { data: s ? JSON.parse(s) : null, zmenyAdresy, api: window.__arlingPredvyplnenie };
}

t('bez parametra z kontroly skript nič nemení', () => {
  const { data, zmenyAdresy } = spusti('');
  assert.equal(data, null);
  assert.equal(zmenyAdresy.length, 0);
  assert.equal(spusti('#nahlad').data, null);
});

t('parameter zaškrtne služby, cookies a činnosti a zmaže sa z adresy', () => {
  const { data, zmenyAdresy } = spusti('#z=kontrola&n=ga4,meta,neznamy&c=analyticke,marketingove,zle&a=eshop,analytika&i=Smartsupp%20(chat%20na%20webe)&w=https%3A%2F%2Fobchod.sk%2Fkategoria%3Fx%3D1');
  assert.deepEqual(data.nastroje, ['ga4', 'meta']);
  assert.deepEqual(data.cookies, { analyticke: true, marketingove: true });
  assert.deepEqual(data.cinnosti, { eshop: true, analytika: true });
  assert.equal(data.nastrojeIne, 'Smartsupp (chat na webe)');
  assert.equal(data.firma.web, 'https://obchod.sk/');
  assert.deepEqual(zmenyAdresy, ['/gdpr-dokumenty/gdpr-dokumenty-eshop/']);
});

t('nič, čo používateľ vyplnil, sa neprepíše', () => {
  const ulozene = { firma: { nazov: 'Moja s. r. o.', web: 'https://moj-web.sk/' }, nastroje: ['packeta'], cookies: { analyticke: false }, cinnosti: { kontakt: true }, nastrojeIne: 'vlastné CRM', prenosMimoEU: 'ano' };
  const { data } = spusti('#z=kontrola&n=ga4,packeta&c=analyticke&a=eshop&i=Hotjar&w=https%3A%2F%2Finy.sk', { ulozene });
  assert.equal(data.firma.nazov, 'Moja s. r. o.');
  assert.equal(data.firma.web, 'https://moj-web.sk/');
  assert.deepEqual(data.nastroje, ['packeta', 'ga4']);
  assert.equal(data.cinnosti.kontakt, true);
  assert.equal(data.cinnosti.eshop, true);
  assert.equal(data.nastrojeIne, 'vlastné CRM, Hotjar');
  assert.equal(data.prenosMimoEU, 'ano');
});

t('text v parametri sa očistí od HTML a nebezpečná adresa webu sa zahodí', () => {
  const { data } = spusti('#z=kontrola&i=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&w=javascript%3Aalert(1)');
  assert.ok(!/[<>"]/.test(data.nastrojeIne));
  assert.equal(data.firma.web, undefined);
});

t('bez localStorage skript nespadne', () => {
  assert.doesNotThrow(() => spusti('#z=kontrola&n=ga4', { bezUloziska: true }));
});

t('odkaz, ktorý skladá stránka kontroly, sa v balíku prečíta celý', async () => {
  // Rovnaké skladanie ako products/arling-sk/kontrola-eshopu/kontrola.js (odkazNaBalik).
  const siet = async (url) => {
    if (url === 'https://kocka-hracky.sk/') {
      return new Response(readFileSync(join(KOREN, 'arling-asistent', 'tests', 'fixtures', 'eshop', '02-pdf-rso-uvod.html'), 'utf8'), { headers: { 'content-type': 'text/html' } });
    }
    return new Response('', { status: 404 });
  };
  const v = await skontrolujEshop('kocka-hracky.sk', { fetchImpl: siet, dnsImpl: async () => ['93.184.216.34'] });
  const p = new URLSearchParams();
  p.set('z', 'kontrola');
  p.set('n', v.predvyplnenie.nastroje.join(','));
  p.set('c', v.predvyplnenie.cookies.join(','));
  p.set('a', v.predvyplnenie.cinnosti.join(','));
  for (const x of v.predvyplnenie.ine) p.append('i', x);
  p.set('w', v.predvyplnenie.web);
  const { data } = spusti(`#${p.toString()}`);
  assert.deepEqual(data.nastroje.sort(), ['ga4', 'meta']);
  assert.equal(data.firma.web, 'https://kocka-hracky.sk/');
  assert.equal(data.cookies.marketingove, true);
});
