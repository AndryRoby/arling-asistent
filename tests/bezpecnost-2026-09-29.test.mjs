// bezpecnost-2026-09-29.test.mjs
//
// Testy k bezpečnostnej kontrole Asistenta z 29. 9. 2026 pred oslovením
// e-shopov (cf-security-audit v režime guidance, nálezy potvrdené nezávislým
// overením). Každý test pokrýva celú triedu vstupov, nie jeden príklad:
//   1. prevzatie a obsadenie cudzieho obchodu cez POST /v1/tenants
//      (onboarding.js: 409 domain_taken, zmeny len overený majiteľ, výnimka
//      čerstvej skúšky),
//   2. e-mail účtu v odpovediach pre návštevníkov (chat.js),
//   3. rozpočet obnovy pri súbežných načítaniach (rezervujObnovu, strop názvu),
//   4. telo feedu bez stropu bajtov a času (feed.js),
//   5. živá ukážka pod cudzím menom (arling-sk/asistent/live, status live_demo),
//   6. adresa homelabu vo verejnom repozitári (demo/), Umami ďalej zapojené.
// Nič nejde na sieť: feed, Stripe aj Resend stoja za env.fetchImpl.

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
  classifyFeedError,
  zivaUkazkaPovolena,
  jeCerstvaSkuska,
  DomainTakenError,
  FeedOtherDomainError,
  DOMENA_OBSADENA_TEXT,
  ODHAD_ZNAKOV_NA_PRODUKT,
  SKUSKA_OPRAVA_MS,
  TENANT_STATUS,
} from '../worker/src/onboarding.js';
import { getTenantById, setTenantStatus, createTenant } from '../worker/src/tenants.js';
import { jazykZoVstupu, zaznamenaj } from '../worker/src/zivotny-cyklus.js';
import { runChat, runChatBezAI, buildUserPrompt, noMatchFallback, bezVypoctuOdpoved } from '../worker/src/chat.js';
import { fetchFeed, guardedFetch, normaliseProduct, parseFeed, FEED_CHYBY, MAX_FEED_BAJTOV, TITLE_MAX_LEN } from '../worker/src/feed.js';
import { znakyProduktov, buildProductChunks } from '../worker/src/embed.js';
import { obnovaZaZnaky } from '../worker/src/budget.js';
import { pripocitaj, kluce } from '../worker/src/pocty.js';
import { vytvorToken } from '../worker/src/ucet.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const TU = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(TU, '..');
const HUB = path.join(REPO, '..', 'arling-sk', 'asistent');

const XML = (n = 1, host = 'obchod.sk') => `<products>${Array.from({ length: n }, (_, i) => `<item><id>${i + 1}</id><name>Kanvica ${i + 1}</name><price>9.99</price><url>https://${host}/p/${i + 1}</url><description>Popis kanvice ${i + 1}.</description></item>`).join('')}</products>`;
const TAJOMSTVO = Buffer.from('tajomstvo-bezpecnost-29-9').toString('base64');

function makeEnv({ feedText = XML(), feedOk = true, extra = {} } = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    UCET_TAJOMSTVO: TAJOMSTVO,
    fetchImpl: async () => ({ ok: feedOk, status: feedOk ? 200 : 500, text: async () => feedText }),
    ...extra,
  };
}

/** Platný Bearer z /v1/ucet/over pre `email` (ten istý postup ako zivotny-cyklus.test.mjs A4). */
async function tokenPre(env, email) {
  await env.ASISTENT_CACHE.put(`ucet:ucet:${email}`, JSON.stringify({ email, vytvorene: new Date().toISOString(), verzia: 1, nakupy: [], predplatne: [] }));
  return vytvorToken(env, { email, verzia: 1 });
}

