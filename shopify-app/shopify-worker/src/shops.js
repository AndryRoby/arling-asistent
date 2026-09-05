/*
 * shops.js
 *
 * D1-backed shop records for the Shopify integration. One row per installed
 * (or previously installed) shop: the offline access token, which ARLing
 * Asistent tenant it maps to, the chosen plan/charge, and the widget
 * settings the embedded admin page edits (language, colour, position).
 *
 * Schema: see ../schema.sql. All SQL text lives in the SQL constant below,
 * same convention as worker/src/tenants.js in the main product, so tests can
 * build a narrow in-memory mock that recognises these exact statements (see
 * tests/helpers/mock-d1.mjs) instead of a general SQL engine.
 */

export const PLANS = {
  FREE: 'free',
  STARTER: 'starter',
  PRO: 'pro',
};

export const SQL = {
  UPSERT_SHOP_ON_INSTALL: `
    INSERT INTO shops (domain, access_token, scope, plan, status, language, color, position, installed_at, updated_at)
    VALUES (?, ?, ?, 'free', 'installed', 'auto', 'auto', 'right', ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      access_token = excluded.access_token,
      scope = excluded.scope,
      status = 'installed',
      updated_at = excluded.updated_at
  `,
  GET_SHOP_BY_DOMAIN: `SELECT * FROM shops WHERE domain = ?`,
  SET_TENANT: `UPDATE shops SET tenant_id = ?, contact_email = ?, feed_mode = ?, updated_at = ? WHERE domain = ?`,
  SET_FEED_CACHE: `UPDATE shops SET feed_mode = ?, feed_cache = ?, updated_at = ? WHERE domain = ?`,
  SET_PLAN: `UPDATE shops SET plan = ?, charge_id = ?, updated_at = ? WHERE domain = ?`,
  SET_SETTINGS: `UPDATE shops SET language = ?, color = ?, position = ?, updated_at = ? WHERE domain = ?`,
  MARK_UNINSTALLED: `UPDATE shops SET status = 'uninstalled', access_token = NULL, updated_at = ? WHERE domain = ?`,
  PURGE_SHOP: `DELETE FROM shops WHERE domain = ?`,
};

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function getShopByDomain(db, domain) {
  return db.prepare(SQL.GET_SHOP_BY_DOMAIN).bind(domain).first();
}

/** Record (or refresh) an offline access token for a shop right after OAuth completes. Idempotent: reinstalling a previously-uninstalled shop revives the same row. */
export async function upsertShopOnInstall(db, domain, accessToken, scope, { now = new Date() } = {}) {
  const iso = now.toISOString();
  await db.prepare(SQL.UPSERT_SHOP_ON_INSTALL).bind(domain, accessToken, scope, iso, iso).run();
  return getShopByDomain(db, domain);
}

export async function setShopTenant(db, domain, tenantId, contactEmail, feedMode, { now = new Date() } = {}) {
  await db.prepare(SQL.SET_TENANT).bind(tenantId, contactEmail, feedMode, now.toISOString(), domain).run();
}

export async function setShopFeedCache(db, domain, feedMode, feedCacheJson, { now = new Date() } = {}) {
  await db.prepare(SQL.SET_FEED_CACHE).bind(feedMode, feedCacheJson, now.toISOString(), domain).run();
}

export async function setShopPlan(db, domain, plan, chargeId, { now = new Date() } = {}) {
  await db.prepare(SQL.SET_PLAN).bind(plan, chargeId || null, now.toISOString(), domain).run();
}

export async function setShopSettings(db, domain, { language, color, position }, { now = new Date() } = {}) {
  await db.prepare(SQL.SET_SETTINGS).bind(language, color, position, now.toISOString(), domain).run();
}

/** app/uninstalled: the access token is dead the moment Shopify sends this, so drop it immediately rather than waiting for a failed API call to notice. */
export async function markShopUninstalled(db, domain, { now = new Date() } = {}) {
  await db.prepare(SQL.MARK_UNINSTALLED).bind(now.toISOString(), domain).run();
}

/** shop/redact: erase the local row entirely (no offline token, no cached feed, no settings). Does not and cannot delete the ARLing tenant/vectors, see README "known gaps": the tenant API has no delete endpoint yet. */
export async function purgeShop(db, domain) {
  await db.prepare(SQL.PURGE_SHOP).bind(domain).run();
}

export { genId };
