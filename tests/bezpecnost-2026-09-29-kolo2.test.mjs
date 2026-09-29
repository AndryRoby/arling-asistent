// bezpecnost-2026-09-29-kolo2.test.mjs
//
// Druhé kolo bezpečnostných opráv Asistenta 29. 9. 2026 po protivníckej
// kontrole prvého kola (scratchpad bezpecnost-kontrola.md). Každý test
// pokrýva celú triedu vstupov:
//   A. väzba feedu na doménu obchodu (založenie, zmena, každý skok
//      presmerovania), plugin 0.4.0 pri zmene adresy REST (R1), oslovený obchod
//      po pripojení pluginu (R2), nový feed bežiaceho obchodu až po úspešnom
//      načítaní, formulár na arling.sk (feed_other_domain, pravdivý text),
//   B. vektory, ktoré v novom načítaní nie sú, sa zmažú,
//   C. obchod v stave ready pri zlyhaní ostáva ready, XML nad stropom po
//      posledný celý záznam, feed_too_large,
//   D. parser v lineárnom čase a JSON parsovaný raz so stropom,
//   E. nočný cron: celkový čas, údržba pred obnovou, poradie a rezervácia,
//   F. živá ukážka: otázky z odkazu, verejné prípony, Umami.
// Nič nejde na sieť: feed, e-maily aj ping stoja za env.fetchImpl.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import worker from '../worker/src/index.js';
import {
  createTenantFromRequest,
  ingestFeedForTenant,
  tenantStatusResponse,
  readIngestError,
  zivaUkazkaPovolena,
  classifyFeedError,
  domenaFeeduObchodu,
  FeedOtherDomainError,
  DomainTakenError,
  FEED_INA_DOMENA_TEXT,
  SPOLOCNA_DOMENA_TEXT,
  DOMENA_OBSADENA_TEXT,
  TENANT_STATUS,
  INGEST_ERRORS,
} from '../worker/src/onboarding.js';
import { createTenant, getTenantById, setTenantStatus, hostPatriDomene, jeVerejnaPripona, VEREJNE_PRIPONY } from '../worker/src/tenants.js';
import {
  fetchFeed,
  parseFeed,
  extractBlocks,
  extractTag,
  stripCdata,
  stripHtml,
  decodeXmlEntities,
  detectFeedType,
  parsujJsonSoStropom,
  xmlPoPoslednyZaznam,
  FeedUrlNotAllowedError,
  FEED_CHYBY,
  FEED_TYPES,
  MAX_JSON_OBJEKTOV,
  MAX_JSON_NA_STRANU,
  MAX_PRODUCTS,
} from '../worker/src/feed.js';
import { refreshAllFeeds, poradieObnovy, dennyBeh, CRON_CAS_SPOLU_MS } from '../worker/src/cron.js';
import { jazykZoVstupu, udalostiTenanta, zaznamenaj } from '../worker/src/zivotny-cyklus.js';
import { vytvorToken } from '../worker/src/ucet.js';
import { dovodChyby } from '../worker/src/zivotny-cyklus-texty.js';
import { pripocitaj, kluce } from '../worker/src/pocty.js';
import { SQL } from '../worker/src/tenants.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const TU = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.join(TU, '..', '..', 'arling-sk', 'asistent');
const TAJOMSTVO = Buffer.from('tajomstvo-bezpecnost-29-9-kolo2').toString('base64');
const ADMIN_ZAPIS = 'zapis-kolo2';
const POMLCKY = new RegExp('[\\u2013\\u2014]');

const XML = (n = 1, host = 'obchod.sk', pref = 'p') => `<products>${Array.from({ length: n }, (_, i) => `<item><id>${pref}${i + 1}</id><name>Kanvica ${pref}${i + 1}</name><price>9.99</price><url>https://${host}/${pref}/${i + 1}</url><description>Popis ${pref}${i + 1}.</description></item>`).join('')}</products>`;
const WOO = (n = 2, host = 'obchod.sk', pref = 'w') => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `${pref}${i + 1}`, name: `Hrnček ${pref}${i + 1}`, permalink: `https://${host}/${pref}/${i + 1}`, prices: { price: '990', currency_code: 'EUR', currency_minor_unit: 2 }, is_in_stock: true })));
const jeWoo = (url) => /wc\/store|rest_route=/.test(String(url));

/** Feed podľa adresy: Store API dostane JSON, ostatné XML, obsah z hostiteľa (produkty nesú adresu obchodu). */
function predvolenyFetch(url) {
  const host = new URL(String(url)).hostname;
  return { ok: true, status: 200, text: async () => (jeWoo(url) ? WOO(2, host) : XML(2, host)) };
}

function makeEnv({ fetchImpl, extra = {} } = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    UCET_TAJOMSTVO: TAJOMSTVO,
    ADMIN_TOKEN: 'admin-kolo2',
    ASISTENT_ADMIN_ZAPIS: ADMIN_ZAPIS,
    fetchImpl: fetchImpl || (async (url) => predvolenyFetch(url)),
    ...extra,
  };
}

async function tokenPre(env, email) {
  await env.ASISTENT_CACHE.put(`ucet:ucet:${email}`, JSON.stringify({ email, vytvorene: new Date().toISOString(), verzia: 1, nakupy: [], predplatne: [] }));
  return vytvorToken(env, { email, verzia: 1 });
}

let ipPoradie = 0;
/** POST /v1/tenants: formulár (Origin arling.sk) alebo plugin (bez Origin, User-Agent WordPress). */
function tenantReq(body, { token, admin, plugin = false } = {}) {
  ipPoradie += 1;
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.19.${(ipPoradie >> 8) & 255}.${ipPoradie & 255}` };
  if (plugin) headers['User-Agent'] = 'WordPress/6.6.2; https://obchod.sk';
  else headers.Origin = 'https://arling.sk';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Token'] = admin;
  return new Request('https://arling-asistent.arling.workers.dev/v1/tenants', { method: 'POST', headers, body: JSON.stringify(body) });
}

function ctxNaPozadi() {
  const ulohy = [];
  return { ctx: { waitUntil: (p) => ulohy.push(p) }, dobehni: () => Promise.allSettled(ulohy.splice(0)) };
}

const vektoryObchodu = (env, id) => [...env.VECTORIZE._store.keys()].filter((k) => k.startsWith(`${id}::`)).sort();
const urlVektorov = (env, id) => [...env.VECTORIZE._store.values()].filter((v) => v.id.startsWith(`${id}::`)).map((v) => v.metadata.url);

async function readyObchod(env, { domain = 'obchod.sk', feedUrl = `https://${domain}/feed.xml`, email = `majitel@${domain}` } = {}) {
  const { ctx, dobehni } = ctxNaPozadi();
  const res = await worker.fetch(tenantReq({ feed_url: feedUrl, domain, email, lang: 'sk' }), env, ctx);
  assert.equal(res.status, 201, `${domain}: ${await res.clone().text()}`);
  const { id } = await res.json();
  await dobehni();
  assert.equal((await getTenantById(env.DB, id)).status, TENANT_STATUS.READY, domain);
  return id;
}

// ===========================================================================
// A. Väzba feedu na doménu obchodu
// ===========================================================================

test('A1. POST /v1/tenants pustí len feed na doméne obchodu alebo jej subdoméne (aj www, veľké písmená, port); všetko ostatné 400 feed_other_domain v jazyku žiadosti, nič sa nezapíše a odpoveď je rovnaká pre obsadenú aj voľnú doménu', async () => {
  const env = makeEnv();
  await readyObchod(env, { domain: 'obsadena.sk' });
  const obsadenaId = [...env.DB._tenants.values()].find((t) => t.domain === 'obsadena.sk').id;
  const { ctx, dobehni } = ctxNaPozadi();

  const domeny = ['obchod.sk', 'www.obchod2.sk', 'shop.obchod.co.uk', 'obchod.myshopify.com', 'obsadena.sk'];
  for (const domain of domeny) {
    const b = domain.replace(/^www\./, '');
    const rodic = b.split('.').slice(1).join('.');
    const dobre = [`https://${b}/feed.xml`, `https://www.${b}/f.xml`, `https://feed.${b}/x.xml`, `https://a.b.${b}/x.xml`, `https://${b.toUpperCase()}/F.xml`, `http://${b}:8080/f.xml`];
    const zle = ['https://utocnik.example/feed.xml', `https://${b}.utocnik.example/f.xml`, `https://utocnik${b}/f.xml`, `https://x${b}/f.xml`, `https://${b}evil.com/f.xml`, `https://${rodic}/f.xml`, 'https://203.0.113.9/f.xml', 'https://arling.sk/asistent/ukazka/feed.xml'];
    for (const feed_url of dobre) {
      const res = await worker.fetch(tenantReq({ feed_url, domain, email: `majitel@${b}`, lang: 'sk' }), env, ctx);
      await dobehni();
      assert.ok([200, 201].includes(res.status), `${domain} ${feed_url}: ${res.status}`);
    }
    for (const feed_url of zle) {
      for (const lang of ['sk', 'cs', 'en', 'de', undefined, 'fr']) {
        for (const email of [`majitel@${b}`, 'utocnik@example.com']) {
          const pocet = env.DB._tenants.size;
          const pred = domain === 'obsadena.sk' ? { ...(await getTenantById(env.DB, obsadenaId)) } : null;
          const res = await worker.fetch(tenantReq({ feed_url, domain, email, lang }), env, ctx);
          await dobehni();
          const popis = `${domain} ${feed_url} ${lang} ${email}`;
          assert.equal(res.status, 400, popis);
          const telo = await res.json();
          assert.deepEqual(Object.keys(telo).sort(), ['error', 'issues'], popis);
          assert.equal(telo.error, 'feed_other_domain', popis);
          const jazyk = jazykZoVstupu(lang);
          const text = (jeVerejnaPripona(b) ? SPOLOCNA_DOMENA_TEXT : FEED_INA_DOMENA_TEXT)[jazyk || 'en'](b);
          assert.equal(telo.issues[0], text, popis);
          // Rovnaká veta ako pre voľnú doménu: nič neprezradí, že obchod existuje.
          assert.equal(telo.issues[0], new FeedOtherDomainError(b, jazyk).sprava, popis);
          assert.ok(!JSON.stringify(telo).includes(obsadenaId), popis);
          assert.equal(env.DB._tenants.size, pocet, `${popis}: nič nové v D1`);
          if (pred) assert.deepEqual(await getTenantById(env.DB, obsadenaId), pred, `${popis}: obsadený obchod bez zmeny`);
        }
      }
    }
  }
  assert.ok(!urlVektorov(env, '').some((u) => /utocnik|arling\.sk\/asistent/.test(u)));
});