let ipPoradie = 0;
function tenantReq(body, { token } = {}) {
  ipPoradie += 1; // každá požiadavka z inej siete, limit 10 za hodinu tu nie je predmetom testu
  return new Request('https://arling-asistent.arling.workers.dev/v1/tenants', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://arling.sk',
      'CF-Connecting-IP': `198.18.${(ipPoradie >> 8) & 255}.${ipPoradie & 255}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const cakajNaPozadi = (ulohy) => Promise.allSettled(ulohy.splice(0));

// ===========================================================================
// 1. Prevzatie a obsadenie cudzieho obchodu (onboarding.js)
// ===========================================================================

test('1a. iný e-mail nikdy nedostane id ani údaje obchodu a nič nezmení: feed na doméne obchodu 409 domain_taken, cudzí feed už 400 feed_other_domain (druhé kolo), v jazyku žiadosti, pre všetky cudzie adresy, feedy, jazyky, stavy aj s platným Bearerom inej adresy', async () => {
  const env = makeEnv();
  const ulohy = [];
  const ctx = { waitUntil: (p) => ulohy.push(p) };
  const prvy = await worker.fetch(tenantReq({ feed_url: 'https://obchod.sk/feed.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk', lang: 'sk' }), env, ctx);
  assert.equal(prvy.status, 201);
  const { id } = await prvy.json();
  await cakajNaPozadi(ulohy);
  const tokenCudzi = await tokenPre(env, 'utocnik@example.com');

  const cudzie = ['utocnik@example.com', 'info@obchod.sk', 'majitel@obchod.com', 'majitel@obchod.sk.example', 'majitel+x@obchod.sk'];
  const feedy = ['https://obchod.sk/feed.xml', 'https://utocnik.example/feed.xml'];
  const jazyky = ['sk', 'cs', 'en', 'de', undefined, 'fr_FR'];
  for (const stav of [TENANT_STATUS.READY, TENANT_STATUS.ERROR]) {
    await setTenantStatus(env.DB, id, stav, { now: new Date('2020-01-01T00:00:00Z') }); // aj „stale“, aby by sa inak načítavalo
    const pred = { ...(await getTenantById(env.DB, id)) };
    const aiPred = env.AI.calls.length;
    for (const email of cudzie) {
      for (const feed_url of feedy) {
        for (const lang of jazyky) {
          const token = email === 'utocnik@example.com' ? tokenCudzi : undefined;
          const res = await worker.fetch(tenantReq({ feed_url, domain: 'obchod.sk', email, lang, zdroj: 'formular' }, { token }), env, ctx);
          await cakajNaPozadi(ulohy);
          const popis = `${stav} ${email} ${feed_url} ${lang}`;
          const naDomene = feed_url.startsWith('https://obchod.sk/');
          assert.equal(res.status, naDomene ? 409 : 400, popis);
          const telo = await res.json();
          assert.deepEqual(Object.keys(telo).sort(), ['error', 'issues'], popis);
          assert.equal(telo.error, naDomene ? 'domain_taken' : 'feed_other_domain', popis);
          const jazyk = jazykZoVstupu(lang) || 'en';
          const veta = naDomene ? DOMENA_OBSADENA_TEXT[jazyk] || DOMENA_OBSADENA_TEXT.en : new FeedOtherDomainError('obchod.sk', jazykZoVstupu(lang)).sprava;
          assert.equal(telo.issues[0], veta, popis);
          const surove = JSON.stringify(telo);
          for (const zakazane of [id, 'majitel@obchod.sk', email]) assert.ok(!surove.includes(zakazane), `${popis}: ${zakazane}`);
          assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://arling.sk', popis);
        }
      }
    }
    const po = await getTenantById(env.DB, id);
    assert.deepEqual(
      { feed_url: po.feed_url, jazyk: po.jazyk, status: po.status, last: po.last_ingested_at },
      { feed_url: pred.feed_url, jazyk: pred.jazyk, status: pred.status, last: pred.last_ingested_at },
      stav
    );
    assert.equal(env.AI.calls.length, aiPred, `${stav}: žiadne načítanie`);
  }
  assert.equal(DOMENA_OBSADENA_TEXT.sk.includes('@arling.sk') && DOMENA_OBSADENA_TEXT.en.includes('support@arling.sk'), true);
});

test('1b. majiteľ bez platného Bearera zdravý ready nemení; cudzí feed nikdy, jazyk len s platným Bearerom', async () => {
  const env = makeEnv();
  const ulohy = [];
  const ctx = { waitUntil: (p) => ulohy.push(p) };
  const prvy = await worker.fetch(tenantReq({ feed_url: 'https://obchod.sk/feed.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk', lang: 'sk' }), env, ctx);
  const { id } = await prvy.json();
  await cakajNaPozadi(ulohy);
  assert.equal((await getTenantById(env.DB, id)).status, TENANT_STATUS.READY);

  // Store API (plugin) odpovedá JSON, ostatné adresy XML.
  const woo = JSON.stringify([{ id: 7, name: 'Kanvica W', permalink: 'https://obchod.sk/p/w7', prices: { price: '990', currency_code: 'EUR', currency_minor_unit: 2 } }]);
  env.fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes('rest_route') ? woo : XML()) });
  const tokenCudzi = await tokenPre(env, 'iny@example.com');
  const bearery = [undefined, 'podvrh.token', tokenCudzi];
  const adresy = ['majitel@obchod.sk', ' Majitel@Obchod.SK '];
  const feedy = ['https://obchod.sk/feed.xml', 'https://obchod.sk/iny-feed.xml', 'https://www.obchod.sk/?rest_route=/wc/store/v1/products', 'https://feed.obchod.sk/x.xml', 'https://utocnik.example/feed.xml', 'https://obchod.sk.utocnik.example/feed.xml'];
  for (const token of bearery) {
    for (const email of adresy) {
      for (const feed_url of feedy) {
        env.DB._tenants.get(id).feed_url = 'https://obchod.sk/feed.xml';
        const res = await worker.fetch(tenantReq({ feed_url, domain: 'obchod.sk', email, lang: 'de' }, { token }), env, ctx);
        await cakajNaPozadi(ulohy);
        const popis = `${token ? token.slice(0, 6) : 'bez'} ${email} ${feed_url}`;
        const naDomene = /^https:\/\/(www\.|feed\.)?obchod\.sk\//.test(feed_url);
        const riadok = await getTenantById(env.DB, id);
        assert.equal(riadok.jazyk, 'sk', popis);
        assert.equal(riadok.status, TENANT_STATUS.READY, popis);
        if (!naDomene) {
          assert.equal(res.status, 400, popis);
          assert.equal((await res.json()).error, 'feed_other_domain', popis);
          assert.equal(riadok.feed_url, 'https://obchod.sk/feed.xml', popis);
          continue;
        }
        assert.equal(res.status, 200, popis);
        const telo = await res.json();
        assert.equal(telo.id, id, popis);
        assert.equal(telo.existing, true, popis);
        assert.equal(telo.overeny, false, popis);
        assert.equal(telo.feed_treba_overit, feed_url === 'https://obchod.sk/feed.xml' ? undefined : true, popis);
        assert.equal(riadok.feed_url, 'https://obchod.sk/feed.xml', `${popis}: zdravý ready ostáva bez zmeny`);
      }
    }
  }

  const token = await tokenPre(env, 'majitel@obchod.sk');
  const cudzi = await worker.fetch(tenantReq({ feed_url: 'https://utocnik.example/feed.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk', lang: 'en' }, { token }), env, ctx);
  assert.equal(cudzi.status, 400, 'ani overený majiteľ nedá cudzí feed');
  const aiPred = env.AI.calls.length;
  const res = await worker.fetch(tenantReq({ feed_url: 'https://obchod.sk/novy-feed.xml', domain: 'obchod.sk', email: 'Majitel@obchod.sk', lang: 'en' }, { token }), env, ctx);
  await cakajNaPozadi(ulohy);
  const telo = await res.json();
  assert.equal(res.status, 200);
  assert.equal(telo.overeny, true);
  assert.equal(telo.feed_treba_overit, undefined);
  const riadok = await getTenantById(env.DB, id);
  assert.equal(riadok.feed_url, 'https://obchod.sk/novy-feed.xml');
  assert.equal(riadok.jazyk, 'en');
  assert.ok(env.AI.calls.length > aiPred, 'nový feed sa načítal');
});

test('1c. čerstvá skúška rozhoduje už len o jazyku (druhé kolo): feed bez Bearera opraví v error alebo pending, jazyk len kým obchod nikdy nebol ready a vznikol pred menej ako 24 h; cudzí feed ani v okne 24 h, ani počas pending', async () => {
  const HODINA = 60 * 60 * 1000;
  async function skuska({ feedOk = false } = {}) {
    const env = makeEnv({ feedOk });
    const t = await createTenantFromRequest(env, { feedUrl: 'https://obchod.sk/zly.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk', lang: 'sk' });
    return { env, t };
  }
  const opravi = async (env, { now, email = 'majitel@obchod.sk' } = {}) =>
    createTenantFromRequest(env, { feedUrl: 'https://obchod.sk/spravny.xml', domain: 'obchod.sk', email, lang: 'cs' }, { now });

  // Smie: nikdy ready (error aj pending), bez produktov, bez udalosti ready, do 24 h.
  for (const [popis, posun, stav] of [
    ['hneď po chybe', 0, null],
    ['o hodinu', HODINA, null],
    ['tesne pred 24 h', SKUSKA_OPRAVA_MS - 1000, null],
    ['pending, nikdy nebežal', HODINA, TENANT_STATUS.PENDING],
  ]) {
    const { env, t } = await skuska();
    if (stav) await setTenantStatus(env.DB, t.id, stav);
    env.fetchImpl = makeEnv().fetchImpl; // feed je opravený
    const r = await opravi(env, { now: new Date(Date.now() + posun) });
    assert.equal(r.feed_treba_overit, undefined, popis);
    const riadok = await getTenantById(env.DB, t.id);
    assert.equal(riadok.feed_url, 'https://obchod.sk/spravny.xml', popis);
    assert.equal(riadok.jazyk, 'cs', popis);
    assert.equal(riadok.status, TENANT_STATUS.READY, popis);
  }

  // Jazyk nie (24 h a viac, obchod už bol ready: stav, produkty alebo udalosť), feed z domény obchodu áno.
  const nesmie = [
    ['po 24 h', async () => { const s = await skuska(); return { ...s, now: new Date(Date.now() + SKUSKA_OPRAVA_MS) }; }],
    ['po 30 dňoch', async () => { const s = await skuska(); return { ...s, now: new Date(Date.now() + 30 * 24 * HODINA) }; }],
    ['ready', async () => { const s = await skuska({ feedOk: true }); return { ...s, now: new Date() }; }],
    ['bol ready, teraz chyba', async () => {
      const s = await skuska({ feedOk: true });
      await setTenantStatus(s.env.DB, s.t.id, TENANT_STATUS.ERROR);
      return { ...s, now: new Date() };
    }],
    ['udalosť ready bez produktov', async () => {
      const s = await skuska();
      await zaznamenaj(s.env, s.t.id, 'ready', 'ready', { product_count: 1 });
      return { ...s, now: new Date() };
    }],
    ['produkty bez udalosti', async () => {
      const s = await skuska();
      s.env.DB._tenants.get(s.t.id).product_count = 3;
      return { ...s, now: new Date() };
    }],
  ];
  for (const [popis, priprav] of nesmie) {
    const { env, t, now } = await priprav();
    env.fetchImpl = makeEnv().fetchImpl;
    const pred = { ...(await getTenantById(env.DB, t.id)) };
    const r = await opravi(env, { now });
    const bezi = pred.status === TENANT_STATUS.READY;
    assert.equal(r.feed_treba_overit, bezi ? true : undefined, popis);
    assert.equal(r.id, t.id, popis);
    const riadok = await getTenantById(env.DB, t.id);
    assert.equal(riadok.feed_url, bezi ? pred.feed_url : 'https://obchod.sk/spravny.xml', popis);
    assert.equal(riadok.jazyk, pred.jazyk, popis);
  }
  const { env } = await skuska();
  await assert.rejects(() => opravi(env, { now: new Date(), email: 'iny@obchod.sk' }), DomainTakenError);
  assert.equal(await jeCerstvaSkuska(env, null), false);

  // Repro 1a z kontroly: majiteľov (verejný) e-mail a cudzí feed v okne 24 h, počas pending aj neskôr.
  for (const [popis, stav, posun] of [['error hneď', null, 0], ['pending', TENANT_STATUS.PENDING, HODINA], ['error po 24 h', null, SKUSKA_OPRAVA_MS + HODINA], ['ready', 'ready', HODINA]]) {
    const { env: e, t } = await skuska();
    if (stav) await setTenantStatus(e.DB, t.id, stav);
    for (const feedUrl of ['https://utocnik.example/feed.xml', 'https://obchod.sk.utocnik.example/f.xml', 'https://utocnikobchod.sk/f.xml']) {
      await assert.rejects(
        () => createTenantFromRequest(e, { feedUrl, domain: 'obchod.sk', email: 'majitel@obchod.sk', lang: 'sk' }, { now: new Date(Date.now() + posun) }),
        FeedOtherDomainError,
        `${popis} ${feedUrl}`
      );
    }
    assert.equal((await getTenantById(e.DB, t.id)).feed_url, 'https://obchod.sk/zly.xml', popis);
    assert.ok(![...e.VECTORIZE._store.values()].some((v) => String(v.metadata && v.metadata.url).includes('utocnik')), popis);
  }
});

test('1d. plugin 0.4.0 (bez nového vydania): 409 je pre neho chyba s vetou z issues, id sa neuloží a „Reconnected“ sa neukáže', () => {
  const plugin = path.join(REPO, 'wordpress-plugin', 'arling-asistent', 'includes');
  const api = fs.readFileSync(path.join(plugin, 'class-arling-asistent-api.php'), 'utf8');
  const admin = fs.readFileSync(path.join(plugin, 'class-arling-asistent-admin.php'), 'utf8');
  // create_tenant berie za úspech len 200 a 201, ostatné idú cez chybovú vetvu parse_response s issues ako správou.
  assert.match(api, /return self::parse_response\( \$response, array\( 200, 201 \) \);/);
  assert.match(api, /'error'\s*=> isset\( \$body\['error'\] \)/);
  assert.match(api, /'message' => isset\( \$body\['issues'\] \) && is_array\( \$body\['issues'\] \) \? implode\( ', ', \$body\['issues'\] \)/);
  // handle_connect: pri !ok presmeruje s chybou skôr, než uloží tenant id.
  const connect = admin.slice(admin.indexOf('public function handle_connect()'), admin.indexOf('public function handle_retry()'));
  const chyba = connect.indexOf("if ( empty( $result['ok'] ) )");
  assert.ok(chyba > 0 && chyba < connect.indexOf("update_option( 'arling_asistent_tenant_id'"));
  assert.ok(chyba < connect.indexOf('Reconnected to the assistant this shop already had.'));
  assert.match(admin, /__\( 'Could not connect to ARLing Shopping Assistant: %s', 'arling-asistent' \)/);
});

// ===========================================================================
// 2. E-mail účtu v odpovediach pre návštevníkov (chat.js)
// ===========================================================================

const EMAIL_UCTU = 'sukromny.admin@gmail.com';

test('2a. žiadna odpoveď bez výsledku (prázdna otázka, bez kandidátov, prázdna, zlá či zacyklená odpoveď modelu, bez modelu, bez výpočtu) v žiadnom jazyku neukáže e-mail účtu a model ho nedostane', async () => {
  const tenant = { id: 't', domain: 'obchod.sk', contact_email: EMAIL_UCTU, last_ingested_at: '2020-01-01T00:00:00.000Z', status: 'ready' };
  const sKandidatom = async () => {
    const v = createMockVectorize();
    await v.upsert([{ id: 't::p::0', values: [1, 0, 0, 0], metadata: { tenant: 't', productId: 'p', title: 'Hrniec', url: 'https://obchod.sk/p', price: 9, currency: 'EUR', availability: 'in_stock' } }]);
    return v;
  };
  const modely = ['', '   ', JSON.stringify({ answer: '', products: [] }), JSON.stringify({ answer: 'the the the the the the the the', products: [] })];
  for (const lang of ['sk', 'cs', 'en', 'de', 'auto', 'fr']) {
    for (const otazka of ['', '   ', 'Máte mikrovlnku?', 'Do you sell microwaves?', 'Haben Sie Größe M?']) {
      const odpovede = [];
      odpovede.push((await runChat({ AI: createMockAI({ embedDim: 4 }), VECTORIZE: createMockVectorize() }, { tenant, messages: [{ role: 'user', content: otazka }], lang })).answer);
      for (const model of modely) {
        const ai = createMockAI({ embedDim: 4, chatResponse: model });
        odpovede.push((await runChat({ AI: ai, VECTORIZE: await sKandidatom() }, { tenant, messages: [{ role: 'user', content: otazka }], lang })).answer);
        for (const c of ai.calls.filter((x) => x.model !== '@cf/baai/bge-m3')) {
          assert.ok(!JSON.stringify(c.input).includes(EMAIL_UCTU), `${lang} prompt`);
        }
      }
      const bezAi = { AI: createMockAI({ embedDim: 4 }), VECTORIZE: createMockVectorize() };
      odpovede.push((await runChatBezAI(bezAi, { tenant, messages: [{ role: 'user', content: otazka }], lang })).answer);
      odpovede.push((await runChatBezAI(bezAi, { tenant, messages: [{ role: 'user', content: otazka }], lang, predVektorom: async () => false })).answer);
      odpovede.push(noMatchFallback(lang, otazka).answer, bezVypoctuOdpoved(lang, otazka).answer);
      for (const a of odpovede) {
        assert.equal(typeof a, 'string');
        assert.ok(!a.includes(EMAIL_UCTU), `${lang} „${otazka}“: ${a}`);
        assert.ok(!a.includes('@'), `${lang} „${otazka}“: ${a}`);
      }
    }
  }
  // Prompt nenesie e-mail, ani keď ho volajúci omylom podá.
  for (const contactEmail of [EMAIL_UCTU, 'info@obchod.sk', '']) {
    const prompt = buildUserPrompt({ question: 'x', candidates: [], contactEmail, lang: 'auto' });
    assert.ok(!/@|contact_email/.test(prompt), prompt);
    assert.match(prompt, /shop_contact: the contact page on the shop's own website/);
  }
});

test('2b. repro z nálezu: POST /v1/chat s prázdnou otázkou z Origin obchodu (aj curl) už e-mail majiteľa nevráti', async () => {
  const env = makeEnv();
  const t = await createTenant(env.DB, { domain: 'obchod.sk', feedUrl: 'https://obchod.sk/feed.xml', contactEmail: EMAIL_UCTU });
  await setTenantStatus(env.DB, t.id, 'ready', { now: new Date('2020-01-01T00:00:00Z') });
  for (const [i, obsah] of [' ', '', 'nesúvisiaca otázka o počasí', 'weather?'].entries()) {
    for (const lang of ['sk', 'en', 'de', 'cs', 'auto']) {
      const res = await worker.fetch(new Request('https://arling-asistent.arling.workers.dev/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://obchod.sk', 'CF-Connecting-IP': `203.0.113.${i * 10 + lang.length}` },
        body: JSON.stringify({ tenant: t.id, messages: [{ role: 'user', content: obsah }], lang }),
      }), env, {});
      const text = await res.text();
      assert.ok(!text.includes(EMAIL_UCTU), `${lang} „${obsah}“: ${text}`);
    }
  }
});

// ===========================================================================
// 3. Rozpočet obnovy: súbeh, presná rezervácia, strop názvu
// ===========================================================================

async function nakladFeedu(feedText, host = 'obchod.sk') {
  const { products } = parseFeed(feedText, `https://${host}/feed.xml`);
  return obnovaZaZnaky(znakyProduktov(products));
}

test('3a. súbežné samoobslužné načítania nikdy neprekročia denný rozpočet obnovy: prejde presne toľko feedov, koľko sa zmestí, pre rôzne počty súbežných a stropy', async () => {
  const feed = XML(40);
  const naklad = await nakladFeedu(feed);
  assert.ok(naklad > 0);
  for (const n of [2, 5, 9]) {
    for (const zmesti of [0, 1, 2, n]) {
      const env = makeEnv({ feedText: feed });
      // Pomalé vektory: bez atomickej rezervácie by všetky prečítali tú istú nulovú spotrebu.
      const beh = env.AI.run.bind(env.AI);
      env.AI.run = async (...a) => { await new Promise((r) => setTimeout(r, 2)); return beh(...a); };
      env.AI_DAILY_OBNOVA_BUDGET = String((zmesti * naklad + naklad / 2) / 1000);
      const ulohy = [];
      const tenanty = await Promise.all(Array.from({ length: n }, (_, i) =>
        createTenantFromRequest(env, { feedUrl: `https://obchod${i}.sk/feed.xml`, domain: `obchod${i}.sk`, email: `a@obchod${i}.sk` }, { waitUntil: (p) => ulohy.push(p) })));
      const vysledky = await Promise.all(ulohy);
      const ok = vysledky.filter((v) => v && v.ok).length;
      const popis = `n=${n} zmesti=${zmesti}`;
      assert.equal(ok, Math.min(n, zmesti), popis);
      assert.ok(vysledky.filter((v) => v && !v.ok).every((v) => v.code === 'ai_budget_exhausted'), popis);
      const den = new Date().toISOString().slice(0, 10);
      const spotreba = (env.DB._pocty.get(kluce.obnova(den)) || { hodnota: 0 }).hodnota;
      assert.ok(spotreba <= Math.floor(Number(env.AI_DAILY_OBNOVA_BUDGET) * 1000), `${popis}: ${spotreba}`);
      assert.equal(spotreba, ok * naklad, `${popis}: rezervácia = skutočnosť, nič dvakrát`);
      for (const t of tenanty) {
        const r = await getTenantById(env.DB, t.id);
        assert.ok([TENANT_STATUS.READY, TENANT_STATUS.ERROR].includes(r.status), popis);
      }
    }
  }
});

test('3b. obchod, ktorý už beží, ostane ready, keď majiteľovo opätovné načítanie narazí na vyčerpaný rozpočet', async () => {
  for (const kluc of ['obnova', 'neurony']) {
    const env = makeEnv();
    const t = await createTenantFromRequest(env, { feedUrl: 'https://obchod.sk/feed.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk' });
    assert.equal((await getTenantById(env.DB, t.id)).status, TENANT_STATUS.READY);
    env.DB._tenants.get(t.id).last_ingested_at = '2020-01-01T00:00:00.000Z';
    const den = new Date().toISOString().slice(0, 10);
    await pripocitaj(env.DB, kluc === 'obnova' ? kluce.obnova(den) : kluce.neurony(den), den, 1e9);
    const aiPred = env.AI.calls.length;
    await createTenantFromRequest(env, { feedUrl: 'https://obchod.sk/feed.xml', domain: 'obchod.sk', email: 'majitel@obchod.sk' });
    assert.equal((await getTenantById(env.DB, t.id)).status, TENANT_STATUS.READY, kluc);
    assert.equal(env.AI.calls.length, aiPred, `${kluc}: žiadne vektory`);
  }
  // Nový obchod pri vyčerpanom rozpočte dostane error s kódom, ako doteraz.
  const env = makeEnv();
  const den = new Date().toISOString().slice(0, 10);
  await pripocitaj(env.DB, kluce.obnova(den), den, 1e9);
  const t = await createTenantFromRequest(env, { feedUrl: 'https://novy.sk/feed.xml', domain: 'novy.sk', email: 'a@novy.sk' });
  const status = await tenantStatusResponse(env, t.id);
  assert.equal(status.status, TENANT_STATUS.ERROR);
  assert.equal(status.last_error, 'ai_budget_exhausted');
});

test('3c. strop názvu: pre každú dĺžku názvu a popisu je produkt jeden kus textu do ODHAD_ZNAKOV_NA_PRODUKT, id zo surového názvu do 2 000 znakov', () => {
  for (const dlzkaNazvu of [1, 50, 179, 180, 181, 250, 1000, 20000]) {
    for (const dlzkaPopisu of [0, 10, 599, 600, 601, 5000]) {
      for (const sMedzerami of [false, true]) {
        const znak = sMedzerami ? 'ab ' : 'č';
        const title = znak.repeat(Math.ceil(dlzkaNazvu / znak.length)).slice(0, dlzkaNazvu).trim() || 'x';
        const description = 'p '.repeat(Math.ceil(dlzkaPopisu / 2)).slice(0, dlzkaPopisu);
        for (const rawId of ['', 'SKU-1']) {
          const p = normaliseProduct({ id: rawId, title, description });
          const popis = `${dlzkaNazvu}/${dlzkaPopisu}/${sMedzerami}/${rawId}`;
          assert.ok(p.title.length <= TITLE_MAX_LEN + 1, popis);
          assert.equal(buildProductChunks(p).length, 1, popis);
          assert.ok(znakyProduktov([p]) <= ODHAD_ZNAKOV_NA_PRODUKT, `${popis}: ${znakyProduktov([p])}`);
          assert.equal(p.id, rawId || title.slice(0, 2000).trim(), popis);
          if (title.length <= TITLE_MAX_LEN) assert.equal(p.title, title, popis);
        }
      }
    }
  }
});

// ===========================================================================
// 4. Telo feedu: strop bajtov a čas (feed.js)
// ===========================================================================

function prud({ kus = 64 * 1024, kusov = Infinity, obsah = 'a', pomaly = false, zaciatok = '' } = {}) {
  const stav = { vytiahnute: 0, kusov: 0 };
  const enc = new TextEncoder();
  const blok = enc.encode(obsah.repeat(Math.ceil(kus / obsah.length)).slice(0, kus));
  const stream = new ReadableStream({
    start(c) { if (zaciatok) { const z = enc.encode(zaciatok); stav.vytiahnute += z.byteLength; c.enqueue(z); } },
    pull(c) {
      if (pomaly) return new Promise(() => {}); // nikdy nič ďalšie
      if (stav.kusov >= kusov) { c.close(); return undefined; }
      stav.kusov += 1;
      stav.vytiahnute += blok.byteLength;
      c.enqueue(blok);
      return undefined;
    },
  });
  return { stream, stav };
}

test('4a. telo nad stropom sa prestane čítať pri strope a skončí ako feed_too_large (druhé kolo, predtým feed_not_readable), pre rôzne veľkosti, tvary odpovede aj predvolený strop 20 MB', async () => {
  const limit = 256 * 1024;
  const kus = 16 * 1024;
  for (const kusov of [Infinity, 17, 1000]) {
    const { stream, stav } = prud({ kus, kusov });
    const fetchImpl = async () => new Response(stream, { status: 200 });
    await assert.rejects(() => fetchFeed('https://obchod.sk/feed.xml', { fetchImpl, maxBajtov: limit }), (e) => e.message === FEED_CHYBY.PRILIS_VELKY && classifyFeedError(e) === 'feed_too_large');
    assert.ok(stav.vytiahnute <= limit + 2 * kus, `vytiahnuté ${stav.vytiahnute}`);
  }
  // Telo presne na strope a pod ním sa načíta.
  const xml = XML(3);
  for (const maxBajtov of [new TextEncoder().encode(xml).byteLength, 10 * 1024 * 1024]) {
    const r = await fetchFeed('https://obchod.sk/feed.xml', { fetchImpl: async () => new Response(xml, { status: 200 }), maxBajtov });
    assert.equal(r.products.length, 3);
  }
  // Odpoveď len s text() (bez prúdu) nad stropom.
  await assert.rejects(() => fetchFeed('https://obchod.sk/feed.xml', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(limit + 1) }), maxBajtov: limit }), (e) => e.message === FEED_CHYBY.PRILIS_VELKY);
  // Predvolený strop: nekonečný prúd sa zastaví pri MAX_FEED_BAJTOV.
  const { stream, stav } = prud({ kus: 1024 * 1024 });
  await assert.rejects(() => fetchFeed('https://obchod.sk/feed.xml', { fetchImpl: async () => new Response(stream, { status: 200 }) }), (e) => e.message === FEED_CHYBY.PRILIS_VELKY);
  assert.ok(stav.vytiahnute <= MAX_FEED_BAJTOV + 2 * 1024 * 1024, `vytiahnuté ${stav.vytiahnute}`);
});

