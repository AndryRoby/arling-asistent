// ukazka-v2.test.mjs: ukážkový obchod Dobrá domácnosť a fixtúry snímok (SPEC 8.10 bod 12, časť 9).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kategorieZFeedu, produktyZFeedu } from '../scripts/kategorie-z-feedu.mjs';
import { fixtury } from '../scripts/fixtury-v2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ukazka = path.join(__dirname, '../../arling-sk/asistent/ukazka');
const citaj = (f) => fs.readFileSync(path.join(ukazka, f), 'utf8');
const feed = citaj('feed.xml');
const produkty = new Map(produktyZFeedu(feed).map((p) => [p.id, p]));

test('ukážka: data-kategorie v ukazka.js je presne výstup kategorie-z-feedu.mjs a každý obrázok je vo feede aj na disku', () => {
  const js = citaj('ukazka.js');
  const m = js.match(/var KATEGORIE = (\[[^\n]*\]);/);
  assert.ok(m, 'konštanta KATEGORIE');
  const kat = JSON.parse(m[1]);
  assert.deepEqual(kat, kategorieZFeedu(feed, 3));
  const obrazkyFeedu = new Set([...produkty.values()].map((p) => p.obrazok));
  const kategorieFeedu = new Set([...produkty.values()].map((p) => p.kategoria));
  for (const k of kat) {
    assert.ok(kategorieFeedu.has(k.nazov), k.nazov);
    assert.ok(obrazkyFeedu.has(k.obrazok), k.obrazok);
    assert.ok(fs.existsSync(path.join(ukazka, 'img', path.basename(k.obrazok))), k.obrazok);
  }
});

test('fixtúry snímok: každý produkt je vo feede s rovnakým názvom, cenou a obrázkom; súbory v tests/fixtures/v2 sú aktuálne', () => {
  const f = fixtury(feed);
  const karty = [];
  for (const [meno, fx] of Object.entries(f)) {
    const o = fx.odpoved;
    for (const p of [...(o.products || []), ...(o.picks || []), ...(o.candidates || [])]) karty.push([meno, p]);
    const naDisku = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'v2', meno + '.json'), 'utf8'));
    assert.deepEqual(naDisku, JSON.parse(JSON.stringify(fx)), `${meno}.json je z aktuálneho feedu (node scripts/fixtury-v2.mjs)`);
  }
  assert.equal(karty.length, 18, '4 + 2 karty v chate, 5 tipov a 7 kandidátov darčeka');
  for (const [meno, p] of karty) {
    const id = path.basename(p.image, '.svg');
    const v = produkty.get(id);
    assert.ok(v, `${meno}: ${id} vo feede`);
    assert.equal(p.title, v.nazov, `${meno}: názov ${id}`);
    assert.equal(p.price, Number(v.cena), `${meno}: cena ${id}`);
    assert.equal(path.basename(v.obrazok), id + '.svg');
    assert.equal(p.currency, 'EUR');
    assert.doesNotMatch(JSON.stringify(p), /availability/, 'dostupnosť API dnes neposiela, fixtúra ju nevymýšľa');
  }
  // texty odpovedí: čísla v nich sú z feedu
  const s3 = f['s3-kavovar'].odpoved.answer;
  for (const fakt of ['89,90 €', '19 barov', '25 sekúnd', '0,7 l', '11 cm', '24,90 €', '39,90 €', 'do 3 dní']) assert.ok(s3.includes(fakt), fakt);
});