test('A1b. doména na úrovni verejnej prípony (jednoslovná, myshopify.com, github.io, co.uk, workers.dev …) sa nezaloží ani s feedom „na nej“, vlastná doména obchodu na platforme áno; texty v 4 jazykoch bez pomlčiek', async () => {
  const env = makeEnv();
  const { ctx, dobehni } = ctxNaPozadi();
  const pripony = ['sk', 'com', ...[...VEREJNE_PRIPONY].filter((p) => !p.startsWith('s3.'))];
  for (const d of pripony) {
    for (const feed_url of [`https://${d}/f.xml`, `https://www.${d}/f.xml`, `https://utocnik.${d}/f.xml`]) {
      const res = await worker.fetch(tenantReq({ feed_url, domain: d, email: 'a@example.com', lang: 'en' }), env, ctx);
      assert.equal(res.status, 400, `${d} ${feed_url}`);
      const telo = await res.json();
      assert.equal(telo.error, 'feed_other_domain', d);
      assert.equal(telo.issues[0], SPOLOCNA_DOMENA_TEXT.en(d), d);
    }
    assert.equal(hostPatriDomene(`x.${d}`, d), false, d);
  }
  const vlastna = await worker.fetch(tenantReq({ feed_url: 'https://mojobchod.myshopify.com/products.json', domain: 'mojobchod.myshopify.com', email: 'a@example.com' }), env, ctx);
  await dobehni();
  assert.equal(vlastna.status, 201);
  for (const jazyk of ['sk', 'cs', 'en', 'de']) {
    for (const texty of [FEED_INA_DOMENA_TEXT, SPOLOCNA_DOMENA_TEXT]) {
      const t = texty[jazyk]('obchod.sk');
      assert.ok(t.includes('obchod.sk') && /(podpora|support)@arling\.sk/.test(t), `${jazyk}: ${t}`);
      assert.doesNotMatch(t, POMLCKY, jazyk);
    }
    assert.doesNotMatch(DOMENA_OBSADENA_TEXT[jazyk], POMLCKY, jazyk);
    assert.doesNotMatch(DOMENA_OBSADENA_TEXT[jazyk], /kód|kódem|code|Code/, `${jazyk}: 409 nesľubuje kód, feed na doméne ho nepotrebuje`);
  }
});

test('A1c. výnimky: zdroj oslovenie len s platným admin tokenom (feed na našom serveri); demo obchod len keď je naša doména aj feed', async () => {
  const env = makeEnv();
  const { ctx, dobehni } = ctxNaPozadi();
  const snimka = 'https://ukazky.arling-test.example/u/oslovany.json';
  for (const [admin, cakam] of [[ADMIN_ZAPIS, 201], [undefined, 400], ['zly-token', 400], [ADMIN_ZAPIS + 'x', 400]]) {
    const domain = `oslovany${cakam}${admin ? admin.length : 0}.sk`;
    const res = await worker.fetch(tenantReq({ feed_url: snimka, domain, email: `info@${domain}`, zdroj: 'oslovenie', lang: 'sk' }, { admin }), env, ctx);
    await dobehni();
    assert.equal(res.status, cakam, String(admin));
  }
  // Admin token bez zdroja oslovenie výnimku nemá.
  const bezZdroja = await worker.fetch(tenantReq({ feed_url: snimka, domain: 'inyobchod.sk', email: 'info@inyobchod.sk' }, { admin: ADMIN_ZAPIS }), env, ctx);
  assert.equal(bezZdroja.status, 400);
  const demo = await worker.fetch(tenantReq({ feed_url: 'https://arling.sk/asistent/ukazka/feed.xml', domain: 'ukazka2.arling.sk', email: 'a@gmail.com' }), env, ctx);
  await dobehni();
  assert.equal(demo.status, 201);
  for (const feed_url of ['https://utocnik.example/f.xml', 'https://arling.sk.utocnik.example/f.xml']) {
    const r = await worker.fetch(tenantReq({ feed_url, domain: 'ukazka3.arling.sk', email: 'a@gmail.com' }), env, ctx);
    assert.equal(r.status, 400, feed_url);
  }
});

test('A2. každý skok presmerovania musí byť na doméne obchodu: reťazce v rámci domény prejdú, skok mimo nej skončí feed_other_domain skôr, než sa cudzia adresa zavolá; bez domény ako doteraz', async () => {
  const retazce = [
    [['https://obchod.sk/feed.xml', 'https://www.obchod.sk/feed.xml', 'https://cdn.obchod.sk/feed.xml'], true],
    [['https://obchod.sk/feed.xml', '/feed2.xml'], true],
    [['https://www.obchod.sk/feed.xml', 'https://obchod.sk/f'], true],
    [['https://obchod.sk/feed.xml', 'https://utocnik.example/feed.xml'], false],
    [['https://obchod.sk/feed.xml', '//utocnik.example/x.xml'], false],
    [['https://obchod.sk/feed.xml', 'https://www.obchod.sk/f', 'https://obchod.sk.utocnik.example/f'], false],
    [['https://obchod.sk/feed.xml', 'https://utocnikobchod.sk/f'], false],
    [['https://obchod.sk/feed.xml', 'https://sk/f'], false],
    [['https://utocnik.example/feed.xml'], false],
    [['https://obchod.sk/wp-json/wc/store/v1/products', 'https://utocnik.example/wc/store/v1/products'], false],
  ];
  for (const [skoky, ok] of retazce) {
    for (const domena of ['obchod.sk', 'www.obchod.sk', null]) {
      const volane = [];
      const fetchImpl = async (url) => {
        volane.push(url);
        const dalsi = skoky[volane.length];
        if (dalsi) return { ok: false, status: 302, headers: new Headers({ location: dalsi }), text: async () => '' };
        return predvolenyFetch(url);
      };
      const popis = `${skoky.join(' > ')} [${domena}]`;
      if (ok || !domena) {
        const r = await fetchFeed(skoky[0], { fetchImpl, domena });
        assert.ok(r.products.length > 0, popis);
        continue;
      }
      await assert.rejects(() => fetchFeed(skoky[0], { fetchImpl, domena }), (e) => e instanceof FeedUrlNotAllowedError && e.reason === 'feed_other_domain' && classifyFeedError(e) === 'feed_other_domain', popis);
      assert.ok(volane.every((u) => hostPatriDomene(new URL(u).hostname, domena)), `${popis}: cudzia adresa sa nezavolala (${volane.join(', ')})`);
    }
  }
});

test('A2b. načítanie obchodu viaže feed na jeho doménu (nový obchod dostane error feed_other_domain, bežiaci ostane ready); ukážka oslovenia a demo obchod sa neviažu', async () => {
  const presmeruj = async (url) => (/utocnik/.test(url) ? predvolenyFetch(url) : { ok: false, status: 301, headers: new Headers({ location: 'https://utocnik.example/feed.xml' }), text: async () => '' });
  for (const [popis, pripravit, viazany] of [
    ['bežný obchod', (t) => t, true],
    ['ukážka oslovenia', (t) => ({ ...t, zdroj: 'oslovenie' }), false],
    ['demo obchod', (t) => ({ ...t, domain: 'ukazka.arling.sk' }), false],
  ]) {
    for (const stav of [TENANT_STATUS.PENDING, TENANT_STATUS.READY]) {
      const env = makeEnv({ fetchImpl: presmeruj });
      const t = await createTenant(env.DB, { domain: 'obchod.sk', feedUrl: 'https://obchod.sk/feed.xml', contactEmail: 'a@obchod.sk' });
      await setTenantStatus(env.DB, t.id, stav);
      const tenant = pripravit({ ...(await getTenantById(env.DB, t.id)) });
      assert.equal(domenaFeeduObchodu(env, tenant), viazany ? 'obchod.sk' : null, popis);
      const r = await ingestFeedForTenant(env, tenant);
      const riadok = await getTenantById(env.DB, t.id);
      if (!viazany) {
        assert.equal(r.ok, true, popis);
        continue;
      }
      assert.equal(r.ok, false, popis);
      assert.equal(r.code, 'feed_other_domain', popis);
      assert.equal(await readIngestError(env, t.id), 'feed_other_domain', popis);
      assert.equal(riadok.status, stav === TENANT_STATUS.READY ? TENANT_STATUS.READY : TENANT_STATUS.ERROR, `${popis} ${stav}`);
      assert.equal(env.AI.calls.length, 0, popis);
    }
  }
});

