// eshop-kontrola.test.mjs
// Kontrola e-shopu (worker/src/eshop-kontrola.js) nad desiatimi uloženými
// vzorkami HTML vymyslených e-shopov (tests/fixtures/eshop/), plus bezpečnosť:
// žiadne súkromné adresy, žiadna otvorená proxy, limity veľkosti, času a IP.
// Sieť sa nikdy nevolá: fetch aj DNS sú dvojníky.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import worker from '../worker/src/index.js';
import {
  skontrolujEshop,
  normalizujAdresu,
  jeNeverejnaIp,
  prelozDns,
  stiahniStranku,
  KontrolaChyba,
  KONTROLA_USER_AGENT,
  LIMIT_UVOD_BAJTOV,
  handleEshopKontrolaRoute,
  formulareOdstupenia,
  rozoberStranku,
  najdiNastrojSuhlasu,
} from '../worker/src/eshop-kontrola.js';
import { createMockKV } from './helpers/mock-cf.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eshop');
const vzorka = (meno) => readFileSync(join(DIR, meno), 'utf8');

/** Dvojník fetch: mapa adresa -> odpoveď. Neznáma adresa je 404. Zaznamenáva volania. */
function falosnaSiet(mapa) {
  const volania = [];
  const fetchImpl = async (url, init = {}) => {
    volania.push({ url: String(url), init });
    const z = mapa[String(url)];
    if (!z) return new Response('nie je', { status: 404, headers: { 'content-type': 'text/html' } });
    if (typeof z === 'function') return z(url, init);
    if (z.presmeruj) return new Response(null, { status: z.status || 301, headers: { location: z.presmeruj } });
    return new Response(z.telo !== undefined ? z.telo : vzorka(z.subor), {
      status: z.status || 200,
      headers: { 'content-type': z.typ || 'text/html; charset=utf-8' },
    });
  };
  return { fetchImpl, volania };
}

const verejneDns = async () => ['93.184.216.34'];

async function kontrola(mapa, adresa, extra = {}) {
  const siet = falosnaSiet(mapa);
  const vysledok = await skontrolujEshop(adresa, { fetchImpl: siet.fetchImpl, dnsImpl: verejneDns, ...extra });
  return { vysledok, siet };
}

function stavy(vysledok) {
  return Object.fromEntries(vysledok.riadky.map((r) => [r.id, r.stav]));
}

// ---------------------------------------------------------------------------
// Desať vzoriek
// ---------------------------------------------------------------------------