test('ukážka: žiadny vykonávaný inline skript, prísna CSP, žiadny paper.css ani prepínače webu, widget z ../widget.js zhodný so zdrojom', () => {
  const html = citaj('index.html');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, attrs] of inline) assert.match(attrs, /type="application\/ld\+json"/, 'inline je len JSON-LD');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  // v2.1: ops/design/csp-hash.mjs pri nasadení doplní hash inline JSON-LD (neškodí, nič nespúšťa).
  assert.match(csp, /script-src 'self' https:\/\/api\.arling\.workers\.dev( 'sha256-[A-Za-z0-9+/=]+')*;/);
  // v2.1 (overenie 1): obrázky len z vlastného pôvodu, ukážka žiadne cudzie nepoužíva.
  assert.match(csp, /img-src 'self' data:;/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /\/style\/|paper\.css|nastroj\.css|prepinac\.js|vzhlad\.js/);
  assert.match(html, /<meta name="theme-color" content="#E0582A">/);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  // v2.2 (overenie 2): fotky výrobkov vytvorila AI a pás to hovorí hneď hore (štyri dohody, označené AI obrázky).
  assert.match(html, /Ukážkový obchod ARLing Asistenta\. Výrobky sú vymyslené, fotky výrobkov vytvorila AI, nedá sa tu nakupovať\./);
  assert.doesNotMatch(html, /ilustráci/, 'nikde netvrdí, že sú to ilustrácie');
  assert.match(html, /IČO 56583486/);
  assert.doesNotMatch(html, /hviezd|recenzi|najpredávanejš|obľúben|zľav|košík<|do košíka<\/button/i, 'nič nepredstiera');
  const js = citaj('ukazka.js');
  assert.match(js, /s\.src = '\.\.\/widget\.js';/);
  assert.doesNotMatch(js, /\.innerHTML\s*=/, 'hodnoty z feedu len cez textContent');
  const zdroj = fs.readFileSync(path.join(__dirname, '../widget/widget.js'), 'utf8');
  assert.equal(fs.readFileSync(path.join(ukazka, '..', 'widget.js'), 'utf8'), zdroj);
});

test('ukážka: texty bez pomlčiek, 64 obrázkov bez textu v obrázku a s popisom', () => {
  for (const f of ['index.html', 'ukazka.js', 'ukazka.css']) assert.doesNotMatch(citaj(f), /[—–]/, f);
  const snimky = path.join(__dirname, '../../../ops/asistent/v2/snimky/index.html');
  if (fs.existsSync(snimky)) assert.doesNotMatch(fs.readFileSync(snimky, 'utf8'), /[—–]/, 'galéria snímok');
  const svg = fs.readdirSync(path.join(ukazka, 'img')).filter((f) => /^[A-Z]{3}-\d{3}\.svg$/.test(f));
  assert.equal(svg.length, 64);
  assert.equal(produkty.size, 64);
  for (const f of svg) {
    const t = fs.readFileSync(path.join(ukazka, 'img', f), 'utf8');
    assert.doesNotMatch(t, /<text/, f);
    assert.match(t, /role="img" aria-label="[^"]+"/, f);
    assert.ok(produkty.has(f.slice(0, 7)), f);
  }
});

// v2.2 (overenie 2, nález „všade klipart, 64 fotiek leží nepoužitých“): každý img/ID.svg je obal
// fotky ops/asistent/v2/foto/webp/ID.webp (data: URI), mená súborov a adresy vo feede ostávajú.
test('ukážka: 64 rôznych fotiek výrobkov, každá presne z generátora a so zdrojovou WebP fotkou', async () => {
  const { obal, fotka } = await import('../scripts/obrazky-ukazky-v2.mjs');
  const videne = new Map();
  for (const [id, v] of produkty) {
    const t = fs.readFileSync(path.join(ukazka, 'img', id + '.svg'), 'utf8');
    const webp = fotka(id);
    assert.equal(webp.subarray(8, 12).toString(), 'WEBP', `${id}.webp je WebP`);
    assert.equal(t, obal(webp, v.nazov), `${id}.svg je aktuálny výstup generátora`);
    assert.match(t, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="640" height="640" viewBox="0 0 640 640" role="img" aria-label="[^"]+"><image href="data:image\/webp;base64,[A-Za-z0-9+/=]+" width="640" height="640"\/><\/svg>\n$/);
    const k = webp.toString('base64');
    assert.ok(!videne.has(k), `${id} má rovnakú fotku ako ${videne.get(k)}`);
    videne.set(k, id);
  }
  assert.equal(videne.size, 64);
});
