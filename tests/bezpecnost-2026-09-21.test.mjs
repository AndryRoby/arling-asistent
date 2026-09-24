// bezpecnost-2026-09-21.test.mjs
//
// Testy k bezpecnostnej kontrole workera z 21. 9. 2026
// (report: ops/bezpecnost/arling-asistent-worker.md).
//
// Kazdy test tu popisuje jednu konkretnu dieru a bez prislusnej opravy pada.
// Ziadny z nich nechodi na siet: Stripe, Resend aj stahovanie feedu stoji za
// env.fetchImpl, rovnako ako v ostatnych suboroch v tomto priecinku.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import {
  isPrivateHost,
  parseIpv4,
  expandIpv6,
  createTenant,
  setTenantStatus,
  getTenantById,
} from '../worker/src/tenants.js';
import { fetchFeed, guardedFetch, assertFetchableUrl, FeedUrlNotAllowedError } from '../worker/src/feed.js';
import {
  createTenantFromRequest,
  ingestFeedForTenant,
  TENANT_CREATE_LIMIT_PER_HOUR,
  INGEST_MIN_NEURONS,
} from '../worker/src/onboarding.js';
import { bezpecnePorovnaj } from '../worker/src/security.js';
import { isAdmin, testSessionPovolena, povoleneTestovacieEmaily } from '../worker/src/upload.js';
import { HRA_MAX_POCET } from '../worker/src/ucet.js';
import { createMockD1 } from './helpers/mock-d1.mjs';
import { createMockAI, createMockVectorize, createMockKV } from './helpers/mock-cf.mjs';

const XML_FEED = '<products><item><id>1</id><name>Kanvica</name><price>9.99</price><url>https://shop.sk/p/1</url><description>Popis.</description></item></products>';

// ---------------------------------------------------------------------------
// 1. SSRF: ktoru adresu smie worker stiahnut (tenants.js isPrivateHost)
// ---------------------------------------------------------------------------

