// zivotny-cyklus.test.mjs
//
// Životný cyklus účtu Asistenta (worker/src/zivotny-cyklus.js, návrh
// ops/asistent/zivotny-cyklus.md, časť 7). Všetko s mockmi: D1
// (helpers/mock-d1.mjs), KV, Resend a subscribe-service cez env.fetchImpl.
// Žiadna sieť, žiadny skutočný e-mail ani ntfy.
//
// Čísla v názvoch testov zodpovedajú zoznamu v návrhu (7.1 až 7.30).
// Testy 25 a 26 (Twenty CRM, sync.mjs) patria ďalšiemu kroku, 29 a 30 sú v
// widget.test.mjs a wordpress-plugin.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import cronHandler from '../worker/src/cron.js';
import { createTenantFromRequest, ingestFeedForTenant, handleSetPlanRoute } from '../worker/src/onboarding.js';
import { createTenant, setTenantStatus, getTenantById } from '../worker/src/tenants.js';
import {
  ZC_SQL,
  NTFY_TITULKY,
  zabezpecSchemu,
  zaznamenaj,
  udalostiTenanta,
  jazykUctu,
  jazykZoVstupu,
  zdrojZoVstupu,
  posliEmail,
  poRozhovore,
  poWidgetJs,
  dobeh,
  dennaUdrzba,
  podpisStop,
  odkazStop,
  pingni,
  jePracovnyCas,
  STROP_EMAILOV,
} from '../worker/src/zivotny-cyklus.js';
import { vytvorEmail, KODY_EMAILOV, JAZYKY_EMAILOV, PLATFORMY, dovodChyby } from '../worker/src/zivotny-cyklus-texty.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const FEED = `<products><item><id>1</id><name>Krojovaná bábika</name><price>19.90</price><url>https://obchod.sk/p/1</url><description>Ručne šitá.</description></item><item><id>2</id><name>Drevená lyžica</name><price>4.50</price><url>https://obchod.sk/p/2</url><description>Buk.</description></item></products>`;
const TAJOMSTVO = Buffer.from('k'.repeat(32)).toString('base64');
const ADMIN = 'admin-token-test';
const ZAPIS = 'zapis-token-test';

// Pondelok 21. 9. 2026 10:00 v Bratislave (UTC+2).
const PONDELOK_10 = new Date('2026-09-21T08:00:00Z');
const HOD = 60 * 60 * 1000;

function makeEnv({ emaily = true, ntfy = true, tajomstvo = true, resendKluc = true, resend = 200, feedText = FEED, feedOk = true, extra = {} } = {}) {
  const odoslane = []; // volania Resendu
  const pingy = []; // volania subscribe-service
  let resendVolanie = 0;
  const env = {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: ADMIN,
    ASISTENT_ADMIN_ZAPIS: ZAPIS,
    PING_TOKEN: 'ping-tajne',
    ...(emaily ? { ASISTENT_EMAILY: 'zapnute' } : {}),
    ...(ntfy ? { ASISTENT_NTFY: 'zapnute' } : {}),
    ...(tajomstvo ? { UCET_TAJOMSTVO: TAJOMSTVO } : {}),
    ...(resendKluc ? { RESEND_API_KEY: 're_test_kluc' } : {}),
    odoslane,
    pingy,
    fetchImpl: async (url, opts = {}) => {
      const u = String(url);
      if (u === 'https://api.resend.com/emails') {
        resendVolanie += 1;
        const status = typeof resend === 'function' ? resend(resendVolanie) : resend;
        if (status === 'siet') {
          odoslane.push({ url: u, opts, body: JSON.parse(opts.body), status: 0 });
          throw new Error('network down');
        }
        odoslane.push({ url: u, opts, body: JSON.parse(opts.body), status });
        return { ok: status >= 200 && status < 300, status, json: async () => ({ id: `re_${resendVolanie}` }) };
      }
      if (u.includes('/subscribe/api/ping')) {
        pingy.push({ url: new URL(u), opts });
        return { ok: true, status: 200 };
      }
      return { ok: feedOk, status: feedOk ? 200 : 500, text: async () => feedText };
    },
    ...extra,
  };
  return env;
}

