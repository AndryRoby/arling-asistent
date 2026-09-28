/*
 * Testy HTML obalu e-mailov životného cyklu (Z-42, 28. 9. 2026):
 * worker/src/zivotny-cyklus-html.js a nadpisy, preheadery a tlačidlá
 * v worker/src/zivotny-cyklus-texty.js. H7 až H12 pribudli v pokuse 2 po
 * bráne (ops/ai/kontrola/2026-09-28-z42-html-emaily.md).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { vytvorEmail, KODY_EMAILOV, JAZYKY_EMAILOV, PLATFORMY, CENY_EUR } from '../worker/src/zivotny-cyklus-texty.js';
import { odsekHtml, jePovolenyOdkaz, PISMO_NADPISU, odkaz, textOdkazov } from '../worker/src/zivotny-cyklus-html.js';
import { PLANS, DEFAULT_QUOTAS } from '../worker/src/tenants.js';
import { DENNY_STROP_OTAZOK } from '../worker/src/budget.js';
import { RELACIA_PLATNOST_S, MAX_OTAZOK_NA_ROZHOVOR, maxOtazok } from '../worker/src/relacia.js';

// Nezlomiteľná medzera, ako v textoch („19 EUR“, „24 hodín“, „1 000“).
const NB = ' ';

function parametre(extra = {}) {
  return {
    domena: 'www.ludovka.eu', tenantId: 'abcd1234-0000', pocet: 253, platforma: 'eshoprychle', zdroj: 'formular',
    datum: new Date('2026-09-25T09:00:00Z'), kedy: new Date('2026-09-25T12:05:00Z'), feedUrl: 'https://www.ludovka.eu/heureka.xml',
    chybaKod: 'feed_http_403', used: 80, quota: 100, mesiac: 9, dalsiMesiac: new Date('2026-10-01T00:00:00Z'),
    ucet: 'https://arling.sk/asistent/tenant/?t=abcd1234-0000', skusit: 'https://arling.sk/asistent/live/?t=abcd1234-0000&shop=www.ludovka.eu',
    stop: 'https://arling-asistent.arling.workers.dev/v1/tenants/abcd1234-0000/emaily/stop?k=podpis', volitelne: true, ...extra,
  };
}

const wpParametre = (extra = {}) => parametre({ platforma: 'wordpress', zdroj: 'wordpress', ...extra });
const tlacidla = (html) => [...html.matchAll(/<a href="([^"]+)" class="tlacidlo-a"/g)].map((m) => m[1]);

test('H1. každý e-mail v každom jazyku: tabuľka 600 px, tmavý režim, preheader, nadpis, najviac jedno tlačidlo na arling.sk', () => {
  for (const kod of KODY_EMAILOV) {
    for (const jazyk of JAZYKY_EMAILOV) {
      for (const platforma of PLATFORMY) {
        const e = vytvorEmail(kod, jazyk, parametre({ platforma, zdroj: platforma === 'wordpress' ? 'wordpress' : 'formular' }));
        const m = `${kod} ${jazyk} ${platforma}`;
        assert.ok(e.html.startsWith('<!doctype html>'), m);
        assert.ok(e.html.includes(`<html lang="${jazyk}"`), m);
        assert.ok(e.html.includes('max-width:600px'), `${m}: šírka`);
        assert.ok(e.html.includes('<!--[if mso]><table role="presentation" width="600"'), `${m}: Outlook 600`);
        assert.ok(e.html.includes('prefers-color-scheme:dark') && e.html.includes('name="color-scheme" content="light dark"'), `${m}: tmavý režim`);
        assert.ok(e.html.includes('max-width:620px'), `${m}: úzky displej`);
        assert.ok(e.nadpis && e.preheader, `${m}: nadpis a preheader`);
        assert.ok(e.html.includes('class="nadpis ink"'), `${m}: nadpis`);
        assert.ok(!/[–—]/.test(e.nadpis + e.preheader + e.html + e.text), `${m}: pomlčka`);
        const t = tlacidla(e.html);
        assert.ok(t.length <= 1, `${m}: viac tlačidiel`);
        for (const u of t) assert.ok(jePovolenyOdkaz(u) && u.startsWith('https://arling.sk/'), `${m}: tlačidlo ${u}`);
        assert.ok(!/<img|pixel|utm_|<script/i.test(e.html), `${m}: sledovanie alebo skript`);
        // Gmail oreže správu nad 102 kB; nechávame veľkú rezervu.
        assert.ok(Buffer.byteLength(e.html) < 60000, `${m}: HTML ${Buffer.byteLength(e.html)} B`);
        // Jediný vonkajší zdroj je písmo nadpisu na arling.sk (bez parametra v adrese).
        for (const u of e.html.matchAll(/url\(([^)]+)\)/g)) assert.equal(u[1], PISMO_NADPISU);
        // Čistý text nenesie značky HTML okrem vkladacieho kódu.
        assert.ok(!/<(p|a|table|td|strong)\b/.test(e.text), `${m}: HTML v texte`);
      }
    }
  }
});

test('H2. tlačidlo podľa cieľa: E1 kód (formulár) alebo skúška (WordPress), E0 formulár, E2 až E4 stránka účtu, E3 WordPress žiadne', () => {
  const p = parametre();
  assert.deepEqual(tlacidla(vytvorEmail('E1', 'sk', p).html), [p.ucet]);
  assert.match(vytvorEmail('E1', 'sk', p).html, />Otvoriť kód na vloženie</);
  const wp = wpParametre();
  assert.deepEqual(tlacidla(vytvorEmail('E1', 'en', wp).html), [wp.skusit.replace(/&/g, '&amp;')]);
  assert.deepEqual(tlacidla(vytvorEmail('E1W', 'de', p).html), [p.skusit.replace(/&/g, '&amp;')]);
  assert.deepEqual(tlacidla(vytvorEmail('E0', 'sk', p).html), ['https://arling.sk/asistent/']);
  assert.deepEqual(tlacidla(vytvorEmail('E0', 'de', p).html), ['https://arling.sk/asistent/en/']);
  // Chyba na našej strane: majiteľ nemá čo robiť, žiadne tlačidlo. WordPress: „Try again“ je v jeho administrácii.
  assert.deepEqual(tlacidla(vytvorEmail('E0', 'sk', parametre({ chybaKod: 'internal' })).html), []);
  assert.deepEqual(tlacidla(vytvorEmail('E0', 'cs', wp).html), []);
  for (const kod of ['E2', 'E3', 'E4']) assert.deepEqual(tlacidla(vytvorEmail(kod, 'cs', p).html), [p.ucet], kod);
  assert.match(vytvorEmail('E3', 'sk', p).html, />Otvoriť kód na vloženie</);
  // WordPress E3: kód sa nevkladá a na kontrolu pluginu nevedie naša adresa, výzvou je odpoveď.
  for (const jazyk of JAZYKY_EMAILOV) assert.deepEqual(tlacidla(vytvorEmail('E3', jazyk, wp).html), [], `E3 WordPress ${jazyk}`);
  // Cudzia adresa v parametri nikdy nevytvorí tlačidlo.
  assert.deepEqual(tlacidla(vytvorEmail('E1W', 'en', parametre({ skusit: 'https://zly.example/y' })).html), []);
});

test('H3. E2 hovorí na rovinu, že otázky zákazníkov neukladáme; E4 čísla plánov priamo z konštánt kódu', () => {
  assert.match(vytvorEmail('E2', 'sk', parametre()).text, /obsah rozhovorov neukladáme vôbec/);
  assert.match(vytvorEmail('E2', 'en', parametre()).text, /we do not store conversation content at all/);
  const e4 = vytvorEmail('E4', 'en', parametre());
  const en = (n) => n.toLocaleString('en-US');
  const S = DENNY_STROP_OTAZOK;
  // Strop otázok s modelom (budget.js) a mesačné rozhovory (tenants.js) sa čítajú z kódu: zmena konštanty sa prejaví v texte aj tu.
  assert.ok(e4.text.includes(`from ${en(S[PLANS.FREE])} to ${en(S[PLANS.STARTER])} (Starter) or ${en(S[PLANS.PRO])} (Pro)`), 'strop otázok');
  for (const plan of [PLANS.FREE, PLANS.STARTER, PLANS.PRO]) assert.ok(e4.html.includes(`>${en(DEFAULT_QUOTAS[plan])}<`), `rozhovory ${plan}`);
  for (const plan of [PLANS.STARTER, PLANS.PRO]) assert.ok(e4.html.includes(`>${CENY_EUR[plan]}${NB}EUR<`), `cena ${plan}`);
  assert.ok(e4.text.includes(`Starter for ${CENY_EUR[PLANS.STARTER]}${NB}EUR a month (${en(DEFAULT_QUOTAS[PLANS.STARTER])} conversations)`));
  // Ceny nemajú konštantu vo workeri; zdroj pravdy je ops/stripe/cennik.md (19 a 39 EUR).
  assert.deepEqual([CENY_EUR[PLANS.STARTER], CENY_EUR[PLANS.PRO]], [19, 39]);
  const sk = vytvorEmail('E4', 'sk', parametre());
  assert.match(sk.html, /Free \(teraz\)/);
  assert.match(sk.text, /Nič sa samo nespoplatní/);
  assert.match(sk.text, /Ak nechcete nič meniť, nemusíte robiť nič/);
});

test('H4. nadpis E1 nesie počet produktov v správnom tvare', () => {
  assert.equal(vytvorEmail('E1', 'sk', parametre()).nadpis, `Asistent sa naučil 253${NB}produktov. Naspamäť.`);
  assert.equal(vytvorEmail('E1', 'cs', parametre({ pocet: 3 })).nadpis, `Asistent se naučil 3${NB}produkty. Nazpaměť.`);
  assert.equal(vytvorEmail('E1', 'en', parametre({ pocet: 1 })).nadpis, `Your assistant has learned 1${NB}product. By heart.`);
  assert.equal(vytvorEmail('E1', 'de', parametre({ pocet: 1200 })).nadpis, `Ihr Assistent kennt jetzt 1.200${NB}Produkte. Auswendig.`);
  assert.equal(vytvorEmail('E0', 'en', parametre({ chybaKod: 'ai_budget_exhausted' })).nadpis, 'This time the hiccup is on our side.');
});

test('H5. päta: stop odkaz s krátkym popisom v jazyku e-mailu, adresa v čistom texte ostáva celá', () => {
  const p = parametre();
  const popis = { sk: 'zastaviť e-maily', cs: 'zastavit e-maily', en: 'stop these e-mails', de: 'E-Mails stoppen' };
  for (const jazyk of JAZYKY_EMAILOV) {
    const e = vytvorEmail('E3', jazyk, p);
    assert.ok(e.html.includes(`<a href="${p.stop}"><span class="tlmene" style="color:#5e5d59;text-decoration:underline">${popis[jazyk]}</span></a>`), jazyk);
    assert.ok(e.text.includes(p.stop), jazyk);
  }
});

test('H6. odsekHtml: holá povolená adresa je odkaz bez https:// v texte, cudzia ostane textom, HTML sa escapuje', () => {
  assert.equal(odsekHtml('Pozri https://arling.sk/asistent/.'), 'Pozri <a href="https://arling.sk/asistent/" class="odkaz" style="color:#b23a1d;text-decoration:underline;word-break:break-all">arling.sk/asistent/</a>.');
  assert.equal(odsekHtml('https://zly.example/<b>'), 'https://zly.example/&lt;b&gt;');
  assert.equal(odsekHtml('http://arling.sk/x'), 'http://arling.sk/x');
});

test('H7. nadpisy E3 a E4 netvrdia viac, než ukazujú merania (nález 3)', () => {
  const p = parametre();
  const ocak = {
    sk: ['Pomôžeme so zapojením?', 'Využili ste 80 zo 100 rozhovorov'],
    cs: ['Pomůžeme se zapojením?', 'Využili jste 80 ze 100 konverzací'],
    en: ['Need a hand with setup?', 'You have used 80 of 100 conversations'],
    de: ['Sollen wir beim Einbinden helfen?', 'Sie haben 80 von 100 Gesprächen genutzt'],
  };
  const skusky = { sk: /vaše vlastné skúšky/, cs: /vaše vlastní zkoušky/, en: /your own tests count too/, de: /Ihre eigenen Tests zählen mit/ };
  for (const jazyk of JAZYKY_EMAILOV) {
    for (const q of [p, wpParametre()]) assert.equal(vytvorEmail('E3', jazyk, q).nadpis, ocak[jazyk][0], jazyk);
    assert.equal(vytvorEmail('E4', jazyk, p).nadpis, ocak[jazyk][1], jazyk);
    // E4 priznáva, že do počtu vstupujú aj vlastné skúšky; žiadne „bez prestávky“.
    const t = vytvorEmail('E4', jazyk, p).text;
    assert.match(t, skusky[jazyk], jazyk);
    assert.ok(!/bez prestávky|bez přestávky|without a break|ohne Pause/.test(t), jazyk);
  }
});

test('H8. WordPress E3: nič nevkladať, žiadny kód ani „kam ste ho vložili“, kontrola pluginu a odpoveď (nález 1)', () => {
  for (const jazyk of JAZYKY_EMAILOV) {
    const e = vytvorEmail('E3', jazyk, wpParametre());
    assert.ok(!/<script|&lt;script|data-tenant/.test(e.text + e.html), `${jazyk}: vkladací kód`);
    assert.ok(!/kam ste kód vložili|kam jste kód vložili|where you added the code|auf der Sie den Code eingefügt/.test(e.text), `${jazyk}: otázka na vloženie`);
    assert.ok(!/Skopírovať|Zkopírovat|Copy the code|kopieren/.test(e.text + e.html), `${jazyk}: kopírovanie kódu`);
    assert.match(e.text, /Show widget on/, jazyk);
    assert.match(e.text, /WooCommerce, ARLing Shopping Assistant/, jazyk);
    // Predmet tiež nežiada vkladanie (pokus 2, nález 4); formulárový E3 ho žiadať smie.
    assert.ok(!/vložiť|vložit|add the assistant|Einbinden|einfügen/i.test(e.predmet), `${jazyk}: predmet ${e.predmet}`);
    assert.ok(e.predmet.includes('www.ludovka.eu'), `${jazyk}: doména v predmete`);
  }
  assert.match(vytvorEmail('E3', 'sk', parametre()).predmet, /vložiť Asistenta/);
  // Formulár ostáva s kódom a návodom.
  assert.match(vytvorEmail('E3', 'sk', parametre()).text, /data-tenant="abcd1234-0000"/);
});

test('H9. definícia rozhovoru podľa relacia.js: karta prehliadača, platnosť, strop otázok len keď ho volajúci pošle (nález 2)', () => {
  const h = RELACIA_PLATNOST_S / 3600;
  const bez = vytvorEmail('E1', 'sk', parametre()).text;
  assert.ok(bez.includes(`v tej istej karte prehliadača do ${h}${NB}hodín.`), bez);
  const zle = /bez ohľadu na počet|bez ohledu na počet|however many|egal wie viele/;
  const ocak = {
    sk: `v tej istej karte prehliadača do ${h}${NB}hodín (najviac 1${NB}000${NB}otázok)`,
    cs: `ve stejné kartě prohlížeče do ${h}${NB}hodin (nejvýše 1${NB}000${NB}otázek)`,
    en: `in the same browser tab within ${h}${NB}hours (up to 1,000${NB}questions)`,
    de: `im selben Browser-Tab binnen ${h}${NB}Stunden (höchstens 1.000${NB}Fragen)`,
  };
  // Živý worker: ASISTENT_MAX_OTAZOK = "1000" vo wrangler.toml.
  const zivy = maxOtazok({ ASISTENT_MAX_OTAZOK: '1000' });
  for (const jazyk of JAZYKY_EMAILOV) {
    for (const kod of ['E1', 'E1W']) {
      for (const q of [parametre({ maxOtazok: zivy }), wpParametre({ maxOtazok: zivy })]) {
        const t = vytvorEmail(kod, jazyk, q).text;
        assert.ok(t.includes(ocak[jazyk]), `${kod} ${jazyk}`);
        assert.ok(!zle.test(t), `${kod} ${jazyk}`);
      }
    }
  }
  // Predvolená hodnota modulu (bez premennej) je MAX_OTAZOK_NA_ROZHOVOR.
  assert.ok(vytvorEmail('E1', 'en', parametre({ maxOtazok: maxOtazok({}) })).text.includes(`(up to ${MAX_OTAZOK_NA_ROZHOVOR}${NB}questions)`));
});

test('H10. hlavné tlačidlo hneď pod úvodným odsekom, pred návodom a zoznamami (nález 4)', () => {
  for (const jazyk of JAZYKY_EMAILOV) {
    for (const kod of ['E1', 'E1W', 'E2', 'E3', 'E4']) {
      for (const q of [parametre(), wpParametre()]) {
        const e = vytvorEmail(kod, jazyk, q);
        const karta = e.html.slice(e.html.indexOf('class="nadpis ink"'));
        const i = karta.indexOf('class="tlacidlo-a"');
        if (i < 0) continue;
        const pred = karta.slice(0, i);
        const m = `${kod} ${jazyk} ${q.platforma}`;
        // Pred tlačidlom je len nadpis, pozdrav a jeden vecný odsek.
        assert.ok((pred.match(/<p class="text"/g) || []).length <= 2, `${m}: veľa odsekov pred tlačidlom`);
        assert.ok(!/class="kod"|<strong>|class="tlmene"/.test(pred), `${m}: návod alebo podmienky pred tlačidlom`);
      }
    }
  }
});

test('H11. v HTML žiadna adresa ako text odkazu, žiadna značka; päta 13 px', () => {
  for (const jazyk of JAZYKY_EMAILOV) {
    for (const kod of KODY_EMAILOV) {
      for (const platforma of PLATFORMY) {
        const e = vytvorEmail(kod, jazyk, parametre({ platforma, zdroj: platforma === 'wordpress' ? 'wordpress' : 'formular' }));
        const m = `${kod} ${jazyk} ${platforma}`;
        for (const a of e.html.matchAll(/<a href="[^"]+"[^>]*>([^<]*)<\/a>/g)) {
          assert.ok(!/arling\.sk\/|https?:|workers\.dev/.test(a[1]), `${m}: text odkazu ${a[1]}`);
        }
        // Len telo (v <style> sú „}}“ z @media).
        assert.ok(!/\{\{|\}\}/.test(e.html.slice(e.html.indexOf('<body')) + e.text), `${m}: značka odkazu`);
        assert.ok(!e.html.includes('font-size:12px;line-height:1.6;color:#5e5d59'), `${m}: päta 12 px`);
        assert.ok(e.html.includes('font-size:13px;line-height:1.55;color:#5e5d59'), `${m}: päta 13 px`);
      }
    }
  }
});

test('H13. čistý text nesie názov a úplnú adresu hlavného tlačidla, ten istý cieľ ako HTML (pokus 2, nález 1)', () => {
  let s = 0;
  for (const kod of KODY_EMAILOV) {
    for (const jazyk of JAZYKY_EMAILOV) {
      for (const platforma of PLATFORMY) {
        const e = vytvorEmail(kod, jazyk, parametre({ platforma, zdroj: platforma === 'wordpress' ? 'wordpress' : 'formular' }));
        const m = `${kod} ${jazyk} ${platforma}`;
        const html = [...e.html.matchAll(/<a href="([^"]+)" class="tlacidlo-a"[^>]*>([^<]*)<\/a>/g)].map((x) => [x[1].replace(/&amp;/g, '&'), x[2].replace(/&amp;/g, '&')]);
        for (const [url, nazov] of html) {
          assert.ok(e.text.includes(`${nazov}: ${url}`), `${m}: v texte chýba „${nazov}: ${url}“`);
          s += 1;
        }
      }
    }
  }
  assert.ok(s > 40, `tlačidiel ${s}`);
  // E4: platený plán „na stránke účtu“ má v texte adresu účtu (regresia z pokusu 2).
  const p = parametre();
  for (const jazyk of JAZYKY_EMAILOV) assert.ok(vytvorEmail('E4', jazyk, p).text.includes(p.ucet), `E4 ${jazyk}`);
  // Cudzia adresa ani v texte nevznikne.
  assert.ok(!vytvorEmail('E1W', 'en', parametre({ skusit: 'https://zly.example/y' })).text.includes('zly.example'));
});

test('H12. pomenovaný odkaz: len na povoleného hostiteľa, v čistom texte názov a celá adresa', () => {
  assert.equal(
    odsekHtml(`na ${odkaz('stránke účtu', 'https://arling.sk/asistent/tenant/?t=1&a=2')}.`),
    'na <a href="https://arling.sk/asistent/tenant/?t=1&amp;a=2" class="odkaz" style="color:#b23a1d;text-decoration:underline">stránke účtu</a>.',
  );
  assert.equal(odsekHtml(odkaz('zlý', 'https://zly.example/x')), 'zlý (https://zly.example/x)');
  assert.equal(textOdkazov(`A ${odkaz('b', 'https://arling.sk/c')} d`), 'A b (https://arling.sk/c) d');
  // Zásady v päte: v texte celá adresa (test 12 v zivotny-cyklus.test.mjs), v HTML názov.
  const e = vytvorEmail('E2', 'sk', parametre());
  assert.ok(e.text.includes('zásady Asistenta (https://arling.sk/asistent/#privacy)'));
  // V päte trieda tlmene: v tmavom režime tlmený ako stop odkaz, nie oranžový.
  assert.match(e.html, /<a href="https:\/\/arling\.sk\/asistent\/#privacy" class="tlmene"[^>]*>zásady Asistenta<\/a>/);
});