test('4b. pomalé telo, pomalá odpoveď aj pomalé presmerovanie skončia po časovom limite ako feed_unreachable, bez visenia', async () => {
  const pripady = {
    'telo sa zasekne': async () => new Response(prud({ pomaly: true, zaciatok: '<products>' }).stream, { status: 200 }),
    'odpoveď nepríde': () => new Promise(() => {}),
    'presmerovanie, potom nič': (() => { let n = 0; return (url) => (n++ === 0 ? Promise.resolve({ ok: false, status: 302, headers: new Headers({ location: 'https://www.obchod.sk/feed.xml' }), text: async () => '' }) : new Promise(() => {})); })(),
  };
  for (const [popis, fetchImpl] of Object.entries(pripady)) {
    const start = Date.now();
    await assert.rejects(() => fetchFeed('https://obchod.sk/feed.xml', { fetchImpl, casMs: 60 }), (e) => e.message === FEED_CHYBY.CAS && classifyFeedError(e) === 'feed_unreachable', popis);
    assert.ok(Date.now() - start < 5000, popis);
  }
  // Celkový čas 0: nič sa ani nepošle.
  let volane = 0;
  await assert.rejects(() => fetchFeed('https://obchod.sk/feed.xml', { fetchImpl: async () => { volane += 1; return new Response(XML(), { status: 200 }); }, casSpoluMs: 0 }), (e) => e.message === FEED_CHYBY.CAS);
  assert.equal(volane, 0);
});

