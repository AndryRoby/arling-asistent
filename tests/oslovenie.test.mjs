// Ukážky k osloveniam (27. 9. 2026): karty produktov aj pri mierne zmenenej URL a žiadny automatický e-mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProducts, urlKey } from '../worker/src/chat.js';
import { mozeIst, ZDROJE } from '../worker/src/zivotny-cyklus.js';
import { createTenantFromRequest } from '../worker/src/onboarding.js';
import { getTenantById } from '../worker/src/tenants.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize } from './helpers/mock-cf.mjs';

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

// Oslovený obchod sa zaregistruje sám (27. 9. 2026).
const FEED = `<products><item><id>1</id><name>Čaj</name><price>4.5</price><url>https://obchod.sk/p/1</url><description>Popis.</description></item></products>`;
function envUkazky() {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ALLOWED_ORIGINS: 'arling.sk',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => FEED }),
  };
}
async function ukazka(env) {
  return createTenantFromRequest(env, { feedUrl: 'https://homelab.example/ukazky/x.json', domain: 'obchod.sk', email: 'info@obchod.sk', zdroj: 'oslovenie' });
}

test('ukážku prevezme registrácia s adresou aj feedom na doméne obchodu', async () => {
  const env = envUkazky();
  const u = await ukazka(env);
  const t = await createTenantFromRequest(env, { feedUrl: 'https://www.obchod.sk/export/heureka.xml', domain: 'obchod.sk', email: 'jana@obchod.sk', zdroj: 'formular' });
  assert.equal(t.id, u.id);
  const r = await getTenantById(env.DB, u.id);
  assert.equal(r.feed_url, 'https://www.obchod.sk/export/heureka.xml');
  assert.equal(r.contact_email, 'jana@obchod.sk');
  assert.equal(r.zdroj, 'formular');
});

test('ukážku neprevezme adresa mimo domény obchodu ani cudzí feed', async () => {
  const env = envUkazky();
  const u = await ukazka(env);
  await createTenantFromRequest(env, { feedUrl: 'https://obchod.sk/feed.xml', domain: 'obchod.sk', email: 'majitel@gmail.com', zdroj: 'formular' });
  await createTenantFromRequest(env, { feedUrl: 'https://utocnik.example/feed.xml', domain: 'obchod.sk', email: 'x@obchod.sk', zdroj: 'formular' });
  const r = await getTenantById(env.DB, u.id);
  assert.equal(r.feed_url, 'https://homelab.example/ukazky/x.json');
  assert.equal(r.contact_email, 'info@obchod.sk');
  assert.equal(r.zdroj, 'oslovenie');
});

test('náš opakovaný beh so zdrojom oslovenie ukážku nemení', async () => {
  const env = envUkazky();
  const u = await ukazka(env);
  await createTenantFromRequest(env, { feedUrl: 'https://obchod.sk/feed.xml', domain: 'obchod.sk', email: 'ina@obchod.sk', zdroj: 'oslovenie' });
  const r = await getTenantById(env.DB, u.id);
  assert.equal(r.zdroj, 'oslovenie');
  assert.equal(r.contact_email, 'info@obchod.sk');
});
