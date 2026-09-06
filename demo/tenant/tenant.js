/*
 * tenant.js
 *
 * Per-tenant account page: arling.sk/asistent/tenant/?t=<tenant id>.
 * Reads the id from the query, calls GET /v1/tenants/:id/status on the
 * worker and shows the shop domain, plan, a usage bar for the current
 * calendar month, the period end, indexed products, the last feed refresh,
 * the embed code, and the two Stripe Payment Links (Starter, Pro) with the
 * tenant id in client_reference_id so the licence-service webhook can raise
 * the plan after payment.
 *
 * The tenant id is a public capability (it sits in the embed script of
 * every shop), so this page shows counters only: the status endpoint never
 * returns contact_email or billing_ref, and nothing here asks for them.
 *
 * Degrades gracefully: a worker that still returns the older status shape
 * (used_this_month, last_ingested_at, no usage_percent/period_end) is read
 * through the same normaliser, missing numbers show as "n/a", the period
 * end falls back to the first day of next month (UTC, which is how the
 * worker defines the period anyway), and nothing throws.
 *
 * Pure helpers (normaliseStatus, upgradeUrl, embedSnippetFor, formatting)
 * are exported for tests; everything touching the DOM is guarded so this
 * module can be imported under Node.
 */

import { t, tf, getLang, DEFAULT_LANG } from './i18n.js';

export const ENDPOINT = 'https://arling-asistent.arling.workers.dev';
export const WIDGET_SCRIPT_ORIGIN = ENDPOINT;
export const TENANT_PAGE_URL = 'https://arling.sk/asistent/tenant/';

/** Stripe Payment Links (Managed Payments), one per paid plan. */
export const STRIPE_LINKS = {
  starter: 'https://buy.stripe.com/5kQcMZ1fA6tZaoWaOh4ko03',
  pro: 'https://buy.stripe.com/14AdR30bw05BgNk3lP4ko04',
};

/** Same as DEFAULT_QUOTAS in worker/src/tenants.js. */
export const PLAN_QUOTAS = { free: 100, starter: 1000, pro: 3000 };

/** Ordering used to decide which upgrade buttons make sense for a tenant. */
const PLAN_RANK = { free: 0, trial: 0, starter: 1, pro: 2 };

/** Tenant id from a query string, restricted to the characters a worker id can contain. */
export function tenantIdFromQuery(search) {
  try {
    const raw = new URLSearchParams(search || '').get('t') || '';
    return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  } catch (e) {
    return '';
  }
}

/** Payment Link with the tenant id as client_reference_id (what licence-service reads from the Checkout Session). */
export function upgradeUrl(plan, tenantId) {
  const base = STRIPE_LINKS[plan];
  if (!base || !tenantId) return '';
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + 'client_reference_id=' + encodeURIComponent(tenantId);
}

