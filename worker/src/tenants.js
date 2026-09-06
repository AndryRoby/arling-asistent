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
 *           last_ingested_at, billing_ref, valid_until)
 *   counters(tenant_id, day, conversations, product_clicks)
 *
 * The only non-D1 state this module touches is the short-lived
 * conv:{tenant}:{session} KV key in checkAndRecordConversation(), which
 * dedupes a widget session against the monthly counter. It holds a random
 * id the widget generated, never a visitor identifier.
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
  PRO: 'pro', // 39 EUR/month, up to 3000 conversations
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
  [PLANS.PRO]: 3000,
};

/**
 * How long one widget session stays "already counted" for the monthly
 * quota (see checkAndRecordConversation below): the KV key
 * conv:{tenant}:{session} expires after this many seconds, so a shopper
 * who comes back the next day with the same sessionStorage id starts a
 * new, separately counted conversation.
 */
export const CONVERSATION_SESSION_TTL_SECONDS = 86400;

/**
 * Shape of the widget's session id (widget/widget.js: 16 hex characters,
 * kept in sessionStorage). Anything else, including a missing value from an
 * older embed that predates sessions, falls back to counting once per
 * request, exactly as before sessions existed. The upper bound keeps a
 * malicious caller from using the session id as a free-form KV key.
 */
const SESSION_ID_RE = /^[a-z0-9_-]{8,64}$/i;

export function isValidSessionId(session) {
  return typeof session === 'string' && SESSION_ID_RE.test(session);
}

export function conversationSessionKey(tenantId, session) {
  return `conv:${tenantId}:${session}`;
}

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

/**
 * The current calendar month in UTC as a billing period: `period_start` is
 * the first day of this month, `period_end` the first day of the next one
 * (both "YYYY-MM-DD"), as reported by GET /v1/tenants/:id/status.
 */
export function monthPeriod(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { period_start: start.toISOString().slice(0, 10), period_end: end.toISOString().slice(0, 10) };
}

/**
 * Integer 0..100: how much of `quota` `used` represents, rounded down so
 * 79 of 100 reads as 79, never as an early 80. A zero/negative quota (which
 * setTenantPlan never writes, but a hand-edited row could) counts as fully
 * used rather than dividing by zero.
 */
export function usagePercent(used, quota) {
  const u = Math.max(0, Number(used) || 0);
  const q = Number(quota) || 0;
  if (q <= 0) return 100;
  return Math.max(0, Math.min(100, Math.floor((u * 100) / q)));
}

/**
 * Conversations counted so far in the current UTC calendar month. The
 * tenants row only ever stores the count for `quota_month`; if no chat has
 * happened since the month rolled over, that row is still last month's
 * count and the honest answer for this month is 0 (checkAndRecordConversation
 * resets it on the next chat anyway).
 */
export function conversationsUsedThisMonth(tenant, now = new Date()) {
  if (!tenant) return 0;
  return tenant.quota_month === monthKey(now) ? Number(tenant.used_this_month) || 0 : 0;
}

/**
 * The public plan name. Rows created before the free/starter/pro trio
 * existed carry "trial"; the public status contract only knows the three
 * names, and a trial behaves like a free tenant with a custom quota, so
 * anything unknown reports as "free" (the stored value is left untouched).
 */
export function publicPlanName(plan) {
  return plan === PLANS.STARTER || plan === PLANS.PRO ? plan : PLANS.FREE;
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
 * today's counters row. D1 stays the source of truth for the month.
 *
 * A "conversation" is one widget session, not one message: the widget
 * keeps a random session id in sessionStorage and sends it as `session`
 * with every POST /v1/chat. The (tenant, session) pair is remembered in KV
 * (`kv`, the ASISTENT_CACHE binding; key conv:{tenant}:{session}, TTL
 * CONVERSATION_SESSION_TTL_SECONDS) only after it has actually been counted,
 * so further messages in the same session within 24h are allowed without
 * touching the counter at all, even if the quota filled up in the meantime
 * (a shopper is never cut off mid-conversation; the conversation was paid
 * for when it started). Requests with no usable session (older embeds, or
 * no `kv`) count once per request, as before sessions existed.
 *
 * KV problems never block a shopper: a failing get counts the request (fail
 * open, the same policy as the rate limiter in security.js, so the worst
 * case is over-counting, never a 500), and a failing put is ignored.
 *
 * Returns {allowed, counted, used, quota, remaining, reason?}: `used` is the
 * count after this call, so callers can tell whether a threshold was just
 * crossed (see notify.js).
 */
export async function checkAndRecordConversation(db, tenantId, { now = new Date(), session, kv } = {}) {
  const tenant = await getTenantById(db, tenantId);
  if (!tenant) return { allowed: false, reason: 'unknown_tenant' };

  const currentMonth = monthKey(now);
  if (tenant.quota_month !== currentMonth) {
    await db.prepare(SQL.RESET_QUOTA_MONTH).bind(currentMonth, tenantId).run();
    tenant.used_this_month = 0;
    tenant.quota_month = currentMonth;
  }

  const quota = tenant.monthly_quota;
  const usedBefore = tenant.used_this_month;
  const sessionKey = kv && isValidSessionId(session) ? conversationSessionKey(tenantId, session) : null;

  if (sessionKey) {
    let seen = false;
    try {
      seen = (await kv.get(sessionKey)) != null;
    } catch (err) {
      console.warn('[arling-asistent] conversation session KV get failed, counting this request:', (err && err.message) || err);
    }
    if (seen) {
      return { allowed: true, counted: false, used: usedBefore, quota, remaining: Math.max(0, quota - usedBefore), session: true };
    }
  }

  if (usedBefore >= quota) {
    return { allowed: false, counted: false, reason: 'quota_exceeded', used: usedBefore, quota, remaining: 0 };
  }

  const result = await db.prepare(SQL.INCREMENT_USAGE_IF_UNDER_QUOTA).bind(tenantId).run();
  const changed = (result && result.meta && result.meta.changes) || (result && result.changes) || 0;
  if (!changed) {
    return { allowed: false, counted: false, reason: 'quota_exceeded', used: usedBefore, quota, remaining: 0 };
  }

  await db.prepare(SQL.UPSERT_COUNTER_CONVERSATION).bind(tenantId, dayKey(now)).run();

  if (sessionKey) {
    try {
      await kv.put(sessionKey, '1', { expirationTtl: CONVERSATION_SESSION_TTL_SECONDS });
    } catch (err) {
      console.warn('[arling-asistent] conversation session KV put failed, session will count again:', (err && err.message) || err);
    }
  }

  const used = usedBefore + 1;
  return { allowed: true, counted: true, used, quota, remaining: quota - used, session: !!sessionKey };
}

export async function recordProductClick(db, tenantId, { now = new Date() } = {}) {
  await db.prepare(SQL.UPSERT_COUNTER_CLICK).bind(tenantId, dayKey(now)).run();
}