test('A3. plugin 0.4.0 pri zmene adresy REST (R1): rovnaký majiteľ bez Bearera prepne feed na novú adresu toho istého webu vo všetkých stavoch obchodu, dostane svoje id a obchod je ready', async () => {
  const adresy = [
    'https://obchod.sk/?rest_route=/wc/store/v1/products&per_page=100',
    'https://www.obchod.sk/wp-json/wc/store/v1/products?per_page=100',
    'https://obchod.sk/api/wc/store/v1/products?per_page=100',
    'https://obchod.sk/shop/wp-json/wc/store/v1/products?per_page=100',
  ];
  const TRI_DNI = 3 * 24 * 60 * 60 * 1000;
  for (const nova of adresy) {
    for (const stav of [TENANT_STATUS.READY, TENANT_STATUS.ERROR, TENANT_STATUS.PENDING]) {
      for (const email of ['admin@obchod.sk', ' Admin@Obchod.SK ']) {
        const env = makeEnv();
        const { ctx, dobehni } = ctxNaPozadi();
        const stara = 'https://obchod.sk/wp-json/wc/store/v1/products?per_page=100';
        const r0 = await worker.fetch(tenantReq({ feed_url: stara, domain: 'obchod.sk', email: 'admin@obchod.sk', lang: 'en', zdroj: 'wordpress' }, { plugin: true }), env, ctx);
        const { id } = await r0.json();
        await dobehni();
        const row = env.DB._tenants.get(id);
        row.created_at = new Date(Date.now() - TRI_DNI).toISOString();
        if (stav !== TENANT_STATUS.READY) await setTenantStatus(env.DB, id, stav, { now: new Date(Date.now() - TRI_DNI) });
        const popis = `${nova} ${stav} ${email}`;
        const res = await worker.fetch(tenantReq({ feed_url: nova, domain: 'obchod.sk', email, lang: 'en', zdroj: 'wordpress' }, { plugin: true }), env, ctx);
        await dobehni();
        assert.equal(res.status, 200, popis);
        const telo = await res.json();
        assert.equal(telo.id, id, popis);
        assert.equal(telo.existing, true, popis);
        assert.equal(telo.feed_treba_overit, undefined, popis);
        const po = await getTenantById(env.DB, id);
        assert.equal(po.feed_url, nova, popis);
        assert.equal(po.status, TENANT_STATUS.READY, popis);
      }
    }
  }
});

test('A4. oslovený obchod po pripojení pluginu (R2): s verejnou aj inou adresou dostane id a prepne sa zo snímky na Store API obchodu (vektory snímky preč); contact_email, jazyk a overenie sa nemenia; cudzí feed nie; náš skript smie obnoviť snímku len ukážke oslovenia', async () => {
  const snimka = 'https://ukazky.arling-test.example/u/veselycaj.json';
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://ukazky.')) return { ok: true, status: 200, text: async () => WOO(3, 'veselycaj.sk', 's') };
    return predvolenyFetch(url);
  };
  for (const email of ['info@veselycaj.sk', 'INFO@veselycaj.sk ', 'wp-admin@gmail.com', 'iny.clovek@example.com']) {
    for (const jazyk of ['en', 'de']) {
      const env = makeEnv({ fetchImpl });
      const { ctx, dobehni } = ctxNaPozadi();
      const r0 = await worker.fetch(tenantReq({ feed_url: snimka, domain: 'veselycaj.sk', email: 'info@veselycaj.sk', lang: 'sk', zdroj: 'oslovenie' }, { admin: ADMIN_ZAPIS }), env, ctx);
      assert.equal(r0.status, 201);
      const { id } = await r0.json();
      await dobehni();
      assert.equal((await getTenantById(env.DB, id)).status, TENANT_STATUS.READY);
      const snimkoveVektory = vektoryObchodu(env, id);
      assert.equal(snimkoveVektory.length, 3);

      const storeApi = 'https://veselycaj.sk/wp-json/wc/store/v1/products?per_page=100';
      const popis = `${email} ${jazyk}`;
      const res = await worker.fetch(tenantReq({ feed_url: storeApi, domain: 'veselycaj.sk', email, lang: jazyk, zdroj: 'wordpress' }, { plugin: true }), env, ctx);
      await dobehni();
      assert.equal(res.status, 200, popis);
      const telo = await res.json();
      assert.equal(telo.id, id, popis);
      assert.equal(telo.existing, true, popis);
      assert.equal(telo.overeny, false, popis);
      assert.equal(telo.feed_treba_overit, undefined, popis);
      const po = await getTenantById(env.DB, id);
      assert.equal(po.feed_url, storeApi, popis);
      assert.equal(po.contact_email, 'info@veselycaj.sk', popis);
      assert.equal(po.jazyk, 'sk', popis);
      assert.equal(po.status, TENANT_STATUS.READY, popis);
      assert.ok(!(await udalostiTenanta(env.DB, id)).some((u) => u.kluc === 'overeny'), popis);
      const nove = vektoryObchodu(env, id);
      assert.equal(nove.length, 2, popis);
      assert.ok(snimkoveVektory.every((v) => !nove.includes(v)), `${popis}: vektory snímky zmazané`);
      assert.ok(urlVektorov(env, id).every((u) => u.startsWith('https://veselycaj.sk/w/')), popis);

      // Cudzí feed ani pri ukážke oslovenia.
      const cudzi = await worker.fetch(tenantReq({ feed_url: 'https://utocnik.example/feed.json', domain: 'veselycaj.sk', email }, { plugin: true }), env, ctx);
      assert.equal(cudzi.status, 400, popis);
    }
  }

  // Náš skript (admin + oslovenie) smie ukážke oslovenia obnoviť snímku, obchodu mimo oslovení nie.
  const env = makeEnv({ fetchImpl });
  const { ctx, dobehni } = ctxNaPozadi();
  const r1 = await worker.fetch(tenantReq({ feed_url: snimka, domain: 'veselycaj.sk', email: 'info@veselycaj.sk', zdroj: 'oslovenie' }, { admin: ADMIN_ZAPIS }), env, ctx);
  const { id } = await r1.json();
  await dobehni();
  const nova = 'https://ukazky.arling-test.example/u/veselycaj-2.json';
  const r2 = await worker.fetch(tenantReq({ feed_url: nova, domain: 'veselycaj.sk', email: 'info@veselycaj.sk', zdroj: 'oslovenie' }, { admin: ADMIN_ZAPIS }), env, ctx);
  await dobehni();
  assert.equal((await r2.json()).feed_treba_overit, undefined);
  assert.equal((await getTenantById(env.DB, id)).feed_url, nova);
  const vlastnyId = await readyObchod(env, { domain: 'samsebe.sk' });
  const r3 = await worker.fetch(tenantReq({ feed_url: nova, domain: 'samsebe.sk', email: 'majitel@samsebe.sk', zdroj: 'oslovenie' }, { admin: ADMIN_ZAPIS }), env, ctx);
  await dobehni();
  assert.equal(r3.status, 200);
  assert.equal((await r3.json()).feed_treba_overit, true);
  assert.equal((await getTenantById(env.DB, vlastnyId)).feed_url, 'https://samsebe.sk/feed.xml');
});