test('4c. každý skok guardedFetch dostane signal s časovým limitom a telo presmerovania sa zahodí', async () => {
  const signaly = [];
  let zrusene = 0;
  const fetchImpl = async (url, init) => {
    signaly.push(init.signal);
    if (signaly.length === 1) {
      const res = new Response('presun', { status: 301, headers: { location: 'https://www.obchod.sk/feed.xml' } });
      const cancel = res.body.cancel.bind(res.body);
      res.body.cancel = (...a) => { zrusene += 1; return cancel(...a); };
      return res;
    }
    return new Response(XML(2), { status: 200 });
  };
  const r = await fetchFeed('https://obchod.sk/feed.xml', { fetchImpl });
  assert.equal(r.products.length, 2);
  assert.equal(signaly.length, 2);
  assert.ok(signaly.every((s) => s instanceof AbortSignal));
  assert.equal(zrusene, 1);
  // guardedFetch sám (bez signalu) funguje ako doteraz.
  const res = await guardedFetch('https://obchod.sk/feed.xml', async () => new Response('ok', { status: 200 }));
  assert.equal(res.status, 200);
});

test('4d. stránkovaný JSON (WooCommerce, Shopify): strop bajtov platí pre súčet strán a čas pre každú stranu; prvá strana nad limitom zlyhá, neskoršia len ukončí stránkovanie', async () => {
  const woo = (i) => ({ id: i, name: `Produkt ${i}`, permalink: `https://obchod.sk/p/${i}`, prices: { price: '1990', currency_code: 'EUR', currency_minor_unit: 2 }, is_in_stock: true });
  const shopify = (i) => ({ id: i, title: `Produkt ${i}`, handle: `p-${i}`, variants: [{ price: '19.90', available: true }] });
  for (const [adresa, velkost, tvar, obal] of [
    ['https://obchod.sk/wp-json/wc/store/v1/products', 100, woo, (x) => x],
    ['https://obchod.sk/products.json', 250, shopify, (x) => ({ products: x })],
  ]) {
    const strana1 = JSON.stringify(obal(Array.from({ length: velkost }, (_, i) => tvar(i + 1))));
    const bajty1 = new TextEncoder().encode(strana1).byteLength;
    for (const druha of ['velka', 'pomala']) {
      const fetchImpl = async (url) => {
        const strana = Number(new URL(url).searchParams.get('page'));
        if (strana === 1) return new Response(strana1, { status: 200 });
        if (druha === 'velka') return new Response(prud({ kus: 64 * 1024 }).stream, { status: 200 });
        return new Response(prud({ pomaly: true, zaciatok: '[' }).stream, { status: 200 });
      };
      const r = await fetchFeed(adresa, { fetchImpl, maxBajtov: bajty1 + 100 * 1024, casMs: 60 });
      assert.equal(r.products.length, velkost, `${adresa} ${druha}`);
    }
    await assert.rejects(() => fetchFeed(adresa, { fetchImpl: async () => new Response(strana1, { status: 200 }), maxBajtov: bajty1 - 1 }), (e) => e.message === FEED_CHYBY.PRILIS_VELKY, adresa);
    await assert.rejects(() => fetchFeed(adresa, { fetchImpl: async () => new Response(prud({ pomaly: true, zaciatok: '[' }).stream, { status: 200 }), casMs: 60 }), (e) => e.message === FEED_CHYBY.CAS, adresa);
  }
});

