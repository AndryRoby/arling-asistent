// hub-skuska-chyby.test.mjs
//
// Návrat z chýb skúšky na arling.sk/asistent/ (products/arling-sk/asistent/app.js),
// brána Asistenta v2 29. 9. 2026, nález 1 a 6: po chybe feedu, po dlhom čakaní
// aj po vypršanom kóde sa formulár dá opraviť a poslať znova bez obnovenia
// stránky; staré sledovanie stavu po novom odoslaní nič neprepíše; chybové
// kódy sú v jazyku stránky. Beží vo vm s malým falošným DOM, falošným fetch
// a ručne spúšťanými časovačmi, žiadna sieť.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const tu = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(tu, '..', '..', 'arling-sk', 'asistent', 'app.js'), 'utf8');

class El {
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

/** odpovede: cesta -> funkcia (poradie volania tej cesty) -> { status, body } */
function prostredie({ jazyk = 'sk', odpovede = {}, uloziste = null } = {}) {
  const ids = {};
  const kontajner = new El('div');
  for (const id of ['trial-form', 'trial-feed-url', 'trial-email', 'trial-lang', 'trial-submit', 'trial-status', 'trial-widget-note', 'trial-feed-error']) ids[id] = new El(id === 'trial-form' ? 'form' : 'input');
  kontajner.appendChild(ids['trial-status']);
  const volania = [];
  const pocty = {};
  const fetch = async (url, init = {}) => {
    const cesta = new URL(url).pathname;
    pocty[cesta] = (pocty[cesta] || 0) + 1;
    volania.push({ cesta, init });
    const f = odpovede[cesta];
    // odpoveď môže byť aj Promise (oneskorená odpoveď staršieho pokusu)
    const o = await (f ? f(pocty[cesta], init) : { status: 404, body: {} });
    return { ok: o.status < 400, status: o.status, json: async () => o.body };
  };
  const casovace = [];
  const body = new El('body');
  const document = {
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => new El(tag),
    documentElement: { getAttribute: (k) => (k === 'lang' ? jazyk : null) },
    readyState: 'complete',
    currentScript: { src: 'https://arling.sk/asistent/app.js' },
    body,
  };
  const sledovane = []; // udalosti Umami (app.js track)
  const window = {
    location: { search: '', href: 'https://arling.sk/asistent/' },
    // uloziste (Map) = skutočné localStorage na jednu stránku; bez neho nič neukladá ako doteraz
    localStorage: uloziste
      ? { getItem: (k) => (uloziste.has(k) ? uloziste.get(k) : null), setItem: (k, v) => { uloziste.set(k, String(v)); }, removeItem: (k) => { uloziste.delete(k); } }
      : { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    umami: { track: (e, d) => sledovane.push({ e, d }) },
  };
  const kontext = { window, document, fetch, URL, URLSearchParams, setTimeout: (f) => { casovace.push(f); return casovace.length; }, console, navigator: {} };
  vm.runInNewContext(src, kontext);
  const p = { ids, volania, kontajner, casovace, body, window, sledovane };
  p.odosli = async (feed, email = 'majitel@gmail.com') => {
    ids['trial-feed-url'].value = feed;
    ids['trial-email'].value = email;
    ids['trial-form'].fire('submit');
    await vsetko();
  };
  // spustí všetky čakajúce časovače (jedno kolo sledovania stavu)
  p.tik = async () => { const f = casovace.splice(0); for (const x of f) x(); await vsetko(); };
  p.stav = () => ids['trial-status'].textContent;
  p.skripty = () => body.children.filter((c) => c.tagName === 'script');
  return p;
}

const cakaj = () => new Promise((r) => setImmediate(r));
async function vsetko() { for (let i = 0; i < 12; i++) await cakaj(); }

const ucet = (id) => () => ({ status: 201, body: { id, domain: 'shop.sk', status: 'pending', overeny: false } });
const kodOk = () => ({ status: 200, body: { ok: true } });

test('chyba feedu: tlačidlo sa odomkne, pole URL je označené, oprava a nové odoslanie pokračuje až do hotového Asistenta', async () => {
  let opravene = false;
  const p = prostredie({
    odpovede: {
      '/v1/tenants': (n, init) => { opravene = JSON.parse(init.body).feed_url.endsWith('/spravny.xml'); return { status: 201, body: { id: 't-1', domain: 'shop.sk', status: 'pending' } }; },
      '/v1/ucet/kod': kodOk,
      '/v1/tenants/t-1/status': () => ({ status: 200, body: { status: opravene ? 'ready' : 'error' } }),
    },
  });
  await p.odosli('https://shop.sk/zly.xml');
  assert.match(p.stav(), /Opravte URL feedu a odošlite formulár znova/);
  assert.equal(p.ids['trial-submit'].disabled, false);
  assert.equal(p.ids['trial-feed-url'].getAttribute('aria-invalid'), 'true');

  await p.odosli('https://shop.sk/spravny.xml');
  assert.equal(p.ids['trial-feed-url'].getAttribute('aria-invalid'), null); // nové odoslanie chybu zruší
  const posty = p.volania.filter((v) => v.cesta === '/v1/tenants');
  assert.equal(posty.length, 2);
  assert.equal(JSON.parse(posty[1].init.body).feed_url, 'https://shop.sk/spravny.xml');
  assert.doesNotMatch(p.stav(), /nepodarilo/);
  assert.equal(p.skripty().length, 1); // Asistent sa vložil na stránku
  assert.equal(p.skripty()[0].getAttribute('data-tenant'), 't-1');
});

test('dlhé čakanie: po vyčerpaní pokusov tlačidlo znova funguje a opätovné odoslanie skontroluje stav', async () => {
  let druhy = false;
  const p = prostredie({
    odpovede: {
      '/v1/tenants': (n) => { druhy = n > 1; return { status: 201, body: { id: 't-2', domain: 'shop.sk', status: 'pending' } }; },
      '/v1/ucet/kod': kodOk,
      '/v1/tenants/t-2/status': () => ({ status: 200, body: { status: druhy ? 'ready' : 'pending' } }),
    },
  });
  await p.odosli('https://shop.sk/feed.xml');
  assert.equal(p.ids['trial-submit'].disabled, true);
  for (let i = 0; i < 45 && p.casovace.length; i++) await p.tik();
  assert.match(p.stav(), /trvá dlhšie ako obvykle\. O chvíľu odošlite formulár znova/);
  assert.equal(p.ids['trial-submit'].disabled, false);

  await p.odosli('https://shop.sk/feed.xml');
  assert.equal(p.skripty().length, 1);
  assert.doesNotMatch(p.stav(), /dlhšie/);
});

test('vypršaný kód: správa povie, čo urobiť, formulár sa odomkne a nové odoslanie pošle nový kód', async () => {
  const p = prostredie({
    odpovede: {
      '/v1/tenants': ucet('t-3'),
      '/v1/ucet/kod': kodOk,
      '/v1/ucet/over': () => ({ status: 400, body: { error: 'no_code' } }),
      '/v1/tenants/t-3/status': () => ({ status: 200, body: { status: 'pending' } }),
    },
  });
  await p.odosli('https://shop.sk/feed.xml');
  assert.equal(p.ids['trial-submit'].disabled, true); // spracovanie ešte beží
  const box = p.kontajner.querySelector('.trial-verify');
  const formKod = box.querySelector('.trial-verify-form');
  formKod.querySelector('.field').children[1].value = '123456';
  formKod.fire('submit');
  await vsetko();
  assert.match(box.querySelector('.trial-verify-msg').textContent, /Kód už neplatí\. Odošlite formulár znova, pošleme nový\./);
  assert.equal(p.ids['trial-submit'].disabled, false);

  await p.odosli('https://shop.sk/feed.xml');
  assert.equal(p.volania.filter((v) => v.cesta === '/v1/ucet/kod').length, 2);
  assert.ok(p.kontajner.querySelector('.trial-verify'), 'nové pole na kód');
});

test('nesprávny kód s ďalšími pokusmi formulár nechá zamknutý a pýta kód znova', async () => {
  const p = prostredie({
    odpovede: {
      '/v1/tenants': ucet('t-4'),
      '/v1/ucet/kod': kodOk,
      '/v1/ucet/over': () => ({ status: 400, body: { error: 'bad_code', remaining: 3 } }),
      '/v1/tenants/t-4/status': () => ({ status: 200, body: { status: 'pending' } }),
    },
  });
  await p.odosli('https://shop.sk/feed.xml');
  const box = p.kontajner.querySelector('.trial-verify');
  const formKod = box.querySelector('.trial-verify-form');
  formKod.querySelector('.field').children[1].value = '000000';
  formKod.fire('submit');
  await vsetko();
  assert.equal(p.ids['trial-submit'].disabled, true);
  assert.equal(formKod.children[1].disabled, false); // tlačidlo „Overiť“ znova funguje
});

test('staré sledovanie stavu po novom odoslaní nič neprepíše', async () => {
  const p = prostredie({
    odpovede: {
      '/v1/tenants': (n) => ({ status: 201, body: { id: n === 1 ? 't-stary' : 't-novy', domain: 'shop.sk', status: 'pending' } }),
      '/v1/ucet/kod': kodOk,
      '/v1/ucet/over': () => ({ status: 400, body: { error: 'no_code' } }),
      '/v1/tenants/t-stary/status': () => ({ status: 200, body: { status: 'error' } }),
      '/v1/tenants/t-novy/status': () => ({ status: 200, body: { status: 'pending' } }),
    },
  });
  // prvé odoslanie: stav ešte čaká, časovač sledovania je naplánovaný
  const staryStav = p.volania.length;
  p.ids['trial-feed-url'].value = 'https://shop.sk/a.xml';
  p.ids['trial-email'].value = 'majitel@gmail.com';
  p.ids['trial-form'].fire('submit');
  // odpoveď na stav starého účtu príde až po druhom odoslaní
  p.ids['trial-feed-url'].value = 'https://shop.sk/b.xml';
  p.ids['trial-form'].fire('submit');
  await vsetko();
  await p.tik();
  assert.ok(p.volania.length > staryStav);
  assert.doesNotMatch(p.stav(), /nepodarilo/); // chyba starého účtu sa neukázala
  const poTiku = p.volania.filter((v) => v.cesta === '/v1/tenants/t-stary/status').length;
  await p.tik();
  assert.equal(p.volania.filter((v) => v.cesta === '/v1/tenants/t-stary/status').length, poTiku); // staré sledovanie skončilo
});

test('chybové kódy vytvorenia účtu sú v jazyku stránky (nemčina bez slovenčiny, angličtina)', async () => {
  for (const [jazyk, ocakavane, zakazane] of [
    ['de', /Das heutige Limit für Testkonten ist erreicht\./, /Dnešný|limit skúšobných/],
    ['en', /Today's limit of trial accounts has been reached\./, /Dnešný/],
    ['sk', /Dnešný limit skúšobných účtov bol dosiahnutý\./, /Today/],
  ]) {
    const p = prostredie({ jazyk, odpovede: { '/v1/tenants': () => ({ status: 429, body: { error: 'quota_exceeded' } }) } });
    await p.odosli('https://shop.sk/feed.xml');
    assert.match(p.stav(), ocakavane, jazyk);
    assert.doesNotMatch(p.stav(), zakazane, jazyk);
    assert.equal(p.ids['trial-submit'].disabled, false, jazyk);
  }
  const p = prostredie({ jazyk: 'de', odpovede: { '/v1/tenants': () => ({ status: 500, body: { error: 'internal_error' } }) } });
  await p.odosli('https://shop.sk/feed.xml');
  assert.match(p.stav(), /Auf unserem Server ist ein Fehler aufgetreten\./);
});

// ---------------------------------------------------------------------------
// Bezpečnostná kontrola 29. 9. 2026 (worker onboarding.js, nález 1 a 2):
// 409 domain_taken a feed_treba_overit musia byť zrozumiteľné v jazyku stránky,
// bez id cudzieho obchodu a bez sledovania stavu; id vlastnej skúšky sa pamätá
// pre živú ukážku (live/live.js).
// ---------------------------------------------------------------------------

test('409 domain_taken: celá veta s ďalším krokom v jazyku stránky, bez textu workera navyše, bez sledovania stavu, tlačidlo odomknuté, udalosť v Umami', async () => {
  for (const [jazyk, ocakavane, zakazane] of [
    ['sk', /Tento obchod už má Asistenta, založeného s inou e-mailovou adresou\. .*kódom.*podpora@arling\.sk/, /This shop|Dieser|Nepodarilo sa vytvoriť/],
    ['en', /This shop already has an assistant, set up with a different e-mail address\. .*code.*support@arling\.sk/, /Tento obchod|Could not create/],
    ['de', /Für diesen Shop gibt es bereits einen Assistenten, eingerichtet mit einer anderen E-Mail-Adresse\. .*Code.*support@arling\.sk/, /Tento obchod|This shop|Das Testkonto/],
  ]) {
    const p = prostredie({ jazyk, odpovede: { '/v1/tenants': () => ({ status: 409, body: { error: 'domain_taken', issues: ['TEXT-WORKERA'] } }) } });
    await p.odosli('https://obsadeny.sk/feed.xml', 'iny@gmail.com');
    assert.match(p.stav(), ocakavane, jazyk);
    assert.doesNotMatch(p.stav(), zakazane, jazyk);
    assert.doesNotMatch(p.stav(), /TEXT-WORKERA|domain_taken/, jazyk);
    assert.equal(p.ids['trial-status'].className, 'trial-status trial-status-error', jazyk);
    assert.equal(p.ids['trial-submit'].disabled, false, jazyk);
    assert.equal(p.volania.filter((v) => /\/status$/.test(v.cesta)).length, 0, jazyk);
    assert.equal(p.volania.filter((v) => v.cesta === '/v1/ucet/kod').length, 0, jazyk);
    assert.equal(p.skripty().length, 0, jazyk);
    assert.deepEqual(p.sledovane.map((x) => x.e), ['trial_start', 'trial_domain_taken'], jazyk);
  }
});

test('feed_treba_overit (druhé kolo): pravdivo, že nový feed sa neuložil a kód nepomôže; stav sa nesleduje, kód sa nepýta, Asistent sa nevloží, udalosť v Umami', async () => {
  for (const [jazyk, sprava, zakazane] of [
    ['sk', /^Novú adresu feedu sme neuložili: .*podpora@arling\.sk\.$/, /uložíme|kódom|odpovedá z doterajšieho/],
    ['en', /^We did not save the new feed URL: .*support@arling\.sk\.$/, /we will save|with the code|answers from the current/],
    ['de', /^Die neue Feed-URL haben wir nicht gespeichert: .*support@arling\.sk\.$/, /speichern wir|mit dem Code|antwortet der Assistent aus/],
  ]) {
    const p = prostredie({
      jazyk,
      odpovede: {
        '/v1/tenants': () => ({ status: 200, body: { id: 't-bezi', domain: 'shop.sk', status: 'ready', existing: true, overeny: false, feed_treba_overit: true } }),
        '/v1/ucet/kod': kodOk,
        '/v1/ucet/over': () => ({ status: 200, body: { token: 'tok-1' } }),
        '/v1/tenants/t-bezi/overenie': () => ({ status: 200, body: { overeny: true } }),
        '/v1/tenants/t-bezi/status': () => ({ status: 200, body: { status: 'ready' } }),
      },
    });
    await p.odosli('https://shop.sk/novy-feed.xml', 'majitel@shop.sk');
    assert.match(p.stav(), sprava, jazyk);
    assert.doesNotMatch(p.stav(), zakazane, jazyk);
    assert.equal(p.ids['trial-status'].className, 'trial-status trial-status-warn', jazyk);
    assert.equal(p.ids['trial-submit'].disabled, false, jazyk);
    assert.equal(p.volania.filter((v) => v.cesta === '/v1/tenants/t-bezi/status').length, 0, jazyk);
    assert.equal(p.skripty().length, 0, jazyk); // Asistent sa nevložil, akoby nový feed už bežal
    assert.equal(p.volania.filter((v) => v.cesta === '/v1/ucet/kod').length, 0, jazyk);
    assert.equal(p.kontajner.querySelector('.trial-verify'), null, jazyk);
    assert.deepEqual(p.sledovane.map((x) => x.e), ['trial_start', 'trial_feed_not_saved'], jazyk);
  }
});

test('id vlastnej skúšky sa zapamätá v prehliadači pre živú ukážku (201 aj 200 majiteľa), najviac 10 posledných, bez duplicít', async () => {
  const uloziste = new Map();
  let n = 0;
  const p = prostredie({
    uloziste,
    odpovede: {
      '/v1/tenants': () => { n += 1; return { status: n === 2 ? 200 : 201, body: { id: n === 2 ? 't-1' : `t-${n}`, domain: 'shop.sk', status: 'pending', existing: n === 2 } }; },
      '/v1/ucet/kod': kodOk,
    },
  });
  for (let i = 0; i < 13; i++) await p.odosli(`https://shop${i}.sk/feed.xml`);
  const zoznam = JSON.parse(uloziste.get('arling_asistent_skusky'));
  assert.equal(zoznam.length, 10);
  assert.equal(new Set(zoznam).size, 10);
  assert.equal(zoznam[zoznam.length - 1], 't-13');
  assert.ok(!zoznam.includes('t-3'), 'najstaršie vypadli');

  // Odmietnutá doména (409) sa nezapamätá.
  const u2 = new Map();
  const p2 = prostredie({ uloziste: u2, odpovede: { '/v1/tenants': () => ({ status: 409, body: { error: 'domain_taken' } }) } });
  await p2.odosli('https://obsadeny.sk/feed.xml');
  assert.equal(u2.has('arling_asistent_skusky'), false);
});

// Brána 29. 9., pokus 2, nález 2: oneskorená odpoveď staršieho pokusu (odoslanie kódu aj overenie kódu,
// úspech aj chyba) nesmie zmeniť nové pole na kód, jeho hlásenie ani ovládanie.
function odlozene() { let pusti; const p = new Promise((r) => { pusti = r; }); return { p, pusti }; }

for (const [nazov, staryKod] of [['chyba 500', { status: 500, body: {} }], ['úspech', { status: 200, body: { ok: true } }]]) {
  test(`staré odoslanie kódu (${nazov}) po novom odoslaní formulára nové pole na kód nezmení`, async () => {
    const stary = odlozene();
    const p = prostredie({
      odpovede: {
        '/v1/tenants': (n) => ({ status: 201, body: { id: 't-9', domain: 'shop.sk', status: 'pending', overeny: false } }),
        '/v1/ucet/kod': (n) => (n === 1 ? stary.p : { status: 200, body: { ok: true } }),
        '/v1/tenants/t-9/status': (n) => ({ status: 200, body: { status: n === 1 ? 'error' : 'pending' } }),
      },
    });
    await p.odosli('https://shop.sk/zly.xml');           // 1. pokus: kód visí, feed zlyhá
    assert.equal(p.ids['trial-submit'].disabled, false);
    await p.odosli('https://shop.sk/dobry.xml');         // 2. pokus: nový kód príde hneď
    const box = p.kontajner.querySelector('.trial-verify');
    assert.ok(box && box.querySelector('.trial-verify-form'), 'nové pole na kód');
    const pred = box.querySelector('.trial-verify-msg').textContent;
    stary.pusti(staryKod);                                // starý kód dobehne neskoro
    await vsetko();
    const po = p.kontajner.querySelector('.trial-verify');
    assert.equal(po, box, 'to isté pole, nevymenené');
    assert.ok(po.querySelector('.trial-verify-form'), 'formulár kódu ostal');
    assert.equal(po.querySelector('.trial-verify-msg').textContent, pred, 'hlásenie sa nezmenilo');
  });
}

test('staré overenie kódu po novom odoslaní formulára nové pole, hlásenie ani tlačidlo nezmení', async () => {
  const stareOver = odlozene();
  const p = prostredie({
    odpovede: {
      '/v1/tenants': () => ({ status: 201, body: { id: 't-8', domain: 'shop.sk', status: 'pending', overeny: false } }),
      '/v1/ucet/kod': () => ({ status: 200, body: { ok: true } }),
      '/v1/ucet/over': (n) => (n === 1 ? stareOver.p : { status: 400, body: { error: 'bad_code', remaining: 2 } }),
      '/v1/tenants/t-8/status': () => ({ status: 200, body: { status: 'pending' } }),
    },
  });
  await p.odosli('https://shop.sk/feed.xml');
  const staryBox = p.kontajner.querySelector('.trial-verify');
  const staryForm = staryBox.querySelector('.trial-verify-form');
  staryForm.querySelector('.field').children[1].value = '111111';
  staryForm.fire('submit');                               // overenie visí
  await vsetko();
  // majiteľ medzitým pošle formulár znova (napr. opravený feed): tlačidlo odomkne vypršaný kód, tu simulujeme priame odoslanie
  p.ids['trial-submit'].disabled = false;
  await p.odosli('https://shop.sk/feed2.xml');
  const box = p.kontajner.querySelector('.trial-verify');
  assert.notEqual(box, staryBox, 'nový pokus má nové pole');
  const btn = box.querySelector('.trial-verify-form').children[1];
  const pred = box.querySelector('.trial-verify-msg').textContent;
  stareOver.pusti({ status: 400, body: { error: 'no_code' } });   // staré overenie dobehne s chybou
  await vsetko();
  assert.equal(p.kontajner.querySelector('.trial-verify'), box);
  assert.equal(box.querySelector('.trial-verify-msg').textContent, pred, 'hlásenie nového poľa sa nezmenilo');
  assert.equal(btn.disabled, false, 'tlačidlo nového poľa sa nezmenilo');
  assert.doesNotMatch(p.stav(), /už neplatí/);
});
