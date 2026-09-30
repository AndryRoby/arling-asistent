-- 0004_ucet_ochrana.sql
-- Veľký audit 30. 9. 2026, oprava O-04 (nálezy 01 V3 a V4): prihlásenie kódom
-- na arling.sk/ucet/ (worker/src/ucet.js).
--
--   ucet_pokusy   pokusy o kód na jednu e-mailovú adresu v okne 24 h.
--     kluc     odtlačok adresy (SHA-256 z e-mailu a tajomstva UCET_TAJOMSTVO,
--              32 hex znakov), nikdy holý e-mail
--     pokusy   koľko kódov sa v okne porovnávalo (zlé aj dobré; dobrý riadok zmaže)
--     okno_od  začiatok okna v unix sekundách; po 24 h sa okno začne znova
--   Pripočíta sa atomicky jednou vetou (INSERT ... ON CONFLICT DO UPDATE SET
--   pokusy = pokusy + 1 ... WHERE pokusy < 10 RETURNING pokusy) PRED
--   porovnaním kódu, takže 50 súbežných pokusov porovná najviac 10 kódov.
--   Riadky staršie ako 24 h maže denný cron (src/cron.js).
--
-- Globálny denný strop odoslaných kódov (40 za UTC deň) nepotrebuje novú
-- tabuľku: je to riadok ucetkody:<deň> v asistent_pocty (migrácia 0003,
-- src/pocty.js rezervuj). Značka „ping o strope už odišiel“ je tam tiež.
--
-- Len nová tabuľka a index s IF NOT EXISTS, žiadny DROP ani ALTER. Worker to
-- isté vytvorí sám pri prvom použití (ucet.js zabezpecPokusy), súbor je na
-- spustenie pred nasadením:
--
--   npx wrangler d1 execute asistent --remote --file=migrations/0004_ucet_ochrana.sql

CREATE TABLE IF NOT EXISTS ucet_pokusy (kluc TEXT PRIMARY KEY, pokusy INTEGER NOT NULL DEFAULT 0, okno_od INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ucet_pokusy_okno ON ucet_pokusy (okno_od);
