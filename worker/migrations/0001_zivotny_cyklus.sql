-- 0001_zivotny_cyklus.sql
-- Zivotny cyklus Asistenta (navrh ops/asistent/zivotny-cyklus.md, cast 1.3).
-- Len nove stlpce a nova tabulka. Ziadny DROP, ziadne prepisanie dat.
--
-- Worker to iste robi sam pri prvom pouziti (src/zivotny-cyklus.js,
-- zabezpecSchemu: CREATE TABLE IF NOT EXISTS a strazeny ALTER TABLE, chyba
-- "duplicate column" sa prehltne). Tento subor je pre rucne spustenie pred
-- nasadenim, aby prvy chat po deploy nerobil ALTER TABLE:
--
--   npx wrangler d1 execute asistent --remote --file=migrations/0001_zivotny_cyklus.sql
--
-- POZOR: ALTER TABLE ADD COLUMN v SQLite nema IF NOT EXISTS. Ak uz worker
-- stlpec pridal, prikaz skonci chybou "duplicate column name" a zvysok
-- suboru sa nevykona. Preto je CREATE TABLE prvy a stlpce idu kazdy zvlast;
-- pri chybe spustit zvysne riadky jednotlivo cez --command.

CREATE TABLE IF NOT EXISTS tenant_udalosti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  typ TEXT NOT NULL,
  kluc TEXT NOT NULL,
  kedy TEXT NOT NULL,
  data TEXT,
  UNIQUE (tenant_id, kluc)
);

ALTER TABLE tenants ADD COLUMN jazyk TEXT;
ALTER TABLE tenants ADD COLUMN zdroj TEXT;
ALTER TABLE tenants ADD COLUMN emaily_stop_at TEXT;
ALTER TABLE counters ADD COLUMN web_conversations INTEGER NOT NULL DEFAULT 0;
