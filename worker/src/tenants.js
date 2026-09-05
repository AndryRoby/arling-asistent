/*
 * tenants.js
 *
 * D1-backed tenant (shop) records and usage counters. Deliberately the only
 * place in this codebase that stores anything about a shop's visitors, and
 * even there it stores counts, never message content: no conversations
 * table exists anywhere in this schema.
 *
 * Schema (see ../schema.sql, applied once with `wrangler d1 execute`):
 *
 *   tenants(id, domain, feed_url, contact_email, plan, status, quota_month,
 *           monthly_quota, used_this_month, product_count, created_at,
 *           last_ingested_at)
 *   counters(tenant_id, day, conversations, product_clicks)
 *
 * All SQL text lives in the SQL constant below so tests can build a narrow,
 * purpose-built in-memory mock of D1 that recognises these exact statements
 * (see tests/helpers/mock-d1.mjs) rather than implementing a general SQL
 * engine.
 *
 * `product_count` was added after this table already existed in deployed
 * environments, so schema.sql alone (which only runs once, at first
 * `wrangler d1 execute`) is not enough to bring an existing database up to
 * date. ensureProductCountColumn() below adds the column at runtime with a
 * guarded ALTER TABLE, the first time this module touches a tenant row that
 * needs it (see setProductCount()); a fresh database created from the
 * current schema.sql already has the column and never needs the guard to
 * fire at all.
 */

export const PLANS = {
  FREE: 'free', // default for new tenants, up to 100 conversations/month, no payment
  STARTER: 'starter', // 19 EUR/month, up to 1000 conversations
  PRO: 'pro', // 39 EUR/month, up to 5000 conversations
};

export const DEFAULT_FREE_QUOTA = 100;
export const TRIAL_DAYS = 14;

/**
 * Default monthly_quota for each plan, used by setTenantPlan() (see
 * PATCH /v1/tenants/:id/plan below) whenever a caller sets a plan without
 * an explicit monthly_quota override. Mirrors the "Plány" table in README.md.
 */
export const DEFAULT_QUOTAS = {
  [PLANS.FREE]: DEFAULT_FREE_QUOTA,
  [PLANS.STARTER]: 1000,
  [PLANS.PRO]: 5000,
};