/** Účet v stave ready s udalosťami vytvoreny a ready, ako by vznikol cez formulár v čase `now`. */
async function pripravUcet(env, { domain = 'obchod.sk', email, now = PONDELOK_10, zdroj = 'formular', jazyk = 'sk', status = 'ready', productCount = 253, feedType = 'heureka', overeny = true } = {}) {
  const t = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/heureka/export/products.xml`, contactEmail: email || `majitel@${domain}` }, { now });
  await zabezpecSchemu(env.DB);
  await env.DB.prepare(ZC_SQL.SET_JAZYK_ZDROJ).bind(jazyk, zdroj, t.id).run();
  env.DB._tenants.get(t.id).product_count = productCount;
  await zaznamenaj(env, t.id, 'vytvoreny', 'vytvoreny', { zdroj, jazyk, overeny }, now);
  if (status === 'ready') {
    await setTenantStatus(env.DB, t.id, 'ready', { now });
    await zaznamenaj(env, t.id, 'ready', 'ready', { product_count: productCount, feed_type: feedType }, now);
  } else {
    await setTenantStatus(env.DB, t.id, status, { now });
  }
  return getTenantById(env.DB, t.id);
}

const emailRiadky = async (env, id) => (await udalostiTenanta(env.DB, id)).filter((u) => u.typ === 'email');
const najdiU = async (env, id, kluc) => (await udalostiTenanta(env.DB, id)).find((u) => u.kluc === kluc) || null;

// ---------------------------------------------------------------------------
// Migrácia a udalosti (1 až 6)
// ---------------------------------------------------------------------------

test('1. strážený ALTER TABLE: prvé volanie pridá stĺpce, druhé (iný izolát) prejde, iná chyba prebuble; staré riadky majú NULL a 0', async () => {
  const db = createMockD1();
  const t = await createTenant(db, { domain: 'stary.sk', feedUrl: 'https://stary.sk/feed.xml', contactEmail: 'a@stary.sk' });
  await db.prepare('INSERT INTO counters (tenant_id, day, conversations, product_clicks) VALUES (?, ?, 1, 0) ON CONFLICT(tenant_id, day) DO UPDATE SET conversations = conversations + 1').bind(t.id, '2026-09-20').run();

  await zabezpecSchemu(db);
  const row = db._tenants.get(t.id);
  assert.equal(row.jazyk, null);
  assert.equal(row.zdroj, null);
  assert.equal(row.emaily_stop_at, null);
  assert.equal(db._counters.get(`${t.id}::2026-09-20`).web_conversations, 0);

  // Iný izolát: iná väzba, tá istá databáza. ALTER TABLE hodí duplicate column, to sa prehltne.
  const inyIzolat = { prepare: (sql) => db.prepare(sql) };
  await assert.doesNotReject(() => zabezpecSchemu(inyIzolat));

  // Iná chyba než duplicate column prebuble.
  const pokazena = { prepare: (sql) => (sql === ZC_SQL.ADD_JAZYK ? { run: async () => { throw new Error('D1_ERROR: disk I/O error'); } } : db.prepare(sql)) };
  await assert.rejects(() => zabezpecSchemu(pokazena), /disk I\/O/);
});

test('2. CREATE TABLE IF NOT EXISTS tenant_udalosti dvakrát bez chyby, existujúce obchody a počítadlá ostanú nezmenené', async () => {
  const db = createMockD1();
  const t = await createTenant(db, { domain: 'nezmeneny.sk', feedUrl: 'https://nezmeneny.sk/f.xml', contactEmail: 'a@nezmeneny.sk' });
  const pred = { ...db._tenants.get(t.id) };
  await zabezpecSchemu(db);
  await db.prepare(ZC_SQL.CREATE_UDALOSTI).run();
  const po = db._tenants.get(t.id);
  for (const k of Object.keys(pred)) assert.equal(po[k], pred[k]);
  assert.equal(db._hasUdalosti(), true);
});

test('3. INSERT OR IGNORE s tým istým kľúčom vráti false a vedľajší účinok sa nespustí', async () => {
  const env = makeEnv();
  assert.equal(await zaznamenaj(env, 't1', 'ready', 'ready', {}), true);
  assert.equal(await zaznamenaj(env, 't1', 'ready', 'ready', {}), false);
  assert.equal(env.DB._udalosti.length, 1);
});

test('4. nový obchod dostane vytvoreny raz, s jazykom a zdrojom; opakovaný POST ho nezdvojí; fr je en; WordPress podľa User-Agent', async () => {
  const env = makeEnv({ emaily: false, ntfy: true });
  const t = await createTenantFromRequest(env, { feedUrl: 'https://novy.sk/feed.xml', domain: 'novy.sk', email: 'a@novy.sk', lang: 'sk', zdroj: 'formular' });
  await createTenantFromRequest(env, { feedUrl: 'https://novy.sk/feed.xml', domain: 'novy.sk', email: 'a@novy.sk', lang: 'cs', zdroj: 'formular' });
  const u = (await udalostiTenanta(env.DB, t.id)).filter((x) => x.typ === 'vytvoreny');
  assert.equal(u.length, 1);
  assert.deepEqual({ zdroj: u[0].data.zdroj, jazyk: u[0].data.jazyk, feed_host: u[0].data.feed_host }, { zdroj: 'formular', jazyk: 'sk', feed_host: 'novy.sk' });
  // Majiteľ (ten istý e-mail) smie zmeniť jazyk, cudzí nie.
  assert.equal(env.DB._tenants.get(t.id).jazyk, 'cs');
  await createTenantFromRequest(env, { feedUrl: 'https://novy.sk/feed.xml', domain: 'novy.sk', email: 'cudzi@x.sk', lang: 'de' });
  assert.equal(env.DB._tenants.get(t.id).jazyk, 'cs');
  const novyPing = env.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_novy');
  assert.equal(novyPing.length, 1);

  const wp = await createTenantFromRequest(env, { feedUrl: 'https://wp.fr/?rest_route=/wc/store/v1/products', domain: 'wp.fr', email: 'a@wp.fr', lang: 'fr_FR', userAgent: 'WordPress/6.6; https://wp.fr' });
  assert.equal(env.DB._tenants.get(wp.id).jazyk, 'en');
  assert.equal(env.DB._tenants.get(wp.id).zdroj, 'wordpress');
  assert.equal(zdrojZoVstupu('shopify', ''), 'shopify');
  assert.equal(zdrojZoVstupu('', 'curl/8'), 'api');
  assert.equal(jazykZoVstupu(''), null);
  assert.equal(jazykZoVstupu('auto'), null);
  assert.equal(jazykZoVstupu('de_AT'), 'de');
});

test('5. ready pri prvom úspechu raz aj s E1; nočná obnova už ready obchodu nič nové nevloží; error potom ready dostane ready a E1', async () => {
  const env = makeEnv();
  const t = await createTenantFromRequest(env, { feedUrl: 'https://prvy.sk/feed.xml', domain: 'prvy.sk', email: 'a@prvy.sk', lang: 'sk', zdroj: 'formular' });
  let u = await udalostiTenanta(env.DB, t.id);
  assert.equal(u.filter((x) => x.typ === 'ready').length, 1);
  assert.equal(env.odoslane.length, 1);
  assert.match(env.odoslane[0].body.subject, /Asistent pre prvy\.sk je pripravený: 2 produkty/);

  await ingestFeedForTenant(env, await getTenantById(env.DB, t.id)); // nočná obnova
  u = await udalostiTenanta(env.DB, t.id);
  assert.equal(u.filter((x) => x.typ === 'ready').length, 1);
  assert.equal(env.odoslane.length, 1);

  const env2 = makeEnv({ feedOk: false });
  const t2 = await createTenantFromRequest(env2, { feedUrl: 'https://neskor.sk/feed.xml', domain: 'neskor.sk', email: 'a@neskor.sk', lang: 'en' });
  assert.equal((await getTenantById(env2.DB, t2.id)).status, 'error');
  assert.ok(await najdiU(env2, t2.id, 'chyba'));
  env2.fetchImpl = makeEnv().fetchImpl; // feed opravený
  const odoslaneEnv2 = env2.odoslane;
  const nove = makeEnv();
  env2.fetchImpl = async (url, opts) => {
    const r = await nove.fetchImpl(url, opts);
    if (String(url).includes('resend')) odoslaneEnv2.push(nove.odoslane[nove.odoslane.length - 1]);
    return r;
  };
  await ingestFeedForTenant(env2, await getTenantById(env2.DB, t2.id));
  assert.ok(await najdiU(env2, t2.id, 'ready'));
  assert.equal(odoslaneEnv2.length, 1);
  assert.match(odoslaneEnv2[0].body.subject, /^Your assistant for neskor\.sk is ready/);
});

test('5b. obchod, ktorý bol ready pred nasadením, dostane pri nočnej obnove ready so značkou spatne a žiadny e-mail', async () => {
  const env = makeEnv();
  const t = await createTenant(env.DB, { domain: 'starsi.sk', feedUrl: 'https://starsi.sk/feed.xml', contactEmail: 'a@starsi.sk' });
  await setTenantStatus(env.DB, t.id, 'ready');
  await ingestFeedForTenant(env, await getTenantById(env.DB, t.id));
  const ready = await najdiU(env, t.id, 'ready');
  assert.equal(ready.data.spatne, true);
  assert.equal(env.odoslane.length, 0);
  assert.equal(env.pingy.length, 0);
});

test('6. chyba len kým ready nikdy nebolo, zo všetkých štyroch vetiev ingestFeedForTenant', async () => {
  const pripady = [
    { nazov: 'strop neurónov', env: makeEnv({ extra: { AI_DAILY_NEURON_BUDGET: '100' } }), samo: true, kod: 'ai_budget_exhausted' },
    { nazov: 'stiahnutie', env: makeEnv({ feedOk: false }), kod: 'feed_http_500' },
    { nazov: 'prázdny katalóg', env: makeEnv({ feedText: '<products></products>' }), kod: 'no_products' },
    { nazov: 'vektory', env: makeEnv({ extra: { AI: { run: async () => { throw new Error('boom'); } } } }), kod: 'internal' },
  ];
  for (const p of pripady) {
    const t = await createTenant(p.env.DB, { domain: 'chyba.sk', feedUrl: 'https://chyba.sk/f.xml', contactEmail: 'a@chyba.sk' });
    const r = await ingestFeedForTenant(p.env, t, { samoobsluzne: !!p.samo });
    assert.equal(r.ok, false, p.nazov);
    const ch = await najdiU(p.env, t.id, 'chyba');
    assert.ok(ch, p.nazov);
    assert.equal(ch.data.code, p.kod, p.nazov);
  }
  // Obchod, ktorý raz ready bol, chybu už nedostane.
  const env = makeEnv();
  const t = await pripravUcet(env, { domain: 'bol-ready.sk' });
  env.fetchImpl = makeEnv({ feedOk: false }).fetchImpl;
  await ingestFeedForTenant(env, t);
  assert.equal(await najdiU(env, t.id, 'chyba'), null);
});

// ---------------------------------------------------------------------------
// Zapojenie (7 až 11)
// ---------------------------------------------------------------------------

function widgetReq(referer) {
  const headers = referer ? { Referer: referer } : {};
  return new Request('https://arling-asistent.arling.workers.dev/widget.js', { headers });
}

test('7. GET /widget.js s Referer obchodu zapíše zapojeny; arling.sk, bez Referer, neznáma doména a lokálna adresa nie; chyba D1 skript aj tak doručí', async () => {
  const env = makeEnv({ emaily: false });
  const t = await pripravUcet(env, { domain: 'shop.sk' });
  const zaklad = await (await worker.fetch(widgetReq(null), env, {})).text();

  const bg = [];
  const ctx = { waitUntil: (p) => bg.push(p) };
  const res = await worker.fetch(widgetReq('https://www.shop.sk/produkt/123'), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), zaklad);
  await Promise.all(bg);
  const zap = await najdiU(env, t.id, 'zapojeny');
  assert.equal(zap.data.signal, 'widget_js');
  assert.equal(zap.data.host, 'www.shop.sk');
  const ping = env.pingy.find((p) => p.url.searchParams.get('e') === 'asistent_zapojeny');
  assert.equal(ping.url.searchParams.get('t'), 'shop.sk');

  for (const ref of ['https://arling.sk/asistent/', 'https://neznamy.sk/', 'http://localhost:8080/', 'http://192.168.1.5/']) {
    const e = makeEnv({ emaily: false });
    await pripravUcet(e, { domain: 'shop.sk' });
    await worker.fetch(widgetReq(ref), e, {});
    assert.equal(e.DB._udalosti.filter((u) => u.typ === 'zapojeny').length, 0, ref);
  }

  const pokazene = makeEnv({ emaily: false });
  pokazene.DB = { prepare() { throw new Error('D1 down'); } };
  const r2 = await worker.fetch(widgetReq('https://www.shop.sk/'), pokazene, {});
  assert.equal(r2.status, 200);
  assert.equal(await r2.text(), zaklad);
});

test('8. druhé stiahnutie widget.js z tej istej domény v tom istom izoláte nerobí dopyt do D1', async () => {
  const env = makeEnv({ emaily: false });
  await pripravUcet(env, { domain: 'cache.sk' });
  const dopyty = () => env.DB._calls.filter((s) => s === ZC_SQL.TENANTY_PODLA_DOMEN || s === ZC_SQL.INSERT_UDALOST).length;
  await poWidgetJs(env, widgetReq('https://cache.sk/a'));
  const po1 = dopyty();
  await poWidgetJs(env, widgetReq('https://cache.sk/b'));
  await poWidgetJs(env, widgetReq('https://cache.sk/c'));
  assert.equal(dopyty(), po1);
  // Neznáma doména sa tiež pamätá: druhý pokus nič nepýta.
  await poWidgetJs(env, widgetReq('https://nikto.sk/'));
  const po2 = env.DB._calls.length;
  await poWidgetJs(env, widgetReq('https://nikto.sk/x'));
  assert.equal(env.DB._calls.length, po2);
});

test('9. chat z Origin obchodu zapíše zapojeny aj prva_otazka; surface admin len zapojeny; arling.sk nič; demo obchod nič; gift rovnako', async () => {
  const quota = { counted: true, used: 1, quota: 100 };
  const env = makeEnv({ emaily: false });
  const t = await pripravUcet(env, { domain: 'chat.sk' });
  await poRozhovore(env, t, { origin: 'https://www.chat.sk', surface: 'web', quota });
  assert.ok(await najdiU(env, t.id, 'zapojeny'));
  assert.ok(await najdiU(env, t.id, 'prva_otazka'));

  const admin = makeEnv({ emaily: false });
  const ta = await pripravUcet(admin, { domain: 'wp.sk', zdroj: 'wordpress' });
  await poRozhovore(admin, ta, { origin: 'https://wp.sk', surface: 'admin', quota });
  assert.equal((await najdiU(admin, ta.id, 'zapojeny')).data.surface, 'admin');
  assert.equal(await najdiU(admin, ta.id, 'prva_otazka'), null);

  const nas = makeEnv({ emaily: false });
  const tn = await pripravUcet(nas, { domain: 'nas.sk' });
  await poRozhovore(nas, tn, { origin: 'https://arling.sk', quota });
  assert.equal(await najdiU(nas, tn.id, 'zapojeny'), null);

  const demo = makeEnv({ emaily: false });
  const td = await createTenant(demo.DB, { domain: 'ukazka.arling.sk', feedUrl: 'https://arling.sk/f.xml', contactEmail: 'a@b.sk' });
  await poRozhovore(demo, { ...td, status: 'ready' }, { origin: 'https://ukazka.arling.sk', quota });
  assert.equal(demo.DB._udalosti.length, 0);

  // Gift cez celú cestu /v1/gift: ten istý hák.
  const g = makeEnv({ emaily: false });
  const tg = await pripravUcet(g, { domain: 'gift.sk' });
  await g.VECTORIZE.upsert([{ id: `${tg.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: tg.id, productId: 'p1', title: 'Hrnček', url: 'https://gift.sk/p/1', price: '9.90', availability: 'in_stock' } }]);
  const res = await worker.fetch(new Request('https://x/v1/gift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://gift.sk', 'X-Arling-Test': ADMIN },
    body: JSON.stringify({ tenant: tg.id, recipient: 'mama', lang: 'sk', session: 'abcdef0123456789' }),
  }), g, {});
  assert.equal(res.status, 200);
  assert.ok(await najdiU(g, tg.id, 'zapojeny'));
  assert.ok(await najdiU(g, tg.id, 'prva_otazka'));
});

test('10. web_conversations rastie len pri započítanom rozhovore z webu obchodu', async () => {
  const env = makeEnv({ emaily: false });
  const t = await pripravUcet(env, { domain: 'pocty.sk' });
  const now = new Date('2026-09-22T10:00:00Z');
  const den = '2026-09-22';
  await env.DB.prepare('INSERT INTO counters (tenant_id, day, conversations, product_clicks) VALUES (?, ?, 1, 0) ON CONFLICT(tenant_id, day) DO UPDATE SET conversations = conversations + 1').bind(t.id, den).run();
  const web = () => env.DB._counters.get(`${t.id}::${den}`).web_conversations;
  await poRozhovore(env, t, { origin: 'https://pocty.sk', quota: { counted: true, used: 1, quota: 100 }, now });
  assert.equal(web(), 1);
  await poRozhovore(env, t, { origin: 'https://arling.sk', quota: { counted: true, used: 2, quota: 100 }, now });
  await poRozhovore(env, t, { origin: 'https://pocty.sk', surface: 'admin', quota: { counted: true, used: 3, quota: 100 }, now });
  await poRozhovore(env, t, { origin: 'https://pocty.sk', quota: { counted: false, used: 3, quota: 100 }, now }); // ďalšia správa v tej istej relácii
  assert.equal(web(), 1);
});

