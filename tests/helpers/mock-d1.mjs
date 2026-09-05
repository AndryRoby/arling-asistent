// mock-d1.mjs
// A narrow, purpose-built in-memory stand-in for Cloudflare D1, implementing
// only the exact prepared statements tenants.js issues (imported from its
// SQL export, see worker/src/tenants.js). This is deliberately not a
// general SQL engine: it pattern-matches on the known query strings so the
// worker code under test can use real SQL while the test mock stays small
// and easy to audit.

import { SQL } from '../../worker/src/tenants.js';

export function createMockD1() {
  const tenants = new Map(); // id -> row
  const counters = new Map(); // `${tenantId}::${day}` -> row
  // Mirrors a real tenants table that predates the product_count column:
  // false until something runs SQL.ADD_PRODUCT_COUNT_COLUMN (see
  // tenants.js ensureProductCountColumn/setProductCount), same as a
  // deployed D1 database that has not seen that guarded ALTER TABLE yet.
  let hasProductCountColumn = false;
  // Same idea for billing_ref/valid_until (see tenants.js
  // ensureBillingColumns/setTenantPlan): each is its own ALTER TABLE
  // statement in real SQLite, so each gets its own independent flag.
  let hasBillingRefColumn = false;
  let hasValidUntilColumn = false;

  const clone = (row) => (row ? { ...row } : row);

  function run(sql, args) {
    switch (sql) {
      case SQL.INSERT_TENANT: {
        const [id, domain, feed_url, contact_email, plan, status, quota_month, monthly_quota, used_this_month, created_at] = args;
        // Mirrors real D1/SQLite's constraint checks (schema.sql: id PRIMARY
        // KEY, domain UNIQUE) so createTenant's own catch block (tenants.js)
        // has something realistic to pattern-match against: an id collision
        // is a generic constraint violation (-> D1ConstraintError -> 409), a
        // domain collision is the specific, idempotent-response case
        // (-> DuplicateDomainError, see onboarding.js).
        if (tenants.has(id)) {
          throw new Error('D1_ERROR: UNIQUE constraint failed: tenants.id: SQLITE_CONSTRAINT');
        }
        for (const existing of tenants.values()) {
          if (existing.domain === domain) {
            throw new Error('D1_ERROR: UNIQUE constraint failed: tenants.domain: SQLITE_CONSTRAINT');
          }
        }
        const row = {
          id, domain, feed_url, contact_email, plan, status, quota_month,
          monthly_quota, used_this_month, created_at, last_ingested_at: null,
        };
        // INSERT_TENANT never lists product_count/billing_ref/valid_until
        // explicitly, so a row only gets them if the column already exists,
        // exactly like real SQLite (DEFAULT 0 for product_count, NULL for
        // the two billing columns).
        if (hasProductCountColumn) row.product_count = 0;
        if (hasBillingRefColumn) row.billing_ref = null;
        if (hasValidUntilColumn) row.valid_until = null;
        tenants.set(id, row);
        return { success: true, meta: { changes: 1 } };
      }
      case SQL.ADD_PRODUCT_COUNT_COLUMN: {
        if (hasProductCountColumn) {
          // Real SQLite/D1 error text for adding a column that already exists.
          throw new Error('duplicate column name: product_count');
        }
        hasProductCountColumn = true;
        for (const row of tenants.values()) {
          if (row.product_count === undefined) row.product_count = 0;
        }
        return { success: true, meta: { changes: 0 } };
      }
      case SQL.SET_PRODUCT_COUNT: {
        const [productCount, id] = args;
        const row = tenants.get(id);
        if (row) row.product_count = productCount;
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.SET_FEED_URL: {
        const [feedUrl, id] = args;
        const row = tenants.get(id);
        if (row) row.feed_url = feedUrl;
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.ADD_BILLING_REF_COLUMN: {
        if (hasBillingRefColumn) throw new Error('duplicate column name: billing_ref');
        hasBillingRefColumn = true;
        for (const row of tenants.values()) {
          if (row.billing_ref === undefined) row.billing_ref = null;
        }
        return { success: true, meta: { changes: 0 } };
      }
      case SQL.ADD_VALID_UNTIL_COLUMN: {
        if (hasValidUntilColumn) throw new Error('duplicate column name: valid_until');
        hasValidUntilColumn = true;
        for (const row of tenants.values()) {
          if (row.valid_until === undefined) row.valid_until = null;
        }
        return { success: true, meta: { changes: 0 } };
      }
      case SQL.SET_TENANT_PLAN: {
        const [plan, monthlyQuota, billingRef, validUntil, id] = args;
        const row = tenants.get(id);
        if (row) {
          row.plan = plan;
          row.monthly_quota = monthlyQuota;
          row.billing_ref = billingRef;
          row.valid_until = validUntil;
        }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.SET_TENANT_STATUS: {
        const [status, lastIngestedAt, id] = args;
        const row = tenants.get(id);
        if (row) { row.status = status; row.last_ingested_at = lastIngestedAt; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.RESET_QUOTA_MONTH: {
        const [quotaMonth, id] = args;
        const row = tenants.get(id);
        if (row) { row.used_this_month = 0; row.quota_month = quotaMonth; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.INCREMENT_USAGE_IF_UNDER_QUOTA: {
        const [id] = args;
        const row = tenants.get(id);
        if (row && row.used_this_month < row.monthly_quota) {
          row.used_this_month += 1;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      case SQL.UPSERT_COUNTER_CONVERSATION: {
        const [tenantId, day] = args;
        const key = `${tenantId}::${day}`;
        const row = counters.get(key) || { tenant_id: tenantId, day, conversations: 0, product_clicks: 0 };
        row.conversations += 1;
        counters.set(key, row);
        return { success: true, meta: { changes: 1 } };
      }
      case SQL.UPSERT_COUNTER_CLICK: {
        const [tenantId, day] = args;
        const key = `${tenantId}::${day}`;
        const row = counters.get(key) || { tenant_id: tenantId, day, conversations: 0, product_clicks: 0 };
        row.product_clicks += 1;
        counters.set(key, row);
        return { success: true, meta: { changes: 1 } };
      }
      default:
        throw new Error(`mock-d1: unhandled statement in run(): ${sql}`);
    }
  }

  function first(sql, args) {
    switch (sql) {
      case SQL.GET_TENANT_BY_ID:
        return clone(tenants.get(args[0])) || null;
      case SQL.GET_TENANT_BY_DOMAIN: {
        for (const row of tenants.values()) if (row.domain === args[0]) return clone(row);
        return null;
      }
      default:
        throw new Error(`mock-d1: unhandled statement in first(): ${sql}`);
    }
  }

  function all(sql) {
    switch (sql) {
      case SQL.LIST_TENANTS:
        return { results: Array.from(tenants.values()).map(clone) };
      default:
        throw new Error(`mock-d1: unhandled statement in all(): ${sql}`);
    }
  }

  // Mirrors the real D1PreparedStatement shape: prepare() alone already
  // exposes run()/first()/all() (for parameter-less statements like
  // LIST_TENANTS), and bind() returns a new statement with args attached.
  return {
    prepare(sql) {
      const statement = (args) => ({
        bind(...newArgs) { return statement(newArgs); },
        async run() { return run(sql, args); },
        async first() { return first(sql, args); },
        async all() { return all(sql, args); },
      });
      return statement([]);
    },
    _tenants: tenants,
    _counters: counters,
  };
}