test('A5. bežiaci obchod prevezme nový feed z vlastnej domény až po úspešnom načítaní: pre každý druh zlyhania ostáva starý feed, stav ready, počet produktov aj vektory a zapíše sa kód; funkčný feed sa uloží', async () => {
  const zlyhania = {
    'HTTP 404': [async () => ({ ok: false, status: 404, text: async () => 'nie' }), 'feed_http_404'],
    'HTML stránka': [async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html><body>Coming soon</body></html>' }), 'no_products'],
    'nečitateľné': [async () => ({ ok: true, status: 200, text: async () => 'hello' }), 'feed_not_readable'],
    'prázdny feed': [async () => ({ ok: true, status: 200, text: async () => '<products></products>' }), 'no_products'],
    'sieť': [async () => { throw new Error('connect ECONNREFUSED'); }, 'feed_unreachable'],
    'presmerovanie von': [async () => ({ ok: false, status: 302, headers: new Headers({ location: 'https://utocnik.example/f.xml' }), text: async () => '' }), 'feed_other_domain'],
    'JSON nad strop': [async () => ({ ok: true, status: 200, text: async () => '[' + '{},'.repeat(MAX_JSON_OBJEKTOV) + '{}]' }), 'feed_too_large'],
  };
  for (const [popis, [zlyFetch, kod]] of Object.entries(zlyhania)) {
    const env = makeEnv();
    const id = await readyObchod(env);
    const pred = { ...(await getTenantById(env.DB, id)) };
    const vektoryPred = vektoryObchodu(env, id);
    env.fetchImpl = zlyFetch;
    const { ctx, dobehni } = ctxNaPozadi();
    const res = await worker.fetch(tenantReq({ feed_url: 'https://obchod.sk/uvod', domain: 'obchod.sk', email: 'majitel@obchod.sk' }), env, ctx);
    await dobehni();
    assert.equal(res.status, 200, popis);
    const po = await getTenantById(env.DB, id);
    assert.equal(po.feed_url, pred.feed_url, popis);
    assert.equal(po.status, TENANT_STATUS.READY, popis);
    assert.equal(po.product_count, pred.product_count, popis);
    assert.deepEqual(vektoryObchodu(env, id), vektoryPred, popis);
    assert.equal(await readIngestError(env, id), kod, popis);

    env.fetchImpl = async (url) => predvolenyFetch(url);
    await worker.fetch(tenantReq({ feed_url: 'https://obchod.sk/novy.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk' }), env, ctx);
    await dobehni();
    assert.equal((await getTenantById(env.DB, id)).feed_url, 'https://obchod.sk/novy.xml', popis);
  }
});

// ---- formulár na arling.sk (app.js) vo vm, ten istý postup ako hub-skuska-chyby.test.mjs ----
class HubEl {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {};
    this.hidden = false; this.className = ''; this.textContent = ''; this.value = ''; this.style = {}; this.parentNode = null; this.disabled = false;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  querySelector(sel) {
    const cls = sel.slice(1);
    const walk = (e) => { for (const c of e.children) { if ((' ' + c.className + ' ').includes(' ' + cls + ' ')) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this);
  }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
  checkValidity() { return true; }
  reportValidity() {}
  focus() {}
  scrollIntoView() {}
  fire(t) { for (const f of this.listeners[t] || []) f({ preventDefault() {} }); }
}

const APP_SRC = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');

function formular({ jazyk = 'sk', odpoved }) {
  const ids = {};
  const kontajner = new HubEl('div');
  for (const id of ['trial-form', 'trial-feed-url', 'trial-email', 'trial-lang', 'trial-submit', 'trial-status', 'trial-widget-note', 'trial-feed-error']) ids[id] = new HubEl(id === 'trial-form' ? 'form' : 'input');
  kontajner.appendChild(ids['trial-status']);
  const volania = [];
  const fetch = async (url, init = {}) => {
    const cesta = new URL(url).pathname;
    volania.push({ cesta, init });
    const o = cesta === '/v1/tenants' ? odpoved : { status: 404, body: {} };
    return { ok: o.status < 400, status: o.status, json: async () => o.body };
  };
  const body = new HubEl('body');
  const sledovane = [];
  const document = { getElementById: (id) => ids[id] || null, createElement: (tag) => new HubEl(tag), documentElement: { getAttribute: (k) => (k === 'lang' ? jazyk : null) }, readyState: 'complete', currentScript: { src: 'https://arling.sk/asistent/app.js' }, body };
  const window = { location: { search: '', href: 'https://arling.sk/asistent/' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, umami: { track: (e, d) => sledovane.push({ e, d }) } };
  const casovace = [];
  vm.runInNewContext(APP_SRC, { window, document, fetch, URL, URLSearchParams, setTimeout: (f) => { casovace.push(f); return casovace.length; }, console, navigator: {} });
  return {
    ids, volania, sledovane, kontajner, body, casovace,
    async odosli(feed, email = 'majitel@gmail.com') {
      ids['trial-feed-url'].value = feed;
      ids['trial-email'].value = email;
      ids['trial-form'].fire('submit');
      for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

test('A6. formulár na arling.sk: 400 feed_other_domain ukáže pri poli URL vetu v jazyku stránky (sk, cs, en, de, inak en), bez textu workera, bez sledovania stavu a kódu, s udalosťou v Umami; feed_treba_overit pravdivo bez sľubu kódu', async () => {
  for (const [jazyk, veta] of [
    ['sk', /^Adresa feedu musí byť na vlastnej doméne obchodu.*podpora@arling\.sk\.$/],
    ['cs', /^Adresa feedu musí být na vlastní doméně obchodu.*podpora@arling\.sk\.$/],
    ['en', /^The feed URL must be on the shop's own domain.*support@arling\.sk\.$/],
    ['de', /^Die Feed-URL muss auf der eigenen Domain des Shops liegen.*support@arling\.sk\.$/],
    ['fr', /^The feed URL must be on the shop's own domain/],
  ]) {
    const f = formular({ jazyk, odpoved: { status: 400, body: { error: 'feed_other_domain', issues: ['TEXT-WORKERA'] } } });
    await f.odosli('https://mojobchod.myshopify.com/products.json');
    const pri = f.ids['trial-feed-error'];
    assert.match(pri.textContent, veta, jazyk);
    assert.doesNotMatch(pri.textContent, /TEXT-WORKERA|feed_other_domain/, jazyk);
    assert.doesNotMatch(pri.textContent, POMLCKY, jazyk);
    assert.equal(pri.hidden, false, jazyk);
    assert.equal(f.ids['trial-feed-url'].getAttribute('aria-invalid'), 'true', jazyk);
    assert.equal(f.ids['trial-status'].hidden, true, jazyk);
    assert.equal(f.ids['trial-submit'].disabled, false, jazyk);
    assert.deepEqual(f.volania.map((v) => v.cesta), ['/v1/tenants'], jazyk);
    assert.deepEqual(f.sledovane.map((x) => x.e), ['trial_start', 'trial_feed_other_domain'], jazyk);
  }
  // Pravdivosť: žiadny text formulára nesľubuje „uložíme po kóde“ ani „odpovedá z doterajšieho feedu“.
  assert.doesNotMatch(APP_SRC, /feedNeedsCode|verifyOkResubmit|trial_feed_needs_code/);
  assert.doesNotMatch(APP_SRC, /Dovtedy Asistent odpovedá z doterajšieho feedu|Until then the assistant answers from the current feed/);
});

// ===========================================================================
// B. Vektory, ktoré v novom načítaní nie sú
// ===========================================================================

const katalog = (host, idcka) => `<products>${idcka.map((i) => `<item><id>${i}</id><name>Produkt ${i}</name><price>1</price><url>https://${host}/p/${i}</url><description>Popis ${i}.</description></item>`).join('')}</products>`;
const rozsah = (od, po) => Array.from({ length: po - od + 1 }, (_, i) => `x${od + i}`);

test('B1. po každom úspešnom načítaní ostanú vo Vectorize len vektory z neho (zhodný, menší, väčší, prekrývajúci sa, úplne iný katalóg, starý druhý kus textu), cron aj zmena feedu majiteľom; zoznam v KV sedí a iné obchody ostanú bez zmeny', async () => {
  const pripady = [
    [rozsah(1, 3), rozsah(1, 3)],
    [rozsah(1, 3), rozsah(1, 2)],
    [rozsah(1, 2), rozsah(1, 3)],
    [rozsah(1, 3), rozsah(3, 5)],
    [rozsah(1, 3), ['iny1', 'iny2']],
    [rozsah(1, 50), rozsah(25, 75)],
    [rozsah(1, 40), ['jediny']],
  ];
  for (const cesta of ['cron', 'majitel']) {
    for (const [pred, po] of pripady) {
      const feedy = { 'https://obchod.sk/feed.xml': katalog('obchod.sk', pred), 'https://obchod.sk/novy.xml': katalog('obchod.sk', po), 'https://iny.sk/feed.xml': katalog('iny.sk', rozsah(1, 4)) };
      const env = makeEnv({ fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => feedy[url] }) });
      const id = await readyObchod(env);
      const inyId = await readyObchod(env, { domain: 'iny.sk' });
      const inyPred = vektoryObchodu(env, inyId);
      // Starý druhý kus textu spred stropu popisu (zapamätaný v zozname), musí zmiznúť tiež.
      await env.VECTORIZE.upsert([{ id: `${id}::${pred[0]}::1`, values: [1, 0, 0, 0], metadata: { tenant: id, url: 'https://obchod.sk/stary' } }]);
      const zoznam = JSON.parse(await env.ASISTENT_CACHE.get(`vektory:${id}`));
      await env.ASISTENT_CACHE.put(`vektory:${id}`, JSON.stringify([...zoznam, `${id}::${pred[0]}::1`]));
      const popis = `${cesta} ${pred.length}->${po.length}`;
      if (cesta === 'cron') {
        env.DB._tenants.get(id).feed_url = 'https://obchod.sk/novy.xml';
        const r = await ingestFeedForTenant(env, await getTenantById(env.DB, id));
        assert.equal(r.ok, true, popis);
      } else {
        const { ctx, dobehni } = ctxNaPozadi();
        await worker.fetch(tenantReq({ feed_url: 'https://obchod.sk/novy.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk' }), env, ctx);
        await dobehni();
        assert.equal((await getTenantById(env.DB, id)).feed_url, 'https://obchod.sk/novy.xml', popis);
      }
      const ocakavane = po.map((p) => `${id}::${p}::0`).sort();
      assert.deepEqual(vektoryObchodu(env, id), ocakavane, popis);
      assert.deepEqual(JSON.parse(await env.ASISTENT_CACHE.get(`vektory:${id}`)).sort(), ocakavane, `${popis}: zoznam v KV`);
      assert.deepEqual(vektoryObchodu(env, inyId), inyPred, `${popis}: iný obchod`);
    }
  }
});

test('B2. repro nálezu 1b: vektory cudzieho feedu (spred opravy) po overenej oprave majiteľom zmiznú, chat ich už neukáže', async () => {
  const env = makeEnv();
  const id = await readyObchod(env, { domain: 'obet2.sk' });
  // Stav spred opravy: útočníkov feed bol načítaný a jeho id sú v zozname (zapamatajVektory).
  const utocnik = ['u1', 'u2', 'u3'].map((p) => ({ id: `${id}::${p}::0`, values: [1, 0, 0, 0], metadata: { tenant: id, productId: p, title: `Cudzí ${p}`, url: `https://utocnik.example/p/${p}` } }));
  await env.VECTORIZE.upsert(utocnik);
  const zoznam = JSON.parse(await env.ASISTENT_CACHE.get(`vektory:${id}`));
  await env.ASISTENT_CACHE.put(`vektory:${id}`, JSON.stringify([...zoznam, ...utocnik.map((v) => v.id)]));
  assert.ok(urlVektorov(env, id).some((u) => u.includes('utocnik')));
  const token = await tokenPre(env, 'majitel@obet2.sk');
  const { ctx, dobehni } = ctxNaPozadi();
  const res = await worker.fetch(tenantReq({ feed_url: 'https://obet2.sk/opraveny.xml', domain: 'obet2.sk', email: 'majitel@obet2.sk' }, { token }), env, ctx);
  await dobehni();
  assert.equal(res.status, 200);
  assert.ok(!urlVektorov(env, id).some((u) => u.includes('utocnik')), urlVektorov(env, id).join(', '));
  assert.ok(urlVektorov(env, id).every((u) => u.startsWith('https://obet2.sk/')));
});

test('B3. mazanie vektorov nikdy nezhodí načítanie: chyba deleteByIds nechá id v zozname a ďalšie načítanie ich zmaže; nečitateľný zoznam v KV = nič sa nemaže, nové id sa pridajú; zlyhané načítanie nemaže nič', async () => {
  const feedy = { 'https://obchod.sk/feed.xml': katalog('obchod.sk', rozsah(1, 3)), 'https://obchod.sk/b.xml': katalog('obchod.sk', rozsah(4, 5)) };
  const env = makeEnv({ fetchImpl: async (url) => (feedy[url] ? { ok: true, status: 200, text: async () => feedy[url] } : { ok: false, status: 500, text: async () => '' }) });
  const id = await readyObchod(env);
  const povodne = vektoryObchodu(env, id);
  const mazanie = env.VECTORIZE.deleteByIds;
  env.VECTORIZE.deleteByIds = async () => { throw new Error('vectorize dole'); };
  env.DB._tenants.get(id).feed_url = 'https://obchod.sk/b.xml';
  const r1 = await ingestFeedForTenant(env, await getTenantById(env.DB, id));
  assert.equal(r1.ok, true);
  const zoznam1 = JSON.parse(await env.ASISTENT_CACHE.get(`vektory:${id}`));
  for (const v of povodne) assert.ok(zoznam1.includes(v), 'nezmazané id ostali v zozname');
  env.VECTORIZE.deleteByIds = mazanie;
  const r2 = await ingestFeedForTenant(env, await getTenantById(env.DB, id));
  assert.equal(r2.ok, true);
  assert.deepEqual(vektoryObchodu(env, id), rozsah(4, 5).map((p) => `${id}::${p}::0`).sort());

  // Nečitateľný zoznam: nič sa nemaže.
  const get = env.ASISTENT_CACHE.get;
  env.ASISTENT_CACHE.get = async (k) => (String(k).startsWith('vektory:') ? Promise.reject(new Error('kv dole')) : get(k));
  env.DB._tenants.get(id).feed_url = 'https://obchod.sk/feed.xml';
  const r3 = await ingestFeedForTenant(env, await getTenantById(env.DB, id));
  env.ASISTENT_CACHE.get = get;
  assert.equal(r3.ok, true);
  assert.equal(vektoryObchodu(env, id).length, 5, 'staré aj nové');

  // Zlyhané načítanie nič nemaže.
  const pred = vektoryObchodu(env, id);
  env.DB._tenants.get(id).feed_url = 'https://obchod.sk/chyba.xml';
  const r4 = await ingestFeedForTenant(env, await getTenantById(env.DB, id));
  assert.equal(r4.ok, false);
  assert.deepEqual(vektoryObchodu(env, id), pred);
});

// ===========================================================================
// C. Obchod v stave ready pri zlyhaní ostáva ready; XML nad stropom
// ===========================================================================

test('C1. obchod v stave ready ostáva ready s doterajším katalógom pri každom druhu zlyhania a každej ceste (nočný cron, opätovné odoslanie majiteľom po 24 h, admin reingest); kód sa zapíše; obchod, ktorý ešte nebeží, dostane error s kódom ako doteraz', async () => {
  const zlyhania = {
    http500: [{ fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) }, 'feed_http_500'],
    http403: [{ fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) }, 'feed_http_403'],
    siet: [{ fetchImpl: async () => { throw new TypeError('fetch failed'); } }, 'feed_unreachable'],
    html: [{ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html><body>Maintenance</body></html>' }) }, 'no_products'],
    prazdny: [{ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<products></products>' }) }, 'no_products'],
    jsonNadStrop: [{ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[' + '[],'.repeat(MAX_JSON_OBJEKTOV) + '[]]' }) }, 'feed_too_large'],
    vektory: [{ ai: async () => { throw new Error('vectorize upsert failed'); } }, 'internal'],
    kapacita: [{ ai: async () => { throw new Error('you have used up your daily free allocation of 10,000 neurons'); } }, 'ai_budget_exhausted'],
  };
  for (const cesta of ['cron', 'majitel', 'admin']) {
    for (const [nazov, [zlom, kod]] of Object.entries(zlyhania)) {
      const env = makeEnv();
      const id = await readyObchod(env);
      const pred = { ...(await getTenantById(env.DB, id)) };
      const vektoryPred = vektoryObchodu(env, id);
      env.DB._tenants.get(id).last_ingested_at = '2020-01-01T00:00:00.000Z';
      if (zlom.fetchImpl) env.fetchImpl = zlom.fetchImpl;
      if (zlom.ai) { const beh = env.AI.run.bind(env.AI); env.AI.run = async (m, v) => (m === '@cf/baai/bge-m3' ? zlom.ai() : beh(m, v)); }
      const popis = `${cesta} ${nazov}`;
      if (cesta === 'cron') {
        const v = await refreshAllFeeds(env);
        assert.equal(v.find((x) => x.tenantId === id).ok, false, popis);
      } else if (cesta === 'majitel') {
        const { ctx, dobehni } = ctxNaPozadi();
        const res = await worker.fetch(tenantReq({ feed_url: pred.feed_url, domain: 'obchod.sk', email: 'majitel@obchod.sk' }), env, ctx);
        await dobehni();
        assert.equal(res.status, 200, popis);
      } else {
        const res = await worker.fetch(new Request(`https://arling-asistent.arling.workers.dev/v1/tenants/${id}/reingest`, { method: 'POST', headers: { 'X-Admin-Token': 'admin-kolo2' } }), env, {});
        assert.equal(res.status, 502, popis);
        assert.equal((await res.json()).ponechanyReady, true, popis);
      }
      const po = await getTenantById(env.DB, id);
      assert.equal(po.status, TENANT_STATUS.READY, popis);
      assert.equal(po.product_count, pred.product_count, popis);
      assert.equal(po.feed_url, pred.feed_url, popis);
      assert.deepEqual(vektoryObchodu(env, id), vektoryPred, popis);
      assert.equal(await readIngestError(env, id), kod, popis);
      const status = await tenantStatusResponse(env, id);
      assert.equal(status.status, 'ready', popis);
    }
  }
  // Nový obchod pri tých istých zlyhaniach: error s kódom.
  for (const [nazov, [zlom, kod]] of Object.entries(zlyhania)) {
    const env = makeEnv();
    if (zlom.fetchImpl) env.fetchImpl = zlom.fetchImpl;
    if (zlom.ai) { const beh = env.AI.run.bind(env.AI); env.AI.run = async (m, v) => (m === '@cf/baai/bge-m3' ? zlom.ai() : beh(m, v)); }
    const t = await createTenantFromRequest(env, { feedUrl: 'https://novy.sk/feed.xml', domain: 'novy.sk', email: 'a@novy.sk' });
    const status = await tenantStatusResponse(env, t.id);
    assert.equal(status.status, 'error', nazov);
    assert.equal(status.last_error, kod, nazov);
  }
});

function xmlPolozky(druh, n) {
  const polozka = (i) => {
    const popis = 'Popis č. ' + 'ľ'.repeat(i % 7) + i;
    if (druh === 'heureka') return `<SHOPITEM><ITEM_ID>${i}</ITEM_ID><PRODUCTNAME>Výrobok ${i}</PRODUCTNAME><DESCRIPTION>${popis}</DESCRIPTION><URL>https://obchod.sk/p/${i}</URL><PRICE_VAT>${i},50</PRICE_VAT></SHOPITEM>\n`;
    if (druh === 'google') return `<item><g:id>${i}</g:id><g:title>Výrobok ${i}</g:title><g:description>${popis}</g:description><g:link>https://obchod.sk/p/${i}</g:link><g:price>${i}.50 EUR</g:price></item>\n`;
    return `<item><id>${i}</id><name>Výrobok ${i}</name><description>${popis}</description><url>https://obchod.sk/p/${i}</url><price>${i}</price></item>\n`;
  };
  const hlava = druh === 'heureka' ? '<?xml version="1.0" encoding="utf-8"?>\n<SHOP>\n' : druh === 'google' ? '<?xml version="1.0"?>\n<rss xmlns:g="http://base.google.com/ns/1.0"><channel>\n' : '<products>\n';
  const paty = druh === 'heureka' ? '</SHOP>' : druh === 'google' ? '</channel></rss>' : '</products>';
  const casti = Array.from({ length: n }, (_, i) => polozka(i + 1));
  return { text: hlava + casti.join('') + paty, hlava, casti };
}

test('C2. XML nad stropom bajtov sa spracuje po posledný celý záznam s truncated: true (Heureka, Google, všeobecné; UTF-8 aj pri reze uprostred znaku, každý strop); bez celého záznamu, JSON nad stropom a JSON strana nad stropom podľa pravidiel feed_too_large alebo truncated', async () => {
  for (const druh of ['heureka', 'google', 'vseobecne']) {
    const { text, hlava, casti } = xmlPolozky(druh, 40);
    const celkom = Buffer.byteLength(text);
    // Konce záznamov v bajtoch.
    const konce = [];
    let pos = Buffer.byteLength(hlava);
    for (const c of casti) { pos += Buffer.byteLength(c); konce.push(pos - 1); } // bez koncového \n
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => text });
    for (let strop = Buffer.byteLength(hlava) + 5; strop < celkom; strop += 37) {
      const celych = konce.filter((k) => k <= strop).length;
      const popis = `${druh} strop ${strop}`;
      if (celych === 0) {
        await assert.rejects(() => fetchFeed('https://obchod.sk/feed.xml', { fetchImpl, maxBajtov: strop }), (e) => e.message === FEED_CHYBY.PRILIS_VELKY && classifyFeedError(e) === 'feed_too_large', popis);
        continue;
      }
      const r = await fetchFeed('https://obchod.sk/feed.xml', { fetchImpl, maxBajtov: strop });
      assert.equal(r.products.length, celych, popis);
      assert.equal(r.truncated, true, popis);
      assert.equal(r.products[celych - 1].title, `Výrobok ${celych}`, popis);
    }
    const cely = await fetchFeed('https://obchod.sk/feed.xml', { fetchImpl, maxBajtov: celkom });
    assert.equal(cely.products.length, 40, druh);
    assert.equal(cely.truncated, false, druh);
  }
  assert.equal(xmlPoPoslednyZaznam('{"products":[]}'), null);
  assert.equal(xmlPoPoslednyZaznam('<products><item><id>1</id>'), null);
  // Jeden JSON nad stropom strany: feed_too_large, nie nečitateľný.
  const velkyJson = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, name: `P ${i}`, description: 'x'.repeat(200) })));
  await assert.rejects(() => fetchFeed('https://obchod.sk/export.json', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => velkyJson }), maxJsonBajtov: 1000 }), (e) => classifyFeedError(e) === 'feed_too_large');
  // Stránkovanie: druhá strana nad stropom strany ukončí stránkovanie s truncated: true, prvá strana nad stropom je chyba.
  const strana = (n, od) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: od + i, name: `P ${od + i}`, permalink: `https://obchod.sk/p/${od + i}`, prices: { price: '100', currency_minor_unit: 2 } })));
  const s1 = strana(100, 1);
  const r = await fetchFeed('https://obchod.sk/wp-json/wc/store/v1/products', {
    fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => (new URL(url).searchParams.get('page') === '1' ? s1 : strana(100, 101) + ' '.repeat(Buffer.byteLength(s1))) }),
    maxJsonBajtov: Buffer.byteLength(s1) + 10,
  });
  assert.equal(r.products.length, 100);
  assert.equal(r.truncated, true);
  await assert.rejects(() => fetchFeed('https://obchod.sk/wp-json/wc/store/v1/products', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => s1 }), maxJsonBajtov: 100 }), (e) => classifyFeedError(e) === 'feed_too_large');
});