test('4e. načítanie nového obchodu s obrovským feedom bez jediného celého záznamu skončí stavom error a kódom feed_too_large, bez jediného vektora', async () => {
  const env = makeEnv();
  const { stream } = prud({ kus: 1024 * 1024, zaciatok: '<products>' });
  env.fetchImpl = async () => new Response(stream, { status: 200 });
  const t = await createTenant(env.DB, { domain: 'obchod.sk', feedUrl: 'https://obchod.sk/feed.xml', contactEmail: 'a@obchod.sk' });
  const r = await ingestFeedForTenant(env, t, { samoobsluzne: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'feed_too_large');
  assert.equal((await getTenantById(env.DB, t.id)).status, TENANT_STATUS.ERROR);
  assert.equal(env.AI.calls.length, 0);
});

// ===========================================================================
// 5. Živá ukážka (arling-sk/asistent/live) len pre obchody, ktoré to dovolia
// ===========================================================================

test('5a. zivaUkazkaPovolena: áno pre ukážky oslovení a feed na doméne obchodu (aj www a subdoména), nie pre cudzí feed a nič pre neplatné vstupy', () => {
  const ano = [
    { domain: 'obchod.sk', feed_url: 'https://obchod.sk/feed.xml' },
    { domain: 'www.obchod.sk', feed_url: 'https://obchod.sk/feed.xml' },
    { domain: 'obchod.sk', feed_url: 'https://www.obchod.sk/fotky1/xml/heureka_sk.xml' },
    { domain: 'obchod.sk', feed_url: 'https://feed.obchod.sk/x.xml' },
    { domain: 'OBCHOD.sk', feed_url: 'https://obchod.SK/?rest_route=/wc/store/v1/products' },
    { domain: 'cudzi.sk', feed_url: 'https://utocnik.example/feed.xml', zdroj: 'oslovenie' },
  ];
  const nie = [
    { domain: 'obet.sk', feed_url: 'https://utocnik.example/feed.xml' },
    { domain: 'obet.sk', feed_url: 'https://obet.sk.utocnik.example/feed.xml' },
    { domain: 'obet.sk', feed_url: 'https://utocnikobet.sk/feed.xml' },
    { domain: 'shop.obet.sk', feed_url: 'https://obet.sk/feed.xml' },
    { domain: 'obet.sk', feed_url: 'nie-je-adresa' },
    { domain: '', feed_url: 'https://obet.sk/feed.xml' },
    { domain: 'obet.sk', feed_url: 'https://utocnik.example/feed.xml', zdroj: 'formular' },
    null,
  ];
  for (const t of ano) assert.equal(zivaUkazkaPovolena(t), true, JSON.stringify(t));
  for (const t of nie) assert.equal(zivaUkazkaPovolena(t), false, JSON.stringify(t));
});

test('5b. verejný status nesie live_demo a outreach_demo (oslovenie len bez platby), staré polia bez zmeny', async () => {
  const env = makeEnv();
  const vlastny = await createTenantFromRequest(env, { feedUrl: 'https://obchod.sk/feed.xml', domain: 'obchod.sk', email: 'a@obchod.sk' });
  // Cudzí feed sa od druhého kola nezaloží; takýto riadok môže ostať len spred opravy.
  const cudzi = await createTenant(env.DB, { domain: 'obet.sk', feedUrl: 'https://utocnik.example/feed.xml', contactEmail: 'a@utocnik.example' });
  const s1 = await tenantStatusResponse(env, vlastny.id);
  const s2 = await tenantStatusResponse(env, cudzi.id);
  assert.deepEqual([s1.live_demo, s1.outreach_demo], [true, false]);
  assert.deepEqual([s2.live_demo, s2.outreach_demo], [false, false]);
  assert.ok(!JSON.stringify(s2).includes('utocnik.example'), 'adresa feedu sa nezverejní');
  const row = env.DB._tenants.get(cudzi.id);
  row.zdroj = 'oslovenie';
  assert.deepEqual([(await tenantStatusResponse(env, cudzi.id)).live_demo, (await tenantStatusResponse(env, cudzi.id)).outreach_demo], [true, true]);
  row.plan = 'starter';
  assert.equal((await tenantStatusResponse(env, cudzi.id)).outreach_demo, false, 'po platbe už nie ukážka');
});

// ---- falošný DOM pre live.js a stranka.js ----
class El {
  constructor(tag, id) {
    this.tagName = tag; this.id = id || ''; this.children = []; this.attrs = {}; this.hidden = false; this._text = '';
    this.className = ''; this.listeners = {}; this.parentNode = null; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    const cls = new Set();
    this.classList = { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c), _set: cls };
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
const STRANKA_SRC = fs.readFileSync(path.join(HUB, 'live', 'stranka.js'), 'utf8');

async function zivaStranka({ hladanie, status = null, skusky = null, jazyk = 'sk-SK' } = {}) {
  const ids = {};
  const el = (id) => (ids[id] = ids[id] || new El('div', id));
  for (const id of ['otazky', 'akcie-chyba', 'missing', 'otazky-pozn']) el(id).hidden = true;
  const body = new El('body');
  const listeners = {};
  const sledovane = [];
  const volania = [];
  const casovace = [];
  const document = {
    title: 'povodny',
    body,
    documentElement: { lang: 'sk' },
    getElementById: (id) => el(id),
    createElement: (tag) => new El(tag),
    createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; },
    querySelectorAll: () => [],
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent: (e) => { for (const f of listeners[e.type] || []) f(e); return true; },
  };
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const uloziste = new Map(skusky ? [['arling_asistent_skusky', JSON.stringify(skusky)]] : []);
  const window = {
    localStorage: { getItem: (k) => (uloziste.has(k) ? uloziste.get(k) : null), setItem: (k, v) => uloziste.set(k, v), removeItem: (k) => uloziste.delete(k) },
    umami: { track: (e) => sledovane.push(e) },
  };
  const fetch = async (url) => {
    volania.push(String(url));
    const odpoved = typeof status === 'function' ? status(volania.length) : status;
    if (odpoved instanceof Error) throw odpoved;
    if (odpoved === 404) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    return { ok: true, status: 200, json: async () => odpoved };
  };
  const kontext = {
    window, document, fetch, URLSearchParams, CustomEvent, JSON, String, Math, Array,
    location: { search: hladanie },
    navigator: { language: jazyk },
    setTimeout: (f) => { casovace.push(f); return casovace.length; },
    clearTimeout: () => {},
    console,
  };
  kontext.window.document = document;
  vm.createContext(kontext);
  vm.runInContext(LIVE_SRC, kontext);
  vm.runInContext(STRANKA_SRC, kontext);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  const skripty = body.children.filter((c) => c.tagName === 'script');
  const vsetkyTexty = () => [document.title, ...Object.values(ids).map((e) => e.textContent), ...skripty.map((s) => JSON.stringify(s.attrs))].join(' | ');
  const pockaj = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  return { ids, body, skripty, sledovane, volania, document, casovace, vsetkyTexty, pockaj, widgety: () => body.children.filter((c) => c.tagName === 'script') };
}

const DEMO = 'ce535d37-f297-4b43-89dd-30aa7b6301dd';
const CUDZI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('5c. live.js a stranka.js: asistent len pre obchod, ktorý to dovolí; meno vždy zo servera, nikdy z odkazu; text pre oslovený obchod len pri outreach_demo', async () => {
  const pripady = [];
  for (const tenant of [DEMO, CUDZI]) {
    for (const skusky of [null, [CUDZI]]) {
      for (const live_demo of [false, true]) {
        for (const outreach_demo of [false, true]) {
          for (const u of ['', '&u=1']) pripady.push({ tenant, skusky, live_demo, outreach_demo, u });
        }
      }
    }
  }
  for (const p of pripady) {
    const popis = JSON.stringify(p);
    const s = await zivaStranka({
      hladanie: `?t=${p.tenant}&shop=obet-podvrh.sk${p.u}&q=Ot%C3%A1zka`,
      skusky: p.skusky,
      status: { id: p.tenant, domain: 'overeny-obchod.sk', status: 'ready', live_demo: p.live_demo, outreach_demo: p.outreach_demo },
    });
    const smie = p.tenant === DEMO || (p.skusky || []).includes(p.tenant) || p.live_demo || p.outreach_demo;
    assert.ok(!s.vsetkyTexty().includes('obet-podvrh'), `${popis}: meno z odkazu`);
    assert.equal(s.volania.length, 1, popis);
    assert.match(s.volania[0], new RegExp(`/v1/tenants/${p.tenant}/status$`), popis);
    if (smie) {
      assert.equal(s.skripty.length, 1, popis);
      assert.equal(s.skripty[0].getAttribute('data-tenant'), p.tenant, popis);
      assert.equal(s.skripty[0].getAttribute('data-title'), 'overeny-obchod.sk', popis);
      assert.match(s.ids['h1-obchod'].textContent, /Asistent pre overeny-obchod\.sk je pripravený/, popis);
      assert.equal(s.ids['okno-meno'].textContent, 'overeny-obchod.sk', popis);
      assert.equal(s.ids['otazky-pozn'].hidden, !(p.u && p.outreach_demo), `${popis}: text oslovenia`);
      assert.equal(s.ids.missing.hidden, true, popis);
      assert.ok(!s.sledovane.includes('live_nepovolena'), popis);
    } else {
      assert.equal(s.skripty.length, 0, `${popis}: žiadny widget`);
      assert.equal(s.ids.missing.hidden, false, popis);
      assert.match(s.ids.missing.textContent, /Túto ukážku tu nevieme ukázať/, popis);
      assert.equal(s.ids['h1-obchod'].textContent, 'Túto ukážku tu nevieme ukázať', popis);
      assert.equal(s.ids['akcie-chyba'].hidden, false, popis);
      assert.ok(s.body.classList.contains('lv-stav-chyba'), popis);
      assert.equal(s.ids['otazky-pozn'].hidden, true, popis);
      assert.deepEqual(s.sledovane, ['live_nepovolena'], popis);
    }
  }
});

test('5d. live.js: neznámy obchod (404) sa neukáže; bez odpovede servera sa ukážkový obchod a vlastná skúška načítajú bez mena, cudzí ukáže chybu; texty vo všetkých jazykoch', async () => {
  const nenajdeny = await zivaStranka({ hladanie: `?t=${CUDZI}&shop=obet.sk`, status: 404, skusky: [CUDZI] });
  assert.equal(nenajdeny.skripty.length, 0);
  assert.equal(nenajdeny.ids.missing.hidden, false);

  for (const [tenant, skusky, widget] of [[DEMO, null, true], [CUDZI, [CUDZI], true], [CUDZI, null, false]]) {
    const s = await zivaStranka({ hladanie: `?t=${tenant}&shop=obet.sk&u=1`, status: new Error('siet'), skusky });
    assert.equal(s.skripty.length, widget ? 1 : 0, tenant);
    assert.ok(!s.vsetkyTexty().includes('obet.sk'), tenant);
    if (widget) assert.equal(s.skripty[0].getAttribute('data-title'), 'ARLing Shopping Assistant');
    else assert.equal(s.ids['okno-stav'].getAttribute('data-stav'), 'chyba');
    assert.equal(s.ids['otazky-pozn'].hidden, true, 'bez servera žiadny text oslovenia');
  }

  // Chyba siete, potom „Skúsiť znova“: znova sa pýta servera a meno obchodu po načítaní widgetu ostane.
  const s = await zivaStranka({ hladanie: `?t=${CUDZI}&shop=obet.sk`, status: (n) => (n === 1 ? new Error('siet') : { domain: 'overeny-obchod.sk', live_demo: true, outreach_demo: false }) });
  assert.equal(s.ids['okno-stav'].getAttribute('data-stav'), 'chyba');
  s.ids['okno-znova'].listeners.click[0]();
  await s.pockaj();
  assert.equal(s.volania.length, 2);
  assert.equal(s.widgety().length, 1);
  s.document.dispatchEvent({ type: 'arling-asistent:ready' });
  assert.match(s.ids['h1-obchod'].textContent, /overeny-obchod\.sk/);
  assert.ok(!s.vsetkyTexty().includes('obet.sk'));

  for (const [jazyk, veta] of [['cs-CZ', /Tuto ukázku tu neumíme zobrazit/], ['de-DE', /Diese Demo können wir hier nicht zeigen/], ['en-GB', /We cannot show this demo here/], ['fr-FR', /We cannot show this demo here/]]) {
    const s = await zivaStranka({ hladanie: `?t=${CUDZI}`, status: { domain: 'x.sk', live_demo: false, outreach_demo: false }, jazyk });
    assert.match(s.ids.missing.textContent, veta, jazyk);
    assert.match(s.ids['h1-obchod'].textContent, veta, jazyk);
  }
});

test('5e. demo/live/live.js (staršia kópia vo verejnom repozitári) tiež neberie meno z odkazu a pýta sa servera', () => {
  const src = fs.readFileSync(path.join(REPO, 'demo', 'live', 'live.js'), 'utf8');
  assert.doesNotMatch(src, /q\.get\('shop'\)/);
  assert.match(src, /\/v1\/tenants\/' \+ encodeURIComponent\(tenant\) \+ '\/status'/);
  assert.match(src, /data\.live_demo === true \|\| data\.outreach_demo === true/);
  const hub = LIVE_SRC;
  assert.doesNotMatch(hub, /q\.get\('shop'\)/);
  assert.doesNotMatch(STRANKA_SRC, /q\.get\('shop'\)/);
});

// ===========================================================================
// 6. Adresa homelabu vo verejnom repozitári, Umami ďalej zapojené
// ===========================================================================

function vsetkySubory(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    if (n === '.git' || n === 'node_modules') continue;
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) vsetkySubory(p, out);
    else out.push(p);
  }
  return out;
}

