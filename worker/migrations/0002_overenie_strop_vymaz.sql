-- 0002_overenie_strop_vymaz.sql
-- Oprava po adverzarnej kontrole 25. 9. 2026 (src/zivotny-cyklus.js):
--   asistent_strop      globalny denny strop automatickych e-mailov (atomicky,
--                       PRIMARY KEY (den, poradie); poradie 0 = ping o strope)
--   asistent_potlacene  hash adries, ktore povedali „tohto Asistenta som
--                       nevytvaral“ (SHA-256, prvych 16 bajtov, nie adresa)
--   tenant_zmazane      id a cas zmazanych uctov bez osobnych udajov, pre CRM
-- Len nove tabulky, ziadny DROP ani ALTER. Worker to iste robi sam
-- (zabezpecSchemu), subor je na rucne spustenie pred nasadenim:
--
--   npx wrangler d1 execute asistent --remote --file=migrations/0002_overenie_strop_vymaz.sql

CREATE TABLE IF NOT EXISTS asistent_strop (
  den TEXT NOT NULL,
  poradie INTEGER NOT NULL,
  kedy TEXT NOT NULL,
  PRIMARY KEY (den, poradie)
);

CREATE TABLE IF NOT EXISTS asistent_potlacene (
  hash TEXT PRIMARY KEY,
  kedy TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_zmazane (
  tenant_id TEXT PRIMARY KEY,
  kedy TEXT NOT NULL
);