test('SSRF: IPv6 obal sukromnej adresy sa uz neda pouzit ako feed_url', () => {
  // Presne tieto tvary predchadzajuca kontrola pustila: nesedeli na vzor
  // styroch oktetov a nezacinali na ::1, fe80:, fc ani fd.
  for (const host of [
    '[::ffff:127.0.0.1]',
    '::ffff:127.0.0.1',
    '[::ffff:7f00:1]',
    '[0:0:0:0:0:ffff:127.0.0.1]',
    '[::ffff:10.0.0.1]',
    '[::ffff:169.254.169.254]',
    '[::ffff:192.168.1.1]',
    '[::]',
    '[::127.0.0.1]',
    '[64:ff9b::127.0.0.1]',
    '[fe80::1%eth0]',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} ma byt sukromna`);
  }
});

test('SSRF: IPv4 zapisana inak nez styrmi oktetmi sa uz neda pouzit ako feed_url', () => {
  // 2130706433 aj 127.1 su pre rozlisovac adries to iste ako 127.0.0.1.
  assert.equal(parseIpv4('2130706433'), 2130706433);
  assert.equal(parseIpv4('127.1'), 2130706433);
  assert.equal(parseIpv4('0x7f000001'), 2130706433);
  assert.equal(parseIpv4('0177.0.0.1'), 2130706433);
  for (const host of ['2130706433', '127.1', '0x7f000001', '0177.0.0.1', '0xa000001', '169.254.169.254', '100.64.0.1']) {
    assert.equal(isPrivateHost(host), true, `${host} ma byt sukromna`);
  }
});

test('SSRF: verejne adresy a domeny ostavaju povolene', () => {
  for (const host of ['shop.sk', 'www.upgates.cz', '8.8.8.8', '93.184.216.34', '[2a00:1450:4014:80e::200e]']) {
    assert.equal(isPrivateHost(host), false, `${host} ma byt verejna`);
  }
});

test('SSRF: domena zacinajuca na fc alebo fd uz nie je omylom oznacena za sukromnu', () => {
  // Stara kontrola robila h.startsWith('fc'), takze odmietla kazdeho
  // zakaznika s takouto domenou. Je to chyba opacnym smerom, ale je to chyba.
  assert.equal(isPrivateHost('fcbarcelona.sk'), false);
  assert.equal(isPrivateHost('fdmarket.cz'), false);
  // Skutocne ULA adresy musia ostat zakazane.
  assert.equal(isPrivateHost('[fd00::1]'), true);
  assert.equal(isPrivateHost('[fc00::1]'), true);
});

test('expandIpv6 rozbali skratene tvary na osem hextetov', () => {
  assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(expandIpv6('fd00::1'), [0xfd00, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(expandIpv6('nie-je-adresa'), null);
});

// ---------------------------------------------------------------------------
// 2. SSRF cez presmerovanie (feed.js guardedFetch)
// ---------------------------------------------------------------------------

/** Odpoved s hlavickami, aky vracia skutocny fetch (testovacie dvojniky hlavicky nemaju). */
function presmerovanie(location, status = 302) {
  return { ok: false, status, headers: new Headers({ location }), text: async () => '' };
}

test('SSRF: verejna adresa, ktora presmeruje na loopback, sa uz nenasleduje', async () => {
  const volane = [];
  const fetchImpl = async (url) => {
    volane.push(String(url));
    if (String(url).startsWith('https://feed.example/')) return presmerovanie('http://127.0.0.1:8080/tajomstvo');
    return { ok: true, status: 200, text: async () => XML_FEED };
  };
  await assert.rejects(
    () => fetchFeed('https://feed.example/feed.xml', { fetchImpl }),
    (err) => err instanceof FeedUrlNotAllowedError && err.reason === 'feed_url_private_host'
  );
  // Klucove: druhy skok sa vobec neposlal.
  assert.deepEqual(volane, ['https://feed.example/feed.xml']);
});

test('SSRF: presmerovanie na verejnu adresu sa nasleduje a feed sa nacita', async () => {
  const volane = [];
  const fetchImpl = async (url) => {
    volane.push(String(url));
    if (volane.length === 1) return presmerovanie('https://www.feed.example/feed.xml', 301);
    return { ok: true, status: 200, text: async () => XML_FEED };
  };
  const vysledok = await fetchFeed('https://feed.example/feed.xml', { fetchImpl });
  assert.equal(vysledok.products.length, 1);
  assert.deepEqual(volane, ['https://feed.example/feed.xml', 'https://www.feed.example/feed.xml']);
});

test('SSRF: kruh presmerovani skonci chybou, nie nekonecnym stahovanim', async () => {
  const fetchImpl = async () => presmerovanie('https://feed.example/dokola');
  await assert.rejects(
    () => guardedFetch('https://feed.example/feed.xml', fetchImpl),
    (err) => err instanceof FeedUrlNotAllowedError && err.reason === 'feed_too_many_redirects'
  );
});

test('assertFetchableUrl odmietne inu schemu nez http(s)', () => {
  assert.throws(() => assertFetchableUrl('file:///etc/passwd'), FeedUrlNotAllowedError);
  assert.throws(() => assertFetchableUrl('gopher://shop.sk/'), FeedUrlNotAllowedError);
  assert.equal(assertFetchableUrl('https://shop.sk/feed.xml').hostname, 'shop.sk');
});

// ---------------------------------------------------------------------------
// 3. Prevzatie cudzieho obchodu cez POST /v1/tenants (onboarding.js)
// ---------------------------------------------------------------------------

function makeEnv({ feedText = XML_FEED, kv = createMockKV() } = {}) {
  return {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4 }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: kv,
    ALLOWED_ORIGINS: 'arling.sk',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => feedText }),
  };
}

test('cudzi clovek uz nevymeni feed existujuceho obchodu', async () => {
  const env = makeEnv();
  const majitel = await createTenantFromRequest(env, {
    feedUrl: 'https://obchod.sk/feed.xml',
    domain: 'obchod.sk',
    email: 'majitel@obchod.sk',
  });

  const utok = await createTenantFromRequest(env, {
    feedUrl: 'https://utocnik.example/feed.xml',
    domain: 'obchod.sk',
    email: 'utocnik@example.com',
  });

  // Odpoved vyzera rovnako ako doteraz, aby sa cudzi clovek nedozvedel nic navyse.
  assert.equal(utok.existing, true);
  assert.equal(utok.id, majitel.id);
  // Ale katalog ostal netknuty.
  const riadok = await getTenantById(env.DB, majitel.id);
  assert.equal(riadok.feed_url, 'https://obchod.sk/feed.xml');
});

test('majitel s tou istou adresou feed nadalej zmeni', async () => {
  const env = makeEnv();
  const majitel = await createTenantFromRequest(env, {
    feedUrl: 'https://obchod.sk/feed.xml',
    domain: 'obchod.sk',
    email: 'Majitel@Obchod.sk',
  });
  await createTenantFromRequest(env, {
    feedUrl: 'https://obchod.sk/novy-feed.xml',
    domain: 'obchod.sk',
    // Velke pismena a medzery sa normalizuju rovnako ako pri zalozeni.
    email: ' majitel@obchod.sk ',
  });
  const riadok = await getTenantById(env.DB, majitel.id);
  assert.equal(riadok.feed_url, 'https://obchod.sk/novy-feed.xml');
});

test('cudzi clovek nespusti ani opakovane nacitanie feedu cudzieho obchodu', async () => {
  const env = makeEnv();
  const majitel = await createTenantFromRequest(env, {
    feedUrl: 'https://obchod.sk/feed.xml',
    domain: 'obchod.sk',
    email: 'majitel@obchod.sk',
  });
  const pocetPred = env.AI.calls.length;
  // Stary zaznam: bez opravy by sem isla podmienka isIngestionStale a nacitanie
  // by sa spustilo komukolvek, kto poslal cudziu domenu.
  env.DB._tenants.get(majitel.id).last_ingested_at = '2020-01-01T00:00:00.000Z';
  await createTenantFromRequest(env, {
    feedUrl: 'https://obchod.sk/feed.xml',
    domain: 'obchod.sk',
    email: 'utocnik@example.com',
  });
  assert.equal(env.AI.calls.length, pocetPred, 'model sa nemal volat');
});

// ---------------------------------------------------------------------------
// 4. Limit a denny strop pri zakladani obchodu
// ---------------------------------------------------------------------------

function tenantRequest(domain, ip = '5.5.5.5') {
  return new Request('https://asistent.arling.sk/v1/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ feed_url: `https://${domain}/feed.xml`, domain, email: `a@${domain}` }),
  });
}