export const SQL = {
  INSERT_TENANT: `INSERT INTO tenants (id, domain, feed_url, contact_email, plan, status, quota_month, monthly_quota, used_this_month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  GET_TENANT_BY_ID: `SELECT * FROM tenants WHERE id = ?`,
  GET_TENANT_BY_DOMAIN: `SELECT * FROM tenants WHERE domain = ?`,
  LIST_TENANTS: `SELECT * FROM tenants`,
  SET_TENANT_STATUS: `UPDATE tenants SET status = ?, last_ingested_at = ? WHERE id = ?`,
  RESET_QUOTA_MONTH: `UPDATE tenants SET used_this_month = 0, quota_month = ? WHERE id = ?`,
  INCREMENT_USAGE_IF_UNDER_QUOTA: `UPDATE tenants SET used_this_month = used_this_month + 1 WHERE id = ? AND used_this_month < monthly_quota`,
  UPSERT_COUNTER_CONVERSATION: `INSERT INTO counters (tenant_id, day, conversations, product_clicks) VALUES (?, ?, 1, 0) ON CONFLICT(tenant_id, day) DO UPDATE SET conversations = conversations + 1`,
  UPSERT_COUNTER_CLICK: `INSERT INTO counters (tenant_id, day, conversations, product_clicks) VALUES (?, ?, 0, 1) ON CONFLICT(tenant_id, day) DO UPDATE SET product_clicks = product_clicks + 1`,
  ADD_PRODUCT_COUNT_COLUMN: `ALTER TABLE tenants ADD COLUMN product_count INTEGER NOT NULL DEFAULT 0`,
  SET_PRODUCT_COUNT: `UPDATE tenants SET product_count = ? WHERE id = ?`,
  SET_FEED_URL: `UPDATE tenants SET feed_url = ? WHERE id = ?`,
  ADD_BILLING_REF_COLUMN: `ALTER TABLE tenants ADD COLUMN billing_ref TEXT`,
  ADD_VALID_UNTIL_COLUMN: `ALTER TABLE tenants ADD COLUMN valid_until TEXT`,
  SET_TENANT_PLAN: `UPDATE tenants SET plan = ?, monthly_quota = ?, billing_ref = ?, valid_until = ? WHERE id = ?`,
};

export class ValidationError extends Error {
  constructor(issues) {
    super(`invalid tenant input: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/** domain has a UNIQUE constraint (schema.sql): thrown by createTenant instead of the raw D1 error so callers can offer an idempotent response (see onboarding.js) instead of a hard failure. */
export class DuplicateDomainError extends Error {
  constructor(domain) {
    super(`tenant domain already exists: ${domain}`);
    this.name = 'DuplicateDomainError';
    this.domain = domain;
  }
}

/** Any other D1 constraint violation (e.g. a colliding explicit id), not the domain-uniqueness case above: callers should treat this as a 409, not a 500. */
export class D1ConstraintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'D1ConstraintError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Extract and lowercase a hostname from a domain string, which may be a bare domain or a full URL. */
export function normaliseDomain(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}


/** True for hostnames the worker can never fetch from the public internet: localhost, loopback, RFC 1918 ranges, link-local, .local/.internal names. */
export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home')) return true;
  if (h === '::1' || h === '0.0.0.0' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export function validateTenantInput({ domain, feedUrl, contactEmail } = {}) {
  const issues = [];
  const normalisedDomain = normaliseDomain(domain);
  if (!normalisedDomain) issues.push('domain is missing or not a valid hostname');

  let feedUrlObj = null;
  try {
    feedUrlObj = new URL(feedUrl);
  } catch (e) {
    issues.push('feed_url is missing or not a valid URL');
  }
  if (feedUrlObj && !/^https?:$/.test(feedUrlObj.protocol)) {
    issues.push('feed_url must be http or https');
  }
  if (feedUrlObj && isPrivateHost(feedUrlObj.hostname)) {
    issues.push('feed_url must be publicly reachable (localhost and private network addresses cannot be fetched)');
  }

  if (!contactEmail || !EMAIL_RE.test(String(contactEmail).trim())) {
    issues.push('email is missing or not a valid address');
  }

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    domain: normalisedDomain,
    feedUrl: String(feedUrl).trim(),
    contactEmail: String(contactEmail).trim().toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTenantById(db, id) {
  return db.prepare(SQL.GET_TENANT_BY_ID).bind(id).first();
}

export async function getTenantByDomain(db, domain) {
  return db.prepare(SQL.GET_TENANT_BY_DOMAIN).bind(normaliseDomain(domain) || domain).first();
}

export async function listTenants(db) {
  const res = await db.prepare(SQL.LIST_TENANTS).all();
  return (res && res.results) || [];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a new tenant in 'pending' status (ingestion has not run yet).
 * Throws ValidationError on bad input, DuplicateDomainError if `domain`
 * (UNIQUE in schema.sql) already belongs to another tenant, or
 * D1ConstraintError for any other constraint violation (e.g. a caller-
 * supplied `id` that collides); see onboarding.js for how each is handled.
 */
export async function createTenant(db, input, { plan = PLANS.FREE, monthlyQuota = DEFAULT_FREE_QUOTA, now = new Date(), id } = {}) {
  const clean = validateTenantInput(input);
  const tenantId = id || genId();
  const createdAt = now.toISOString();
  try {
    await db
      .prepare(SQL.INSERT_TENANT)
      .bind(tenantId, clean.domain, clean.feedUrl, clean.contactEmail, plan, 'pending', monthKey(now), monthlyQuota, 0, createdAt)
      .run();
  } catch (err) {
    const message = String((err && err.message) || err);
    if (/constraint failed/i.test(message)) {
      if (/domain/i.test(message)) throw new DuplicateDomainError(clean.domain);
      throw new D1ConstraintError(message);
    }
    throw err;
  }
  return {
    id: tenantId,
    domain: clean.domain,
    feed_url: clean.feedUrl,
    contact_email: clean.contactEmail,
    plan,
    status: 'pending',
    quota_month: monthKey(now),
    monthly_quota: monthlyQuota,
    used_this_month: 0,
    product_count: 0,
    created_at: createdAt,
    last_ingested_at: null,
  };
}

export async function setTenantStatus(db, tenantId, status, { now = new Date() } = {}) {
  await db.prepare(SQL.SET_TENANT_STATUS).bind(status, now.toISOString(), tenantId).run();
}

/**
 * Add the product_count column to an existing tenants table, if it is not
 * there yet. Guarded: SQLite (D1) raises "duplicate column name" if the
 * column already exists, and that specific error is swallowed here since it
 * just means a previous call (an earlier ingestion, a previous deploy, or a
 * different Worker isolate) already added it; any other error propagates.
 * Cached per `db` binding (WeakSet, not a module-level boolean) so repeated
 * calls against the same binding skip the ALTER TABLE round-trip entirely,
 * while a distinct `db` (a fresh binding, or a fresh mock in tests) always
 * gets its own check.
 */
const productCountColumnEnsured = new WeakSet();
export async function ensureProductCountColumn(db) {
  if (productCountColumnEnsured.has(db)) return;
  try {
    await db.prepare(SQL.ADD_PRODUCT_COUNT_COLUMN).run();
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!/duplicate column/i.test(message)) throw err;
  }
  productCountColumnEnsured.add(db);
}

/** Record how many products the tenant's last successful ingestion embedded (see onboarding.js ingestFeedForTenant). */
export async function setProductCount(db, tenantId, productCount) {
  await ensureProductCountColumn(db);
  await db.prepare(SQL.SET_PRODUCT_COUNT).bind(productCount, tenantId).run();
}

/** Update a tenant's feed URL (used by the idempotent POST /v1/tenants path in onboarding.js when a re-submission for an existing domain carries a new feed URL). */
export async function setFeedUrl(db, tenantId, feedUrl) {
  await db.prepare(SQL.SET_FEED_URL).bind(feedUrl, tenantId).run();
}

/**
 * Add the billing_ref and valid_until columns to an existing tenants table,
 * if they are not there yet. Same pattern as ensureProductCountColumn()
 * above (guarded ALTER TABLE, cached per `db` binding via a WeakSet): these
 * two columns were added after billing (PATCH /v1/tenants/:id/plan, see
 * onboarding.js) shipped, so an already-deployed database needs them added
 * at runtime rather than relying on schema.sql, which only ever runs once.
 */
const billingColumnsEnsured = new WeakSet();
export async function ensureBillingColumns(db) {
  if (billingColumnsEnsured.has(db)) return;
  for (const sql of [SQL.ADD_BILLING_REF_COLUMN, SQL.ADD_VALID_UNTIL_COLUMN]) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      const message = String((err && err.message) || err);
      if (!/duplicate column/i.test(message)) throw err;
    }
  }
  billingColumnsEnsured.add(db);
}

/**
 * Set a tenant's plan, monthly_quota, and billing metadata in one write.
 * Used by the admin-only PATCH /v1/tenants/:id/plan route (see
 * onboarding.js), which is how a paid Stripe subscription actually changes
 * what a tenant is allowed to use (see licence-service/app.py's webhook,
 * which calls that route). `monthlyQuota` defaults to DEFAULT_QUOTAS[plan]
 * when omitted; `billingRef`/`validUntil` default to null (e.g. moving a
 * tenant back to `free` clears any stale subscription id / expiry).
 */
export async function setTenantPlan(db, tenantId, { plan, monthlyQuota, billingRef = null, validUntil = null } = {}) {
  await ensureBillingColumns(db);
  const quota = Number.isFinite(monthlyQuota) && monthlyQuota > 0 ? Math.floor(monthlyQuota) : DEFAULT_QUOTAS[plan];
  await db.prepare(SQL.SET_TENANT_PLAN).bind(plan, quota, billingRef, validUntil, tenantId).run();
  return quota;
}

/**
 * Check the tenant's monthly quota and, if there is room, atomically record
 * one conversation: increments used_this_month (single SQL statement, so
 * concurrent requests cannot both slip through under the limit) and bumps
 * today's counters row.
 *
 * MVP simplification: one POST /v1/chat call = one billed conversation unit
 * (there is no server-side conversation/session concept, by design: nothing
 * about a conversation is stored). A future version could count once per
 * widget session using the client-held in-memory session id instead of once
 * per message; see README "what is not built yet".
 */
export async function checkAndRecordConversation(db, tenantId, { now = new Date() } = {}) {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) return { allowed: false, reason: 'unknown_tenant' };

  const currentMonth = monthKey(now);
  if (tenant.quota_month !== currentMonth) {
    await db.prepare(SQL.RESET_QUOTA_MONTH).bind(currentMonth, tenantId).run();
    tenant.used_this_month = 0;
    tenant.quota_month = currentMonth;
  }

  if (tenant.used_this_month >= tenant.monthly_quota) {
    return { allowed: false, reason: 'quota_exceeded', remaining: 0 };
  }

  const result = await db.prepare(SQL.INCREMENT_USAGE_IF_UNDER_QUOTA).bind(tenantId).run();
  const changed = (result && result.meta && result.meta.changes) || (result && result.changes) || 0;
  if (!changed) {
    return { allowed: false, reason: 'quota_exceeded', remaining: 0 };
  }

  await db.prepare(SQL.UPSERT_COUNTER_CONVERSATION).bind(tenantId, dayKey(now)).run();

  return { allowed: true, remaining: tenant.monthly_quota - tenant.used_this_month - 1 };
}

export async function recordProductClick(db, tenantId, { now = new Date() } = {}) {
  await db.prepare(SQL.UPSERT_COUNTER_CLICK).bind(tenantId, dayKey(now)).run();
}
