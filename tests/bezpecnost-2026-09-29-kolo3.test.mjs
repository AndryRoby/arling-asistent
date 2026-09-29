// Tretie kolo: ochrana katalógu, parsera a denného rozpočtu. Bez siete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import worker from '../worker/src/index.js';
import {
  createTenantFromRequest, ingestFeedForTenant, readIngestError,
  domenaFeeduObchodu, jeKanonickyFeed, readIngestLimit,
} from '../worker/src/onboarding.js';
import {
  createTenant, getTenantById, setTenantStatus, SQL,
  VEREJNE_PRIPONY, jeVerejnaPripona, hostPatriDomene,
} from '../worker/src/tenants.js';
import {
  stripHtml, decodeXmlEntities, fetchFeed, parseFeed, extractTag,
  parseWooCommerceJson, parseShopifyJson, normaliseProduct, MAX_PRODUCTS,
} from '../worker/src/feed.js';
import { refreshAllFeeds, poradieObnovy } from '../worker/src/cron.js';
import { rezervujObnovu, usedObnovaToday } from '../worker/src/budget.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const DOMENA = 'ludovka.eu';
const FEED = 'https://ludovka.eu/wp-json/wc/store/v1/products';
const EMAIL = 'majitel@ludovka.eu';
const xml = (n, pref = 'p') => '<products>' + Array.from({ length: n }, (_, i) =>
  '<item><id>' + pref + i + '</id><name>Výrobok ' + i + '</name><description>Popis</description></item>').join('') + '</products>';
const woo = (n, pref = 'p', popis = '') => Array.from({ length: n }, (_, i) =>
  ({ id: pref + i, name: 'Výrobok ' + i, description: popis, price: '9.99' }));
const odpoved = (text, status = 200) => ({ ok: status === 200, status, text: async () => text });
function prostredie() {
  return {
    DB: createMockD1(), AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(), ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    fetchImpl: async () => odpoved(xml(40)),
  };
}
async function obchod(env, { domain = DOMENA, feedUrl = 'https://' + domain + '/feed.xml', ...data } = {}) {
  const t = await createTenant(env.DB, { domain, feedUrl, contactEmail: EMAIL });
  Object.assign(env.DB._tenants.get(t.id), data);
  return getTenantById(env.DB, t.id);
}
const vektory = (env) => [...env.VECTORIZE._store.keys()].sort();
let ip = 0;
async function plugin(env, feed_url, email = EMAIL) {
  const ulohy = [];
  const req = new Request('https://worker.example/v1/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'WordPress/6.6.2',
      'CF-Connecting-IP': '198.19.0.' + (++ip) },
    body: JSON.stringify({ feed_url, domain: DOMENA, email, zdroj: 'wordpress', lang: 'sk' }),
  });
  const res = await worker.fetch(req, env, { waitUntil: (p) => ulohy.push(p) });
  await Promise.all(ulohy);
  return { status: res.status, body: await res.json() };
}

test('1. Kanonický feed: iba tri tvary a povolené parametre, bez filtrov a cudzích domén', () => {
  for (const cesta of ['/wp-json/wc/store/v1/products', '/wp-json/wc/store/v1/products/',
    '/?rest_route=%2Fwc%2Fstore%2Fv1%2Fproducts', '/products.json']) {
    const u = new URL(cesta, 'https://www.ludovka.eu');
    for (const [k, v] of [['per_page', '100'], ['page', '9'], ['lang', 'sk']]) u.searchParams.set(k, v);
    assert.equal(jeKanonickyFeed(u.href, DOMENA), true, u.href);
    for (const kluc of ['search', 'include', 'exclude', 'category', 'offset', 'limit', 'x', 'url']) {
      const zly = new URL(u); zly.searchParams.set(kluc, '1');
      assert.equal(jeKanonickyFeed(zly.href, DOMENA), false, zly.href);
    }
  }
  for (const cesta of ['/rss.xml', '/out?u=https://cudzi.example', '/products.json/extra',
    '/wp-content/uploads/feed.xml', '/?rest_route=/wc/store/v1/products/1',
    '/wp-json/wc/store/v1/products?rest_route=/ina/cesta',
    '/products.json?page=1&page=2', '/products.json#x']) {
    assert.equal(jeKanonickyFeed('https://ludovka.eu' + cesta, DOMENA), false, cesta);
  }
  assert.equal(jeKanonickyFeed(FEED.replace('ludovka.eu', 'ludovka.eu.cudzi.example'), DOMENA), false);
});