/** Same snippet the demo page shows after trial creation. */
export function embedSnippetFor(tenantId) {
  return '<script src="' + WIDGET_SCRIPT_ORIGIN + '/widget.js" data-tenant="' + tenantId + '" data-lang="auto" data-endpoint="' + ENDPOINT + '" defer></script>';
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function firstDayOfNextMonthUTC(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = new Date(Date.UTC(y, m + 1, 1));
  return d.toISOString().slice(0, 10);
}

function firstDayOfMonthUTC(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Turns whatever the status endpoint returned into one flat shape the page
 * renders from. Accepts the contract fields (conversations_used,
 * usage_percent, period_end, last_ingest) and the older ones
 * (used_this_month, last_ingested_at); anything missing becomes null.
 */
export function normaliseStatus(raw, now = new Date()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const quota = num(r.monthly_quota);
  let used = num(r.conversations_used);
  if (used === null) used = num(r.used_this_month);
  let percent = num(r.usage_percent);
  if (percent === null && used !== null && quota !== null && quota > 0) {
    percent = Math.round((used / quota) * 100);
  }
  if (percent !== null) percent = Math.max(0, Math.min(100, Math.round(percent)));
  const productCount = num(r.product_count);
  return {
    id: typeof r.id === 'string' ? r.id : '',
    domain: typeof r.domain === 'string' ? r.domain : '',
    plan: typeof r.plan === 'string' && r.plan ? r.plan.toLowerCase() : '',
    status: typeof r.status === 'string' ? r.status : '',
    quota,
    used,
    percent,
    periodStart: typeof r.period_start === 'string' && r.period_start ? r.period_start : firstDayOfMonthUTC(now),
    periodEnd: typeof r.period_end === 'string' && r.period_end ? r.period_end : firstDayOfNextMonthUTC(now),
    productCount,
    validUntil: typeof r.valid_until === 'string' && r.valid_until ? r.valid_until : null,
    lastIngest: (typeof r.last_ingest === 'string' && r.last_ingest) ? r.last_ingest : ((typeof r.last_ingested_at === 'string' && r.last_ingested_at) ? r.last_ingested_at : null),
  };
}

function localeFor(lang) {
  return lang === 'sk' ? 'sk-SK' : 'en-GB';
}

/** 1000 -> "1 000" (sk) / "1,000" (en); null -> "n/a". */
export function formatNumber(n, lang) {
  if (n === null || n === undefined || !Number.isFinite(n)) return t('usage.na', lang);
  try {
    return new Intl.NumberFormat(localeFor(lang)).format(n);
  } catch (e) {
    return String(n);
  }
}

/** "2026-10-01" -> "1. 10. 2026" (sk) / "1 October 2026" (en); unparseable -> "n/a". */
export function formatDate(iso, lang) {
  if (!iso) return t('usage.na', lang);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00Z' : iso);
  if (Number.isNaN(d.getTime())) return t('usage.na', lang);
  try {
    return new Intl.DateTimeFormat(localeFor(lang), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  } catch (e) {
    return iso.slice(0, 10);
  }
}

/** ISO timestamp -> local date and time; unparseable -> "n/a". */
export function formatDateTime(iso, lang) {
  if (!iso) return t('usage.na', lang);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t('usage.na', lang);
  try {
    return new Intl.DateTimeFormat(localeFor(lang), { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch (e) {
    return iso;
  }
}

export function planLabel(plan, lang) {
  if (!plan) return t('usage.na', lang);
  const key = 'plan.' + plan;
  const label = t(key, lang);
  return label === key ? plan : label;
}

export function statusLabel(status, lang) {
  if (!status) return t('usage.na', lang);
  const key = 'status.' + status;
  const label = t(key, lang);
  return label === key ? status : label;
}

/** Which of the two paid plans still make sense as an upgrade for `plan` ("current", "upgrade" or "lower"). */
export function planRelation(currentPlan, candidate) {
  if (currentPlan === candidate) return 'current';
  const cur = PLAN_RANK[currentPlan];
  const cand = PLAN_RANK[candidate];
  if (cur === undefined || cand === undefined) return 'upgrade';
  return cand > cur ? 'upgrade' : 'lower';
}

export function isPaidPlan(plan) {
  return plan === 'starter' || plan === 'pro';
}

// DOM (browser only)

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);

  function track(event, data) {
    try {
      if (window.umami && typeof window.umami.track === 'function') { window.umami.track(event, data || {}); return true; }
    } catch (e) {}
    return false;
  }

  /** umami.js loads with defer alongside this module; retry a few times so tenant_view is not lost on a fast page. */
  function trackWhenReady(event, data, tries) {
    if (track(event, data)) return;
    if (tries > 0) setTimeout(() => trackWhenReady(event, data, tries - 1), 700);
  }

  function copyToClipboard(text, btn) {
    const done = (ok) => {
      if (!btn) return;
      btn.textContent = ok ? t('embed.copied') : t('embed.copy');
      setTimeout(() => { btn.textContent = t('embed.copy'); }, 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done(true);
    } catch (e) {
      done(false);
    }
  }

  function showState(which) {
    ['state-loading', 'state-missing', 'state-notfound', 'state-network'].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = id !== which;
    });
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  const tenantId = tenantIdFromQuery(location.search);
  let data = null; // normalised status, once loaded
  let loadFailed = false;

  function renderStatic() {
    // Everything that only needs the id: embed code and upgrade links.
    const idInput = $('embed-id');
    if (idInput) idInput.value = tenantId;
    setText('embed-snippet', embedSnippetFor(tenantId));
    const live = $('embed-livedemo');
    if (live) live.href = '../live/?t=' + encodeURIComponent(tenantId);
    ['starter', 'pro'].forEach((plan) => {
      const a = $('btn-' + plan);
      if (a) a.href = upgradeUrl(plan, tenantId);
    });
  }

  function renderUsage() {
    const lang = getLang() || DEFAULT_LANG;
    const d = data || normaliseStatus({});
    setText('v-domain', d.domain || t('usage.na'));
    setText('v-plan', planLabel(d.plan, lang));
    setText('v-status', statusLabel(d.status, lang));
    const barText = tf('usage.bar', {
      used: formatNumber(d.used, lang),
      quota: formatNumber(d.quota, lang),
      percent: d.percent === null ? t('usage.na') : String(d.percent),
    });
    setText('v-bar-text', barText);
    const bar = $('v-bar');
    const fill = $('v-bar-fill');
    if (bar && fill) {
      const pct = d.percent === null ? 0 : d.percent;
      fill.style.width = pct + '%';
      bar.classList.toggle('warn', pct >= 80 && pct < 100);
      bar.classList.toggle('full', pct >= 100);
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuetext', barText);
    }
    setText('v-period-end', formatDate(d.periodEnd, lang));
    setText('v-products', formatNumber(d.productCount, lang));
    setText('v-last-ingest', formatDateTime(d.lastIngest, lang));
    const validRow = $('row-valid-until');
    if (validRow) {
      validRow.hidden = !d.validUntil;
      setText('v-valid-until', formatDate(d.validUntil, lang));
    }
  }

  function renderPlans() {
    const plan = data ? data.plan : '';
    ['starter', 'pro'].forEach((candidate) => {
      const relation = plan ? planRelation(plan, candidate) : 'upgrade';
      const btn = $('btn-' + candidate);
      const current = $('current-' + candidate);
      const lower = $('lower-' + candidate);
      if (btn) btn.hidden = relation !== 'upgrade';
      if (current) current.hidden = relation !== 'current';
      if (lower) lower.hidden = relation !== 'lower';
    });
    const manage = $('manage');
    if (manage) manage.hidden = !isPaidPlan(plan);
    const note = $('upgrade-note');
    if (note) note.hidden = plan === 'pro';
  }

  function renderAll() {
    renderUsage();
    renderPlans();
  }

  function load() {
    showState('state-loading');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    fetch(ENDPOINT + '/v1/tenants/' + encodeURIComponent(tenantId) + '/status', { signal: controller ? controller.signal : undefined })
      .then((res) => {
        if (res.status === 404) return { notFound: true };
        if (!res.ok) throw new Error('status_' + res.status);
        return res.json().then((json) => ({ json }));
      })
      .then((result) => {
        if (timer) clearTimeout(timer);
        if (result.notFound) {
          showState('state-notfound');
          const sections = $('sections');
          if (sections) sections.hidden = true;
          trackWhenReady('tenant_view', { result: 'not_found' }, 3);
          return;
        }
        data = normaliseStatus(result.json);
        showState(null);
        renderAll();
        trackWhenReady('tenant_view', { plan: data.plan || 'unknown', status: data.status || 'unknown' }, 3);
      })
      .catch(() => {
        if (timer) clearTimeout(timer);
        loadFailed = true;
        showState('state-network');
        renderAll(); // n/a everywhere, embed and upgrade still usable
        trackWhenReady('tenant_view', { result: 'network_error' }, 3);
      });
  }

  function boot() {
    const sections = $('sections');
    if (!tenantId) {
      showState('state-missing');
      if (sections) sections.hidden = true;
      trackWhenReady('tenant_view', { result: 'missing_id' }, 3);
      return;
    }
    renderStatic();
    renderPlans();
    const copyId = $('embed-copy-id');
    const copySnippet = $('embed-copy-snippet');
    if (copyId) copyId.addEventListener('click', () => copyToClipboard(tenantId, copyId));
    if (copySnippet) copySnippet.addEventListener('click', () => copyToClipboard(embedSnippetFor(tenantId), copySnippet));
    ['starter', 'pro'].forEach((plan) => {
      const a = $('btn-' + plan);
      if (a) a.addEventListener('click', () => track('upgrade_click', { plan, place: 'tenant' }));
    });
    document.addEventListener('arling:langchange', () => { if (data || loadFailed) renderAll(); });
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
