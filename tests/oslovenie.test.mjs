// Ukážky k osloveniam (27. 9. 2026): karty produktov aj pri mierne zmenenej URL a žiadny automatický e-mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProducts, urlKey } from '../worker/src/chat.js';
import { mozeIst, ZDROJE } from '../worker/src/zivotny-cyklus.js';

const kandidati = [
  { id: 'a', title: 'Čiapočka BARRY', url: 'https://www.svetvlny.sk/ciapocka-barry', price: 3, currency: 'EUR', image: 'x.jpg' },
  { id: 'b', title: 'Colombia Supremo Sofía', url: 'https://www.praziarenjolka.sk/produkt/colombia-supremo-sofia/', price: 6.5, currency: 'EUR', image: 'y.jpg' },
];

test('urlKey ignoruje schému, www, veľkosť hostiteľa, lomku na konci, query a &amp;', () => {
  assert.equal(urlKey('https://WWW.Shop.sk/p/a/?x=1'), urlKey('http://shop.sk/p/a'));
  assert.equal(urlKey('https://shop.sk/p?a=1&amp;b=2'), urlKey('https://shop.sk/p'));
  assert.notEqual(urlKey('https://shop.sk/p/A'), urlKey('https://shop.sk/p/a'), 'cesta ostáva citlivá na veľkosť písmen');
});

test('karta aj pri URL bez www a s lomkou na konci', () => {
  const out = reconcileProducts([{ title: 'iné', url: 'https://svetvlny.sk/ciapocka-barry/' }], kandidati);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://www.svetvlny.sk/ciapocka-barry', 'URL a ostatné polia vždy z kandidáta');
});

test('karta podľa presného názvu, keď URL chýba; nič pre neznámy produkt', () => {
  const out = reconcileProducts([{ title: 'colombia supremo sofía', url: '' }, { title: 'Neexistuje', url: 'https://inde.sk/x' }], kandidati);
  assert.deepEqual(out.map((p) => p.title), ['Colombia Supremo Sofía']);
});

test('zdroj oslovenie existuje a nikdy nepustí automatický e-mail', () => {
  assert.ok(ZDROJE.includes('oslovenie'));
  const env = { ASISTENT_EMAILY: 'zapnute', RESEND_API_KEY: 'x', ALLOWED_ORIGINS: 'arling.sk' };
  const tenant = { id: 't', domain: 'shrimp.sk', contact_email: 'info@shrimp.sk', status: 'ready', zdroj: 'oslovenie' };
  for (const kod of ['E0', 'E1', 'E1W', 'E2', 'E3', 'E4']) {
    assert.deepEqual(mozeIst(env, tenant, kod, [], { rucne: true }), { ok: false, dovod: 'oslovenie' }, kod);
  }
});