test('1. U2 a U3: výnimka oslovenia končí snímkou, presmerovanie sa viaže aj po zaplatení', async () => {
  for (const nova of [FEED, 'https://ludovka.eu/?rest_route=/wc/store/v1/products', 'https://ludovka.eu/products.json']) {
    const env = prostredie();
    let t = await obchod(env, { feedUrl: 'https://snimky.example/obchod.xml', zdroj: 'oslovenie' });
    assert.equal((await ingestFeedForTenant(env, t)).ok, true);
    t = await getTenantById(env.DB, t.id);
    assert.equal(domenaFeeduObchodu(env, t), null);
    const stare = vektory(env);
    const zle = await plugin(env, 'https://ludovka.eu/out?u=https://cudzi.example', 'iny@example.com');
    assert.equal(zle.status, 409);
    assert.deepEqual(vektory(env), stare);
    const telo = (n) => JSON.stringify(nova.includes('products.json')
      ? { products: woo(n, 'n').map((p) => ({ ...p, title: p.name })) } : woo(n, 'n'));
    env.fetchImpl = async () => odpoved(telo(19));
    const aiPred = env.AI.calls.length;
    await plugin(env, nova, 'iny@example.com');
    assert.equal(env.AI.calls.length, aiPred, 'ani snímka sa nesmie zúžiť pod polovicu');
    assert.equal((await getTenantById(env.DB, t.id)).feed_url, t.feed_url);
    env.fetchImpl = async () => odpoved(telo(20));
    const r = await plugin(env, nova, 'iny@example.com');
    assert.equal(r.status, 200);
    t = await getTenantById(env.DB, t.id);
    assert.equal(t.feed_url, nova);
    assert.equal(t.contact_email, EMAIL);
    assert.equal(vektory(env).length, 20, 'vektory snímky sú preč');
    assert.equal(domenaFeeduObchodu(env, t), DOMENA);
    assert.equal((await plugin(env, nova, 'iny@example.com')).status, 409);
    for (const plan of ['free', 'starter', 'pro']) {
      Object.assign(env.DB._tenants.get(t.id), { plan });
      let volani = 0;
      env.fetchImpl = async () => {
        volani++;
        return { ok: false, status: 302, headers: new Headers({ location: 'https://cudzi.example/x.xml' }) };
      };
      const pred = vektory(env);
      const vysledok = await ingestFeedForTenant(env, await getTenantById(env.DB, t.id));
      assert.equal(vysledok.code, 'feed_other_domain');
      assert.equal(volani, 1, 'cudzia adresa sa nestiahla');
      assert.deepEqual(vektory(env), pred);
    }
  }
  // Aj navrhnutý kanonický feed snímky viaže skoky pred uložením.
  const env = prostredie();
  let t = await obchod(env, { feedUrl: 'https://snimky.example/x.xml', zdroj: 'oslovenie' });
  await ingestFeedForTenant(env, t);
  env.fetchImpl = async () => ({ ok: false, status: 302, headers: new Headers({ location: 'https://cudzi.example/x.xml' }) });
  assert.equal((await plugin(env, FEED, 'iny@example.com')).status, 200);
  t = await getTenantById(env.DB, t.id);
  assert.equal(t.feed_url, 'https://snimky.example/x.xml');
  assert.equal(await readIngestError(env, t.id), 'feed_other_domain');
});