test('vzorka 01: vzorný e-shop, formulár na odstúpenie, zásady s Google, Cookiebot', async () => {
  const { vysledok, siet } = await kontrola({
    'https://cajovna-lipa.sk/': { subor: '01-vzorny-uvod.html' },
    'https://cajovna-lipa.sk/ochrana-osobnych-udajov/': { subor: '01-vzorny-zasady.html' },
    'https://cajovna-lipa.sk/odstupenie/': { subor: '01-vzorny-odstupenie.html' },
  }, 'cajovna-lipa.sk');
  assert.deepEqual(stavy(vysledok), {
    odstupenie: 'ok', rso: 'nevieme', zasady: 'ok', prijemcovia: 'ok', cookies: 'ok', identifikacia: 'ok', podmienky: 'ok',
  });
  assert.match(vysledok.riadky.find((r) => r.id === 'cookies').text, /Cookiebot/);
  assert.deepEqual(vysledok.sluzby.map((s) => s.id), ['ga4']);
  assert.equal(vysledok.adresa, 'https://cajovna-lipa.sk/');
  // Úvod a najviac 2 ďalšie stránky, nič viac.
  assert.equal(siet.volania.length, 3);
  for (const v of siet.volania) assert.equal(v.init.headers['user-agent'], KONTROLA_USER_AGENT);
  assert.match(KONTROLA_USER_AGENT, /https:\/\/arling\.sk\/kontrola-eshopu\//);
});

test('vzorka 02: odstúpenie ako PDF, odkaz na RSO, Meta Pixel bez lišty a mimo zásad', async () => {
  const { vysledok } = await kontrola({
    'https://kocka-hracky.sk/': { subor: '02-pdf-rso-uvod.html' },
    'https://kocka-hracky.sk/gdpr/': { subor: '02-pdf-rso-zasady.html' },
    'https://kocka-hracky.sk/vop/': { subor: '02-pdf-rso-vop.html' },
  }, 'https://kocka-hracky.sk');
  assert.deepEqual(stavy(vysledok), {
    odstupenie: 'nalez', rso: 'nalez', zasady: 'ok', prijemcovia: 'nalez', cookies: 'nalez', identifikacia: 'ok', podmienky: 'ok',
  });
  assert.match(vysledok.riadky.find((r) => r.id === 'odstupenie').text, /PDF/);
  assert.match(vysledok.riadky.find((r) => r.id === 'prijemcovia').text, /Meta Pixel/);
  assert.deepEqual(vysledok.predvyplnenie.nastroje.sort(), ['ga4', 'meta']);
  assert.deepEqual(vysledok.predvyplnenie.cookies.sort(), ['analyticke', 'marketingove']);
  assert.ok(vysledok.predvyplnenie.cinnosti.includes('analytika'));
});

test('vzorka 03: odstúpenie cez e-mail, Smartsupp chýba v zásadách, podmienky bez vád', async () => {
  const { vysledok } = await kontrola({
    'https://margareta-kvety.sk/': { subor: '03-mailto-uvod.html' },
    'https://margareta-kvety.sk/ochrana-sukromia/': { subor: '03-mailto-zasady.html' },
    'https://margareta-kvety.sk/obchodne-podmienky/': { subor: '03-mailto-vop.html' },
  }, 'margareta-kvety.sk');
  assert.deepEqual(stavy(vysledok), {
    odstupenie: 'nalez', rso: 'ok', zasady: 'ok', prijemcovia: 'nalez', cookies: 'nevieme', identifikacia: 'ok', podmienky: 'nalez',
  });
  assert.match(vysledok.riadky.find((r) => r.id === 'odstupenie').text, /e-mail/);
  const prij = vysledok.riadky.find((r) => r.id === 'prijemcovia').text;
  assert.match(prij, /nenašli názov: Smartsupp/);
  assert.deepEqual(vysledok.predvyplnenie.nastroje, ['packeta']);
  assert.deepEqual(vysledok.predvyplnenie.ine, ['Smartsupp (chat na webe)']);
});

test('vzorka 04: bez povinných odkazov, Hotjar bez lišty', async () => {
  const { vysledok } = await kontrola({ 'https://ponozky-pruh.sk/': { subor: '04-bez-odkazov-uvod.html' } }, 'ponozky-pruh.sk');
  assert.deepEqual(stavy(vysledok), {
    odstupenie: 'nalez', rso: 'nevieme', zasady: 'nalez', prijemcovia: 'nevieme', cookies: 'nalez', identifikacia: 'nevieme', podmienky: 'nalez',
  });
});

test('vzorka 05: stránka skladaná JavaScriptom dáva "nevieme overiť", nikdy "v poriadku" naslepo', async () => {
  const { vysledok } = await kontrola({ 'https://react-obchod.sk/': { subor: '05-js-aplikacia-uvod.html' } }, 'react-obchod.sk');
  const s = stavy(vysledok);
  for (const id of ['odstupenie', 'rso', 'zasady', 'prijemcovia', 'cookies', 'identifikacia', 'podmienky']) {
    assert.equal(s[id], 'nevieme', `${id} má byť nevieme`);
  }
});

test('vzorka 06: Google Tag Manager bez viditeľnej lišty a formulár v iframe', async () => {
  const { vysledok } = await kontrola({
    'https://zrnko-prazi.sk/': { subor: '06-gtm-uvod.html' },
    'https://zrnko-prazi.sk/zasady-ochrany-osobnych-udajov/': { subor: '06-gtm-zasady.html' },
    'https://zrnko-prazi.sk/odstupenie-od-zmluvy/': { subor: '06-gtm-odstupenie.html' },
  }, 'zrnko-prazi.sk');
  assert.deepEqual(stavy(vysledok), {
    odstupenie: 'nevieme', rso: 'nevieme', zasady: 'ok', prijemcovia: 'ok', cookies: 'nevieme', identifikacia: 'ok', podmienky: 'ok',
  });
  assert.match(vysledok.riadky.find((r) => r.id === 'cookies').text, /Tag Manager/);
});

test('vzorka 07: stránka odstúpenia len s vyhľadávaním, e-mailom a PDF je nález; Mailchimp mimo zásad', async () => {
  const { vysledok } = await kontrola({
    'https://knot-sviecky.sk/': { subor: '07-bez-formulara-uvod.html' },
    'https://knot-sviecky.sk/osobne-udaje/': { subor: '07-bez-formulara-zasady.html' },
    'https://knot-sviecky.sk/odstupenie/': { subor: '07-bez-formulara-odstupenie.html' },
  }, 'knot-sviecky.sk');
  const s = stavy(vysledok);
  assert.equal(s.odstupenie, 'nalez');
  assert.match(vysledok.riadky.find((r) => r.id === 'odstupenie').text, /ponúka e-mail alebo súbor/);
  assert.equal(s.prijemcovia, 'nalez');
  // Nič známe nesleduje, ale nepoznané skripty nevidíme: nikdy "v poriadku" naslepo.
  assert.equal(s.cookies, 'nevieme');
  assert.match(vysledok.riadky.find((r) => r.id === 'cookies').text, /Nepoznané skripty nevidíme/);
  assert.ok(vysledok.predvyplnenie.cinnosti.includes('newsletter'));
});

test('vzorka 08: Shoptet so vstavanou lištou, GoPay, zmienka o RSO v zásadách', async () => {
  const { vysledok } = await kontrola({
    'https://med-vcielka.sk/': { subor: '08-shoptet-uvod.html' },
    'https://med-vcielka.sk/podmienky-ochrany-osobnych-udajov/': { subor: '08-shoptet-zasady.html' },
    'https://med-vcielka.sk/odstupenie-od-zmluvy/': { subor: '08-shoptet-odstupenie.html' },
  }, 'med-vcielka.sk');
  assert.deepEqual(stavy(vysledok), {
    odstupenie: 'ok', rso: 'nalez', zasady: 'ok', prijemcovia: 'ok', cookies: 'ok', identifikacia: 'ok', podmienky: 'ok',
  });
  assert.equal(vysledok.platforma, 'Shoptet');
  assert.match(vysledok.riadky.find((r) => r.id === 'cookies').text, /Shoptet/);
  assert.deepEqual(vysledok.sluzby.map((s) => s.id).sort(), ['ga4', 'gopay']);
});

test('vzorka 09: formulár na odstúpenie cez kotvu priamo na úvodnej stránke, newsletter sa nepočíta', async () => {
  const { vysledok } = await kontrola({
    'https://vak-tasky.sk/': { subor: '09-kotva-uvod.html' },
    'https://vak-tasky.sk/gdpr/': { subor: '09-kotva-zasady.html' },
  }, 'vak-tasky.sk');
  const s = stavy(vysledok);
  assert.equal(s.odstupenie, 'ok');
  assert.equal(s.prijemcovia, 'ok');
  assert.equal(s.cookies, 'nevieme');
  assert.match(vysledok.riadky.find((r) => r.id === 'odstupenie').text, /miesto na úvodnej stránke/);
  assert.deepEqual(vysledok.predvyplnenie.nastroje.sort(), ['ecomail', 'stripe']);
});

test('vzorka 10: odstúpenie na cudzej doméne sa nenačíta a je "nevieme"; Google Ads bez lišty', async () => {
  const { vysledok, siet } = await kontrola({
    'https://pedal-bicykle.sk/': { subor: '10-cudzia-domena-uvod.html' },
    'https://pedal-bicykle.sk/ochrana-osobnych-udajov/': { subor: '10-cudzia-domena-zasady.html' },
    'https://pedal-bicykle.sk/obchodne-podmienky/': { subor: '10-cudzia-domena-vop.html' },
  }, 'pedal-bicykle.sk');
  assert.deepEqual(stavy(vysledok), {
    odstupenie: 'nevieme', rso: 'ok', zasady: 'ok', prijemcovia: 'ok', cookies: 'nalez', identifikacia: 'ok', podmienky: 'ok',
  });
  assert.ok(!siet.volania.some((v) => v.url.includes('formulare-odstupenie.example')), 'cudzia doména sa nesmie sťahovať');
});

// ---------------------------------------------------------------------------
// Falošné "v poriadku": prihlásenie, newsletter, informačná lišta, neznáme skripty
// ---------------------------------------------------------------------------

test('vzorka 11: prihlásenie v hlavičke šablóny sa nepočíta ako formulár na odstúpenie', async () => {
  const { vysledok } = await kontrola({
    'https://keramika-hlina.sk/': { subor: '11-login-uvod.html' },
    'https://keramika-hlina.sk/odstupenie/': { subor: '11-login-odstupenie.html' },
  }, 'keramika-hlina.sk');
  const r = vysledok.riadky.find((x) => x.id === 'odstupenie');
  assert.equal(r.stav, 'nalez');
  assert.match(r.text, /Prihlásenie, newsletter ani vyhľadávanie sa nerátajú/);
});

test('vzorka 12: formulár na novinky (meno a e-mail) na stránke odstúpenia je "nevieme", nie "v poriadku"', async () => {
  const { vysledok } = await kontrola({
    'https://keramika-hlina.sk/': { subor: '11-login-uvod.html' },
    'https://keramika-hlina.sk/odstupenie/': { subor: '12-newsletter-odstupenie.html' },
  }, 'keramika-hlina.sk');
  const r = vysledok.riadky.find((x) => x.id === 'odstupenie');
  assert.equal(r.stav, 'nevieme');
  assert.match(r.text, /nevieme ho priradiť/);
});

test('vzorka 12 cez kotvu: prihlásenie a newsletter na úvodnej stránke nedajú "v poriadku"', async () => {
  const uvod = vzorka('11-login-uvod.html').replace('href="/odstupenie/"', 'href="#odstupenie"');
  const { vysledok } = await kontrola({ 'https://keramika-hlina.sk/': { telo: uvod } }, 'keramika-hlina.sk');
  assert.notEqual(stavy(vysledok).odstupenie, 'ok');
});

test('formulár na odstúpenie potrebuje e-mail, číslo objednávky aj potvrdzovacie tlačidlo', () => {
  const vyhodnot = (vnutro, akcia = '/odstupenie') => formulareOdstupenia(rozoberStranku(`<form action="${akcia}" method="post">${vnutro}</form>`, 'https://obchod.sk/odstupenie/'));
  const plny = '<input name="meno"><input name="cislo_objednavky"><input type="email" name="email"><button type="submit">Potvrdiť odstúpenie</button>';
  assert.ok(vyhodnot(plny).dobry, 'úplný formulár je v poriadku');
  // Bez e-mailu: nie je v poriadku, ale je to formulár, ktorý nevieme priradiť.
  const bezEmailu = vyhodnot('<input name="meno"><input name="cislo_objednavky"><button type="submit">Potvrdiť odstúpenie</button>');
  assert.equal(bezEmailu.dobry, null);
  assert.equal(bezEmailu.nejasne.length, 1);
  // Bez čísla objednávky alebo zmluvy.
  assert.equal(vyhodnot('<input name="meno"><input type="email" name="email"><button type="submit">Potvrdiť odstúpenie</button>').dobry, null);
  // Telefónne číslo nie je identifikácia zmluvy.
  assert.equal(vyhodnot('<input name="meno"><input type="tel" name="telefonne_cislo"><input type="email" name="email"><button type="submit">Odoslať</button>').dobry, null);
  // Tlačidlo bez textu odstúpiť, potvrdiť, odoslať.
  assert.equal(vyhodnot('<input name="meno"><input name="objednavka"><input type="email" name="email"><button type="submit">Chcem novinky</button>').dobry, null);
  // Prihlásenie a newsletter sa vyradia úplne.
  assert.equal(vyhodnot('<input type="email" name="email"><input type="password" name="heslo"><input name="objednavka"><button type="submit">Odoslať</button>').nejasne.length, 0);
  assert.equal(vyhodnot('<input name="meno"><input type="email" name="email"><button type="submit">Odoslať</button>', '/newsletter/prihlasit').nejasne.length, 0);
  assert.equal(vyhodnot('<input type="email" name="email"><button type="submit">Odoslať</button>', '/form/1').nejasne.length, 0);
  // Tlačidlo ako input type=submit s hodnotou a pole označené len cez aria-label.
  assert.ok(vyhodnot('<input name="f1"><input name="f2" aria-label="Číslo zmluvy"><input type="email" name="f3"><input type="submit" value="Odoslať odstúpenie">').dobry);
});

test('vzorka 13: Microsoft Clarity, TikTok, Sklik a Heureka bez lišty sú nález a idú do predvyplnenia', async () => {
  const { vysledok } = await kontrola({ 'https://rumancek.sk/': { subor: '13-cudzie-skripty-uvod.html' } }, 'rumancek.sk');
  const ids = vysledok.sluzby.map((s) => s.id).sort();
  assert.deepEqual(ids, ['clarity', 'heureka-konverzie', 'sklik', 'tiktok']);
  assert.equal(stavy(vysledok).cookies, 'nalez');
  const text = vysledok.riadky.find((r) => r.id === 'cookies').text;
  assert.match(text, /Microsoft Clarity/);
  assert.match(text, /TikTok Pixel/);
  assert.ok(vysledok.predvyplnenie.ine.some((x) => /Clarity/.test(x)));
  assert.deepEqual(vysledok.predvyplnenie.cookies.sort(), ['analyticke', 'marketingove']);
});

test('vzorka 14: informačná lišta bez voľby pri Google Analytics je "nevieme", nie "v poriadku"', async () => {
  const { vysledok } = await kontrola({ 'https://hobla-hracky.sk/': { subor: '14-informacna-lista-uvod.html' } }, 'hobla-hracky.sk');
  const r = vysledok.riadky.find((x) => x.id === 'cookies');
  assert.equal(r.stav, 'nevieme');
  assert.match(r.text, /nevieme povedať, či ponúka voľbu/);
});

test('bez známych sledovacích skriptov je cookies "nevieme" a vymenuje cudzie domény skriptov', async () => {
  const html = vzorka('14-informacna-lista-uvod.html')
    .replace(/<script async src="https:\/\/www\.googletagmanager[^]*?<\/script>\s*<script>window\.dataLayer[^]*?<\/script>/, '');
  const { vysledok } = await kontrola({ 'https://hobla-hracky.sk/': { telo: html } }, 'hobla-hracky.sk');
  const r = vysledok.riadky.find((x) => x.id === 'cookies');
  assert.equal(vysledok.sluzby.length, 0);
  assert.equal(r.stav, 'nevieme');
  assert.match(r.text, /Nepoznané skripty nevidíme/);
  assert.match(r.text, /cdn\.jsdelivr\.net/);
});

test('najdiNastrojSuhlasu: pomenovaný nástroj má voľbu, Cookie Notice len s tlačidlom Odmietnuť, všeobecná lišta nikdy', () => {
  assert.deepEqual(najdiNastrojSuhlasu('<script src="https://consent.cookiebot.com/uc.js">'), { nazov: 'Cookiebot', sVolbou: true });
  assert.deepEqual(najdiNastrojSuhlasu('<div id="cookie-notice"><span id="cn-notice-text">Cookies</span><a id="cn-accept-cookie">OK</a></div>'), { nazov: 'Cookie Notice', sVolbou: false });
  assert.deepEqual(najdiNastrojSuhlasu('<div id="cookie-notice"><a id="cn-accept-cookie">OK</a><a id="cn-refuse-cookie" data-cookie-set="reject">Odmietnuť</a></div>'), { nazov: 'Cookie Notice', sVolbou: true });
  assert.deepEqual(najdiNastrojSuhlasu('<div class="cookie-banner">Používame cookies</div>'), { nazov: 'lišta podľa kódu stránky', sVolbou: false });
  // Všeobecná trieda a pomenovaný nástroj naraz: vyhrá pomenovaný.
  assert.deepEqual(najdiNastrojSuhlasu('<div class="cookie-bar"></div><script src="https://cdn-cookieyes.com/x.js">'), { nazov: 'CookieYes', sVolbou: true });
  assert.equal(najdiNastrojSuhlasu('<p>nic</p>'), null);
});

// ---------------------------------------------------------------------------
// Tvar odpovede: žiadne surové HTML, každý riadok má stav a zdroj
// ---------------------------------------------------------------------------

test('odpoveď nenesie surové HTML ani text stránky (nie je to proxy)', async () => {
  const { vysledok } = await kontrola({
    'https://cajovna-lipa.sk/': { subor: '01-vzorny-uvod.html' },
    'https://cajovna-lipa.sk/ochrana-osobnych-udajov/': { subor: '01-vzorny-zasady.html' },
    'https://cajovna-lipa.sk/odstupenie/': { subor: '01-vzorny-odstupenie.html' },
  }, 'cajovna-lipa.sk');
  const json = JSON.stringify(vysledok);
  assert.ok(!json.includes('TAJNY-ZNAK-VZORKY-01'), 'text stránky nesmie odísť v odpovedi');
  assert.ok(!/<(script|html|body|form|a )/i.test(json), 'žiadne HTML značky v odpovedi');
  assert.ok(json.length < 12000, `odpoveď je malá (${json.length} B)`);
});

test('každý riadok má jeden z troch stavov, text a zdroj s adresou https', async () => {
  const { vysledok } = await kontrola({ 'https://ponozky-pruh.sk/': { subor: '04-bez-odkazov-uvod.html' } }, 'ponozky-pruh.sk');
  assert.equal(vysledok.riadky.length, 7);
  assert.deepEqual(vysledok.riadky.map((r) => r.typ), ['odstupenie', 'rso', 'zasady', 'prijemcovia', 'cookies', 'identifikacia', 'podmienky']);
  for (const r of vysledok.riadky) {
    assert.ok(['ok', 'nalez', 'nevieme'].includes(r.stav), r.id);
    assert.ok(r.text && r.text.length > 20, r.id);
    assert.ok(r.zdroj && /^https:\/\//.test(r.zdroj.url) && r.zdroj.nazov, r.id);
    assert.ok(!new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']').test(r.text + r.zdroj.nazov), `${r.id}: bez pomlčiek`);
  }
  assert.equal(vysledok.upozornenie, 'Automatická kontrola verejnej stránky, nie právne poradenstvo.');
});

// ---------------------------------------------------------------------------
// Bezpečnosť adries
// ---------------------------------------------------------------------------

test('odmieta súkromné, interné a nepovolené adresy ešte pred sieťou', () => {
  const zle = [
    'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://2130706433/', 'http://0x7f000001/', 'ftp://obchod.sk/', 'file:///etc/passwd', 'javascript:alert(1)',
    'http://obchod.sk:8080/', 'https://user:heslo@obchod.sk/', 'http://intranet/', 'http://tiskaren.local/', 'http://8.8.8.8/',
    '', 'x'.repeat(600),
  ];
  for (const a of zle) {
    assert.throws(() => normalizujAdresu(a), KontrolaChyba, `mala byť odmietnutá: ${a.slice(0, 60)}`);
  }
  assert.equal(normalizujAdresu('obchod.sk').toString(), 'https://obchod.sk/');
  assert.equal(normalizujAdresu('http://www.obchod.sk/kategoria?x=1#top').toString(), 'http://www.obchod.sk/kategoria?x=1');
});

test('presmerovanie na súkromnú adresu sa nesleduje', async () => {
  const siet = falosnaSiet({ 'https://zly-obchod.sk/': { presmeruj: 'http://169.254.169.254/latest/meta-data/' } });
  await assert.rejects(
    skontrolujEshop('zly-obchod.sk', { fetchImpl: siet.fetchImpl, dnsImpl: verejneDns }),
    (e) => e instanceof KontrolaChyba && e.kod === 'adresa_ip',
  );
  assert.equal(siet.volania.length, 1);
});

test('doména, ktorá sa v DNS preloží na súkromnú adresu, sa nestiahne', async () => {
  const siet = falosnaSiet({ 'https://rebind.sk/': { subor: '01-vzorny-uvod.html' } });
  await assert.rejects(
    skontrolujEshop('rebind.sk', { fetchImpl: siet.fetchImpl, dnsImpl: async () => ['10.0.0.5'] }),
    (e) => e instanceof KontrolaChyba && e.kod === 'adresa_nepovolena',
  );
  assert.equal(siet.volania.length, 0);
});

test('jeNeverejnaIp: 10.x, 192.168.x, 169.254.x, loopback a IPv6 lokálne sú neverejné', () => {
  for (const ip of ['10.1.2.3', '192.168.0.10', '169.254.169.254', '127.0.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1']) {
    assert.equal(jeNeverejnaIp(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '2606:4700::6810:84e5']) assert.equal(jeNeverejnaIp(ip), false, ip);
});

test('prelozDns: NXDOMAIN je chyba domena_neexistuje, výpadok DoH vráti null', async () => {
  const nx = async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 });
  await assert.rejects(prelozDns('neexistuje-xyz.sk', nx), (e) => e.kod === 'domena_neexistuje');
  const dole = async () => { throw new Error('siet'); };
  assert.equal(await prelozDns('obchod.sk', dole), null);
  const ok = async (url) => new Response(JSON.stringify({ Status: 0, Answer: url.includes('type=A&') || url.endsWith('type=A') ? [{ type: 1, data: '93.184.216.34' }] : [] }), { status: 200 });
  assert.deepEqual(await prelozDns('obchod.sk', ok), ['93.184.216.34']);
});

test('veľkosť: telo sa číta najviac po limit a zvyšok sa zahodí', async () => {
  const obrovske = `<html><body>${'a'.repeat(LIMIT_UVOD_BAJTOV + 500000)}</body></html>`;
  const siet = falosnaSiet({ 'https://velky.sk/': { telo: obrovske } });
  const r = await stiahniStranku('https://velky.sk/', { fetchImpl: siet.fetchImpl, dnsImpl: verejneDns }, { limit: LIMIT_UVOD_BAJTOV });
  assert.equal(r.ok, true);
  assert.equal(r.orezane, true);
  assert.ok(r.html.length <= LIMIT_UVOD_BAJTOV);
});

test('čas: po vyčerpaní časového rozpočtu sa ďalej nesťahuje', async () => {
  let t = 0;
  const siet = falosnaSiet({ 'https://pomaly.sk/': { subor: '01-vzorny-uvod.html' } });
  await assert.rejects(
    skontrolujEshop('pomaly.sk', { fetchImpl: siet.fetchImpl, dnsImpl: verejneDns, now: () => (t++ === 0 ? 0 : 60000) }),
    (e) => e.kod === 'stranka_pomala',
  );
  assert.equal(siet.volania.length, 0);
});

test('iný obsah než HTML a stránka, ktorá robota odmietne, majú vlastný kód', async () => {
  const pdf = falosnaSiet({ 'https://subor.sk/': { telo: '%PDF-1.4', typ: 'application/pdf' } });
  await assert.rejects(skontrolujEshop('subor.sk', { fetchImpl: pdf.fetchImpl, dnsImpl: verejneDns }), (e) => e.kod === 'nie_html');
  const blok = falosnaSiet({ 'https://chraneny.sk/': { telo: 'Access denied', status: 403 } });
  await assert.rejects(skontrolujEshop('chraneny.sk', { fetchImpl: blok.fetchImpl, dnsImpl: verejneDns }), (e) => e.kod === 'stranka_blokuje');
});

test('presmerovanie http na https www sa sleduje a ďalšie stránky sa berú z cieľovej domény', async () => {
  const { vysledok } = await kontrola({
    'http://cajovna-lipa.sk/': { presmeruj: 'https://www.cajovna-lipa.sk/' },
    'https://www.cajovna-lipa.sk/': { subor: '01-vzorny-uvod.html' },
    'https://www.cajovna-lipa.sk/ochrana-osobnych-udajov/': { subor: '01-vzorny-zasady.html' },
    'https://www.cajovna-lipa.sk/odstupenie/': { subor: '01-vzorny-odstupenie.html' },
  }, 'http://cajovna-lipa.sk');
  assert.equal(vysledok.adresa, 'https://www.cajovna-lipa.sk/');
  assert.equal(stavy(vysledok).odstupenie, 'ok');
});

test('nekonečné presmerovanie skončí chybou', async () => {
  const siet = falosnaSiet({
    'https://kruh.sk/a': { presmeruj: 'https://kruh.sk/b' },
    'https://kruh.sk/b': { presmeruj: 'https://kruh.sk/a' },
  });
  await assert.rejects(skontrolujEshop('https://kruh.sk/a', { fetchImpl: siet.fetchImpl, dnsImpl: verejneDns }), (e) => e.kod === 'vela_presmerovani');
  assert.ok(siet.volania.length <= 5);
});

// ---------------------------------------------------------------------------
// Trasa: CORS, limity na IP a na cieľ
// ---------------------------------------------------------------------------

function envPreTrasu(mapa) {
  const siet = falosnaSiet(mapa);
  return { env: { ASISTENT_CACHE: createMockKV(), ALLOWED_ORIGINS: 'arling.sk', fetchImpl: siet.fetchImpl, dnsImpl: verejneDns }, siet };
}

function poziadavka(url, { ip = '203.0.113.7', origin = 'https://arling.sk' } = {}) {
  return new Request('https://arling-asistent.arling.workers.dev/v1/eshop/kontrola', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ url }),
  });
}

