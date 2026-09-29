import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../worker/src/index.js';
import { createTenantFromRequest, tenantStatusResponse } from '../worker/src/onboarding.js';
import { getTenantById } from '../worker/src/tenants.js';
import { prevezmiOslovenie, zmazTenanta, dennaUdrzba, ZC_SQL } from '../worker/src/zivotny-cyklus.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const DOM = 'obchod.sk';
const FEED = 'https://obchod.sk/wp-json/wc/store/v1/products';
const XML = '<products><item><id>1</id><name>Kanvica</name><price>10</price><url>https://obchod.sk/p/1</url></item></products>';
let ip = 0;
function request(path, body, token = '', method = 'POST', admin = false) {
  return new Request('https://arling-asistent.arling.workers.dev' + path, {
    method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.18.0.' + (++ip),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(admin ? { 'X-Admin-Token': 'test-admin' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}
async function prostredie(email = 'info@obchod.sk') {
  const env = { DB: createMockD1(), ASISTENT_CACHE: createMockKV(), AI: createMockAI(), VECTORIZE: createMockVectorize(),
    UCET_TAJOMSTVO: btoa('test-secret-for-outreach-takeover'), ASISTENT_ADMIN_ZAPIS: 'test-admin',
    fetchImpl: async (url) => new Response(String(url).includes('/wp-json/')
      ? JSON.stringify([{ id: 1, name: 'Kanvica', permalink: 'https://obchod.sk/p/1', description: 'Kanvica',
          prices: { price: '1000', currency_code: 'EUR', currency_minor_unit: 2 }, images: [] }]) : XML),
    ALLOWED_ORIGINS: 'arling.sk' };
  const demo = await createTenantFromRequest(env, { domain: DOM, feedUrl: 'https://snapshot.example/catalog.xml',
    email, zdroj: 'oslovenie', povolitOslovenie: true, lang: 'sk' });
  return { env, id: demo.id };
}
async function kodom(env, email) {
  // Len doručenie je nahradené fixtúrou; kód kontroluje skutočná HTTP cesta.
  await env.ASISTENT_CACHE.put('ucet:kod:' + email, JSON.stringify({ kod: '654321', pokusy: 0, vytvorene: new Date().toISOString() }));
  const r = await worker.fetch(request('/v1/ucet/over', { email, kod: '654321' }), env);
  assert.equal(r.status, 200);
  return (await r.json()).token;
}
const vstup = (email, extra = {}) => ({ domain: DOM, feed_url: FEED, email, lang: 'sk', ...extra });
async function odosli(env, body, token = '') {
  const ulohy = [];
  const r = await worker.fetch(request('/v1/tenants', body, token), env, { waitUntil: p => ulohy.push(p) });
  await Promise.all(ulohy);
  return r;
}
async function overPrevzaty(env, id, email) {
  const row = await getTenantById(env.DB, id);
  assert.equal(row.zdroj, 'prevzate');
  assert.equal(row.contact_email, email);
  assert.equal(row.feed_url, FEED);
  assert.equal(row.status, 'ready');
  assert.equal(env.DB._tenants.size, 1);
  assert.equal((await tenantStatusResponse(env, id)).outreach_demo, false);
  assert.ok(env.VECTORIZE._store.size > 0);
}

test('plugin pripojí kanonický feed; až kód majiteľa prevezme rovnaké ID', async () => {
  const { env, id } = await prostredie();
  const r = await odosli(env, vstup('admin@obchod.sk', { zdroj: 'wordpress' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, id);
  assert.equal((await getTenantById(env.DB, id)).contact_email, 'info@obchod.sk');
  assert.equal((await tenantStatusResponse(env, id)).outreach_demo, true);
  const token = await kodom(env, 'admin@obchod.sk');
  const over = await worker.fetch(request('/v1/tenants/' + id + '/overenie', null, token), env);
  assert.equal(over.status, 200);
  await overPrevzaty(env, id, 'admin@obchod.sk');
  const znova = await odosli(env, vstup('admin@obchod.sk', { zdroj: 'wordpress' }));
  assert.equal((await znova.json()).id, id);
});

test('formulár s kódom prijme adresu na doméne aj uložený verejný kontakt mimo domény', async () => {
  for (const [povodny, majitel] of [['info@obchod.sk', 'majitel@obchod.sk'], ['kontakt@firma.example', 'kontakt@firma.example']]) {
    const { env, id } = await prostredie(povodny);
    const token = await kodom(env, majitel);
    const r = await odosli(env, vstup(majitel, { prevziat: true }), token);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.fromEntries(Object.entries(await r.json()).filter(([k]) => ['id','existing','prevzate','overeny'].includes(k))),
      { id, existing: true, overeny: true, prevzate: true });
    await overPrevzaty(env, id, majitel);
    const retry = await odosli(env, vstup(majitel, { prevziat: true }), token);
    assert.equal((await retry.json()).id, id);
    assert.equal(env.DB._udalosti.filter(u => u.kluc === 'prevzaty').length, 1);
  }
});

test('prevzatie bez overenia, sfalšovaný Bearer a cudzí overený e-mail sa zamietnu bez zmien', async () => {
  for (const email of ['info@obchod.sk', 'iny@obchod.sk', 'utocnik@example.com']) {
    const { env, id } = await prostredie();
    const pred = await getTenantById(env.DB, id);
    for (const token of ['', 'falsovany.token']) {
      const r = await odosli(env, vstup(email, { prevziat: true }), token);
      assert.equal(r.status, 409);
      assert.equal((await r.json()).id, undefined);
      assert.deepEqual(await getTenantById(env.DB, id), pred);
    }
  }
  const { env, id } = await prostredie();
  const token = await kodom(env, 'utocnik@example.com');
  const r = await odosli(env, vstup('utocnik@example.com', { prevziat: true }), token);
  assert.equal(r.status, 409);
  assert.equal((await getTenantById(env.DB, id)).zdroj, 'oslovenie');
});

test('iný e-mail bez kódu po pripojení snímky je zamietnutý; filtre neprejdú ani na snímke', async () => {
  const { env, id } = await prostredie();
  const filtr = await odosli(env, vstup('iny@obchod.sk', { feed_url: FEED + '?include=1' }));
  assert.equal(filtr.status, 409);
  assert.equal((await odosli(env, vstup('iny@obchod.sk'))).status, 200);
  assert.equal((await odosli(env, vstup('iny@obchod.sk'))).status, 409);
  assert.equal((await getTenantById(env.DB, id)).contact_email, 'info@obchod.sk');
});

test('kód inej adresy, cudzí feed a neexistujúca ukážka nevytvoria ani neprevezmú účet', async () => {
  const { env, id } = await prostredie();
  const token = await kodom(env, 'majitel@obchod.sk');
  assert.equal((await odosli(env, vstup('iny@obchod.sk', { prevziat: true }), token)).status, 409);
  assert.equal((await odosli(env, vstup('majitel@obchod.sk', { feed_url: 'https://cudzi.example/feed', prevziat: true }), token)).status, 400);
  assert.equal((await odosli(env, { domain: 'novy.sk', feed_url: 'https://novy.sk/feed.xml', email: 'majitel@obchod.sk', prevziat: true }, token)).status, 409);
  assert.equal(env.DB._tenants.size, 1);
  assert.equal((await getTenantById(env.DB, id)).zdroj, 'oslovenie');
});

test('výmaz oslovenia, starý DELETE aj retencia zachovajú prevzatý účet a vektory', async () => {
  const { env, id } = await prostredie();
  const token = await kodom(env, 'majitel@obchod.sk');
  await odosli(env, vstup('majitel@obchod.sk', { prevziat: true }), token);
  env.DB._tenants.get(id).created_at = '2020-01-01T00:00:00Z';
  const pred = await getTenantById(env.DB, id), pocet = env.VECTORIZE._store.size;
  for (const ucel of ['', '&ucel=oslovenie']) {
    const r = await worker.fetch(request('/v1/tenants/' + id + '?potvrd=' + DOM + ucel, null, '', 'DELETE', true), env);
    assert.equal(r.status, 409);
  }
  await dennaUdrzba({ ...env, ASISTENT_MAZANIE: 'zapnute' }, { now: new Date() });
  assert.deepEqual(await getTenantById(env.DB, id), pred);
  assert.equal(env.VECTORIZE._store.size, pocet);
  assert.equal(env.DB._zmazane.size, 0);
});

test('podmienené zápisy chránia oba poradia súbehu prevzatia a výmazu', async () => {
  const { env, id } = await prostredie();
  const stale = await getTenantById(env.DB, id);
  assert.equal(await prevezmiOslovenie(env, stale, 'majitel@obchod.sk'), true);
  assert.equal((await zmazTenanta(env, id, { lenOslovenie: true })).zmazany, false);
  const druhe = await prostredie();
  const pred = await getTenantById(druhe.env.DB, druhe.id);
  await druhe.env.DB.prepare(ZC_SQL.ZAMKNI_VYMAZ_OSLOVENIA).bind(druhe.id).run();
  assert.equal(await prevezmiOslovenie(druhe.env, pred, 'majitel@obchod.sk'), false);
  const r = await odosli(druhe.env, vstup('info@obchod.sk'));
  assert.equal(r.status, 409);
  assert.equal((await zmazTenanta(druhe.env, druhe.id, { lenOslovenie: true })).zmazany, true);
});

test('plugin s www použije pôvodné ID ukážky bez www', async () => {
  const { env, id } = await prostredie();
  const r = await odosli(env, vstup('admin@obchod.sk', { domain: 'www.obchod.sk', zdroj: 'wordpress' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, id);
  assert.equal(env.DB._tenants.size, 1);
});

test('výpadok nového feedu nezruší prevzatie ani pôvodné produkty', async () => {
  const { env, id } = await prostredie();
  const pocet = env.VECTORIZE._store.size;
  env.fetchImpl = async () => new Response('', { status: 503 });
  const token = await kodom(env, 'majitel@obchod.sk');
  const r = await odosli(env, vstup('majitel@obchod.sk', { prevziat: true }), token);
  assert.equal(r.status, 200);
  assert.equal((await getTenantById(env.DB, id)).zdroj, 'prevzate');
  assert.equal((await tenantStatusResponse(env, id)).feed_pripojeny, false);
  assert.equal(env.VECTORIZE._store.size, pocet);
  assert.equal((await zmazTenanta(env, id, { lenOslovenie: true })).zmazany, false);
});

test('formulár najprv overí kód a až potom odošle prevzatie s Bearerom', async () => {
  const source = fs.readFileSync(new URL('../demo/prevzatie/prevzatie.js', import.meta.url), 'utf8');
  for (const nacitane of [true, false]) {
    const prvky = new Map(), volania = [];
    const element = (id) => {
      if (!prvky.has(id)) prvky.set(id, { value: '', hidden: true, disabled: false, focus() {},
        addEventListener(event, fn) { this[event] = fn; } });
      return prvky.get(id);
    };
    const c = vm.createContext({ document: { getElementById: element }, URLSearchParams, encodeURIComponent,
      location: { search: '?domain=obchod.sk&feed=' + encodeURIComponent(FEED) },
      setTimeout: (fn) => fn(),
      fetch: async (url, opts) => {
        volania.push({ url, ...opts });
        const data = url.endsWith('/kod') ? {} : url.endsWith('/over') ? { token: 'test-token' }
          : url.endsWith('/status') ? { status: nacitane ? 'ready' : 'error', feed_pripojeny: nacitane, product_count: 1 }
          : { id: 'povodne-id', existing: true, prevzate: true };
        return { ok: true, json: async () => data };
      }
    });
    vm.runInContext(source, c);
    element('email').value = 'majitel@obchod.sk';
    await element('udaje').submit({ preventDefault() {} });
    assert.equal(volania.length, 1);
    assert.ok(volania[0].url.endsWith('/kod'));
    element('kod').value = '654321';
    await element('overenie').submit({ preventDefault() {} });
    assert.ok(volania[1].url.endsWith('/over'));
    assert.ok(volania[2].url.endsWith('/v1/tenants'));
    assert.equal(volania[2].headers.Authorization, 'Bearer test-token');
    assert.equal(JSON.parse(volania[2].body).prevziat, true);
    assert.equal(element('hotovo').hidden, !nacitane);
    assert.match(element('sprava').textContent, nacitane ? /produkty sú načítané/ : /zatiaľ nie je potvrdené/);
  }
});