// ===========================================================================
// D. Parser: lineárny čas, rovnaký výsledok ako predtým, JSON raz so stropom
// ===========================================================================

// Pôvodné regulárne implementácie (pred druhým kolom), len na porovnanie výsledkov.
const stare = {
  stripCdata(text) { if (!text) return ''; return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); },
  extractTag(xml, tagName) { const m = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i')); return m ? decodeXmlEntities(stare.stripCdata(m[1])).trim() : ''; },
  extractBlocks(xml, blockTag, max = MAX_PRODUCTS) { const re = new RegExp(`<${blockTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${blockTag}>`, 'gi'); const b = []; let m; while ((m = re.exec(xml)) !== null) { b.push(m[0]); if (b.length >= max) break; } return b; },
  stripHtml(text) {
    if (!text) return '';
    const w = String(text).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, ' ');
    return decodeXmlEntities(w).replace(/[ \t]+/g, ' ').replace(/ +([.,!?;:])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  },
  heureka: /<SHOP(?:\s[^>]*)?>[\s\S]*?<SHOPITEM(?:\s[^>]*)?>/i,
};

test('D1. nové lineárne hľadanie dáva presne ten istý výsledok ako pôvodné regulárne výrazy: 4 000 náhodných reťazcov zo značiek, CDATA, skriptov a znakov', () => {
  const kusy = ['<item>', '</item>', '<item a="1">', '<ITEM>', '</ITEM>', '<items>', '<item', '<item/>', '<item />', 'x', ' ', '\n', '\t', '>', '<', '<![CDATA[', ']]>', '<name>', '</name>', '<name x>', '<g:id>', '</g:id>', '<script>', '</script>', '<SCRIPT a>', '</Script>', '<style>', '</style>', '<scripts>', '<br/>', '<br >', '</p>', '</li>', '&amp;', '&lt;', '<SHOP>', '<SHOP a="b">', '<SHOPITEM>', '</SHOPITEM>', '<shopitem x>', '<SHOPITEMS>', '<SHOPX>', '<PARAM>', '</PARAM>', 'č', '.', ' ,'];
  let semienko = 20260929;
  const nahoda = () => { semienko = (semienko * 1103515245 + 12345) % 2147483648; return semienko / 2147483648; };
  for (let i = 0; i < 4000; i++) {
    const s = Array.from({ length: Math.floor(nahoda() * 30) }, () => kusy[Math.floor(nahoda() * kusy.length)]).join('');
    for (const tag of ['item', 'SHOPITEM', 'PARAM', 'name', 'g:id']) {
      assert.deepEqual(extractBlocks(s, tag), stare.extractBlocks(s, tag), `blocks ${tag}: ${JSON.stringify(s)}`);
      assert.equal(extractTag(s, tag), stare.extractTag(s, tag), `tag ${tag}: ${JSON.stringify(s)}`);
    }
    assert.deepEqual(extractBlocks(s, 'item', 2), stare.extractBlocks(s, 'item', 2), JSON.stringify(s));
    assert.equal(stripCdata(s), stare.stripCdata(s), JSON.stringify(s));
    assert.equal(stripHtml(s), stare.stripHtml(s), `html: ${JSON.stringify(s)}`);
    const xml = '<x>' + s;
    assert.equal(detectFeedType(xml) === FEED_TYPES.HEUREKA, stare.heureka.test(xml), `heureka: ${JSON.stringify(xml)}`);
  }
});