test('4. U1 a U4: ready bez chyby nič neprepíše; po chybe polovica produktov a bez mazania', async () => {
  for (const zdroj of ['wordpress', 'oslovenie']) {
    const env = prostredie();
    let t = await obchod(env, { zdroj });
    await ingestFeedForTenant(env, t);
    const povodne = vektory(env);
    let volani = 0;
    env.fetchImpl = async () => { volani++; return odpoved(JSON.stringify(woo(20, 'n'))); };
    for (const chyba of [false, true]) {
      if (chyba) await env.ASISTENT_CACHE.put('ingest-error:' + t.id, 'feed_http_404');
      for (const cesta of ['/rss.xml', '/wp-content/uploads/x.xml', '/wp-json/wc/store/v1/products?search=zzz',
        ...(!chyba ? ['/wp-json/wc/store/v1/products'] : [])]) {
        const r = await plugin(env, 'https://ludovka.eu' + cesta);
        assert.equal(r.body.feed_treba_overit, true, cesta);
        assert.deepEqual(vektory(env), povodne);
      }
    }
    assert.equal(volani, 0, 'odmietnutie nespustí ani starý feed');
    const aiPred = env.AI.calls.length;
    env.fetchImpl = async () => odpoved(JSON.stringify(woo(19, 'n')));
    await plugin(env, FEED);
    assert.equal(env.AI.calls.length, aiPred, 'pokles pod polovicu sa odmietne pred vektormi');
    assert.equal((await getTenantById(env.DB, t.id)).feed_url, 'https://ludovka.eu/feed.xml');
    env.fetchImpl = async () => odpoved(JSON.stringify(woo(20, 'n')));
    await plugin(env, FEED);
    t = await getTenantById(env.DB, t.id);
    assert.equal(t.feed_url, FEED);
    assert.equal(t.product_count, 40, 'čiastočný výsledok nezníži ďalší prah');
    assert.equal(vektory(env).length, 60);
    assert.ok(povodne.every((id) => env.VECTORIZE._store.has(id)));
    assert.equal((await ingestFeedForTenant(env, t)).ok, true);
    assert.equal(vektory(env).length, 20, 'ďalšie úplné načítanie zosúladí katalóg');
  }
});

test('4. Plugin: error a pending opraví REST, Bearer majiteľa smie zmeniť ready aj na XML', async () => {
  for (const stav of ['error', 'pending']) {
    const env = prostredie();
    const t = await obchod(env);
    await setTenantStatus(env.DB, t.id, stav);
    env.fetchImpl = async () => odpoved(JSON.stringify(woo(2)));
    assert.equal((await plugin(env, FEED)).status, 200);
    assert.equal((await getTenantById(env.DB, t.id)).status, 'ready');
    assert.equal((await getTenantById(env.DB, t.id)).feed_url, FEED);
  }
  const env = prostredie();
  const t = await obchod(env);
  await ingestFeedForTenant(env, t);
  env.fetchImpl = async () => odpoved(xml(1, 'novy'));
  await createTenantFromRequest(env, { domain: DOMENA, feedUrl: 'https://ludovka.eu/novy.xml',
    email: EMAIL, overenyEmail: EMAIL });
  assert.equal(vektory(env).length, 1);
});