test('POST /v1/tenants ma limit na IP: po TENANT_CREATE_LIMIT_PER_HOUR prichadza 429', async () => {
  const env = makeEnv();
  for (let i = 0; i < TENANT_CREATE_LIMIT_PER_HOUR; i++) {
    const res = await worker.fetch(tenantRequest(`obchod-${i}.sk`), env, {});
    assert.equal(res.status, 201, `poziadavka ${i} mala prejst`);
  }
  const res = await worker.fetch(tenantRequest('obchod-navyse.sk'), env, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
  // A hlavne: cudzi feed sa uz nestahoval.
  assert.equal(await getTenantById(env.DB, 'obchod-navyse.sk'), null);
});

test('samoobsluzne nacitanie feedu sa nespusti, ked je denny strop neuronov vycerpany', async () => {
  const kv = createMockKV();
  const dnes = new Date();
  const kluc = `neurons:${dnes.getUTCFullYear()}-${String(dnes.getUTCMonth() + 1).padStart(2, '0')}-${String(dnes.getUTCDate()).padStart(2, '0')}`;
  await kv.put(kluc, '9499'); // strop je 9500, zostava 1 neuron
  const env = makeEnv({ kv });
  env.AI_DAILY_NEURON_BUDGET = '9500';

  const tenant = await createTenantFromRequest(env, {
    feedUrl: 'https://obchod.sk/feed.xml',
    domain: 'obchod.sk',
    email: 'majitel@obchod.sk',
  });
  assert.equal(env.AI.calls.length, 0, 'model sa nemal volat vobec');
  const riadok = await getTenantById(env.DB, tenant.id);
  assert.equal(riadok.status, 'error');
  assert.ok(INGEST_MIN_NEURONS > 1);
});

test('nacitanie feedu pripocita spotrebu neuronov do denneho stropu', async () => {
  const kv = createMockKV();
  const env = makeEnv({ kv });
  const tenant = await createTenant(env.DB, { domain: 'obchod.sk', feedUrl: 'https://obchod.sk/feed.xml', contactEmail: 'a@obchod.sk' });
  const vysledok = await ingestFeedForTenant(env, tenant);
  assert.equal(vysledok.ok, true);
  const zapis = kv._puts.find((p) => p.key.startsWith('neurons:'));
  assert.ok(zapis, 'spotreba sa zapisala');
  assert.equal(Number(zapis.value), vysledok.chunkCount);
});

// ---------------------------------------------------------------------------
// 5. Denny strop v /v1/gift bol az ZA volanim modelu
// ---------------------------------------------------------------------------

test('/v1/gift pri vycerpanom strope model vobec nezavola', async () => {
  const kv = createMockKV();
  const dnes = new Date();
  const kluc = `neurons:${dnes.getUTCFullYear()}-${String(dnes.getUTCMonth() + 1).padStart(2, '0')}-${String(dnes.getUTCDate()).padStart(2, '0')}`;
  await kv.put(kluc, '9500');
  const env = {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ picks: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: kv,
    ALLOWED_ORIGINS: 'arling.sk',
  };
  const tenant = await createTenant(env.DB, { domain: 'darceky.sk', feedUrl: 'https://darceky.sk/f.xml', contactEmail: 'a@darceky.sk' });
  await setTenantStatus(env.DB, tenant.id, 'ready');

  const res = await worker.fetch(
    new Request('https://asistent.arling.sk/v1/gift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://darceky.sk', 'CF-Connecting-IP': '1.1.1.1' },
      body: JSON.stringify({ tenant: tenant.id, recipient: 'mama', interests: 'kava', budget_min: 10, budget_max: 50 }),
    }),
    env,
    {}
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'quota_exceeded');
  // Toto je cela oprava: predtym sa model zavolal a az potom sa zistilo,
  // ze na to nebol rozpocet.
  assert.equal(env.AI.calls.length, 0);
});

