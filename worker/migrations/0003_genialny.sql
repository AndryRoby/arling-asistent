-- 0003_genialny.sql
-- Plan ops/asistent/genialny-plan.md, cast 4.1. Dopĺňa sa krok po kroku:
-- kazdy krok stavby pridava len to, co sam pouziva.
--
--   Krok 1 (ochrana a presne pocitanie): stlpce nakladov v counters.
--     otazky         zodpovedane otazky za den a obchod
--     tokeny_vstup   vstupne tokeny jazykoveho modelu
--     tokeny_vystup  vystupne tokeny jazykoveho modelu
--     neurony        skutocne neurony (model aj vektory otazky), zaokruhlene na otazku
--     bez_ai         odpovede bez modelu (limity, stisenie free pri 80 %, vsetci pri 100 %)
--   Len cisla za den a obchod. Nikdy text otazky, id relacie ani IP.
--
--   Krok 1, oprava nalezov kontroly: tabulka asistent_pocty (src/pocty.js),
--   atomicke denne pocitadla, ktore sa rezervuju PRED volanim modelu
--   (spolocny strop, strop obchodu, denne limity siete IP, nove rozhovory,
--   rozpocet obnovy feedov, chyby modelu). Kluc nikdy nenesie IP ani id
--   relacie: limity IP pouzivaju len cislo kosa 0 az 65535 z odtlacku siete s
--   dnom a tajomstvom. Riadky starsie ako 2 dni maze denny cron.
--
-- Len nove tabulky a stlpce s predvolenou hodnotou, ziadny DROP ani
-- prepisanie dat. Worker to iste robi sam pri prvom pouziti (src/tenants.js
-- ensureNakladyColumns a src/pocty.js zabezpecPocty). Subor je na rucne
-- spustenie pred nasadenim, aby prvy chat po deploy nerobil ALTER TABLE:
--
--   npx wrangler d1 execute asistent --remote --file=migrations/0003_genialny.sql
--
-- POZOR: ALTER TABLE ADD COLUMN v SQLite nema IF NOT EXISTS. Ak uz worker
-- stlpec pridal, prikaz skonci chybou "duplicate column name" a zvysok suboru
-- sa nevykona; potom spustit zvysne riadky jednotlivo cez --command. Preto
-- su vety s IF NOT EXISTS na zaciatku.

-- Index pre dennu sumu neuronov vsetkych obchodov (src/tenants.js SUM_NEURONY_DNES).
CREATE INDEX IF NOT EXISTS idx_counters_day ON counters (day);

CREATE TABLE IF NOT EXISTS asistent_pocty (kluc TEXT PRIMARY KEY, den TEXT NOT NULL, hodnota INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_asistent_pocty_den ON asistent_pocty (den);

ALTER TABLE counters ADD COLUMN otazky INTEGER NOT NULL DEFAULT 0;
ALTER TABLE counters ADD COLUMN tokeny_vstup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE counters ADD COLUMN tokeny_vystup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE counters ADD COLUMN neurony INTEGER NOT NULL DEFAULT 0;
ALTER TABLE counters ADD COLUMN bez_ai INTEGER NOT NULL DEFAULT 0;