test('D2. parsovanie je lineárne: každá známa kvadratická rodina vstupov (otváracie značky bez zatváracích, <SHOP> bez položiek, parametre, CDATA, skripty a osamelé < v popise) do 1 MB pod 1 s', () => {
  const MB = 1024 * 1024;
  const opakuj = (hlava, kus, paty = '') => hlava + kus.repeat(Math.floor((MB - hlava.length - paty.length) / kus.length)) + paty;
  const rodiny = {
    'rss + <item>': opakuj('<rss>', '<item>'),
    '<item><name> bez zatvorenia': opakuj('<products>', '<item><name>'),
    'google <item><g:id>': opakuj('<rss xmlns:g="x">', '<item><g:id>'),
    '<SHOP> bez položiek': opakuj('', '<SHOP>'),
    '<SHOP a> s medzerami': opakuj('', '<SHOP a="1" '),
    'SHOPITEM bez zatvorenia': opakuj('<SHOP>', '<SHOPITEM>'),
    'PARAM v jednej položke': opakuj('<SHOP><SHOPITEM><ITEM_ID>1</ITEM_ID><PRODUCTNAME>x</PRODUCTNAME>', '<PARAM><VAL>', '</SHOPITEM></SHOP>'),
    'CURRENCY v hlavičke': opakuj('<SHOP>', '<CURRENCY>', '<SHOPITEM><ITEM_ID>1</ITEM_ID><PRODUCTNAME>x</PRODUCTNAME></SHOPITEM></SHOP>'),
    'CDATA v názve': opakuj('<products><item><id>1</id><name>', '<![CDATA[', '</name></item></products>'),
    'script v popise': opakuj('<products><item><id>1</id><name>x</name><description>', '&lt;script&gt;', '</description></item></products>'),
    'style a script v popise': opakuj('<products><item><id>1</id><name>x</name><description>', '&lt;style&gt;&lt;script a&gt;', '</description></item></products>'),
    'osamelé < v popise': opakuj('<products><item><id>1</id><name>x</name><description>', '&lt;', '</description></item></products>'),
    'br bez konca': opakuj('<products><item><id>1</id><name>x</name><description>', '&lt;br    ', '</description></item></products>'),
  };
  for (const [nazov, text] of Object.entries(rodiny)) {
    const start = process.hrtime.bigint();
    try { parseFeed(text, 'https://obchod.sk/feed.xml'); } catch (e) { /* nečitateľný feed je v poriadku, ide o čas */ }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1000, `${nazov}: ${ms.toFixed(0)} ms`);
  }
  // stripHtml priamo na 1 MB popise.
  for (const kus of ['<script>', '<style>', '<', '<br ', '<scripts x']) {
    const start = process.hrtime.bigint();
    stripHtml(kus.repeat(Math.floor(MB / kus.length)));
    assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 1000, kus);
  }
});

