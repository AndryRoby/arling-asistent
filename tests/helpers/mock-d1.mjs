// mock-d1.mjs
// A narrow, purpose-built in-memory stand-in for Cloudflare D1, implementing
// only the exact prepared statements tenants.js issues (imported from its
// SQL export, see worker/src/tenants.js). This is deliberately not a
// general SQL engine: it pattern-matches on the known query strings so the
// worker code under test can use real SQL while the test mock stays small
// and easy to audit.

import { SQL } from '../../worker/src/tenants.js';
import { ZC_SQL } from '../../worker/src/zivotny-cyklus.js';

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
  // Životný cyklus (worker/src/zivotny-cyklus.js zabezpecSchemu): nová
  // tabuľka a štyri stĺpce, každý so svojím príznakom, presne ako databáza
  // nasadená pred touto zmenou.
  let hasUdalosti = false;
  const zcStlpce = { jazyk: false, zdroj: false, emaily_stop_at: false, web_conversations: false };
  const udalosti = []; // {id, tenant_id, typ, kluc, kedy, data}
  // Tabuľky z opravy 25. 9. 2026: denný strop e-mailov, potlačené adresy, zmazané účty.
  const zcTabulky = { asistent_strop: false, asistent_potlacene: false, tenant_zmazane: false };
  const strop = new Map(); // `${den}::${poradie}` -> {den, poradie, kedy}
  const potlacene = new Map(); // hash -> kedy
  const zmazane = new Map(); // tenant_id -> kedy
  function potrebujTabulku(nazov) {
    if (!zcTabulky[nazov]) throw new Error(`D1_ERROR: no such table: ${nazov}`);
  }
  let dalsieId = 1;
  const calls = []; // každý vykonaný príkaz, pre testy „žiadny dopyt do D1“

  const clone = (row) => (row ? { ...row } : row);

  function potrebujUdalosti() {
    if (!hasUdalosti) throw new Error('D1_ERROR: no such table: tenant_udalosti');
  }
  function potrebujStlpec(nazov) {
    if (!zcStlpce[nazov]) throw new Error(`D1_ERROR: no such column: ${nazov}`);
  }
  function pridajStlpec(nazov, tabulka, predvolena) {
    if (zcStlpce[nazov]) throw new Error(`duplicate column name: ${nazov}`);
    zcStlpce[nazov] = true;
    for (const row of tabulka.values()) if (row[nazov] === undefined) row[nazov] = predvolena;
    return { success: true, meta: { changes: 0 } };
  }

  function run(sql, args) {
    calls.push(sql);
    switch (sql) {
      case ZC_SQL.CREATE_UDALOSTI:
        hasUdalosti = true;
        return { success: true, meta: { changes: 0 } };
      case ZC_SQL.CREATE_STROP:
        zcTabulky.asistent_strop = true;
        return { success: true, meta: { changes: 0 } };
      case ZC_SQL.CREATE_POTLACENE:
        zcTabulky.asistent_potlacene = true;
        return { success: true, meta: { changes: 0 } };
      case ZC_SQL.CREATE_ZMAZANE:
        zcTabulky.tenant_zmazane = true;
        return { success: true, meta: { changes: 0 } };
      case ZC_SQL.INSERT_STROP: {
        potrebujTabulku('asistent_strop');
        const [den, poradie, kedy] = args;
        const k = `${den}::${poradie}`;
        if (strop.has(k)) return { success: true, meta: { changes: 0 } };
        strop.set(k, { den, poradie, kedy });
        return { success: true, meta: { changes: 1 } };
      }
      case ZC_SQL.DELETE_STARY_STROP: {
        potrebujTabulku('asistent_strop');
        let n = 0;
        for (const [k, r] of strop) if (r.den < args[0]) { strop.delete(k); n += 1; }
        return { success: true, meta: { changes: n } };
      }
      case ZC_SQL.INSERT_POTLACENA: {
        potrebujTabulku('asistent_potlacene');
        const [hash, kedy] = args;
        if (potlacene.has(hash)) return { success: true, meta: { changes: 0 } };
        potlacene.set(hash, kedy);
        return { success: true, meta: { changes: 1 } };
      }
      case ZC_SQL.INSERT_ZMAZANY: {
        potrebujTabulku('tenant_zmazane');
        const [tenantId, kedy] = args;
        if (zmazane.has(tenantId)) return { success: true, meta: { changes: 0 } };
        zmazane.set(tenantId, kedy);
        return { success: true, meta: { changes: 1 } };
      }
      case ZC_SQL.ADD_JAZYK:
        return pridajStlpec('jazyk', tenants, null);
      case ZC_SQL.ADD_ZDROJ:
        return pridajStlpec('zdroj', tenants, null);
      case ZC_SQL.ADD_EMAILY_STOP:
        return pridajStlpec('emaily_stop_at', tenants, null);
      case ZC_SQL.ADD_WEB_CONVERSATIONS:
        return pridajStlpec('web_conversations', counters, 0);
      case ZC_SQL.INSERT_UDALOST: {
        potrebujUdalosti();
        const [tenant_id, typ, kluc, kedy, data] = args;
        if (udalosti.some((u) => u.tenant_id === tenant_id && u.kluc === kluc)) return { success: true, meta: { changes: 0 } };
        udalosti.push({ id: dalsieId++, tenant_id, typ, kluc, kedy, data });
        return { success: true, meta: { changes: 1, last_row_id: dalsieId - 1 } };
      }
      case ZC_SQL.SET_UDALOST_DATA: {
        potrebujUdalosti();
        const [data, tenantId, kluc] = args;
        const u = udalosti.find((x) => x.tenant_id === tenantId && x.kluc === kluc);
        if (u) u.data = data;
        return { success: true, meta: { changes: u ? 1 : 0 } };
      }
      case ZC_SQL.CAS_UDALOST_DATA: {
        potrebujUdalosti();
        const [data, tenantId, kluc, stare] = args;
        const u = udalosti.find((x) => x.tenant_id === tenantId && x.kluc === kluc && x.data === stare);
        if (u) u.data = data;
        return { success: true, meta: { changes: u ? 1 : 0 } };
      }
      case ZC_SQL.SET_JAZYK_ZDROJ: {
        potrebujStlpec('jazyk');
        potrebujStlpec('zdroj');
        const [jazyk, zdroj, id] = args;
        const row = tenants.get(id);
        if (row) { row.jazyk = jazyk; row.zdroj = zdroj; }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case ZC_SQL.SET_JAZYK: {
        potrebujStlpec('jazyk');
        const [jazyk, id] = args;
        const row = tenants.get(id);
        if (row) row.jazyk = jazyk;
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case ZC_SQL.SET_EMAILY_STOP: {
        potrebujStlpec('emaily_stop_at');
        const [kedy, id] = args;
        const row = tenants.get(id);
        const zmena = !!row && row.emaily_stop_at == null;
        if (zmena) row.emaily_stop_at = kedy;
        return { success: true, meta: { changes: zmena ? 1 : 0 } };
      }
      case ZC_SQL.INC_WEB_CONVERSATIONS: {
        potrebujStlpec('web_conversations');
        const [tenantId, day] = args;
        const row = counters.get(`${tenantId}::${day}`);
        if (row) row.web_conversations = (row.web_conversations || 0) + 1;
        return { success: true, meta: { changes: row ? 1 : 0 } };
      }
      case ZC_SQL.DELETE_TENANT: {
        const existed = tenants.delete(args[0]);
        return { success: true, meta: { changes: existed ? 1 : 0 } };
      }
      case ZC_SQL.DELETE_COUNTERS: {
        let n = 0;
        for (const [k, row] of counters) if (row.tenant_id === args[0]) { counters.delete(k); n += 1; }
        return { success: true, meta: { changes: n } };
      }
      case ZC_SQL.DELETE_UDALOSTI: {
        potrebujUdalosti();
        const pred = udalosti.length;
        for (let i = udalosti.length - 1; i >= 0; i--) if (udalosti[i].tenant_id === args[0]) udalosti.splice(i, 1);
        return { success: true, meta: { changes: pred - udalosti.length } };
      }
      case ZC_SQL.DELETE_STARE_UDALOSTI: {
        potrebujUdalosti();
        const pred = udalosti.length;
        for (let i = udalosti.length - 1; i >= 0; i--) if (udalosti[i].kedy < args[0]) udalosti.splice(i, 1);
        return { success: true, meta: { changes: pred - udalosti.length } };
      }
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
        if (zcStlpce.jazyk) row.jazyk = null;
        if (zcStlpce.zdroj) row.zdroj = null;
        if (zcStlpce.emaily_stop_at) row.emaily_stop_at = null;
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
        const row = counters.get(key) || { tenant_id: tenantId, day, conversations: 0, product_clicks: 0, ...(zcStlpce.web_conversations ? { web_conversations: 0 } : {}) };
        row.conversations += 1;
        counters.set(key, row);
        return { success: true, meta: { changes: 1 } };
      }
      case SQL.UPSERT_COUNTER_CLICK: {
        const [tenantId, day] = args;
        const key = `${tenantId}::${day}`;
        const row = counters.get(key) || { tenant_id: tenantId, day, conversations: 0, product_clicks: 0, ...(zcStlpce.web_conversations ? { web_conversations: 0 } : {}) };
        row.product_clicks += 1;
        counters.set(key, row);
        return { success: true, meta: { changes: 1 } };
      }
      default:
        throw new Error(`mock-d1: unhandled statement in run(): ${sql}`);
    }
  }

  function first(sql, args) {
    calls.push(sql);
    switch (sql) {
      case SQL.GET_TENANT_BY_ID:
        return clone(tenants.get(args[0])) || null;
      case SQL.GET_TENANT_BY_DOMAIN: {
        for (const row of tenants.values()) if (row.domain === args[0]) return clone(row);
        return null;
      }
      case ZC_SQL.POCET_STROP: {
        potrebujTabulku('asistent_strop');
        let n = 0;
        for (const r of strop.values()) if (r.den === args[0] && r.poradie > 0) n += 1;
        return { n };
      }
      case ZC_SQL.JE_POTLACENA: {
        potrebujTabulku('asistent_potlacene');
        return potlacene.has(args[0]) ? { hash: args[0] } : null;
      }
      default:
        throw new Error(`mock-d1: unhandled statement in first(): ${sql}`);
    }
  }

  function all(sql, args) {
    calls.push(sql);
    switch (sql) {
      case SQL.LIST_TENANTS:
        return { results: Array.from(tenants.values()).map(clone) };
      case ZC_SQL.LIST_UDALOSTI_TENANTA:
        potrebujUdalosti();
        return { results: udalosti.filter((u) => u.tenant_id === args[0]).sort((a, b) => a.id - b.id).map(clone) };
      case ZC_SQL.LIST_UDALOSTI_PO: {
        potrebujUdalosti();
        const [po, limit] = args;
        return { results: udalosti.filter((u) => u.id > po).sort((a, b) => a.id - b.id).slice(0, limit).map(clone) };
      }
      case ZC_SQL.COUNTERS_OD: {
        const [tenantId, od] = args;
        return {
          results: Array.from(counters.values())
            .filter((r) => r.tenant_id === tenantId && r.day >= od)
            .map((r) => ({ day: r.day, conversations: r.conversations, web_conversations: r.web_conversations || 0 })),
        };
      }
      case ZC_SQL.TENANTY_PODLA_DOMEN: {
        const hladane = new Set(args);
        return { results: Array.from(tenants.values()).filter((r) => hladane.has(r.domain)).map((r) => ({ id: r.id, domain: r.domain, status: r.status })) };
      }
      case ZC_SQL.TENANTY_S_PRACOU: {
        potrebujUdalosti();
        const [od] = args;
        const maxId = new Map();
        for (const u of udalosti) {
          const cakajuci = u.typ === 'email' && typeof u.data === 'string' && (u.data.includes('"stav":"zlyhal"') || u.data.includes('"stav":"odosiela"'));
          if (u.kedy > od || cakajuci) maxId.set(u.tenant_id, Math.max(maxId.get(u.tenant_id) || 0, u.id));
        }
        return { results: [...maxId.entries()].sort((a, b) => b[1] - a[1]).map(([tenant_id]) => ({ tenant_id })) };
      }
      case ZC_SQL.ZAPOJENE_BEZ_AKTIVNEHO: {
        potrebujUdalosti();
        const aktivne = new Set(udalosti.filter((u) => u.typ === 'aktivny').map((u) => u.tenant_id));
        const ids = [...new Set(udalosti.filter((u) => u.typ === 'zapojeny' && !aktivne.has(u.tenant_id)).map((u) => u.tenant_id))];
        return { results: ids.map((tenant_id) => ({ tenant_id })) };
      }
      case ZC_SQL.LIST_ZMAZANE: {
        potrebujTabulku('tenant_zmazane');
        return { results: [...zmazane.entries()].map(([tenant_id, kedy]) => ({ tenant_id, kedy })).sort((a, b) => (a.kedy < b.kedy ? -1 : 1)) };
      }
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
    _udalosti: udalosti,
    _calls: calls,
    _zcStlpce: zcStlpce,
    _hasUdalosti: () => hasUdalosti,
    _strop: strop,
    _potlacene: potlacene,
    _zmazane: zmazane,
  };
}
