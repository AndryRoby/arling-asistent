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

  const clone = (row) => (row ? { ...row } : row);

  function run(sql, args) {
    switch (sql) {
      case SQL.INSERT_TENANT: {
        const [id, domain, feed_url, contact_email, plan, status, quota_month, monthly_quota, used_this_month, created_at] = args;
        tenants.set(id, {
          id, domain, feed_url, contact_email, plan, status, quota_month,
          monthly_quota, used_this_month, created_at, last_ingested_at: null,
        });
        return { success: true, meta: { changes: 1 } };
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