test('6a. žiadny súbor repozitára arling-asistent nenesie adresu homelabu ani iné meno v tailnete', () => {
  const nalezy = [];
  // Vzor poskladaný za behu, aby ho tento súbor sám neobsahoval.
  const vzor = new RegExp(['tail', '[0-9a-f]{6}', '\\.ts\\.net'].join('') + '|[a-z0-9-]+\\.ts\\.net\\b', 'i');
  for (const f of vsetkySubory(REPO)) {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue; // binárny súbor (obrázok, písmo)
    const text = buf.toString('utf8');
    if (vzor.test(text)) nalezy.push(path.relative(REPO, f));
  }
  assert.deepEqual(nalezy, []);
});

test('6b. každá stránka demo/ aj hubu Asistenta s Umami ho má povolené v CSP (script-src aj connect-src), odber a ping idú cez worker api.arling.workers.dev', () => {
  const chyby = [];
  let sUmami = 0;
  for (const koren of [path.join(REPO, 'demo'), HUB]) {
    for (const f of vsetkySubory(koren).filter((x) => x.endsWith('.html'))) {
      const h = fs.readFileSync(f, 'utf8');
      const umami = [...h.matchAll(/<script[^>]*src="(https:\/\/[^"]+\/script\.js)"[^>]*data-website-id/g)].map((m) => new URL(m[1]).origin);
      const csp = (h.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1];
      if (!umami.length || !csp) continue;
      sUmami += 1;
      const ss = (csp.match(/script-src ([^;]+)/) || [])[1] || '';
      const cs = (csp.match(/connect-src ([^;]+)/) || [])[1] || '';
      for (const o of umami) if (!ss.split(/\s+/).includes(o) || !cs.split(/\s+/).includes(o)) chyby.push(path.relative(REPO, f));
    }
  }
  assert.ok(sUmami > 10, `stránok s Umami: ${sUmami}`);
  assert.deepEqual(chyby, []);
  for (const subor of ['subscribe.js', 'sell.js']) {
    const src = fs.readFileSync(path.join(REPO, 'demo', subor), 'utf8');
    assert.match(src, /https:\/\/api\.arling\.workers\.dev\/subscribe\/api\/(subscribe|ping)/, subor);
  }
});