test('11. aktivny: 10 rozhovorov v 3 dňoch za 14 dní áno, 10 v jeden deň nie, staršie sa nerátajú, len raz', async () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const nastav = async (env, t, dni) => {
    await zabezpecSchemu(env.DB);
    for (const [den, n] of dni) env.DB._counters.set(`${t.id}::${den}`, { tenant_id: t.id, day: den, conversations: n, product_clicks: 0, web_conversations: n });
  };
  const env = makeEnv({ emaily: false });
  const t = await pripravUcet(env, { domain: 'aktivny.sk' });
  await zaznamenaj(env, t.id, 'zapojeny', 'zapojeny', { signal: 'chat' }, now);
  await nastav(env, t, [['2026-09-20', 4], ['2026-09-22', 3], ['2026-09-25', 3]]);
  let r = await dobeh(env, { now });
  assert.deepEqual(r.aktivne, [t.id]);
  r = await dobeh(env, { now });
  assert.deepEqual(r.aktivne, []);
  assert.equal(env.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_aktivny').length, 1);

  const jedenDen = makeEnv({ emaily: false });
  const t2 = await pripravUcet(jedenDen, { domain: 'jedenden.sk' });
  await zaznamenaj(jedenDen, t2.id, 'zapojeny', 'zapojeny', {}, now);
  await nastav(jedenDen, t2, [['2026-09-24', 10]]);
  assert.deepEqual((await dobeh(jedenDen, { now })).aktivne, []);

  const stare = makeEnv({ emaily: false });
  const t3 = await pripravUcet(stare, { domain: 'stare.sk' });
  await zaznamenaj(stare, t3.id, 'zapojeny', 'zapojeny', {}, now);
  await nastav(stare, t3, [['2026-09-01', 5], ['2026-09-05', 5], ['2026-09-24', 1], ['2026-09-25', 1]]);
  assert.deepEqual((await dobeh(stare, { now })).aktivne, []);
});

// ---------------------------------------------------------------------------
// E-maily (12 až 21)
// ---------------------------------------------------------------------------

function parametre(extra = {}) {
  return {
    domena: 'www.ludovka.eu', tenantId: 'abcd1234-0000', pocet: 253, platforma: 'heureka', zdroj: 'formular',
    datum: new Date('2026-09-25T09:00:00Z'), kedy: new Date('2026-09-25T12:05:00Z'), feedUrl: 'https://www.ludovka.eu/heureka/export/products.xml',
    chybaKod: 'feed_http_403', used: 80, quota: 100, mesiac: 9, dalsiMesiac: new Date('2026-10-01T00:00:00Z'),
    ucet: 'https://arling.sk/asistent/tenant/?t=abcd1234-0000', skusit: 'https://arling.sk/asistent/live/?t=abcd1234-0000&shop=www.ludovka.eu',
    stop: 'https://arling-asistent.arling.workers.dev/v1/tenants/abcd1234-0000/emaily/stop?k=podpis', volitelne: true, ...extra,
  };
}

test('12. každý e-mail E0 až E4 a E1W v sk, cs, en, de: predmet, text aj HTML, doména, dôvod, kontakt, stop odkaz, žiadna pomlčka ani pixel', () => {
  const dovodVeta = { sk: /Prečo vám to píšeme|Tento e-mail prišiel/, cs: /Proč vám píšeme|Tento e-mail přišel/, en: /Why you are getting this|You are getting this because/, de: /Warum Sie diese E-Mail erhalten|Sie erhalten diese E-Mail, weil/ };
  for (const kod of KODY_EMAILOV) {
    for (const jazyk of JAZYKY_EMAILOV) {
      for (const platforma of PLATFORMY) {
        const e = vytvorEmail(kod, jazyk, parametre({ platforma }));
        const vsetko = `${e.predmet}\n${e.text}\n${e.html}`;
        assert.ok(e.predmet && e.text && e.html, `${kod} ${jazyk}`);
        assert.ok(!/[–—]/.test(vsetko), `pomlčka v ${kod} ${jazyk} ${platforma}`);
        assert.ok(e.predmet.includes('www.ludovka.eu'), `${kod} ${jazyk} predmet bez domény`);
        assert.ok(e.text.includes('www.ludovka.eu'));
        assert.match(e.text, dovodVeta[jazyk], `${kod} ${jazyk} bez dôvodu`);
        assert.ok(e.text.includes('Ivanská cesta 32E'), 'bez firmy');
        const zasady = jazyk === 'sk' || jazyk === 'cs' ? 'https://arling.sk/asistent/#privacy' : 'https://arling.sk/asistent/en/#privacy';
        assert.ok(e.text.includes(zasady), `${kod} ${jazyk} bez zásad Asistenta`);
        assert.ok(!e.text.includes('/privacy/'), 'odkaz na všeobecné zásady, ktoré Asistenta neopisujú');
        assert.ok(!/Jedno kliknutie|Jedno kliknutí|One click|Ein Klick/.test(e.text), 'nepravdivé „jedno kliknutie“');
        if (jazyk === 'en') assert.ok(!/\n[a-z]/.test(e.text.split('\n--\n')[0]), `${kod} en: odsek začína malým písmenom`);
        assert.ok(!/19 €|39 €|80 %/.test(e.text), 'bez nezlomiteľnej medzery pri cene či percentách');
        assert.ok(e.text.includes('/emaily/stop?k=podpis'), `${kod} ${jazyk} bez stop odkazu`);
        assert.ok(!/<img|pixel|utm_/i.test(e.html), 'sledovanie');
        assert.ok(e.html.includes('<a href="https://arling-asistent.arling.workers.dev/v1/tenants/abcd1234-0000/emaily/stop?k=podpis">'));
      }
    }
  }
  // Všetky kódy chýb majú dôvod aj radu bez pomlčky.
  for (const jazyk of JAZYKY_EMAILOV) {
    for (const kod of ['feed_http_401', 'feed_http_403', 'feed_http_404', 'feed_http_429', 'feed_http_503', 'feed_http_418', 'feed_not_readable', 'feed_unreachable', 'feed_url_private_host', 'feed_too_many_redirects', 'no_products', 'ai_budget_exhausted', 'internal', 'nieco']) {
      const d = dovodChyby(jazyk, kod);
      assert.ok(d.dovod && d.rada && !/[–—]/.test(d.dovod + d.rada), `${jazyk} ${kod}`);
    }
  }
});

test('12b. slovenský E1 pre ľudovku: 253 produktov, návod Shoptet, skúšobná stránka, stránka účtu, anglická veta na konci', () => {
  const e = vytvorEmail('E1', 'sk', parametre({ platforma: 'shoptet', anglickaVeta: true }));
  assert.equal(e.predmet, 'Asistent pre www.ludovka.eu je pripravený: 253 produktov');
  assert.match(e.text, /Vzhľad a obsah, Editor, HTML kód, časť Pätička/);
  assert.match(e.text, /data-tenant="abcd1234-0000" data-lang="auto" defer><\/script>/);
  assert.match(e.text, /arling\.sk\/asistent\/live\/\?t=abcd1234-0000/);
  assert.match(e.text, /Starter za 19 € mesačne \(1 000 rozhovorov\)/);
  assert.ok(e.text.trim().endsWith('Prefer English? Reply "English" and we will write in English from now on.'));
  assert.ok(e.html.includes('&lt;script src='));
});

test('13. jazyk: null a .sk je sk, .cz cs, .at de, .fr en; fr z pluginu je en', () => {
  assert.equal(jazykUctu({ jazyk: null, domain: 'obchod.sk' }), 'sk');
  assert.equal(jazykUctu({ jazyk: null, domain: 'obchod.cz' }), 'cs');
  assert.equal(jazykUctu({ jazyk: null, domain: 'shop.at' }), 'de');
  assert.equal(jazykUctu({ jazyk: null, domain: 'boutique.fr' }), 'en');
  assert.equal(jazykUctu({ jazyk: jazykZoVstupu('fr'), domain: 'obchod.sk' }), 'en');
  assert.equal(jazykUctu({ jazyk: 'cs', domain: 'obchod.sk' }), 'cs');
});