test('/v1/gift s nasou testovacou hlavickou nemini ani jeden neuron', async () => {
  const env = {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ picks: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    ADMIN_TOKEN: 'nas-admin-token',
  };
  const tenant = await createTenant(env.DB, { domain: 'darceky.sk', feedUrl: 'https://darceky.sk/f.xml', contactEmail: 'a@darceky.sk' });
  await setTenantStatus(env.DB, tenant.id, 'ready');

  const res = await worker.fetch(
    new Request('https://asistent.arling.sk/v1/gift', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://darceky.sk',
        'CF-Connecting-IP': '1.1.1.2',
        'X-Arling-Test': 'nas-admin-token',
      },
      body: JSON.stringify({ tenant: tenant.id, recipient: 'mama', interests: 'kava' }),
    }),
    env,
    {}
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).meta.test, true);
  assert.equal(env.AI.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Porovnanie tajomstiev v konstantnom case
// ---------------------------------------------------------------------------

test('bezpecnePorovnaj sa sprava ako ===, len bez skratky na prvom rozdiele', () => {
  assert.equal(bezpecnePorovnaj('tajomstvo', 'tajomstvo'), true);
  assert.equal(bezpecnePorovnaj('tajomstvo', 'tajomstvx'), false);
  assert.equal(bezpecnePorovnaj('tajomstvo', 'tajomstv'), false);
  assert.equal(bezpecnePorovnaj('', ''), true);
  assert.equal(bezpecnePorovnaj(null, ''), true);
  assert.equal(bezpecnePorovnaj('a', null), false);
  // Diakritika: porovnava sa po bajtoch UTF-8, nie po znakoch.
  assert.equal(bezpecnePorovnaj('kľúč', 'kľúč'), true);
  assert.equal(bezpecnePorovnaj('kľúč', 'kluc'), false);
});

test('isAdmin pouziva porovnanie v konstantnom case a bez tajomstva nikoho nepusti', () => {
  const req = (token) => new Request('https://x/', { headers: token ? { 'X-Admin-Token': token } : {} });
  assert.equal(isAdmin(req('spravny'), { ADMIN_TOKEN: 'spravny' }), true);
  assert.equal(isAdmin(req('spravnX'), { ADMIN_TOKEN: 'spravny' }), false);
  assert.equal(isAdmin(req(''), { ADMIN_TOKEN: 'spravny' }), false);
  assert.equal(isAdmin(req('cokolvek'), {}), false);
  assert.equal(isAdmin(req('cokolvek'), { ADMIN_TOKEN: '' }), false);
});

// ---------------------------------------------------------------------------
// 7. Testovaci rezim Stripe (N1 auditu po platbe)
// ---------------------------------------------------------------------------

test('testSessionPovolena: ostra session vzdy, testovacia len z TEST_EMAILS', () => {
  const ostra = { livemode: true, customer_details: { email: 'ktokolvek@example.com' } };
  const testovacia = { livemode: false, customer_details: { email: 'Majitel@ARLing.sk' } };
  assert.equal(testSessionPovolena({}, ostra), true);
  assert.equal(testSessionPovolena({}, testovacia), false);
  assert.equal(testSessionPovolena({ TEST_EMAILS: '' }, testovacia), false);
  assert.equal(testSessionPovolena({ TEST_EMAILS: 'majitel@arling.sk' }, testovacia), true);
  assert.equal(testSessionPovolena({ TEST_EMAILS: 'niekto@inde.sk' }, testovacia), false);
  // Session bez adresy (pokladna bez e-mailu) neprejde nikdy.
  assert.equal(testSessionPovolena({ TEST_EMAILS: 'majitel@arling.sk' }, { livemode: false }), false);
  assert.deepEqual([...povoleneTestovacieEmaily({ TEST_EMAILS: ' A@b.sk , c@d.sk ,, ' })], ['a@b.sk', 'c@d.sk']);
});

// ---------------------------------------------------------------------------
// 8. Bezpecnostne hlavicky
// ---------------------------------------------------------------------------

test('kazda JSON odpoved nesie nosniff a no-store', async () => {
  const env = makeEnv();
  for (const cesta of ['/health', '/nic-take-tu-nie-je']) {
    const res = await worker.fetch(new Request(`https://asistent.arling.sk${cesta}`), env, {});
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', cesta);
    assert.equal(res.headers.get('cache-control'), 'no-store', cesta);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', cesta);
  }
});

test('widget.js sa smie kesovat, ale nesie nosniff', async () => {
  const res = await worker.fetch(new Request('https://asistent.arling.sk/widget.js'), makeEnv(), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /max-age/);
});

// ---------------------------------------------------------------------------
// 9. Strop na pocet ulozenych hier jedneho uctu (ucet.js)
// ---------------------------------------------------------------------------

test('jeden ucet si nemoze do KV ulozit neobmedzene vela hier', async () => {
  const { vytvorToken } = await import('../worker/src/ucet.js');
  const kv = createMockKV();
  const tajomstvo = Buffer.from('tajomstvo-pre-test-hier').toString('base64');
  const email = 'hrac@example.com';
  await kv.put(`ucet:ucet:${email}`, JSON.stringify({ email, vytvorene: '2026-09-01T00:00:00.000Z', verzia: 1, nakupy: [], predplatne: [] }));
  const env = { ASISTENT_CACHE: kv, UCET_TAJOMSTVO: tajomstvo, ALLOWED_ORIGINS: 'arling.sk' };
  // createMockKV nepozna typ 'json', ktory ucet.js pouziva; doplnime ho.
  const povodnyGet = kv.get.bind(kv);
  kv.get = async (key, type) => {
    const hodnota = await povodnyGet(key);
    if (type === 'json' && typeof hodnota === 'string') {
      try { return JSON.parse(hodnota); } catch (e) { return null; }
    }
    return hodnota;
  };
  const token = await vytvorToken(env, { email, verzia: 1 });

  // Kazda poziadavka z inej adresy, aby sa test tykal stropu na pocet hier a
  // nie minutoveho limitu na IP (ten ma vlastny test nizsie).
  let poradie = 0;
  const zapis = (hra) => worker.fetch(
    new Request(`https://asistent.arling.sk/v1/ucet/hra/${hra}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.0.${poradie++ % 250}` },
      body: JSON.stringify({ stav: 'nieco' }),
    }),
    env,
    {}
  );

  for (let i = 0; i < HRA_MAX_POCET; i++) {
    assert.equal((await zapis(`hra-${i}`)).status, 200, `hra ${i} mala prejst`);
  }
  const navyse = await zapis('hra-navyse');
  assert.equal(navyse.status, 409);
  assert.equal((await navyse.json()).error, 'too_many_games');
  // Uz zalozena hra sa da prepisat aj po dosiahnuti stropu.
  assert.equal((await zapis('hra-0')).status, 200);
});

test('cesty uctu maju minutovy limit na IP, rovnako ako chat a kontrola', async () => {
  const { RATE_LIMIT_DEFAULT } = await import('../worker/src/security.js');
  const kv = createMockKV();
  const env = { ASISTENT_CACHE: kv, UCET_TAJOMSTVO: Buffer.from('x').toString('base64'), ALLOWED_ORIGINS: 'arling.sk' };
  const poziadavka = () => new Request('https://asistent.arling.sk/v1/ucet/over', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '3.3.3.3' },
    body: JSON.stringify({ email: 'nikto@example.com', kod: '000000' }),
  });
  for (let i = 0; i < RATE_LIMIT_DEFAULT; i++) {
    const res = await worker.fetch(poziadavka(), env, {});
    // Bez kodu v KV je odpoved 400 no_code; podstatne je, ze to nie je 429.
    assert.notEqual(res.status, 429, `poziadavka ${i}`);
  }
  const res = await worker.fetch(poziadavka(), env, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
});
