-- schema.sql
-- D1 schema for the ARLing Asistent Shopify app worker. Apply once with:
--   wrangler d1 execute asistent-shopify --file=schema.sql --remote
--
-- One row per shop that has ever installed the app (kept, not deleted, on
-- uninstall so a reinstall or a late shop/redact webhook has something to
-- act on; shop/redact deletes the row, see src/webhooks.js).

CREATE TABLE IF NOT EXISTS shops (
  domain TEXT PRIMARY KEY,          -- "my-shop.myshopify.com"
  access_token TEXT,                -- offline access token; cleared on app/uninstalled
  scope TEXT,
  tenant_id TEXT,                   -- ARLing Asistent tenant id (see ../../../worker/src/tenants.js)
  contact_email TEXT,
  plan TEXT NOT NULL DEFAULT 'free',       -- free | starter | pro
  charge_id TEXT,                   -- Shopify AppSubscription gid, once a paid plan is active
  status TEXT NOT NULL DEFAULT 'installed', -- installed | uninstalled
  feed_mode TEXT NOT NULL DEFAULT 'public', -- public (shop's own /products.json) | graphql (see src/products-feed.js)
  feed_cache TEXT,                  -- cached {"products":[...]} JSON, only populated when feed_mode = 'graphql'
  language TEXT NOT NULL DEFAULT 'auto', -- 'auto' matches the widget's own default (see ../../widget/widget.js)
  color TEXT NOT NULL DEFAULT 'auto',
  position TEXT NOT NULL DEFAULT 'right',
  installed_at TEXT,
  updated_at TEXT
);
