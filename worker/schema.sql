-- schema.sql
-- D1 schema for ARLing Asistent. Apply once per environment with:
--   wrangler d1 execute asistent --file=schema.sql --remote
--
-- Deliberately no conversations/messages table anywhere: only tenant
-- records and daily aggregate counters are ever stored.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  feed_url TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  status TEXT NOT NULL DEFAULT 'pending',
  quota_month TEXT NOT NULL,
  monthly_quota INTEGER NOT NULL DEFAULT 1000,
  used_this_month INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_ingested_at TEXT
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
  PRIMARY KEY (tenant_id, day)
);
