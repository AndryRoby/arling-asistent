// mock-d1.mjs
// A narrow, purpose-built in-memory stand-in for Cloudflare D1, implementing
// only the exact prepared statements shops.js issues (imported from its SQL
// export, see shopify-worker/src/shops.js). Same convention as the parent
// product's tests/helpers/mock-d1.mjs: pattern-match on known query strings
// rather than a general SQL engine.

import { SQL } from '../../shopify-worker/src/shops.js';

export function createMockD1() {
  const shops = new Map(); // domain -> row

  const clone = (row) => (row ? { ...row } : row);

  function run(sql, args) {
    switch (sql) {
      case SQL.UPSERT_SHOP_ON_INSTALL: {
        const [domain, accessToken, scope, installedAt, updatedAt] = args;
        const existing = shops.get(domain);
        if (existing) {
          existing.access_token = accessToken;
          existing.scope = scope;
          existing.status = 'installed';
          existing.updated_at = updatedAt;
        } else {
          shops.set(domain, {
            domain, access_token: accessToken, scope, tenant_id: null, contact_email: null,
            plan: 'free', charge_id: null, status: 'installed', feed_mode: 'public', feed_cache: null,
            language: 'auto', color: 'auto', position: 'right', installed_at: installedAt, updated_at: updatedAt,
          });
        }
        return { success: true, meta: { changes: 1 } };
      }
      case SQL.SET_TENANT: {
        const [tenantId, contactEmail, feedMode, updatedAt, domain] = args;
        const row = shops.get(domain);
        if (row) { row.tenant_id = tenantId; row.contact_email = contactEmail; row.feed_mode = feedMode; row.updated_at = updatedAt; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.SET_FEED_CACHE: {
        const [feedMode, feedCache, updatedAt, domain] = args;
        const row = shops.get(domain);
        if (row) { row.feed_mode = feedMode; row.feed_cache = feedCache; row.updated_at = updatedAt; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.SET_PLAN: {
        const [plan, chargeId, updatedAt, domain] = args;
        const row = shops.get(domain);
        if (row) { row.plan = plan; row.charge_id = chargeId; row.updated_at = updatedAt; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.SET_SETTINGS: {
        const [language, color, position, updatedAt, domain] = args;
        const row = shops.get(domain);
        if (row) { row.language = language; row.color = color; row.position = position; row.updated_at = updatedAt; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.MARK_UNINSTALLED: {
        const [updatedAt, domain] = args;
        const row = shops.get(domain);
        if (row) { row.status = 'uninstalled'; row.access_token = null; row.updated_at = updatedAt; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case SQL.PURGE_SHOP: {
        const [domain] = args;
        const existed = shops.delete(domain);
        return { success: true, meta: { changes: existed ? 1 : 0 } };
      }
      default:
        throw new Error(`mock-d1: unhandled statement in run(): ${sql}`);
    }
  }

  function first(sql, args) {
    switch (sql) {
      case SQL.GET_SHOP_BY_DOMAIN:
        return clone(shops.get(args[0])) || null;
      default:
        throw new Error(`mock-d1: unhandled statement in first(): ${sql}`);
    }
  }

  return {
    prepare(sql) {
      const statement = (args) => ({
        bind(...newArgs) { return statement(newArgs); },
        async run() { return run(sql, args); },
        async first() { return first(sql, args); },
      });
      return statement([]);
    },
    _shops: shops,
  };
}