test('D3. JSON sa parsuje raz (detekcia vráti objekt), stránkovanie bez JSON.stringify a druhého parsovania; strop znakov a objektov na stranu, pole bez objektov prejde', async () => {
  const shopify = JSON.stringify({ products: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `P ${i + 1}`, handle: `p-${i + 1}`, variants: [{ price: '1.00', available: true }] })) });
  const woo = WOO(5);
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  let parsovani = 0;
  let stringifikacii = 0;
  try {
    JSON.parse = (...a) => { parsovani += 1; return parse(...a); };
    for (const [text, typ] of [[shopify, FEED_TYPES.SHOPIFY], [woo, FEED_TYPES.WOOCOMMERCE]]) {
      parsovani = 0;
      const r = parseFeed(text, 'https://obchod.sk/export.json');
      assert.equal(r.type, typ);
      assert.equal(r.products.length, 5);
      assert.equal(parsovani, 1, typ);
    }
    const strany = { 1: WOO(100, 'obchod.sk', 'a'), 2: WOO(100, 'obchod.sk', 'b'), 3: WOO(7, 'obchod.sk', 'c') };
    parsovani = 0;
    JSON.stringify = (...a) => { stringifikacii += 1; return stringify(...a); };
    const r = await fetchFeed('https://obchod.sk/wp-json/wc/store/v1/products', { fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => strany[new URL(url).searchParams.get('page')] }) });
    JSON.stringify = stringify;
    assert.equal(r.products.length, 207);
    assert.equal(parsovani, 3, 'jedno parsovanie na stranu');
    assert.equal(stringifikacii, 0, 'žiadne JSON.stringify');
  } finally {
    JSON.parse = parse;
    JSON.stringify = stringify;
  }
  // Strop objektov: tesne pod prejde, nad nie; reťazce so zátvorkami sa rátajú tiež (radšej viac).
  assert.equal(parsujJsonSoStropom('[' + '{},'.repeat(MAX_JSON_OBJEKTOV - 2) + '{}]').length, MAX_JSON_OBJEKTOV - 1);
  for (const zly of ['[' + '{},'.repeat(MAX_JSON_OBJEKTOV) + '{}]', '['.repeat(MAX_JSON_OBJEKTOV + 1), '[' + '[],'.repeat(MAX_JSON_OBJEKTOV) + '[]]', JSON.stringify(['{'.repeat(MAX_JSON_OBJEKTOV + 1)])]) {
    assert.throws(() => parsujJsonSoStropom(zly), (e) => e.message === FEED_CHYBY.PRILIS_VELKY);
  }
  assert.throws(() => parsujJsonSoStropom(' '.repeat(MAX_JSON_NA_STRANU + 1) + '[]'), (e) => e.message === FEED_CHYBY.PRILIS_VELKY);
  const cisla = '[' + '0,'.repeat(500000) + '0]';
  assert.equal(parsujJsonSoStropom(cisla).length, 500001);
  const r = parseFeed(cisla, 'https://obchod.sk/x.json');
  assert.equal(r.products.length, 0, 'čísla nie sú produkty, nič nespadne');
  assert.equal(detectFeedType('[' + '{},'.repeat(MAX_JSON_OBJEKTOV) + '{}]'), null);
  assert.throws(() => parseFeed('[' + '{},'.repeat(MAX_JSON_OBJEKTOV) + '{}]', 'https://obchod.sk/x.json'), (e) => classifyFeedError(e) === 'feed_too_large');
});

// ===========================================================================
// E. Nočný cron
// ===========================================================================

test('E1. celkový časový strop nočnej obnovy: po ňom sa ďalšie načítanie nezačne (preskocene: cas), pre rôzne tempá; strop je pod 15 minútami Cloudflare', async () => {
  assert.ok(CRON_CAS_SPOLU_MS > 0 && CRON_CAS_SPOLU_MS < 15 * 60 * 1000);
  for (const [krokMin, cakamOk] of [[1, 6], [3, 3], [4, 2], [11, 0], [0, 6]]) {
    const env = makeEnv();
    for (let i = 0; i < 6; i++) await readyObchod(env, { domain: `c${i}.sk` });
    let cas = 0;
    const hodiny = () => { const t = cas; cas += krokMin * 60 * 1000; return t; };
    const v = await refreshAllFeeds(env, { hodiny });
    assert.equal(v.filter((x) => x.ok).length, cakamOk, `krok ${krokMin} min`);
    assert.equal(v.filter((x) => x.preskocene === 'cas').length, 6 - cakamOk, `krok ${krokMin} min`);
  }
});

test('E2. denná údržba beží pred obnovou a nezávisle od nej: ani chyba zoznamu obchodov, ani zlyhanie údržby nezastaví druhú časť', async () => {
  const env = makeEnv();
  await readyObchod(env, { domain: 'udrzba.sk' });
  const dopyty = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { dopyty.push(sql); return prepare(sql); };
  const v = await dennyBeh(env);
  assert.equal(v.length, 1);
  const udrzba = dopyty.findIndex((s) => /DELETE FROM tenant_udalosti WHERE kedy/.test(s));
  const zoznam = dopyty.indexOf(SQL.LIST_TENANTS);
  assert.ok(udrzba >= 0 && zoznam > udrzba, `údržba (${udrzba}) pred obnovou (${zoznam})`);

  // Zoznam obchodov padne: údržba aj tak zbehla, beh vráti prázdny výsledok bez výnimky.
  dopyty.length = 0;
  env.DB.prepare = (sql) => { dopyty.push(sql); if (sql === SQL.LIST_TENANTS) throw new Error('D1 dole'); return prepare(sql); };
  assert.deepEqual(await dennyBeh(env), []);
  assert.ok(dopyty.some((s) => /DELETE FROM tenant_udalosti WHERE kedy/.test(s)));
  // Údržba a mazanie počítadiel padnú: obnova aj tak zbehne.
  env.DB.prepare = (sql) => { if (/tenant_udalosti|asistent_pocty|asistent_strop/.test(sql) && /DELETE/.test(sql)) throw new Error('D1 dole'); return prepare(sql); };
  const v2 = await dennyBeh(env);
  assert.equal(v2.length, 1);
  assert.equal(v2[0].ok, true);
});

test('E3. poradie obnovy: platiace, bežiace obchody, bežiace ukážky, nové, odložené na konci; odložené cudzie feedy bez rezervácie nepredbehnú ostatných a nič neprečerpajú', async () => {
  const velky = (host) => XML(300, host, 'v');
  const env = makeEnv({ fetchImpl: async (url) => { const h = new URL(url).hostname; return { ok: true, status: 200, text: async () => (h.startsWith('odlozeny') ? velky(h) : XML(3, h)) }; } });
  const zaloz = async (domain, stav, uprav = {}) => {
    const t = await createTenant(env.DB, { domain, feedUrl: `https://${domain}/feed.xml`, contactEmail: `a@${domain}` });
    await setTenantStatus(env.DB, t.id, stav);
    Object.assign(env.DB._tenants.get(t.id), uprav);
    return t.id;
  };
  // Poradie v D1 je naschvál opačné: odložené prvé.
  const odl1 = await zaloz('odlozeny1.sk', 'error');
  const odl2 = await zaloz('odlozeny2.sk', 'error');
  for (const id of [odl1, odl2]) await env.ASISTENT_CACHE.put(`ingest-error:${id}`, 'ai_budget_exhausted');
  const novy = await zaloz('novy.sk', 'pending');
  const ukazka = await zaloz('ukazka-oslovenia.sk', 'ready', { zdroj: 'oslovenie' });
  const zakaznik = await zaloz('zakaznik.sk', 'ready');
  const platiaci = await zaloz('platiaci.sk', 'ready', { plan: 'starter' });
  const poradie = (await poradieObnovy(env, [...env.DB._tenants.values()])).map((t) => t.id);
  assert.deepEqual(poradie, [platiaci, zakaznik, ukazka, novy, odl1, odl2]);

  // Rozpočet: štyri malé feedy a nový obchod sa zmestia, veľké odložené nie.
  const den = new Date().toISOString().slice(0, 10);
  env.AI_DAILY_OBNOVA_BUDGET = '2';
  const v = await refreshAllFeeds(env);
  const podla = Object.fromEntries(v.map((x) => [x.tenantId, x]));
  for (const id of [platiaci, zakaznik, ukazka, novy]) assert.equal(podla[id].ok, true, id);
  for (const id of [odl1, odl2]) {
    assert.notEqual(podla[id].ok, true, id);
    assert.equal(vektoryObchodu(env, id).length, 0, `${id}: žiadne vektory`);
  }
  const spotreba = (env.DB._pocty.get(kluce.obnova(den)) || { hodnota: 0 }).hodnota;
  assert.ok(spotreba <= 2000, `spotreba ${spotreba} v rámci rozpočtu`);
});

// ===========================================================================
// F. Živá ukážka
// ===========================================================================

test('F1. zivaUkazkaPovolena odmietne doménu na úrovni verejnej prípony (každú zo zoznamu aj jednoslovnú), vlastná doména obchodu na platforme a ukážka oslovenia áno', () => {
  for (const d of ['sk', 'com', 'cz', ...VEREJNE_PRIPONY]) {
    assert.equal(zivaUkazkaPovolena({ domain: d, feed_url: `https://utocnik.${d}/feed.xml` }), false, d);
    assert.equal(zivaUkazkaPovolena({ domain: d, feed_url: `https://${d}/feed.xml` }), false, d);
    assert.equal(zivaUkazkaPovolena({ domain: `obchod.${d}`, feed_url: `https://obchod.${d}/feed.xml` }), true, d);
    assert.equal(zivaUkazkaPovolena({ domain: `obchod.${d}`, feed_url: `https://ine.${d}/feed.xml` }), false, d);
    assert.equal(zivaUkazkaPovolena({ domain: d, feed_url: `https://x.${d}/f.json`, zdroj: 'oslovenie' }), true, d);
  }
});

