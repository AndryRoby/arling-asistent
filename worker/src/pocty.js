/*
 * pocty.js
 *
 * Atomické denné počítadlá v D1 (tabuľka asistent_pocty), oprava nálezov
 * kontroly kroku 1 (ops/asistent/stavba/krok1-ochrana.md).
 *
 * Prečo: pôvodné limity kroku 1 sa najprv prečítali (KV, D1) a zapísali až
 * neskôr, často až po odpovedi modelu. Súbežná dávka požiadaviek tak prešla
 * všetkými limitmi naraz (sonda: 120 požiadaviek, 120 volaní modelu). KV
 * navyše nevie „pripočítaj, ak je pod limitom“ a pri viac ako 1 zápise za
 * sekundu na kľúč zlyháva.
 *
 * Tu je jedna SQL veta, ktorá pripočíta a zároveň overí limit:
 *   INSERT ... ON CONFLICT DO UPDATE SET hodnota = hodnota + ? WHERE hodnota + ? <= limit RETURNING hodnota
 * D1 (SQLite s jedným primárnym zapisovateľom) ju vykoná celú naraz, takže
 * dve súbežné požiadavky nikdy neprejdú obe o posledné miesto. Rezervuje sa
 * PRED volaním modelu; pri chybe modelu sa rezervácia vráti (vrat).
 *
 * Súkromie (plán 1.3, úroveň A): kľúč nikdy nenesie IP, text otázky ani id
 * relácie. Limity na IP používajú len číslo koša 0 až 65 535 z odtlačku
 * /64 siete s dňom a tajomstvom (security.js kosIp): do jedného koša padne asi
 * 65 000 IPv4 adries, z koša sa IP spätne určiť nedá. Riadky sa mažú denným
 * cronom po 2 dňoch (zmazStare).
 */

export const POCTY_SQL = {
  CREATE_POCTY: `CREATE TABLE IF NOT EXISTS asistent_pocty (kluc TEXT PRIMARY KEY, den TEXT NOT NULL, hodnota INTEGER NOT NULL DEFAULT 0)`,
  CREATE_POCTY_INDEX: `CREATE INDEX IF NOT EXISTS idx_asistent_pocty_den ON asistent_pocty (den)`,
  PRIDAJ_AK_POD: `INSERT INTO asistent_pocty (kluc, den, hodnota) VALUES (?, ?, ?) ON CONFLICT(kluc) DO UPDATE SET hodnota = asistent_pocty.hodnota + excluded.hodnota WHERE asistent_pocty.hodnota + excluded.hodnota <= ? RETURNING hodnota`,
  PRIDAJ: `INSERT INTO asistent_pocty (kluc, den, hodnota) VALUES (?, ?, ?) ON CONFLICT(kluc) DO UPDATE SET hodnota = asistent_pocty.hodnota + excluded.hodnota RETURNING hodnota`,
  ODOBER: `UPDATE asistent_pocty SET hodnota = MAX(0, hodnota - ?) WHERE kluc = ?`,
  CITAJ: `SELECT hodnota FROM asistent_pocty WHERE kluc = ?`,
  ZMAZ_STARE: `DELETE FROM asistent_pocty WHERE den < ?`,
};

/** Koľko dní riadky ostávajú (dnešok a včerajšok stačia na UTC deň v každej časovej zóne). */
export const POCTY_DNI = 2;

const tabulkaHotova = new WeakSet();

/** Strážené vytvorenie tabuľky pri behu (ako ensureBillingColumns); to isté je v migrations/0003_genialny.sql. */
export async function zabezpecPocty(db) {
  if (!db || tabulkaHotova.has(db)) return;
  await db.prepare(POCTY_SQL.CREATE_POCTY).run();
  await db.prepare(POCTY_SQL.CREATE_POCTY_INDEX).run();
  tabulkaHotova.add(db);
}

const cele = (n) => Math.max(0, Math.round(Number(n) || 0));

/**
 * Atomicky pripočíta `pocet` ku kľúču, len keď výsledok neprekročí `limit`.
 * Vracia novú hodnotu, alebo null (nezmestí sa, nič sa nezapísalo).
 * Chyba D1 sa hádže ďalej, rozhoduje volajúci.
 */