test('POST /v1/eshop/kontrola cez smerovač vráti výsledok s CORS pre arling.sk', async () => {
  const { env } = envPreTrasu({
    'https://cajovna-lipa.sk/': { subor: '01-vzorny-uvod.html' },
    'https://cajovna-lipa.sk/ochrana-osobnych-udajov/': { subor: '01-vzorny-zasady.html' },
    'https://cajovna-lipa.sk/odstupenie/': { subor: '01-vzorny-odstupenie.html' },
  });
  const res = await worker.fetch(poziadavka('cajovna-lipa.sk'), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://arling.sk');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const data = await res.json();
  assert.equal(data.riadky.length, 7);

  const pre = await worker.fetch(new Request('https://arling-asistent.arling.workers.dev/v1/eshop/kontrola', {
    method: 'OPTIONS', headers: { Origin: 'https://arling.sk', 'Access-Control-Request-Method': 'POST' },
  }), env, {});
  assert.equal(pre.status, 204);
  const cudzi = await worker.fetch(new Request('https://arling-asistent.arling.workers.dev/v1/eshop/kontrola', {
    method: 'OPTIONS', headers: { Origin: 'https://zly.example', 'Access-Control-Request-Method': 'POST' },
  }), env, {});
  assert.equal(cudzi.status, 403);
});

test('trasa odmietne súkromnú adresu kódom 400 a nič nestiahne', async () => {
  const { env, siet } = envPreTrasu({});
  const res = await handleEshopKontrolaRoute(poziadavka('http://192.168.1.1/'), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'adresa_ip');
  assert.equal(siet.volania.length, 0);
});

test('limit na IP: siedma kontrola za minútu z jednej IP je 429', async () => {
  const { env } = envPreTrasu({ 'https://ponozky-pruh.sk/': { subor: '04-bez-odkazov-uvod.html' } });
  const kody = [];
  for (let i = 0; i < 7; i++) {
    const res = await handleEshopKontrolaRoute(poziadavka('ponozky-pruh.sk'), env);
    kody.push(res.status);
  }
  assert.deepEqual(kody.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.equal(kody[6], 429);
});

test('limit na cieľ: jednu doménu nejde kontrolovať viac ako 10-krát za hodinu ani z rôznych IP', async () => {
  const { env } = envPreTrasu({ 'https://ponozky-pruh.sk/': { subor: '04-bez-odkazov-uvod.html' } });
  const kody = [];
  for (let i = 0; i < 11; i++) {
    const res = await handleEshopKontrolaRoute(poziadavka('ponozky-pruh.sk', { ip: `198.51.100.${i + 1}` }), env);
    kody.push(res.status);
  }
  assert.equal(kody.filter((k) => k === 200).length, 10);
  assert.equal(kody[10], 429);
  // Kľúč limitu nesie odtlačok, nie meno domény.
  const kluce = [...(env.ASISTENT_CACHE._store ? env.ASISTENT_CACHE._store.keys() : [])];
  assert.ok(!kluce.some((k) => k.includes('ponozky')), 'doména sa nesmie ukladať v čitateľnej podobe');
});

test('príliš veľké telo požiadavky je 413', async () => {
  const { env } = envPreTrasu({});
  const res = await handleEshopKontrolaRoute(new Request('https://x.sk/v1/eshop/kontrola', {
    method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ url: 'a'.repeat(5000) }),
  }), env);
  assert.equal(res.status, 413);
});

test('zásady: produktový odkaz s GDPR neprebije výslovný odkaz Ochrana údajov (arling.sk 24. 9. 2026)', async () => {
  const { najdiOdkazy } = await import('../worker/src/eshop-kontrola.js');
  const o = (text, href) => ({ norm: text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''), href, hrefNorm: href.toLowerCase() });
  const vysledok = najdiOdkazy([o('GDPR dokumenty Pre firmu a e-shop za 10 minút', 'https://arling.sk/gdpr-dokumenty/'), o('Ochrana údajov', 'https://arling.sk/privacy/')]);
  assert.equal(vysledok.zasady.href, 'https://arling.sk/privacy/');
});

test('RSO: veta, že platforma ODR už neexistuje, nie je nález', async () => {
  const { spominaZivuRso } = await import('../worker/src/eshop-kontrola.js');
  assert.equal(spominaZivuRso('europska platforma na riesenie sporov online (odr) uz neexistuje: nariadenie ju zrusilo'), false);
  assert.equal(spominaZivuRso('the european online dispute resolution platform (odr) no longer exists'), false);
  assert.equal(spominaZivuRso('spotrebitel moze vyuzit platformu riesenia sporov online na adrese ec.europa.eu'), true);
});