test('14. Resend: odosielateľ, reply_to, adresa, Idempotency-Key, List-Unsubscribe aj One-Click, text aj HTML', async () => {
  const env = makeEnv();
  const t = await pripravUcet(env, { domain: 'hlavicky.sk', email: 'Majitel@Hlavicky.sk' });
  const r = await posliEmail(env, t, 'E1', { now: PONDELOK_10 });
  assert.equal(r.poslane, true);
  const o = env.odoslane[0];
  assert.equal(o.url, 'https://api.resend.com/emails');
  assert.equal(o.opts.method, 'POST');
  assert.equal(o.opts.headers.Authorization, 'Bearer re_test_kluc');
  assert.equal(o.opts.headers['Idempotency-Key'], `asistent-${t.id}-E1`);
  assert.equal(o.body.from, 'ARLing Asistent <asistent@mail.arling.sk>');
  assert.equal(o.body.reply_to, 'andrej@arling.sk');
  assert.deepEqual(o.body.to, ['majitel@hlavicky.sk']);
  const stop = await odkazStop(env, t.id);
  assert.equal(o.body.headers['List-Unsubscribe'], `<${stop}>`);
  assert.equal(o.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(o.body.text.length > 200 && o.body.html.startsWith('<!doctype html>'));
  const riadok = await najdiU(env, t.id, 'email:E1');
  assert.equal(riadok.data.stav, 'odoslany');
  assert.equal(riadok.data.resend_id, 're_1');
});

test('15. najviac raz: dva súbežné E1 pošlú jeden POST; 4xx zamietnutý bez ďalšieho pokusu; 5xx zlyhal, cron skúša s tým istým kľúčom a po 3 pokusoch pingne', async () => {
  const env = makeEnv();
  const t = await pripravUcet(env, { domain: 'subeh.sk' });
  const [a, b] = await Promise.all([posliEmail(env, t, 'E1', { now: PONDELOK_10 }), posliEmail(env, t, 'E1', { now: PONDELOK_10 })]);
  assert.equal(env.odoslane.length, 1);
  assert.equal([a, b].filter((x) => x.poslane).length, 1);

  const env4 = makeEnv({ resend: 422 });
  const t4 = await pripravUcet(env4, { domain: 'zamietnuty.sk' });
  await posliEmail(env4, t4, 'E1', { now: PONDELOK_10 });
  assert.equal((await najdiU(env4, t4.id, 'email:E1')).data.stav, 'zamietnuty');
  await dobeh(env4, { now: new Date(PONDELOK_10.getTime() + HOD) });
  assert.equal(env4.odoslane.length, 1);
  assert.ok(env4.pingy.some((p) => p.url.searchParams.get('e') === 'asistent_email_chyba'));

  const env5 = makeEnv({ resend: 503 });
  const t5 = await pripravUcet(env5, { domain: 'padajuci.sk' });
  await posliEmail(env5, t5, 'E1', { now: PONDELOK_10 });
  assert.equal((await najdiU(env5, t5.id, 'email:E1')).data.stav, 'zlyhal');
  await dobeh(env5, { now: new Date(PONDELOK_10.getTime() + 10 * 60 * 1000) });
  await dobeh(env5, { now: new Date(PONDELOK_10.getTime() + 20 * 60 * 1000) });
  await dobeh(env5, { now: new Date(PONDELOK_10.getTime() + 30 * 60 * 1000) });
  assert.equal(env5.odoslane.length, 3);
  assert.ok(env5.odoslane.every((o) => o.opts.headers['Idempotency-Key'] === `asistent-${t5.id}-E1`));
  const riadok = await najdiU(env5, t5.id, 'email:E1');
  assert.equal(riadok.data.stav, 'vzdany');
  assert.equal(riadok.data.pokusy, 3);
  assert.equal(env5.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_email_chyba').length, 1);

  // Sieťová chyba sa ráta ako zlyhanie a nič nevyhodí.
  const envS = makeEnv({ resend: 'siet' });
  const tS = await pripravUcet(envS, { domain: 'siet.sk' });
  const rS = await posliEmail(envS, tS, 'E1', { now: PONDELOK_10 });
  assert.equal(rS.stav, 'zlyhal');
});

test('16. strop: žiadna kombinácia udalostí nevedie k piatemu e-mailu; po E0 nepríde E3; E4 len raz a len na pláne free', async () => {
  const env = makeEnv();
  const t = await pripravUcet(env, { domain: 'strop.sk', status: 'error' });
  await zaznamenaj(env, t.id, 'chyba', 'chyba', { code: 'feed_http_403' }, PONDELOK_10);
  assert.equal((await posliEmail(env, t, 'E0', { now: PONDELOK_10, params: { chyba_kod: 'feed_http_403' } })).poslane, true);
  await setTenantStatus(env.DB, t.id, 'ready');
  await zaznamenaj(env, t.id, 'ready', 'ready', { product_count: 5 }, PONDELOK_10);
  let tt = await getTenantById(env.DB, t.id);
  assert.equal((await posliEmail(env, tt, 'E1', { now: PONDELOK_10 })).poslane, true);
  // E3 po E0 nie, ani po 72 hodinách.
  assert.equal((await posliEmail(env, tt, 'E3', { now: PONDELOK_10 })).dovod, 'zapojeny_alebo_e0');
  await zaznamenaj(env, t.id, 'zapojeny', 'zapojeny', {}, PONDELOK_10);
  assert.equal((await posliEmail(env, tt, 'E2', { now: PONDELOK_10 })).poslane, true);
  const e4 = { now: PONDELOK_10, params: { used: 80, quota: 100, mesiac: 9, dalsi_mesiac: '2026-10-01T00:00:00Z' } };
  assert.equal((await posliEmail(env, tt, 'E4', e4)).poslane, true);
  assert.equal((await posliEmail(env, tt, 'E4', e4)).poslane, false);
  assert.equal((await posliEmail(env, tt, 'E3', e4)).poslane, false);
  assert.equal(env.odoslane.length, STROP_EMAILOV);
  assert.equal((await emailRiadky(env, t.id)).length, 4);

  // Ani ručne vložený piaty riadok neprejde cez strop.
  const env2 = makeEnv();
  const t2 = await pripravUcet(env2, { domain: 'strop2.sk' });
  for (const k of ['email:E0', 'email:E2', 'email:E3', 'email:E4']) await zaznamenaj(env2, t2.id, 'email', k, { stav: 'odoslany' });
  assert.equal((await posliEmail(env2, t2, 'E1', { now: PONDELOK_10 })).dovod, 'strop');

  // E4 na platenom pláne nie.
  const env3 = makeEnv();
  const t3 = await pripravUcet(env3, { domain: 'plati.sk' });
  await posliEmail(env3, t3, 'E1', { now: PONDELOK_10 });
  env3.DB._tenants.get(t3.id).plan = 'starter';
  const r = await posliEmail(env3, await getTenantById(env3.DB, t3.id), 'E4', e4);
  assert.equal(r.dovod, 'plateny_plan');

  // E4 z chatu: prekročenie 80 % pošle E4 raz za život účtu, aj v ďalšom mesiaci nie.
  const env4 = makeEnv();
  const t4 = await pripravUcet(env4, { domain: 'limit.sk' });
  await posliEmail(env4, t4, 'E1', { now: PONDELOK_10 });
  await poRozhovore(env4, t4, { origin: 'https://limit.sk', quota: { counted: true, used: 80, quota: 100 }, now: PONDELOK_10 });
  await poRozhovore(env4, t4, { origin: 'https://limit.sk', quota: { counted: true, used: 80, quota: 100 }, now: new Date('2026-10-20T10:00:00Z') });
  const e4s = env4.odoslane.filter((o) => /80 zo 100/.test(o.body.subject));
  assert.equal(e4s.length, 1);
  assert.match(e4s[0].body.subject, /v septembri$/);
  assert.ok(await najdiU(env4, t4.id, 'limit_80:2026-09'));
  assert.ok(await najdiU(env4, t4.id, 'limit_80:2026-10'));
});

test('17. WordPress: zapojenie do 15 minút dá jeden spojený E1W so zapísaným E1 aj E2; bez zapojenia ide po 15 minútach samostatný E1', async () => {
  const env = makeEnv();
  const t = await createTenantFromRequest(env, { feedUrl: 'https://wp.sk/feed.xml', domain: 'wp.sk', email: 'a@wp.sk', lang: 'sk', zdroj: 'wordpress' });
  assert.equal(env.odoslane.length, 0); // WordPress čaká
  const tt = await getTenantById(env.DB, t.id);
  await poRozhovore(env, tt, { origin: 'https://wp.sk', surface: 'admin', quota: { counted: true, used: 1, quota: 100 } });
  assert.equal(env.odoslane.length, 1);
  assert.match(env.odoslane[0].body.subject, /je pripravený a už beží na vašom webe/);
  assert.match(env.odoslane[0].body.text, /Nastavenia nájdete vo WordPresse v časti WooCommerce, ARLing Shopping Assistant/);
  assert.equal((await najdiU(env, t.id, 'email:E1')).data.sablona, 'E1W');
  assert.equal((await najdiU(env, t.id, 'email:E2')).data.stav, 'spojeny');
  await dobeh(env, { now: new Date(Date.now() + 20 * 60 * 1000) });
  assert.equal(env.odoslane.length, 1);

  const env2 = makeEnv();
  const t2 = await createTenantFromRequest(env2, { feedUrl: 'https://wp2.sk/feed.xml', domain: 'wp2.sk', email: 'a@wp2.sk', lang: 'en', zdroj: 'wordpress' });
  await dobeh(env2, { now: new Date(Date.now() + 5 * 60 * 1000) });
  assert.equal(env2.odoslane.length, 0);
  await dobeh(env2, { now: new Date(Date.now() + 16 * 60 * 1000) });
  assert.equal(env2.odoslane.length, 1);
  assert.match(env2.odoslane[0].body.subject, /^Your assistant for wp2\.sk is ready: 2 products$/);
  assert.match(env2.odoslane[0].body.text, /There is nothing to paste/);
  assert.equal((await najdiU(env2, t2.id, 'email:E1')).data.sablona, 'E1');
});

test('18. E3: po 72 hodinách bez zapojenia áno; so zapojením nie; v sobotu nie; o 20:00 v Bratislave nie; po zastavení nie', async () => {
  const pripravE1 = async (domain) => {
    const env = makeEnv();
    const t = await pripravUcet(env, { domain });
    await posliEmail(env, t, 'E1', { now: PONDELOK_10 });
    return { env, t };
  };
  const stvrtok10 = new Date(PONDELOK_10.getTime() + 72 * HOD);
  assert.equal(jePracovnyCas(stvrtok10), true);

  let { env, t } = await pripravE1('e3.sk');
  await dobeh(env, { now: new Date(stvrtok10.getTime() - HOD) });
  assert.equal(env.odoslane.length, 1); // 71 hodín: ešte nie
  await dobeh(env, { now: stvrtok10 });
  assert.equal(env.odoslane.length, 2);
  assert.equal(env.odoslane[1].body.subject, 'Pomôžeme vám vložiť Asistenta na e3.sk?');
  await dobeh(env, { now: new Date(stvrtok10.getTime() + HOD) });
  assert.equal(env.odoslane.length, 2);

  ({ env, t } = await pripravE1('zapojeny.sk'));
  await zaznamenaj(env, t.id, 'zapojeny', 'zapojeny', {}, PONDELOK_10);
  await env.DB.prepare(ZC_SQL.SET_UDALOST_DATA).bind(JSON.stringify({ stav: 'spojeny' }), t.id, 'email:E2').run();
  await dobeh(env, { now: stvrtok10 });
  assert.ok(!env.odoslane.some((o) => /Pomôžeme/.test(o.body.subject)));

  ({ env } = await pripravE1('sobota.sk'));
  await dobeh(env, { now: new Date('2026-09-26T08:00:00Z') });
  assert.equal(env.odoslane.length, 1);

  ({ env } = await pripravE1('vecer.sk'));
  await dobeh(env, { now: new Date('2026-09-24T18:00:00Z') });
  assert.equal(env.odoslane.length, 1);

  ({ env, t } = await pripravE1('stop.sk'));
  await env.DB.prepare(ZC_SQL.SET_EMAILY_STOP).bind(PONDELOK_10.toISOString(), t.id).run();
  await dobeh(env, { now: stvrtok10 });
  assert.equal(env.odoslane.length, 1);
});

test('19. bez RESEND_API_KEY sa nič neposiela ani nezapisuje ako odoslané; bez UCET_TAJOMSTVO ide E1 bez stop odkazu a E2 nie; vypínač ASISTENT_EMAILY', async () => {
  const bez = makeEnv({ resendKluc: false });
  const t = await createTenantFromRequest(bez, { feedUrl: 'https://bezkluca.sk/feed.xml', domain: 'bezkluca.sk', email: 'a@bezkluca.sk', lang: 'sk', zdroj: 'formular' });
  assert.equal(bez.odoslane.length, 0);
  assert.equal((await emailRiadky(bez, t.id)).length, 0);
  assert.ok(await najdiU(bez, t.id, 'ready'));

  const vyp = makeEnv({ emaily: false });
  const tv = await createTenantFromRequest(vyp, { feedUrl: 'https://vypnute.sk/feed.xml', domain: 'vypnute.sk', email: 'a@vypnute.sk', lang: 'sk' });
  assert.equal(vyp.odoslane.length, 0);
  assert.equal((await emailRiadky(vyp, tv.id)).length, 0);

  const bezT = makeEnv({ tajomstvo: false });
  const t2 = await pripravUcet(bezT, { domain: 'beztajomstva.sk' });
  assert.equal((await posliEmail(bezT, t2, 'E1', { now: PONDELOK_10 })).poslane, true);
  const o = bezT.odoslane[0];
  assert.equal(o.body.headers['List-Unsubscribe'], undefined);
  assert.ok(!o.body.text.includes('/emaily/stop'));
  assert.ok(!/pošleme vám krátke potvrdenie/.test(o.body.text)); // nič nesľubujeme
  assert.match(o.body.text, /Ďalšie voliteľné správy k tomuto Asistentovi posielať nebudeme/);
  await zaznamenaj(bezT, t2.id, 'zapojeny', 'zapojeny', {}, PONDELOK_10);
  assert.equal((await posliEmail(bezT, t2, 'E2', { now: PONDELOK_10 })).dovod, 'bez_tajomstva');
});

test('20. demo obchod a adresa @arling.sk mimo TEST_EMAILS: žiadny e-mail, žiadny ping', async () => {
  const env = makeEnv();
  const demo = await createTenantFromRequest(env, { feedUrl: 'https://arling.sk/asistent/ukazka/feed.xml', domain: 'ukazka.arling.sk', email: 'a@gmail.com', lang: 'sk' });
  assert.equal(env.odoslane.length, 0);
  assert.equal(env.pingy.length, 0);
  assert.equal((await udalostiTenanta(env.DB, demo.id)).length, 0);

  const nas = makeEnv();
  await createTenantFromRequest(nas, { feedUrl: 'https://skuska.sk/feed.xml', domain: 'skuska.sk', email: 'andrej@arling.sk', lang: 'sk', overenyEmail: 'andrej@arling.sk' });
  assert.equal(nas.odoslane.length, 0);
  const povoleny = makeEnv({ extra: { TEST_EMAILS: 'andrej@arling.sk' } });
  await createTenantFromRequest(povoleny, { feedUrl: 'https://skuska2.sk/feed.xml', domain: 'skuska2.sk', email: 'andrej@arling.sk', lang: 'sk', overenyEmail: 'andrej@arling.sk' });
  assert.equal(povoleny.odoslane.length, 1);
});

test('21. strop 3 e-maily E0 alebo E1 na jednu adresu za deň naprieč obchodmi', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 4; i++) {
    await createTenantFromRequest(env, { feedUrl: `https://obchod${i}.sk/feed.xml`, domain: `obchod${i}.sk`, email: 'ta.ista@adresa.sk', lang: 'sk', overenyEmail: 'ta.ista@adresa.sk' });
  }
  assert.equal(env.odoslane.length, 3);
});

