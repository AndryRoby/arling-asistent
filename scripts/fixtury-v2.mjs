#!/usr/bin/env node
// fixtury-v2.mjs (SPEC 10.1): odpovede API pre snímky widgetu v2, bez volania skutočného workera.
// Produkty, názvy a ceny sa berú presne z feed.xml ukážky; texty odpovedí sú písané len z faktov
// popisu a parametrov feedu (nič sa nevymýšľa). Dostupnosť (W-1) API dnes neposiela, preto ju
// fixtúry nemajú ani ony. Obrázky ukazujú na lokálny server snímok (127.0.0.1:8851).
//
//   node scripts/fixtury-v2.mjs            zapíše tests/fixtures/v2/*.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { produktyZFeedu } from './kategorie-z-feedu.mjs';

const koren = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const feedPath = path.join(koren, '..', 'arling-sk', 'asistent', 'ukazka', 'feed.xml');
const out = path.join(koren, 'tests', 'fixtures', 'v2');
export const LOKALNE = 'http://127.0.0.1:8851/asistent/ukazka/';

export function fixtury(xml) {
  const feed = new Map(produktyZFeedu(xml).map((p) => [p.id, p]));
  const karta = (id) => {
    const p = feed.get(id);
    if (!p) throw new Error('vo feede chýba ' + id);
    return { title: p.nazov, url: LOKALNE + '#p-' + id, image: LOKALNE + 'img/' + id + '.svg', price: Number(p.cena), currency: 'EUR' };
  };
  const darcek = (id, why) => ({ ...karta(id), why });
  return {
    's3-kavovar': {
      otazka: 'Aký kávovar do 100 eur?',
      odpoved: {
        answer: 'Do 100 € máme štyri možnosti. Kapsulový kávovar Orava Mini stojí 89,90 € v červenej aj bielej farbe: tlak 19 barov, zahriatie za 25 sekúnd, nádržka 0,7 l a šírka len 11 cm.\n\nAk vám stačí káva bez kapsúl, french press na 1 liter stojí 24,90 € a kanvica s dlhým hrdlom na filtrovanú kávu 39,90 €. Červený Orava Mini je skladom, biely má dodanie do 3 dní.',
        // v2.1 (overenie 1): prvé dve karty sú rôzne výrobky, aby „Porovnať prvé dva“ naozaj porovnávalo.
        products: ['KAV-003', 'KAV-006', 'KAV-007', 'KAV-004'].map(karta),
      },
    },
    's5-porovnanie': {
      otazka: 'Porovnajte mi Kapsulový kávovar Orava Mini a French press.',
      odpoved: {
        answer: 'Orava Mini za 89,90 € je kapsulový kávovar: tlak 19 barov, zahriatie za 25 sekúnd, nádržka 0,7 l, príkon 1200 W a šírka 11 cm. French press za 24,90 € je zaparovacia kanvica na 1 liter, asi 4 šálky, zo skla a nerezového rámu s piestom.\n\nRozdiel je v príprave: Orava Mini ide na hliníkové kapsule bežného rozmeru, french press zaparí mletú kávu a dvojité sitko zachytí aj jemnejšie mletie. Oba sú skladom.',
        products: ['KAV-003', 'KAV-006'].map(karta),
      },
    },
    's4-darcek': {
      telo: { recipient: 'Mama', budget_min: 0, budget_max: 50 },
      odpoved: {
        picks: [
          darcek('DAR-001', 'Tri druhy medu od včelárov z podhoria v drevenej krabičke.'),
          darcek('DAR-007', 'Štyri bylinkové čaje po 30 g: lipa, mäta, medovka a šípka.'),
          darcek('DAR-004', 'Vôňa borovice a drevený knôt, horí asi 40 hodín.'),
          darcek('DAR-005', 'Ručne točená kamenina, každý kus je trochu iný.'),
          darcek('DAR-011', 'Plstená ovčia vlna s koženou podrážkou, teplé a priedušné.'),
        ],
        candidates: ['DAR-001', 'DAR-007', 'DAR-004', 'DAR-005', 'DAR-011', 'DAR-009', 'DAR-006'].map(karta),
        widened: false,
        few: false,
      },
    },
    's6-chyba': { status: 500, odpoved: { error: 'internal_error' } },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(out, { recursive: true });
  const f = fixtury(readFileSync(feedPath, 'utf8'));
  for (const [meno, obsah] of Object.entries(f)) writeFileSync(path.join(out, meno + '.json'), JSON.stringify(obsah, null, 2) + '\n', 'utf8');
  console.log('fixtúry: ' + Object.keys(f).join(', ') + ' -> ' + path.relative(koren, out));
}
