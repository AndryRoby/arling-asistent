-- schema.sql
-- D1 schema for ARLing Asistent. Apply once per environment with:
--   wrangler d1 execute asistent --file=schema.sql --remote
--
-- Deliberately no conversations/messages table anywhere: only tenant
-- records and daily aggregate counters are ever stored.
--
-- This file only ever runs once, at first `wrangler d1 execute` for a given
-- database (every statement is IF NOT EXISTS): a column added here later,
-- such as product_count, billing_ref or valid_until below, will not
-- retroactively appear in an already applied database. worker/src/tenants.js
-- (ensureProductCountColumn, ensureBillingColumns) adds those columns at
-- runtime with a guarded ALTER TABLE instead, so an existing deployment does
-- not need this file re-run by hand.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  feed_url TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'pending',
  quota_month TEXT NOT NULL,
  monthly_quota INTEGER NOT NULL DEFAULT 100,
  used_this_month INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_ingested_at TEXT,
  billing_ref TEXT,
  valid_until TEXT,
  -- Zivotny cyklus (src/zivotny-cyklus.js, migrations/0001_zivotny_cyklus.sql):
  -- jazyk e-mailov (sk|cs|en|de, NULL = podla domeny), odkial ucet vznikol
  -- (formular|wordpress|shopify|api) a cas zastavenia volitelnych e-mailov.
  jazyk TEXT,
  zdroj TEXT,
  emaily_stop_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_domain ON tenants (domain);

-- Daily aggregate counters only: how many conversations happened and how
-- many product links were clicked, per tenant per day. No message content,
-- no per-visitor identifiers.
CREATE TABLE IF NOT EXISTS counters (
  tenant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  conversations INTEGER NOT NULL DEFAULT 0,
  product_clicks INTEGER NOT NULL DEFAULT 0,
  -- Rozhovory z webu samotneho obchodu (nie z arling.sk, nie z nahladu v
  -- administracii WordPressu); z nich sa pocita udalost "aktivny".
  web_conversations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- Udalosti uctu (vytvoreny, ready, chyba, zapojeny, prva_otazka, aktivny,
-- limit_80, limit_100, plan, zruseny, email:E0 az email:E4, emaily_stop).
-- Len fakty o ucte, nic o navstevnikoch e-shopu. UNIQUE (tenant_id, kluc) je
-- zaroven zamok: INSERT OR IGNORE jednorazovej udalosti spusti e-mail ci
-- ping len vtedy, ked riadok naozaj pribudol.
CREATE TABLE IF NOT EXISTS tenant_udalosti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  typ TEXT NOT NULL,
  kluc TEXT NOT NULL,
  kedy TEXT NOT NULL,
  data TEXT,
  UNIQUE (tenant_id, kluc)
);

-- Globalny denny strop automatickych e-mailov (migrations/0002).
CREATE TABLE IF NOT EXISTS asistent_strop (
  den TEXT NOT NULL,
  poradie INTEGER NOT NULL,
  kedy TEXT NOT NULL,
  PRIMARY KEY (den, poradie)
);

-- Hash adries, ktore povedali „nevytvaral som“: nikdy ziadny e-mail.
CREATE TABLE IF NOT EXISTS asistent_potlacene (
  hash TEXT PRIMARY KEY,
  kedy TEXT NOT NULL
);

-- Zmazane ucty (len id a cas), aby CRM zmazalo svoj zaznam.
CREATE TABLE IF NOT EXISTS tenant_zmazane (
  tenant_id TEXT PRIMARY KEY,
  kedy TEXT NOT NULL
);