class LiveEl {
  constructor(tag, id) {
    this.tagName = tag; this.id = id || ''; this.children = []; this.attrs = {}; this.hidden = false; this._text = '';
    this.className = ''; this.listeners = {}; this.parentNode = null; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    const cls = new Set();
    this.classList = { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { this.textContent = String(v).replace(/<[^>]+>/g, ''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
}

const LIVE_SRC = fs.readFileSync(path.join(HUB, 'live', 'live.js'), 'utf8');
const DEMO = 'ce535d37-f297-4b43-89dd-30aa7b6301dd';
const CUDZI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function ziva({ hladanie, status = null, skusky = null, jazyk = 'sk-SK' }) {
  const ids = {};
  const el = (id) => (ids[id] = ids[id] || new LiveEl('div', id));
  for (const id of ['otazky', 'akcie-chyba', 'missing', 'otazky-pozn']) el(id).hidden = true;
  const body = new LiveEl('body');
  const listeners = {};
  const sledovane = [];
  const casovace = [];
  const document = {
    title: '', body, documentElement: { lang: 'sk' },
    getElementById: (id) => el(id), createElement: (tag) => new LiveEl(tag), createTextNode: (t) => { const n = new LiveEl('#text'); n.textContent = t; return n; },
    querySelectorAll: () => [], addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, dispatchEvent: (e) => { for (const f of listeners[e.type] || []) f(e); return true; },
  };
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const uloziste = new Map(skusky ? [['arling_asistent_skusky', JSON.stringify(skusky)]] : []);
  const window = { localStorage: { getItem: (k) => (uloziste.has(k) ? uloziste.get(k) : null), setItem: (k, v) => uloziste.set(k, v), removeItem: (k) => uloziste.delete(k) }, umami: { track: (e, d) => sledovane.push(JSON.parse(JSON.stringify({ e, d }))) } }; // objekty z vm do tohto sveta (deepEqual porovnáva prototypy)
  let volani = 0;
  const fetch = async () => {
    volani += 1;
    const o = typeof status === 'function' ? status(volani) : status;
    if (o instanceof Error) throw o;
    if (typeof o === 'number') return { ok: o < 400, status: o, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => o };
  };
  const kontext = { window, document, fetch, URLSearchParams, CustomEvent, JSON, String, Math, Array, location: { search: hladanie }, navigator: { language: jazyk }, setTimeout: (f, ms) => { casovace.push({ f, ms }); return casovace.length; }, clearTimeout: () => {}, console };
  kontext.window.document = document;
  vm.createContext(kontext);
  vm.runInContext(LIVE_SRC, kontext);
  const pockaj = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await pockaj();
  const skripty = () => body.children.filter((c) => c.tagName === 'script');
  const spustiCasovac = async (ms) => { for (const c of casovace.filter((x) => x.ms === ms)) c.f(); await pockaj(); };
  return { ids, sledovane, skripty, spustiCasovac, pockaj };
}

const VSEOB = ['Čo mi odporučíte ako darček?', 'Máte niečo pre začiatočníka?', 'Čo sa hodí na každodenné použitie?'];

test('F2. otázky z odkazu (?q=) len pre ukážkový obchod a ukážku osloveného obchodu; vlastná skúška, live_demo aj výpadok servera majú všeobecné otázky; Umami live_obchod s druhom pre každú povolenú ukážku', async () => {
  const q = '&q=Pod%C4%BEa%20v%C3%A1s%20najlep%C5%A1%C3%AD&q=Druh%C3%A1';
  const zOdkazu = ['Podľa vás najlepší', 'Druhá'];
  for (const tenant of [DEMO, CUDZI]) {
    for (const skusky of [null, [CUDZI]]) {
      for (const live_demo of [false, true]) {
        for (const outreach_demo of [false, true]) {
          for (const sOtazkami of [true, false]) {
            const popis = JSON.stringify({ tenant, skusky, live_demo, outreach_demo, sOtazkami });
            const s = await ziva({ hladanie: `?t=${tenant}${sOtazkami ? q : ''}`, skusky, status: { domain: 'overeny.sk', status: 'ready', live_demo, outreach_demo } });
            const smie = tenant === DEMO || (skusky || []).includes(tenant) || live_demo || outreach_demo;
            if (!smie) {
              assert.equal(s.skripty().length, 0, popis);
              assert.deepEqual(s.sledovane.map((x) => x.e), ['live_nepovolena'], popis);
              continue;
            }
            const otazky = JSON.parse(s.skripty()[0].getAttribute('data-questions'));
            const odkazSmie = tenant === DEMO || outreach_demo;
            assert.deepEqual(otazky, odkazSmie && sOtazkami ? zOdkazu : VSEOB, popis);
            const druh = tenant === DEMO ? 'demo' : outreach_demo ? 'outreach' : (skusky || []).includes(tenant) ? 'skuska' : 'live_demo';
            assert.deepEqual(s.sledovane, [{ e: 'live_obchod', d: { druh } }], popis);
          }
        }
      }
    }
  }
  // Výpadok servera: ukážkový obchod smie otázky z odkazu, vlastná skúška nie.
  for (const [tenant, skusky, cakam] of [[DEMO, null, zOdkazu], [CUDZI, [CUDZI], VSEOB]]) {
    const s = await ziva({ hladanie: `?t=${tenant}${q}`, skusky, status: new Error('siet') });
    assert.deepEqual(JSON.parse(s.skripty()[0].getAttribute('data-questions')), cakam, tenant);
  }
});

test('F3. Umami live_chyba s dôvodom pre každé zlyhanie stavu (sieť, HTTP 5xx, časový limit) aj widgetu (chyba skriptu, časový limit), jedna udalosť na jedno zlyhanie; nepovolená ukážka len live_nepovolena', async () => {
  for (const [popis, status, casovac, dovod] of [
    ['sieť', new Error('siet'), null, 'stav_siet'],
    ['HTTP 500', 500, null, 'stav_http_500'],
    ['HTTP 503', 503, null, 'stav_http_503'],
    ['časový limit stavu', () => new Promise(() => {}), 8000, 'stav_cas'],
  ]) {
    for (const [tenant, skusky] of [[DEMO, null], [CUDZI, [CUDZI]], [CUDZI, null]]) {
      const s = await ziva({ hladanie: `?t=${tenant}`, skusky, status });
      if (casovac) await s.spustiCasovac(casovac);
      const lokalne = tenant === DEMO || !!skusky;
      const chyby = s.sledovane.filter((x) => x.e === 'live_chyba');
      assert.deepEqual(chyby, [{ e: 'live_chyba', d: { dovod } }], `${popis} ${tenant} ${!!skusky}`);
      assert.equal(s.sledovane.some((x) => x.e === 'live_obchod'), lokalne, `${popis} ${tenant}`);
    }
  }
  for (const [popis, zlyhaj, dovod] of [['chyba skriptu', (sk) => sk.onerror(), 'widget_chyba'], ['časový limit widgetu', null, 'widget_cas']]) {
    const s = await ziva({ hladanie: `?t=${CUDZI}`, status: { domain: 'overeny.sk', live_demo: true } });
    const skript = s.skripty()[0];
    if (zlyhaj) zlyhaj(skript);
    await s.spustiCasovac(12000); // aj časovač po chybe skriptu: stále jedna udalosť
    if (zlyhaj) zlyhaj(skript);
    assert.deepEqual(s.sledovane.filter((x) => x.e === 'live_chyba'), [{ e: 'live_chyba', d: { dovod } }], popis);
    assert.equal(s.ids['okno-stav'].getAttribute('data-stav'), 'chyba', popis);
    // Opakovanie a nové zlyhanie: druhá udalosť.
    s.ids['okno-znova'].listeners.click[0]();
    await s.pockaj();
    s.skripty()[0].onerror();
    assert.equal(s.sledovane.filter((x) => x.e === 'live_chyba').length, 2, popis);
  }
});

test('C3. nové kódy feed_too_large a feed_other_domain majú v e-maile E0 vlastný dôvod a radu vo všetkých jazykoch (nie všeobecný text), bez pomlčiek; nie sú chybou na našej strane', () => {
  for (const jazyk of ['sk', 'cs', 'en', 'de', 'fr']) {
    const inak = dovodChyby(jazyk, 'nieco-nove');
    for (const kod of [INGEST_ERRORS.TOO_LARGE, INGEST_ERRORS.OTHER_DOMAIN]) {
      const d = dovodChyby(jazyk, kod);
      assert.ok(d.dovod && d.rada, `${jazyk} ${kod}`);
      assert.notEqual(d.dovod, inak.dovod, `${jazyk} ${kod}`);
      assert.doesNotMatch(d.dovod + d.rada, POMLCKY, `${jazyk} ${kod}`);
      assert.equal(d.nasa, false, kod);
    }
  }
  assert.deepEqual([INGEST_ERRORS.TOO_LARGE, INGEST_ERRORS.OTHER_DOMAIN], ['feed_too_large', 'feed_other_domain']);
});
