#!/usr/bin/env node
// obrazky-ukazky-v2.mjs (SPEC 9.1, v2.2 po overení 2): fotky výrobkov ukážkového obchodu.
//
// Overenie 2: plošné kresby pôsobili ako klipart a práve fotka je rozdiel medzi šablónou a obchodom
// (LATKA bod 1). 64 fotiek 640 x 640 WebP vytvoril generátor obrázkov podľa nášho zadania
// (ops/asistent/v2/foto/ZOZNAM.md), sú teda vygenerované AI a pás ukážky to hovorí.
// Súbory ostávajú na tých istých menách img/ID.svg: SVG je len obal s WebP ako data: URI, takže
// adresy vo feede aj vo Vectorize živého workera platia ďalej a nič sa nenačítava znova.
// Obrázok v <img> smie niesť data: URI, CSP ukážky (img-src 'self' data:) ho pustí.
// Pôvodné kresby a ich generátor sú v ops/asistent/v2/archiv/.
//
//   node scripts/obrazky-ukazky-v2.mjs [--sucho]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { produktyZFeedu } from './kategorie-z-feedu.mjs';

const koren = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(koren, '..', '..');
export const ukazka = path.join(koren, '..', 'arling-sk', 'asistent', 'ukazka');
export const FOTO = path.join(repo, 'ops', 'asistent', 'v2', 'foto', 'webp');
const sucho = process.argv.includes('--sucho');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Fotka výrobku (WebP) zo zdrojového priečinka. */
export const fotka = (id) => readFileSync(path.join(FOTO, id + '.webp'));

/** Jeden súbor img/ID.svg: 640 x 640, WebP ako data: URI, názov výrobku v aria-label, bez textu v obrázku. */
export function obal(webp, nazov) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640" role="img" aria-label="${esc(nazov)}">` +
    `<image href="data:image/webp;base64,${Buffer.from(webp).toString('base64')}" width="640" height="640"/></svg>\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const produkty = produktyZFeedu(readFileSync(path.join(ukazka, 'feed.xml'), 'utf8'));
  let spolu = 0;
  for (const v of produkty) {
    const webp = fotka(v.id);
    if (webp.subarray(0, 4).toString() !== 'RIFF' || webp.subarray(8, 12).toString() !== 'WEBP') throw new Error('nie je WebP: ' + v.id);
    const svg = obal(webp, v.nazov);
    spolu += svg.length;
    if (!sucho) writeFileSync(path.join(ukazka, 'img', v.id + '.svg'), svg, 'utf8');
  }
  console.log(`${sucho ? 'skúška' : 'prepísané'}: ${produkty.length} fotiek v ${path.relative(koren, path.join(ukazka, 'img'))}, spolu ${Math.round(spolu / 1024)} kB`);
}