test('2. Všetky kotvy stripHtml: 1 MB pod sekundu, rovnaký výsledok ako pôvodné regexy', () => {
  const stary = (s) => decodeXmlEntities(s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/ +([.,!?;:])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  for (const kotva of ['<br', '<br/', '<br /', '<br />', '</p', '</P', '</div', '</li']) {
    for (const kus of ['<', '<a', '<br']) {
      const maly = kus.repeat(64) + kotva + '>';
      assert.equal(stripHtml(maly), stary(maly), maly);
      const prefix = kus.repeat(Math.ceil(1024 * 1024 / kus.length));
      const velky = prefix + kotva + '>';
      const start = performance.now();
      const vysledok = stripHtml(velky);
      assert.ok(performance.now() - start < 1000, kus + kotva);
      assert.ok(vysledok === (kotva.endsWith('>') ? '' : prefix), kus + kotva + ': výstup');
    }
  }
  let seed = 29;
  const kusy = ['<br>', '</P>', '</div>', '<a', '<', '>', '&amp;', 'x', '\n', '<style>x</style>'];
  for (let i = 0; i < 1000; i++) {
    let s = '';
    for (let j = 0; j < 20; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; s += kusy[seed % kusy.length]; }
    assert.equal(stripHtml(s), stary(s));
  }
});

test('3. Orezanie surových polí v každej vstupnej ceste a platný rozsah entít', () => {
  const nazov = 'N'.repeat(3000), popis = '&amp;'.repeat(10000);
  for (const tag of ['name', 'title', 'PRODUCTNAME', 'PRODUCT', 'g:title']) {
    assert.equal(extractTag('<' + tag + '>' + nazov + '</' + tag + '>', tag).length, 2000);
  }
  for (const tag of ['description', 'DESCRIPTION', 'g:description']) {
    assert.equal(extractTag('<' + tag + '>' + popis + '</' + tag + '>', tag), '&'.repeat(4000));
  }
  assert.equal(parseWooCommerceJson([{ name: nazov, description: popis }])[0].description.length, 20000);
  assert.equal(parseWooCommerceJson([{ name: nazov, short_description: popis }])[0].title.length, 2000);
  assert.equal(parseShopifyJson({ products: [{ title: nazov, body_html: popis }] })[0].description.length, 20000);
  const p = normaliseProduct({ title: nazov, description: popis }, { descriptionMaxLen: 10000 });
  assert.equal(p.id.length, 2000);
  assert.equal(p.description, '&'.repeat(4000));
  for (const n of [0, 65, 0xd800, 0x10ffff]) {
    assert.equal(decodeXmlEntities('&#' + n + ';'), String.fromCodePoint(n));
    assert.equal(decodeXmlEntities('&#x' + n.toString(16) + ';'), String.fromCodePoint(n));
  }
  for (const entita of ['&#1114112;', '&#99999999;', '&#x110000;', '&#xFFFFFFFF;']) {
    assert.equal(decodeXmlEntities(entita), entita);
  }
});

test('3. XML aj JSON: entity, značky a CDATA pod 128 MB a pod dve sekundy', () => {
  const modul = new URL('../worker/src/feed.js', import.meta.url).href;
  for (const format of ['xml', 'woo', 'shopify']) {
    for (const druh of ['entity', 'znacky', 'cdata', 'zle-entity']) {
      const kod = [
        'const { parseFeed } = await import(' + JSON.stringify(modul) + ');',
        'const start = performance.now();',
        'const velkost = ' + (format === 'xml' ? 18 * 1024 * 1024 : 3900000) + ';',
        'const druh = ' + JSON.stringify(druh) + ';',
        "const kus = druh === 'entity' ? '&amp;' : druh === 'zle-entity' ? '&#99999999;' : '<b>x</b>';",
        "const popis = druh === 'cdata' ? '<![CDATA[' + 'x'.repeat(velkost - 12) + ']]>' : kus.repeat(Math.floor(velkost / kus.length));",
        'const format = ' + JSON.stringify(format) + ';',
        "const text = format === 'xml' ? '<products><item><id>1</id><name>Názov</name><description>' + popis + '</description></item></products>'",
        "  : format === 'woo' ? JSON.stringify([{ id: 1, name: 'Názov', description: popis }])",
        "  : JSON.stringify({ products: [{ id: 1, title: 'Názov', body_html: popis }] });",
        "const r = parseFeed(text, 'https://obchod.sk/export');",
        "if (r.products.length !== 1 || r.products[0].description.length > 601) throw Error('produkty');",
        'const ms = performance.now() - start;',
        "if (ms >= 2000) throw Error('čas ' + ms);",
        'console.log(ms);',
      ].join('\n');
      const r = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module'], {
        input: kod, encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.equal(r.status, 0, format + '/' + druh + ': ' + (r.error || r.stderr));
      assert.ok(Number(r.stdout.trim()) < 2000);
    }
  }
});

test('5. Každá chyba ďalšej strany zachová katalóg Woo aj Shopify; zmena adresy ho vymení', async () => {
  for (const shopify of [false, true]) {
    const adresa = shopify ? 'https://ludovka.eu/products.json' : FEED;
    const velkost = shopify ? 250 : 100;
    const strana = (n) => JSON.stringify(shopify
      ? { products: woo(n).map((p) => ({ ...p, title: p.name })) } : woo(n));
    const chyby = [
      () => odpoved('', 429), () => odpoved('', 500), () => odpoved('', 503),
      () => odpoved('<html>firewall</html>'), () => odpoved('{zlý JSON'),
      () => odpoved('{}'), () => odpoved(' '.repeat(4 * 1024 * 1024 + 1)),
      () => { throw new Error('feed_timeout'); }, () => { throw new TypeError('fetch failed'); },
    ];
    for (const chyba of chyby) {
      const env = prostredie();
      const t = await obchod(env, { feedUrl: adresa });
      env.fetchImpl = async () => odpoved(xml(velkost + 30));
      // Pôvodný katalóg vznikol pred výpadkom stránkovania.
      await ingestFeedForTenant(env, { ...t, feed_url: 'https://ludovka.eu/export.xml' });
      const pred = vektory(env);
      env.fetchImpl = async (url) => new URL(url).searchParams.get('page') === '1'
        ? odpoved(strana(velkost)) : chyba();
      const r = await ingestFeedForTenant(env, await getTenantById(env.DB, t.id));
      assert.equal(r.ok, true);
      assert.equal(r.truncated, true);
      assert.equal(r.neuplny, true);
      assert.equal(r.zmazaneVektory, 0);
      assert.deepEqual(vektory(env), pred);
      assert.equal((await getTenantById(env.DB, t.id)).product_count, velkost + 30);
      // Pri novej adrese sa staré produkty už nesmú zachovať.
      const zmena = await ingestFeedForTenant(env, await getTenantById(env.DB, t.id), { novyFeed: adresa + '?lang=sk' });
      assert.equal(zmena.zmazaneVektory, 30);
      assert.equal(vektory(env).length, velkost);
    }
  }
});

test('5. Skutočný časovač, XML nad stropom a limit MAX_PRODUCTS', async () => {
  const r = await fetchFeed(FEED, {
    casMs: 10, casSpoluMs: 100,
    fetchImpl: async (url) => new URL(url).searchParams.get('page') === '1'
      ? odpoved(JSON.stringify(woo(100))) : new Promise(() => {}),
  });
  assert.equal(r.neuplny, true);
  const env = prostredie();
  let t = await obchod(env);
  await ingestFeedForTenant(env, t);
  env.fetchImpl = async () => odpoved(xml(1) + ' '.repeat(21 * 1024 * 1024));
  t = await getTenantById(env.DB, t.id);
  const pred = vektory(env);
  const xmlVysledok = await ingestFeedForTenant(env, t);
  assert.equal(xmlVysledok.truncated, true);
  assert.deepEqual(vektory(env), pred);
  assert.equal((await getTenantById(env.DB, t.id)).product_count, 40);
  assert.equal(await readIngestLimit(env, t.id), true);
  const plny = parseFeed(xml(MAX_PRODUCTS), 'https://ludovka.eu/feed.xml');
  assert.equal(plny.truncated, true);
  assert.equal(plny.neuplny, false, 'produktový limit nie je chyba sťahovania');
  env.fetchImpl = async () => odpoved(xml(2));
  await ingestFeedForTenant(env, await getTenantById(env.DB, t.id));
  assert.equal(await readIngestLimit(env, t.id), false);
  assert.equal(vektory(env).length, 2);
});

test('6. U6: ready obchody nezjedia rezervu registrácií ani pri súbehu cronov', async () => {
  const env = prostredie();
  env.AI_DAILY_OBNOVA_BUDGET = '100';
  for (let i = 0; i < 6; i++) {
    await obchod(env, { domain: 'utok' + i + '.sk', status: 'ready', product_count: 1 });
  }
  env.fetchImpl = async () => odpoved(JSON.stringify(woo(300, 'p', 'x'.repeat(600))));
  await Promise.all([refreshAllFeeds(env), refreshAllFeeds(env)]);
  assert.ok(await usedObnovaToday(env) <= 70);
  env.fetchImpl = async () => odpoved(xml(2));
  const novy = await createTenantFromRequest(env, {
    domain: 'novy.sk', feedUrl: 'https://novy.sk/feed.xml', email: 'a@novy.sk',
  });
  assert.equal((await getTenantById(env.DB, novy.id)).status, 'ready');
  // Priama rezervácia: súbeh nemôže obísť strop a zvyšok ostáva registrácii.
  const e2 = prostredie(); e2.AI_DAILY_OBNOVA_BUDGET = '10';
  const vysledky = await Promise.all(Array.from({ length: 20 }, () => rezervujObnovu(e2, 1000, undefined, { podiel: 0.7 })));
  assert.equal(vysledky.filter(Boolean).length, 7);
  assert.equal(await rezervujObnovu(e2, 3000), true);
  assert.equal(await usedObnovaToday(e2), 10);
});

test('6. U7: rozhovory v skupine 1 majú prednosť, posledný čas alebo strop idú na koniec', async () => {
  const env = prostredie();
  const bez = await obchod(env, { domain: 'bez.sk', status: 'ready' });
  const cas = await obchod(env, { domain: 'cas.sk', status: 'ready' });
  const strop = await obchod(env, { domain: 'strop.sk', status: 'ready' });
  const aktivny = await obchod(env, { domain: 'aktivny.sk', status: 'ready' });
  const plateny = await obchod(env, { domain: 'plateny.sk', status: 'ready', plan: 'starter' });
  await env.DB.prepare(SQL.UPSERT_COUNTER_CONVERSATION).bind(aktivny.id, new Date().toISOString().slice(0, 10)).run();
  env.fetchImpl = async () => { throw new Error('feed_timeout'); };
  await ingestFeedForTenant(env, cas);
  env.fetchImpl = async () => { throw new Error('feed_too_large'); };
  await ingestFeedForTenant(env, strop);
  const zoradene = await poradieObnovy(env, [bez, cas, strop, aktivny, plateny], new Set([aktivny.id]));
  assert.deepEqual(zoradene.map((t) => t.id), [plateny.id, aktivny.id, bez.id, cas.id, strop.id]);
  env.fetchImpl = async () => odpoved(xml(1));
  let casMs = 0;
  const vysledky = await refreshAllFeeds(env, { hodiny: () => casMs++, casSpoluMs: 3 });
  assert.deepEqual(vysledky.filter((r) => r.ok).map((r) => r.tenantId), [plateny.id, aktivny.id]);
  assert.ok(vysledky.slice(2).every((r) => r.preskocene === 'cas'));
});

test('7. Verejné hostingové prípony nepovolia platformu ani susedný obchod', () => {
  for (const p of ['eshop-rychle.cz', 'webareal.sk', 'byznysweb.cz', 'eu.org', 'duckdns.org',
    'ddns.net', 'glitch.me', 'azurestaticapps.net', 'surge.sh', 'blogspot.sk']) {
    assert.equal(VEREJNE_PRIPONY.has(p), true, p);
  }
  for (const p of VEREJNE_PRIPONY) {
    assert.equal(jeVerejnaPripona(p), true, p);
    assert.equal(hostPatriDomene('utok.' + p, p), false, p);
    assert.equal(hostPatriDomene('iny.' + p, 'obchod.' + p), false, p);
    assert.equal(hostPatriDomene('cdn.obchod.' + p, 'obchod.' + p), true, p);
  }
});

// Útočník kola 3 (Claude, 29. 9.): samoobsluha s vlastným stropom, orezanie všetkých polí, vlastná predpona REST.
test('7. samoobslužné rezervácie majú vlastný strop 30 %, súčet so 70 % cronu nikdy nad 100 %', async () => {
  const e = prostredie(); e.AI_DAILY_OBNOVA_BUDGET = '10';
  const samo = await Promise.all(Array.from({ length: 20 }, () => rezervujObnovu(e, 1000, undefined, { samoobsluha: true })));
  assert.equal(samo.filter(Boolean).length, 3, 'samoobsluha najviac 30 %');
  const cron = await Promise.all(Array.from({ length: 20 }, () => rezervujObnovu(e, 1000, undefined, { podiel: 0.7 })));
  assert.equal(cron.filter(Boolean).length, 4, 'cron dorovná do 70 % spolu');
  assert.ok(await usedObnovaToday(e) <= 10);
  // aj keď samoobsluha narazí na strop, cron pre platiacich má stále miesto
  const e2 = prostredie(); e2.AI_DAILY_OBNOVA_BUDGET = '10';
  for (let i = 0; i < 10; i++) await rezervujObnovu(e2, 1000, undefined, { samoobsluha: true });
  assert.equal(await rezervujObnovu(e2, 1000, undefined, { podiel: 0.7 }), true);
});

test('8. surové polia okrem názvu a popisu sú orezané (URL, obrázok, kategória, výrobca, EAN), 8 MB bez pádu', () => {
  for (const tag of ['URL', 'IMGURL', 'CATEGORYTEXT', 'MANUFACTURER', 'EAN', 'ITEMGROUP_ID']) {
    // vstup vzniká až v podprocese (8 MB sa nezmestí do príkazového riadka Windows)
    const r = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e',
      `const { parseHeurekaXml } = await import(${JSON.stringify(new URL('../worker/src/feed.js', import.meta.url).href)});
       const zla = '&#99999999;'.repeat(Math.floor((8 * 1024 * 1024) / 11));
       const x = '<SHOP><SHOPITEM><ITEM_ID>1</ITEM_ID><PRODUCTNAME>X</PRODUCTNAME><PRICE_VAT>9.99</PRICE_VAT><${tag}>' + zla + '</${tag}></SHOPITEM></SHOP>';
       const t = Date.now(); const p = parseHeurekaXml(x, 'https://obchod.sk/export.xml');
       const d = Math.max(0, ...p.flatMap((q) => Object.values(q || {}).map((v) => String(v).length)));
       console.log(JSON.stringify({ d, ms: Date.now() - t }));`], { encoding: 'utf8' });
    assert.equal(r.status, 0, tag + ' ' + (r.stderr || '').slice(0, 200));
    const v = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    assert.ok(v.d <= 4100 && v.ms < 2000, tag + ' ' + JSON.stringify(v));
  }
});

test('9. kanonický feed prijme vlastnú predponu REST, ktorú posiela plugin (get_rest_url)', () => {
  assert.equal(jeKanonickyFeed('https://ludovka.eu/api/wc/store/v1/products?per_page=100', 'ludovka.eu'), true);
  assert.equal(jeKanonickyFeed('https://ludovka.eu/wp-json/wc/store/v1/products', 'ludovka.eu'), true);
  assert.equal(jeKanonickyFeed('https://ludovka.eu/out?u=https://zly.example/wc/store/v1/products', 'ludovka.eu'), false);
  assert.equal(jeKanonickyFeed('https://ludovka.eu/api/wc/store/v1/products?search=zzz', 'ludovka.eu'), false);
});