// ---------------------------------------------------------------------------
// Zastavenie (22)
// ---------------------------------------------------------------------------

test('22. stop: GET so správnym podpisom nič nemení a hovorí jazykom účtu; POST zastaví; zlý alebo cudzí podpis 403; bez tajomstva 503', async () => {
  const env = makeEnv();
  const t = await pripravUcet(env, { domain: 'stop.cz', jazyk: 'cs' });
  const iny = await pripravUcet(env, { domain: 'iny.sk' });
  const odkaz = await odkazStop(env, t.id);
  assert.ok(odkaz.startsWith(`https://arling-asistent.arling.workers.dev/v1/tenants/${t.id}/emaily/stop?k=`));

  const g = await worker.fetch(new Request(odkaz), env, {});
  assert.equal(g.status, 200);
  const html = await g.text();
  assert.match(html, /Zastavit e-maily/);
  assert.match(html, /method="post"/);
  assert.equal(env.DB._tenants.get(t.id).emaily_stop_at, null);

  const p = await worker.fetch(new Request(odkaz, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env, {});
  assert.equal(p.status, 200);
  assert.ok(env.DB._tenants.get(t.id).emaily_stop_at);
  assert.ok(await najdiU(env, t.id, 'emaily_stop'));
  assert.equal(env.pingy.filter((x) => x.url.searchParams.get('e') === 'asistent_stop').length, 1);
  await worker.fetch(new Request(odkaz, { method: 'POST' }), env, {});
  assert.equal(env.pingy.filter((x) => x.url.searchParams.get('e') === 'asistent_stop').length, 1);

  const zly = await worker.fetch(new Request(`https://x/v1/tenants/${t.id}/emaily/stop?k=zly`, { method: 'POST' }), env, {});
  assert.equal(zly.status, 403);
  const cudzi = await worker.fetch(new Request(`https://x/v1/tenants/${iny.id}/emaily/stop?k=${await podpisStop(env, t.id)}`, { method: 'POST' }), env, {});
  assert.equal(cudzi.status, 403);
  assert.equal(env.DB._tenants.get(iny.id).emaily_stop_at, null);

  const bez = makeEnv({ tajomstvo: false });
  assert.equal((await worker.fetch(new Request(`https://x/v1/tenants/${t.id}/emaily/stop?k=x`), bez, {})).status, 503);
});

// ---------------------------------------------------------------------------
// ntfy (23)
// ---------------------------------------------------------------------------

test('23. ping nesie presné e, doménu s bodkami v t a X-Ping-Token; chyba pingu nič nezhodí; titulky hovoria „(nie platba)“; vypínač ASISTENT_NTFY', async () => {
  const env = makeEnv();
  assert.equal(await pingni(env, 'asistent_zapojeny', { domena: 'www.ludovka.eu', p: 'widget_js' }), true);
  const p = env.pingy[0];
  assert.equal(p.url.origin + p.url.pathname, 'https://homelab.tailbf8f27.ts.net/subscribe/api/ping');
  assert.equal(p.url.searchParams.get('e'), 'asistent_zapojeny');
  assert.equal(p.url.searchParams.get('t'), 'www.ludovka.eu');
  assert.equal(p.opts.headers['X-Ping-Token'], 'ping-tajne');

  const padajuci = makeEnv({ extra: { fetchImpl: async () => { throw new Error('homelab down'); } } });
  assert.equal(await pingni(padajuci, 'asistent_novy', { domena: 'a.sk' }), false);
  const vyp = makeEnv({ ntfy: false });
  assert.equal(await pingni(vyp, 'asistent_novy', { domena: 'a.sk' }), false);
  assert.equal(vyp.pingy.length, 0);

  for (const [e, titulok] of Object.entries(NTFY_TITULKY)) {
    assert.match(titulok, /\(nie platba\)$/, e);
    assert.ok(!/platba:|PLATBA|zaplat/i.test(titulok.replace('(nie platba)', '')), e);
  }

  // Padajúci homelab nezhodí ani celý chat.
  const chatEnv = makeEnv({ emaily: false });
  const t = await pripravUcet(chatEnv, { domain: 'ping.sk' });
  await chatEnv.VECTORIZE.upsert([{ id: `${t.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: t.id, productId: 'p1', title: 'Test', url: 'https://ping.sk/p/1', availability: 'in_stock' } }]);
  chatEnv.fetchImpl = async () => { throw new Error('homelab down'); };
  const res = await worker.fetch(new Request('https://x/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://ping.sk' },
    body: JSON.stringify({ tenant: t.id, messages: [{ role: 'user', content: 'Máte test?' }], lang: 'sk', session: 'aaaaaaaaaaaaaaaa' }),
  }), chatEnv, {});
  assert.equal(res.status, 200);
  assert.ok(await najdiU(chatEnv, t.id, 'zapojeny'));
});

// ---------------------------------------------------------------------------
// Admin cesty (24, 27, 28) a ostatné
// ---------------------------------------------------------------------------

// Zápisové cesty (doplnit, uvitaci-email, DELETE) majú vlastné tajomstvo ASISTENT_ADMIN_ZAPIS.
const jeZapisovaCesta = (cesta, method) => method === 'DELETE' || /\/(doplnit|uvitaci-email)/.test(cesta);
function adminReq(cesta, { method = 'GET', token, body } = {}) {
  const t = token === undefined ? (jeZapisovaCesta(cesta, method) ? ZAPIS : ADMIN) : token;
  const headers = t ? { 'X-Admin-Token': t } : {};
  return new Request(`https://arling-asistent.arling.workers.dev${cesta}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

test('24. GET /v1/admin/asistent/udalosti: bez tokenu 401, bez ADMIN_TOKEN 401, kurzor, limit najviac 500, demo chýba, contact_email len tu', async () => {
  const env = makeEnv({ emaily: false });
  const a = await pripravUcet(env, { domain: 'a.sk', email: 'majitel@a.sk' });
  const demo = await createTenant(env.DB, { domain: 'ukazka.arling.sk', feedUrl: 'https://arling.sk/f.xml', contactEmail: 'demo@x.sk' });
  await zaznamenaj(env, demo.id, 'ready', 'ready', {});
  await zaznamenaj(env, a.id, 'zapojeny', 'zapojeny', { signal: 'chat' });

  assert.equal((await worker.fetch(adminReq('/v1/admin/asistent/udalosti', { token: null }), env, {})).status, 401);
  assert.equal((await worker.fetch(adminReq('/v1/admin/asistent/udalosti', { token: 'zly' }), env, {})).status, 401);
  const bezTokenu = { ...env, ADMIN_TOKEN: undefined };
  assert.equal((await worker.fetch(adminReq('/v1/admin/asistent/udalosti', { token: '' }), bezTokenu, {})).status, 401);

  const r = await (await worker.fetch(adminReq('/v1/admin/asistent/udalosti?po=0&limit=2'), env, {})).json();
  assert.equal(r.udalosti.length, 2); // vytvoreny, ready obchodu a.sk (demo vynechané)
  assert.ok(r.udalosti.every((u) => u.tenant_id === a.id));
  assert.equal(r.tenanti[a.id].contact_email, 'majitel@a.sk');
  assert.equal(r.tenanti[a.id].jazyk, 'sk');
  assert.equal(r.tenanti[demo.id], undefined);
  assert.ok(r.dalsi);
  const r2 = await (await worker.fetch(adminReq(`/v1/admin/asistent/udalosti?po=${r.dalsi}&limit=9999`), env, {})).json();
  assert.deepEqual(r2.udalosti.map((u) => u.typ), ['zapojeny']);
  assert.equal(r2.dalsi, null);
  assert.ok(r2.posledne_id > r.dalsi);

  const status = await (await worker.fetch(new Request(`https://x/v1/tenants/${a.id}/status`), env, {})).text();
  assert.ok(!status.includes('majitel@a.sk'));
});

test('27. POST /v1/admin/asistent/doplnit vloží vytvoreny a ready s pôvodnými časmi, bez e-mailu a pingu; druhé spustenie nič nepridá', async () => {
  const env = makeEnv();
  const stary = await createTenant(env.DB, { domain: 'www.ludovka.eu', feedUrl: 'https://www.ludovka.eu/heureka/export/products.xml', contactEmail: 'info@ludovka.eu' }, { now: new Date('2026-09-25T07:00:00Z') });
  await setTenantStatus(env.DB, stary.id, 'ready', { now: new Date('2026-09-25T07:03:00Z') });
  const r = await (await worker.fetch(adminReq('/v1/admin/asistent/doplnit', { method: 'POST' }), env, {})).json();
  assert.deepEqual(r, { vytvoreny: 1, ready: 1, spracovane: 1, dalsi: null });
  assert.equal((await najdiU(env, stary.id, 'vytvoreny')).kedy, '2026-09-25T07:00:00.000Z');
  assert.equal((await najdiU(env, stary.id, 'ready')).kedy, '2026-09-25T07:03:00.000Z');
  assert.equal((await najdiU(env, stary.id, 'ready')).data.spatne, true);
  const r2 = await (await worker.fetch(adminReq('/v1/admin/asistent/doplnit', { method: 'POST' }), env, {})).json();
  assert.deepEqual(r2, { vytvoreny: 0, ready: 0, spracovane: 1, dalsi: null });
  assert.equal(env.odoslane.length, 0);
  assert.equal(env.pingy.length, 0);
  // Ani dobeh starému účtu sám nič nepošle.
  await dobeh(env, { now: new Date('2026-09-28T08:00:00Z') });
  assert.equal(env.odoslane.length, 0);
  assert.equal((await worker.fetch(adminReq('/v1/admin/asistent/doplnit', { method: 'POST', token: null }), env, {})).status, 401);
  // ADMIN_TOKEN (pozná ho aj licence-service a CRM) na zápis nestačí; bez ASISTENT_ADMIN_ZAPIS je cesta zatvorená.
  assert.equal((await worker.fetch(adminReq('/v1/admin/asistent/doplnit', { method: 'POST', token: ADMIN }), env, {})).status, 401);
  assert.equal((await worker.fetch(adminReq('/v1/admin/asistent/doplnit', { method: 'POST' }), { ...env, ASISTENT_ADMIN_ZAPIS: undefined }, {})).status, 503);
});

test('27b. doplnit po dávkach: limit a kurzor po, žiadna dávka nepresiahne limit', async () => {
  const env = makeEnv({ emaily: false });
  for (let i = 0; i < 5; i++) await createTenant(env.DB, { domain: `davka${i}.sk`, feedUrl: `https://davka${i}.sk/f.xml`, contactEmail: `a@davka${i}.sk` });
  const a = await (await worker.fetch(adminReq('/v1/admin/asistent/doplnit?limit=2', { method: 'POST' }), env, {})).json();
  assert.deepEqual([a.vytvoreny, a.spracovane, a.dalsi], [2, 2, 2]);
  const b = await (await worker.fetch(adminReq('/v1/admin/asistent/doplnit?limit=2&po=2', { method: 'POST' }), env, {})).json();
  const c = await (await worker.fetch(adminReq(`/v1/admin/asistent/doplnit?limit=2&po=${b.dalsi}`, { method: 'POST' }), env, {})).json();
  assert.deepEqual([b.vytvoreny, c.vytvoreny, c.dalsi], [2, 1, null]);
  assert.equal(env.DB._udalosti.filter((u) => u.typ === 'vytvoreny').length, 5);
});

test('28. POST /v1/admin/asistent/uvitaci-email pošle E1 v zadanom jazyku raz, s návodom Shoptet a anglickou vetou; druhé volanie uz_odoslany', async () => {
  const env = makeEnv();
  const stary = await createTenant(env.DB, { domain: 'www.ludovka.eu', feedUrl: 'https://www.ludovka.eu/export/feed.xml', contactEmail: 'info@ludovka.eu' });
  await setTenantStatus(env.DB, stary.id, 'ready');
  env.DB._tenants.get(stary.id).product_count = 253;
  await worker.fetch(adminReq('/v1/admin/asistent/doplnit', { method: 'POST' }), env, {});
  const telo = { tenant_id: stary.id, jazyk: 'sk', anglicka_veta: true, platforma: 'shoptet' };
  const r = await worker.fetch(adminReq('/v1/admin/asistent/uvitaci-email', { method: 'POST', body: telo }), env, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.poslane, true);
  assert.equal(j.jazyk, 'sk');
  assert.equal(env.odoslane.length, 1);
  assert.equal(env.odoslane[0].body.subject, 'Asistent pre www.ludovka.eu je pripravený: 253 produktov');
  assert.match(env.odoslane[0].body.text, /Vzhľad a obsah, Editor, HTML kód, časť Pätička/);
  assert.match(env.odoslane[0].body.text, /Prefer English\?/);
  assert.equal(env.DB._tenants.get(stary.id).jazyk, 'sk');
  const r2 = await (await worker.fetch(adminReq('/v1/admin/asistent/uvitaci-email', { method: 'POST', body: telo }), env, {})).json();
  assert.equal(r2.uz_odoslany, true);
  assert.equal(env.odoslane.length, 1);
  assert.equal((await worker.fetch(adminReq('/v1/admin/asistent/uvitaci-email', { method: 'POST', body: telo, token: null }), env, {})).status, 401);

  // Po ručnom E1 už bežia aj voliteľné: zapojenie pošle E2.
  await poWidgetJs(env, widgetReq('https://www.ludovka.eu/'));
  assert.equal(env.odoslane.length, 2);
  assert.equal(env.odoslane[1].body.subject, 'Asistent už beží na www.ludovka.eu');
});

test('28b. ľudovka: ručne poslaný uvítací e-mail sa len zapíše (žiadny Resend), E1 sa nezopakuje, E3 nepríde, zapojenie pošle E2; návod Eshop-rychle', async () => {
  const env = makeEnv();
  const stary = await createTenant(env.DB, { domain: 'www.ludovka.eu', feedUrl: 'https://www.ludovka.eu/export/heureka.xml', contactEmail: 'info@ludovka.eu' });
  await setTenantStatus(env.DB, stary.id, 'ready');
  env.DB._tenants.get(stary.id).product_count = 253;
  await worker.fetch(adminReq('/v1/admin/asistent/doplnit', { method: 'POST' }), env, {});

  // Zlý čas: 400, nič sa nezapíše.
  const zle = await worker.fetch(adminReq('/v1/admin/asistent/uvitaci-email', { method: 'POST', body: { tenant_id: stary.id, rucne_odoslany: { odoslane_at: 'vcera' } } }), env, {});
  assert.equal(zle.status, 400);
  assert.equal(await najdiU(env, stary.id, 'email:E1'), null);

  const telo = { tenant_id: stary.id, jazyk: 'sk', rucne_odoslany: { odoslane_at: '2026-09-25T11:12:00Z', resend_id: '01a0d844-aec4-77ba-8fb4-507ef11cbd38', poznamka: 'ručne, návod Eshop rýchlo' } };
  const r = await worker.fetch(adminReq('/v1/admin/asistent/uvitaci-email', { method: 'POST', body: telo }), env, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.zapisane, true);
  assert.equal(j.poslane, false);
  assert.equal(env.odoslane.length, 0, 'ručne poslaný e-mail sa znova neposiela');
  const e1 = await najdiU(env, stary.id, 'email:E1');
  assert.equal(e1.data.stav, 'odoslany');
  assert.equal(e1.data.rucne, true);
  assert.equal(e1.kedy, '2026-09-25T11:12:00.000Z');
  assert.equal(env.DB._tenants.get(stary.id).jazyk, 'sk');

  // Druhé volanie (aj bez rucne_odoslany) nič nepošle.
  const r2 = await (await worker.fetch(adminReq('/v1/admin/asistent/uvitaci-email', { method: 'POST', body: { tenant_id: stary.id } }), env, {})).json();
  assert.equal(r2.uz_odoslany, true);
  assert.equal(env.odoslane.length, 0);

  // Pondelok 28. 9. 2026 10:00 v Bratislave: 72 hodín od ručného e-mailu, pracovný čas, bez zapojenia. E3 nie.
  await dobeh(env, { now: new Date('2026-09-28T08:00:00Z') });
  assert.equal(env.odoslane.length, 0, 'po osobnej pomoci žiadna pripomienka');

  // Zapojenie na webe pošle E2 slovensky.
  await poWidgetJs(env, widgetReq('https://www.ludovka.eu/'), { now: new Date('2026-09-28T09:00:00Z') });
  assert.equal(env.odoslane.length, 1);
  assert.equal(env.odoslane[0].body.subject, 'Asistent už beží na www.ludovka.eu');
  assert.ok(env.odoslane[0].body.headers['List-Unsubscribe']);

  // Návod Eshop-rychle: explicitne aj podľa adresy feedu.
  const e = vytvorEmail('E1', 'sk', parametre({ platforma: 'eshoprychle' }));
  assert.match(e.text, /E-shop, Meracie kódy \(v českej administrácii Měřící kódy\), pridajte vlastný kód s umiestnením Pätička/);
  assert.match(e.text, /data-position="left"/);
  assert.match(vytvorEmail('E3', 'cs', parametre({ platforma: 'eshoprychle' })).text, /E-shop, Měřící kódy/);
  const { platformaUctu } = await import('../worker/src/zivotny-cyklus.js');
  assert.equal(platformaUctu({ feed_url: 'https://www.eshop-rychle.cz/export/obchod/heureka.xml' }, []), 'eshoprychle');
  assert.equal(platformaUctu({ feed_url: 'https://obchod.sk/heureka.xml' }, [{ kluc: 'ready', data: { feed_type: 'heureka' } }]), 'heureka');
  // Ľudovkin skutočný feed (Eshop rýchlo, ops/asistent/integracie/PLAN-INTEGRACII.md:68) aj s typom heureka.
  assert.equal(platformaUctu({ feed_url: 'https://www.ludovka.eu/fotky40717/xml/heureka_sk.xml' }, [{ kluc: 'ready', data: { feed_type: 'heureka' } }]), 'eshoprychle');
  // Shoptet sa rozpozná ako shoptet, nie ako všeobecný zoznam štyroch platforiem.
  assert.equal(platformaUctu({ feed_url: 'https://obchod.myshoptet.com/export/productsComplete.xml' }, [{ kluc: 'ready', data: { feed_type: 'heureka' } }]), 'shoptet');
  // Heureka blok spomína aj Eshop rýchlo a má nadpis pred zoznamom platforiem.
  const heur = vytvorEmail('E1', 'sk', parametre({ platforma: 'heureka' }));
  assert.match(heur.text, /Eshop rýchlo \(Eshop-rychle\): E-shop, Meracie kódy/);
  assert.match(heur.html, /<strong>Kde to nájdete podľa platformy:<\/strong>/);
});

test('plán a zrušenie: PATCH /plan zapíše plan, pád z plateného na free aj zruseny s pingom; licence-service cesta /udalost; DELETE zmaže účet', async () => {
  const env = makeEnv({ emaily: false });
  const t = await pripravUcet(env, { domain: 'platiaci.sk' });
  const patch = (body) => handleSetPlanRoute(new Request('https://x/', { method: 'PATCH', headers: { 'X-Admin-Token': ADMIN }, body: JSON.stringify(body) }), env, t.id);
  await patch({ plan: 'starter', billing_ref: 'sub_123', valid_until: '2026-10-25' });
  assert.ok(await najdiU(env, t.id, 'plan:starter:sub_123'));
  await patch({ plan: 'free' });
  const z = await najdiU(env, t.id, 'zruseny:sub_123');
  assert.equal(z.data.plati_do, '2026-10-25');
  assert.equal(env.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_zruseny').length, 1);

  const u = await worker.fetch(adminReq(`/v1/tenants/${t.id}/udalost`, { method: 'POST', body: { typ: 'zruseny', billing_ref: 'sub_123', plati_do: '2026-10-25' } }), env, {});
  assert.deepEqual(await u.json(), { nove: false }); // už zapísané z /plan
  assert.equal((await worker.fetch(adminReq(`/v1/tenants/${t.id}/udalost`, { method: 'POST', body: { typ: 'iny' } }), env, {})).status, 400);

  await env.VECTORIZE.upsert([{ id: `${t.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: t.id } }, { id: 'iny::p1::0', values: [1, 0, 0, 0], metadata: { tenant: 'iny' } }]);
  assert.equal((await worker.fetch(adminReq(`/v1/tenants/${t.id}?potvrd=platiaci.sk`, { method: 'DELETE', token: null }), env, {})).status, 401);
  // ADMIN_TOKEN nestačí, bez potvrdenia domény 400.
  assert.equal((await worker.fetch(adminReq(`/v1/tenants/${t.id}?potvrd=platiaci.sk`, { method: 'DELETE', token: ADMIN }), env, {})).status, 401);
  assert.equal((await worker.fetch(adminReq(`/v1/tenants/${t.id}`, { method: 'DELETE' }), env, {})).status, 400);
  assert.equal((await worker.fetch(adminReq(`/v1/tenants/${t.id}?potvrd=iny.sk`, { method: 'DELETE' }), env, {})).status, 400);
  const d = await (await worker.fetch(adminReq(`/v1/tenants/${t.id}?potvrd=platiaci.sk`, { method: 'DELETE' }), env, {})).json();
  assert.equal(d.zmazany, true);
  assert.equal(d.vektory, 1);
  assert.equal(env.DB._tenants.has(t.id), false);
  assert.equal(env.DB._udalosti.filter((x) => x.tenant_id === t.id).length, 0);
  assert.ok(env.VECTORIZE._store.has('iny::p1::0'));
  // Záznam o výmaze (bez osobných údajov) ide do /udalosti pre CRM.
  const r = await (await worker.fetch(adminReq('/v1/admin/asistent/udalosti'), env, {})).json();
  assert.deepEqual(r.zmazane.map((x) => x.tenant_id), [t.id]);
  assert.deepEqual(Object.keys(r.zmazane[0]).sort(), ['kedy', 'tenant_id']);
});

test('výmaz: vektory podľa zoznamu z KV aj tie, ktoré dopyt ešte vracia; asynchrónny index nezacyklí slučku', async () => {
  const env = makeEnv({ emaily: false });
  const t = await createTenantFromRequest(env, { feedUrl: 'https://vektory.sk/feed.xml', domain: 'vektory.sk', email: 'a@vektory.sk', lang: 'sk' });
  const ulozene = JSON.parse(env.ASISTENT_CACHE._store.get(`vektory:${t.id}`));
  assert.ok(ulozene.length >= 2 && ulozene.every((id) => id.startsWith(`${t.id}::`)));
  // Starý vektor, ktorý v zozname nie je (produkt medzitým zmizol z feedu).
  await env.VECTORIZE.upsert([{ id: `${t.id}::stary::0`, values: [1, 0, 0, 0], metadata: { tenant: t.id } }]);
  // Index ako ostrý Vectorize: deleteByIds je asynchrónne, dopyt ešte vracia zmazané id.
  const zmazaneIds = new Set();
  const povodnyQuery = env.VECTORIZE.query.bind(env.VECTORIZE);
  let dopytov = 0;
  env.VECTORIZE.deleteByIds = async (ids) => { ids.forEach((id) => zmazaneIds.add(id)); return { count: ids.length }; };
  env.VECTORIZE.query = async (...a) => { dopytov += 1; return povodnyQuery(...a); };
  const r = await worker.fetch(adminReq(`/v1/tenants/${t.id}?potvrd=vektory.sk`, { method: 'DELETE' }), env, {});
  const j = await r.json();
  assert.equal(j.vektory, ulozene.length + 1);
  assert.ok(zmazaneIds.has(`${t.id}::stary::0`));
  assert.ok(dopytov <= 2, `dopytov ${dopytov}`);
  assert.equal(env.ASISTENT_CACHE._store.has(`vektory:${t.id}`), false);
});

test('cron: */10 spustí dobeh, 0 3 obnovu feedov; denná údržba maže staré udalosti a účty len so zapnutým ASISTENT_MAZANIE', async () => {
  const env = makeEnv({ emaily: false });
  // Udalosti v čase behu: dobeh číta len účty s udalosťou za posledných 11 dní.
  const t = await pripravUcet(env, { domain: 'cron.sk', now: new Date() });
  const bg = [];
  await cronHandler.scheduled({ cron: '*/10 * * * *' }, env, { waitUntil: (p) => bg.push(p) });
  const prehlad = await bg[0];
  assert.equal(prehlad.tenanty, 1);
  await cronHandler.scheduled({ cron: '0 3 * * *' }, env, { waitUntil: (p) => bg.push(p) });
  const outcomes = await bg[1];
  assert.equal(outcomes[0].tenantId, t.id);

  const now = new Date('2028-10-01T00:00:00Z');
  await zaznamenaj(env, t.id, 'plan', 'plan:stary', {}, now, '2026-01-01T00:00:00Z');
  const u1 = await dennaUdrzba(env, { now });
  assert.ok(u1.stare_udalosti >= 1);
  assert.deepEqual(u1.zmazane_ucty, []);
  assert.ok(env.DB._tenants.has(t.id));
  env.ASISTENT_MAZANIE = 'zapnute';
  const u2 = await dennaUdrzba(env, { now });
  assert.deepEqual(u2.zmazane_ucty, [t.id]);
});

// ---------------------------------------------------------------------------
// Adverzárna kontrola 25. 9. 2026: overenie adresy, stropy, zastavenie,
// phishing v E0, Resend 409, falošné zapojenie, limity D1
// ---------------------------------------------------------------------------

/** Bearer token z /v1/ucet/over pre `email` (ako po zadaní 6-miestneho kódu). */
async function tokenPre(env, email) {
  const { vytvorToken } = await import('../worker/src/ucet.js');
  await env.ASISTENT_CACHE.put(`ucet:ucet:${email}`, JSON.stringify({ email, vytvorene: new Date().toISOString(), verzia: 1, nakupy: [], predplatne: [] }));
  return vytvorToken(env, { email, verzia: 1 });
}

function tenantReq(body, { ip = '203.0.113.1', token } = {}) {
  return new Request('https://arling-asistent.arling.workers.dev/v1/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: 'https://arling.sk', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('A1. útok: 50 účtov s rotáciou IP, subdoménami a feedom 404 na cudzie adresy nevyrobí žiadny e-mail', async () => {
  const env = makeEnv({ feedOk: false });
  env.fetchImpl = ((povodny) => async (url, opts) => (String(url).includes('zly.sk') ? { ok: false, status: 404, text: async () => '' } : povodny(url, opts)))(env.fetchImpl);
  for (let i = 0; i < 50; i++) {
    const r = await worker.fetch(tenantReq({ feed_url: `https://a${i}.zly.sk/feed.xml`, domain: `a${i}.zly.sk`, email: `obet${i % 5}@firma-obete.sk`, lang: 'sk', zdroj: 'formular' }, { ip: `198.51.100.${i}` }), env, {});
    assert.equal(r.status, 201, `účet ${i}`);
  }
  for (const min of [11, 30, 60 * 24]) await dobeh(env, { now: new Date(Date.now() + min * 60 * 1000) });
  assert.equal(env.odoslane.length, 0, 'neoverená adresa nedostane E0 ani nič iné');
  // Pingy „nový účet“ za neoverené účty majú vlastný denný strop.
  assert.ok(env.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_novy').length <= 20);
  assert.equal(env.DB._udalosti.filter((u) => u.typ === 'email').length, 0);
});

test('A2. globálny denný strop: 50 overených účtov dá najviac 30 e-mailov a jeden ping o strope', async () => {
  const env = makeEnv();
  for (let i = 0; i < 50; i++) {
    const email = `majitel${i}@obchod${i}.sk`;
    await createTenantFromRequest(env, { feedUrl: `https://obchod${i}.sk/feed.xml`, domain: `obchod${i}.sk`, email, lang: 'sk', overenyEmail: email });
  }
  assert.equal(env.odoslane.length, 30);
  await dobeh(env, { now: new Date(Date.now() + 15 * 60 * 1000) });
  assert.equal(env.odoslane.length, 30, 'dobeh v ten istý deň nad strop nič nepošle');
  assert.equal(env.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_strop').length, 1);
  // Ručný e-mail cez admin cestu strop neobmedzuje (Andrej ho posiela vedome).
  const zvysny = [...env.DB._tenants.values()].find((t) => !env.DB._udalosti.some((u) => u.tenant_id === t.id && u.kluc === 'email:E1'));
  const r = await worker.fetch(adminReq('/v1/admin/asistent/uvitaci-email', { method: 'POST', body: { tenant_id: zvysny.id } }), env, {});
  assert.equal(r.status, 200);
  assert.equal(env.odoslane.length, 31);
});

test('A3. zhoda domén: firemná adresa a feed na doméne obchodu stačí na E1, nie na E0; gmail, cudzí feed a nárokovaná verejná doména nie', async () => {
  const env = makeEnv();
  const ok = await createTenantFromRequest(env, { feedUrl: 'https://www.zhoda.sk/feed.xml', domain: 'www.zhoda.sk', email: 'info@zhoda.sk', lang: 'sk' });
  assert.equal(env.odoslane.length, 1);
  assert.deepEqual(env.odoslane[0].body.to, ['info@zhoda.sk']);
  assert.ok(ok.id);
  const pripady = [
    { feedUrl: 'https://gmailovy.sk/feed.xml', domain: 'gmailovy.sk', email: 'majitel@gmail.com' },
    { feedUrl: 'https://utocnik.example/feed.xml', domain: 'obet.sk', email: 'info@obet.sk' },
    { feedUrl: 'https://gmail.com/feed.xml', domain: 'gmail.com', email: 'obet@gmail.com' },
    { feedUrl: 'https://x.gmail.com/feed.xml', domain: 'x.gmail.com', email: 'obet@gmail.com' },
  ];
  for (const p of pripady) await createTenantFromRequest(env, { ...p, lang: 'sk' });
  assert.equal(env.odoslane.length, 1, 'žiadny ďalší e-mail');
  // E0 pri zhode domén nie (E0 ide aj bez feedu).
  const e0 = makeEnv({ feedOk: false });
  const t = await createTenantFromRequest(e0, { feedUrl: 'https://chyba-zhoda.sk/feed.xml', domain: 'chyba-zhoda.sk', email: 'info@chyba-zhoda.sk', lang: 'sk' });
  await dobeh(e0, { now: new Date(Date.now() + 11 * 60 * 1000) });
  assert.equal(e0.odoslane.length, 0);
  assert.equal((await posliEmail(e0, await getTenantById(e0.DB, t.id), 'E0', { params: { chyba_kod: 'feed_http_500' } })).dovod, 'neovereny');
});

test('A4. overenie kódom: POST /v1/tenants s Bearer overí hneď; POST /overenie neskôr pošle E1; cudzí token 403, bez tokenu 401', async () => {
  const env = makeEnv();
  const token = await tokenPre(env, 'majitel@gmail.com');
  const r = await worker.fetch(tenantReq({ feed_url: 'https://overeny.sk/feed.xml', domain: 'overeny.sk', email: 'Majitel@gmail.com', lang: 'sk', zdroj: 'formular' }, { token }), env, {});
  assert.equal(r.status, 201);
  assert.equal(env.odoslane.length, 1, 'overená gmail adresa dostane E1');
  const id1 = (await r.json()).id;
  assert.equal((await najdiU(env, id1, 'vytvoreny')).data.overeny, true);

  // Bez tokenu: účet vznikne, e-mail nie; overenie neskôr pošle E1 hneď.
  const r2 = await worker.fetch(tenantReq({ feed_url: 'https://neskor-overeny.sk/feed.xml', domain: 'neskor-overeny.sk', email: 'druhy@gmail.com', lang: 'sk' }), env, {});
  const id2 = (await r2.json()).id;
  assert.equal(env.odoslane.length, 1);
  const overenie = (tok) => worker.fetch(new Request(`https://x/v1/tenants/${id2}/overenie`, { method: 'POST', headers: { Origin: 'https://arling.sk', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) } }), env, {});
  assert.equal((await overenie(null)).status, 401);
  assert.equal((await overenie(token)).status, 403, 'token inej adresy');
  const ok = await overenie(await tokenPre(env, 'druhy@gmail.com'));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk');
  assert.equal(env.odoslane.length, 2);
  assert.deepEqual(env.odoslane[1].body.to, ['druhy@gmail.com']);
  assert.ok(await najdiU(env, id2, 'overeny'));
  // Druhé overenie nič nepošle.
  await overenie(await tokenPre(env, 'druhy@gmail.com'));
  assert.equal(env.odoslane.length, 2);
});

test('A5. zastavenie zastaví aj E1 a E0; ručná cesta tiež; opakovanie zlyhaného e-mailu po zastavení nejde', async () => {
  const env = makeEnv();
  const t = await pripravUcet(env, { domain: 'zastaveny.sk', status: 'error' });
  await env.DB.prepare(ZC_SQL.SET_EMAILY_STOP).bind(PONDELOK_10.toISOString(), t.id).run();
  const tt = await getTenantById(env.DB, t.id);
  assert.equal((await posliEmail(env, tt, 'E0', { now: PONDELOK_10 })).dovod, 'zastavene');
  await setTenantStatus(env.DB, t.id, 'ready');
  await zaznamenaj(env, t.id, 'ready', 'ready', { product_count: 3 }, PONDELOK_10);
  const t2 = await getTenantById(env.DB, t.id);
  assert.equal((await posliEmail(env, t2, 'E1', { now: PONDELOK_10 })).dovod, 'zastavene');
  assert.equal((await posliEmail(env, t2, 'E1', { now: PONDELOK_10, rucne: true })).dovod, 'zastavene');
  assert.equal(env.odoslane.length, 0);

  // Zlyhaný E1, potom zastavenie: cron ho už nezopakuje.
  const env2 = makeEnv({ resend: 503 });
  const t3 = await pripravUcet(env2, { domain: 'padol.sk' });
  await posliEmail(env2, t3, 'E1', { now: PONDELOK_10 });
  await env2.DB.prepare(ZC_SQL.SET_EMAILY_STOP).bind(PONDELOK_10.toISOString(), t3.id).run();
  await dobeh(env2, { now: new Date(PONDELOK_10.getTime() + 20 * 60 * 1000) });
  assert.equal(env2.odoslane.length, 1);
});

test('A6. „nevytváral som“: adresa sa potlačí pre všetky účty, ping bez slova platba, stránka má obe tlačidlá', async () => {
  const env = makeEnv();
  const t = await pripravUcet(env, { domain: 'cudzi.sk', email: 'obet@firma.sk' });
  const odkaz = await odkazStop(env, t.id);
  const html = await (await worker.fetch(new Request(odkaz), env, {})).text();
  assert.match(html, /Tohto Asistenta som nevytváral/);
  assert.match(html, /name="akcia" value="nevytvaral"/);
  const p = await worker.fetch(new Request(odkaz, { method: 'POST', body: 'akcia=nevytvaral', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env, {});
  assert.equal(p.status, 200);
  assert.match(await p.text(), /už nepošleme žiadny e-mail k žiadnemu Asistentovi/);
  assert.equal(env.DB._potlacene.size, 1);
  assert.ok(![...env.DB._potlacene.keys()][0].includes('obet'), 'ukladá sa hash, nie adresa');
  const ping = env.pingy.filter((x) => x.url.searchParams.get('e') === 'asistent_odmietnuty');
  assert.equal(ping.length, 1);
  assert.match(NTFY_TITULKY.asistent_odmietnuty, /\(nie platba\)$/);
  // Iný účet s tou istou adresou: nič, ani ručne.
  const iny = await pripravUcet(env, { domain: 'iny-cudzi.sk', email: 'OBET@firma.sk' });
  assert.equal((await posliEmail(env, iny, 'E1', { now: PONDELOK_10 })).dovod, 'potlacena');
  assert.equal((await posliEmail(env, iny, 'E1', { now: PONDELOK_10, rucne: true })).dovod, 'potlacena');
  assert.equal(env.odoslane.length, 0);
});

test('A7. E0 nenesie cudzí odkaz: len hostiteľ feedu, bez href; odkazy len na arling.sk a worker', async () => {
  const e = vytvorEmail('E0', 'sk', parametre({ feedUrl: 'https://zly.example/prihlasenie-arling', chybaKod: 'feed_http_404' }));
  assert.ok(!e.html.includes('href="https://zly.example'), 'href na cudziu doménu');
  assert.ok(!e.text.includes('/prihlasenie-arling'), 'celá adresa feedu v texte');
  assert.match(e.text, /z feedu na serveri zly\.example/);
  // Aj keby sa cudzia adresa dostala do textu, HTML z nej odkaz neurobí.
  const zly = vytvorEmail('E1', 'sk', parametre({ domena: 'https://zly.example/x', skusit: 'https://zly.example/y' }));
  assert.ok(!/href="https:\/\/zly\.example/.test(zly.html));
  for (const kod of KODY_EMAILOV) {
    for (const m of vytvorEmail(kod, 'en', parametre()).html.matchAll(/href="([^"]+)"/g)) {
      assert.ok(/^https:\/\/(arling\.sk|arling-asistent\.arling\.workers\.dev)\//.test(m[1]), m[1]);
    }
  }
});

test('A8. Resend 409: súbežný kľúč sa opakuje, kľúč s iným telom je „overiť“ s pingom, nie zamietnutý; opakovanie posiela rovnaké telo', async () => {
  const s409 = (name) => {
    const env = makeEnv();
    env.fetchImpl = ((povodny) => async (url, opts) => {
      if (String(url) === 'https://api.resend.com/emails') {
        env.odoslane.push({ body: JSON.parse(opts.body), opts });
        return { ok: false, status: 409, json: async () => ({ statusCode: 409, name, message: 'x' }) };
      }
      return povodny(url, opts);
    })(env.fetchImpl);
    return env;
  };
  const a = s409('concurrent_idempotent_requests');
  const ta = await pripravUcet(a, { domain: 'subezny.sk' });
  assert.equal((await posliEmail(a, ta, 'E1', { now: PONDELOK_10 })).stav, 'zlyhal');
  const b = s409('invalid_idempotent_request');
  const tb = await pripravUcet(b, { domain: 'ine-telo.sk' });
  assert.equal((await posliEmail(b, tb, 'E1', { now: PONDELOK_10 })).stav, 'overit');
  assert.equal(b.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_email_overit').length, 1);
  assert.equal(b.pingy.filter((p) => p.url.searchParams.get('e') === 'asistent_email_chyba').length, 0);

  // Zmrazené údaje: počet produktov sa medzi pokusmi zmení, telo ostane rovnaké.
  const env = makeEnv({ resend: (n) => (n === 1 ? 503 : 200) });
  const t = await pripravUcet(env, { domain: 'zmrazene.sk', productCount: 253 });
  await posliEmail(env, t, 'E1', { now: PONDELOK_10 });
  env.DB._tenants.get(t.id).product_count = 260;
  await dobeh(env, { now: new Date(PONDELOK_10.getTime() + 20 * 60 * 1000) });
  assert.equal(env.odoslane.length, 2);
  assert.equal(env.odoslane[0].body.text, env.odoslane[1].body.text);
  assert.equal(env.odoslane[0].body.subject, env.odoslane[1].body.subject);
});

test('A9. náhľad v administrácii WordPressu (Referer /wp-admin/, wp-login.php) nie je zapojenie, bežná stránka áno', async () => {
  const env = makeEnv({ emaily: false });
  const t = await pripravUcet(env, { domain: 'wpadmin.sk' });
  await poWidgetJs(env, widgetReq('https://wpadmin.sk/wp-admin/admin.php?page=arling'));
  await poWidgetJs(env, widgetReq('https://wpadmin.sk/wp-login.php'));
  assert.equal(await najdiU(env, t.id, 'zapojeny'), null);
  await poWidgetJs(env, widgetReq('https://wpadmin.sk/kategoria/'));
  assert.ok(await najdiU(env, t.id, 'zapojeny'));
});

test('A10. dobeh číta len účty s prácou a pri limite dopytov D1 sa zastaví; staré účty nestoja nič', async () => {
  const env = makeEnv({ emaily: false });
  const stare = new Date('2026-01-10T10:00:00Z');
  for (let i = 0; i < 30; i++) await pripravUcet(env, { domain: `stary${i}.sk`, now: stare });
  const now = new Date('2026-09-25T10:00:00Z');
  let r = await dobeh(env, { now });
  assert.equal(r.tenanty, 0);
  assert.ok(r.dopyty <= 2, `dopyty ${r.dopyty}`);
  for (let i = 0; i < 40; i++) await pripravUcet(env, { domain: `novy${i}.sk`, now });
  r = await dobeh(env, { now, maxDopytov: 200 });
  assert.equal(r.prerusene, true);
  assert.ok(r.dopyty <= 200, `dopyty ${r.dopyty}`);
  assert.ok(r.tenanty > 0 && r.tenanty < 40);
  // Staré zapojené bez `aktivny`: dopočíta denná údržba.
  const st = [...env.DB._tenants.values()].find((x) => x.domain === 'stary0.sk');
  await zaznamenaj(env, st.id, 'zapojeny', 'zapojeny', { signal: 'chat' }, stare, stare.toISOString());
  for (const [den, n] of [['2026-09-20', 4], ['2026-09-22', 3], ['2026-09-24', 3]]) env.DB._counters.set(`${st.id}::${den}`, { tenant_id: st.id, day: den, conversations: n, product_clicks: 0, web_conversations: n });
  const u = await dennaUdrzba(env, { now });
  assert.deepEqual(u.aktivne, [st.id]);
});

test('A11. adresa s menom a lomenými zátvorkami neprejde; zlé percentové kódovanie v ceste stop je 400', async () => {
  const env = makeEnv({ emaily: false });
  for (const email of ['Meno<x@y.sk>', 'a@b.sk, c@d.sk', 'x y@z.sk']) {
    const r = await worker.fetch(tenantReq({ feed_url: 'https://zle-adresy.sk/f.xml', domain: 'zle-adresy.sk', email }), env, {});
    assert.equal(r.status, 400, email);
  }
  const r = await worker.fetch(new Request('https://x/v1/tenants/%E0/emaily/stop?k=x'), env, {});
  assert.equal(r.status, 400);
});