export async function rezervuj(db, kluc, den, pocet, limit) {
  const p = cele(pocet);
  const l = Math.floor(Number(limit));
  if (!Number.isFinite(l) || p > l) return null;
  await zabezpecPocty(db);
  const row = await db.prepare(POCTY_SQL.PRIDAJ_AK_POD).bind(kluc, den, p, l).first();
  return row ? Number(row.hodnota) || 0 : null;
}

/** Pripočíta bez limitu (skutočný náklad po odpovedi). Vracia novú hodnotu. */
export async function pripocitaj(db, kluc, den, pocet) {
  const p = cele(pocet);
  await zabezpecPocty(db);
  const row = await db.prepare(POCTY_SQL.PRIDAJ).bind(kluc, den, p).first();
  return row ? Number(row.hodnota) || 0 : p;
}

/** Vráti rezerváciu (chyba modelu, doúčtovanie nadhodnoteného odhadu). Nikdy pod nulu. */
export async function vrat(db, kluc, pocet) {
  const p = cele(pocet);
  if (!p) return;
  await zabezpecPocty(db);
  await db.prepare(POCTY_SQL.ODOBER).bind(p, kluc).run();
}

/** Aktuálna hodnota kľúča, bez riadku 0. */
export async function citaj(db, kluc) {
  await zabezpecPocty(db);
  const row = await db.prepare(POCTY_SQL.CITAJ).bind(kluc).first();
  return Number(row && row.hodnota) || 0;
}

/** Zmaže riadky starších dní (denný cron). `dnes` = RRRR-MM-DD. */
export async function zmazStare(db, dnes) {
  await zabezpecPocty(db);
  const hranica = new Date(`${dnes}T00:00:00Z`);
  hranica.setUTCDate(hranica.getUTCDate() - (POCTY_DNI - 1));
  await db.prepare(POCTY_SQL.ZMAZ_STARE).bind(hranica.toISOString().slice(0, 10)).run();
}

/** Kľúče počítadiel. Žiadny nenesie IP ani id relácie. */
export const kluce = {
  neurony: (den) => `neurony:${den}`, // spoločný strop chatu a darčeka, tisíciny neurónu
  neuronyFree: (den) => `neurony-free:${den}`, // bazén bezplatných obchodov a ukážky (80 % základného stropu), tisíciny
  neuronyOslovenie: (den) => `neurony-osl:${den}`, // rezerva ukážok oslovených obchodov, tisíciny (budget.js rezervaOslovenia)
  interne: (den) => `interne:${den}`, // náš interný beh (X-Arling-Meranie), tisíciny, vlastný rozpočet
  obnova: (den) => `obnova:${den}`, // načítanie feedov, tisíciny neurónu, vlastný rozpočet
  zalozenie: (den, kos) => `zal:${den}:${kos}`, // nové obchody z jednej siete za deň (kôš IP)
  ai: (t, den) => `ai:${t}:${den}`, // otázky obchodu s modelom
  mili: (t, den) => `mili:${t}:${den}`, // neuróny obchodu v tisícinách
  nove: (t, den) => `nove:${t}:${den}`, // započítané nové rozhovory obchodu
  bezAi: (t, den) => `bezai:${t}:${den}`, // odpovede obchodu bez modelu
  ipOtazky: (t, den, kos) => `ipq:${t}:${den}:${kos}`, // všetky otázky (obchod, kôš IP)
  ipRozhovory: (t, den, kos) => `ipr:${t}:${den}:${kos}`, // nové rozhovory (obchod, kôš IP)
  ipAi: (t, den, kos) => `ipa:${t}:${den}:${kos}`, // otázky s modelom (obchod, kôš IP)
  ipAiSpolu: (den, kos) => `ipa:*:${den}:${kos}`, // otázky s modelom (kôš IP, všetky obchody)
  aiChyby: (hodina) => `aichyby:${hodina}`,
  znacka: (nazov, kedy) => `znacka:${nazov}:${kedy}`,
};
