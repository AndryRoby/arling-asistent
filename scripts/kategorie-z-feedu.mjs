#!/usr/bin/env node
// kategorie-z-feedu.mjs (SPEC 4.4): tri kategórie pre úvod widgetu z produktového feedu obchodu.
// Prvá úroveň CATEGORYTEXT (Heureka) alebo g:product_type (Google), poradie podľa počtu produktov
// (pri zhode abecedne), obrázok = IMGURL prvého produktu kategórie skladom (DELIVERY_DATE 0), inak prvého.
// Výstup je hotová hodnota atribútu data-kategorie (JSON).
//
//   node scripts/kategorie-z-feedu.mjs <feed.xml alebo https://...> [--pocet 3]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dekoduj = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .trim();

function pole(blok, ...mena) {
  for (const m of mena) {
    const r = new RegExp('<' + m + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + m + '>', 'i').exec(blok);
    if (r) return dekoduj(r[1]);
  }
  return '';
}

/** Produkty z feedu: {id, nazov, kategoria (prvá úroveň), obrazok, skladom, cena}. */
export function produktyZFeedu(xml) {
  const bloky = xml.match(/<SHOPITEM>[\s\S]*?<\/SHOPITEM>/gi) || xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return bloky.map((b) => {
    const kat = pole(b, 'CATEGORYTEXT', 'g:product_type', 'product_type').split(/\s*[|>]\s*/)[0].trim();
    const dodanie = pole(b, 'DELIVERY_DATE');
    return {
      id: pole(b, 'ITEM_ID', 'g:id', 'id'),
      nazov: pole(b, 'PRODUCTNAME', 'title', 'g:title'),
      kategoria: kat,
      obrazok: pole(b, 'IMGURL', 'g:image_link', 'image_link'),
      skladom: dodanie === '0' || /in[ _]stock/i.test(pole(b, 'g:availability', 'availability')),
      cena: pole(b, 'PRICE_VAT', 'g:price', 'price'),
      url: pole(b, 'URL', 'link', 'g:link'),
    };
  });
}

export function kategorieZFeedu(xml, pocet = 3) {
  const podla = new Map();
  for (const p of produktyZFeedu(xml)) {
    if (!p.kategoria) continue;
    if (!podla.has(p.kategoria)) podla.set(p.kategoria, []);
    podla.get(p.kategoria).push(p);
  }
  return [...podla.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'sk'))
    .slice(0, pocet)
    .map(([nazov, zoznam]) => ({ nazov: nazov.slice(0, 40), obrazok: (zoznam.find((p) => p.skladom) || zoznam[0]).obrazok }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zdroj = process.argv[2];
  if (!zdroj) {
    console.error('použitie: node scripts/kategorie-z-feedu.mjs <feed.xml alebo URL> [--pocet 3]');
    process.exit(2);
  }
  const i = process.argv.indexOf('--pocet');
  const pocet = i > 0 ? Number(process.argv[i + 1]) || 3 : 3;
  const xml = /^https?:\/\//.test(zdroj) ? await (await fetch(zdroj)).text() : readFileSync(zdroj, 'utf8');
  console.log(JSON.stringify(kategorieZFeedu(xml, pocet)));
}
