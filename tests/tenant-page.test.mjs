// Tests for the per-tenant usage/upgrade page (demo/tenant/) and for the
// demo landing page texts that describe billing. Both tenant modules guard
// their DOM code behind `typeof document`, so they import under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as I18N from '../demo/tenant/i18n.js';
import * as TENANT from '../demo/tenant/tenant.js';
import * as DEMO_I18N from '../demo/i18n.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const EM_DASH = '—';
const ALLBIRDS = '8d9a6783-7ef9-4790-a63b-c52752face6b';

// ---------------------------------------------------------------- i18n

test('tenant i18n: every key has sk and en, no em-dashes, no emoji', () => {
  assert.deepEqual(I18N.findIncompleteEntries(), []);
  for (const [key, entry] of Object.entries(I18N.DICT)) {
    for (const lang of I18N.LANGS) {
      assert.ok(!entry[lang].includes(EM_DASH), `${key}.${lang} contains an em-dash`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(entry[lang]), `${key}.${lang} contains an emoji`);
    }
  }
});

test('tenant i18n: t() falls back visibly and tf() fills placeholders', () => {
  assert.equal(I18N.t('no.such.key', 'sk'), 'no.such.key');
  assert.equal(I18N.t('plan.pro', 'sk'), 'Pro');
  assert.equal(I18N.tf('usage.bar', { used: '122', quota: '1 000', percent: 12 }, 'sk'), '122 z 1 000 rozhovorov tento mesiac (12 %)');
  assert.equal(I18N.tf('usage.bar', { used: '122', quota: '1,000', percent: 12 }, 'en'), '122 of 1,000 conversations this month (12 %)');
});

test('tenant i18n: language resolution (query, locale)', () => {
  assert.equal(I18N.langFromQueryString('?t=abc&lang=sk'), 'sk');
  assert.equal(I18N.langFromQueryString('?lang=de'), null);
  assert.equal(I18N.langFromLocale('sk-SK'), 'sk');
  assert.equal(I18N.langFromLocale('cs-CZ'), 'sk');
  assert.equal(I18N.langFromLocale('de-DE'), 'en');
  assert.ok(I18N.LANGS.includes(I18N.detectLang())); // Node 22 exposes navigator.language, so only the range is fixed
});

// -------------------------------------------------------------- helpers

test('tenantIdFromQuery keeps only id characters', () => {
  assert.equal(TENANT.tenantIdFromQuery(`?t=${ALLBIRDS}`), ALLBIRDS);
  assert.equal(TENANT.tenantIdFromQuery('?t=<script>alert(1)</script>'), 'scriptalert1script');
  assert.equal(TENANT.tenantIdFromQuery('?lang=sk'), '');
  assert.equal(TENANT.tenantIdFromQuery(''), '');
});

test('upgradeUrl appends client_reference_id to the right Payment Link', () => {
  assert.equal(TENANT.upgradeUrl('starter', ALLBIRDS), `https://buy.stripe.com/5kQcMZ1fA6tZaoWaOh4ko03?client_reference_id=${ALLBIRDS}`);
  assert.equal(TENANT.upgradeUrl('pro', ALLBIRDS), `https://buy.stripe.com/14AdR30bw05BgNk3lP4ko04?client_reference_id=${ALLBIRDS}`);
  assert.equal(TENANT.upgradeUrl('pro', 'a b'), 'https://buy.stripe.com/14AdR30bw05BgNk3lP4ko04?client_reference_id=a%20b');
  assert.equal(TENANT.upgradeUrl('free', ALLBIRDS), '');
  assert.equal(TENANT.upgradeUrl('starter', ''), '');
});

test('embedSnippetFor matches the demo snippet shape', () => {
  const s = TENANT.embedSnippetFor(ALLBIRDS);
  assert.ok(s.startsWith('<script src="https://arling-asistent.arling.workers.dev/widget.js"'));
  assert.ok(s.includes(`data-tenant="${ALLBIRDS}"`));
  assert.ok(s.includes('data-lang="auto"'));
  assert.ok(s.includes('data-endpoint="https://arling-asistent.arling.workers.dev"'));
  assert.ok(s.endsWith('defer></script>'));
});

test('normaliseStatus reads the contract shape', () => {
  const d = TENANT.normaliseStatus({
    id: ALLBIRDS, domain: 'allbirds.com', plan: 'starter', status: 'ready',
    monthly_quota: 1000, conversations_used: 122, usage_percent: 12,
    period_start: '2026-09-01', period_end: '2026-10-01', product_count: 294,
    valid_until: '2026-10-10', last_ingest: '2026-09-05T08:00:05.564Z',
  });
  assert.equal(d.domain, 'allbirds.com');
  assert.equal(d.plan, 'starter');
  assert.equal(d.quota, 1000);
  assert.equal(d.used, 122);
  assert.equal(d.percent, 12);
  assert.equal(d.periodEnd, '2026-10-01');
  assert.equal(d.productCount, 294);
  assert.equal(d.validUntil, '2026-10-10');
  assert.equal(d.lastIngest, '2026-09-05T08:00:05.564Z');
});

test('normaliseStatus degrades gracefully on the older shape and on garbage', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const old = TENANT.normaliseStatus({ id: ALLBIRDS, domain: 'arling.sk', plan: 'trial', status: 'ready', monthly_quota: 1000, used_this_month: 122, product_count: 294, last_ingested_at: '2026-09-05T08:00:05.564Z', billing_ref: null, valid_until: null }, now);
  assert.equal(old.used, 122, 'used_this_month is the fallback for conversations_used');
  assert.equal(old.percent, 12, 'usage_percent is computed when missing');
  assert.equal(old.periodStart, '2026-09-01');
  assert.equal(old.periodEnd, '2026-10-01', 'period end falls back to the first day of next month (UTC)');
  assert.equal(old.lastIngest, '2026-09-05T08:00:05.564Z');
  assert.equal(old.validUntil, null);
  assert.equal(old.plan, 'trial');

  const dec = TENANT.normaliseStatus({}, new Date('2026-12-31T23:59:59Z'));
  assert.equal(dec.periodEnd, '2027-01-01');

  const empty = TENANT.normaliseStatus({});
  assert.equal(empty.used, null);
  assert.equal(empty.quota, null);
  assert.equal(empty.percent, null);
  assert.equal(empty.productCount, null);
  assert.equal(empty.lastIngest, null);
  assert.equal(empty.domain, '');
  assert.equal(empty.plan, '');

  assert.doesNotThrow(() => TENANT.normaliseStatus(null));
  assert.doesNotThrow(() => TENANT.normaliseStatus('nope'));
  assert.doesNotThrow(() => TENANT.normaliseStatus({ monthly_quota: 'x', conversations_used: {} }));

  const over = TENANT.normaliseStatus({ monthly_quota: 100, conversations_used: 250, usage_percent: 250 });
  assert.equal(over.percent, 100, 'percent is clamped to 0..100');
  const strings = TENANT.normaliseStatus({ monthly_quota: '100', conversations_used: '80' });
  assert.equal(strings.percent, 80, 'numeric strings are accepted');
});

test('formatting: n/a for missing values, locale-aware otherwise', () => {
  assert.equal(TENANT.formatNumber(null, 'sk'), 'n/a');
  assert.equal(TENANT.formatNumber(1000, 'en'), '1,000');
  assert.match(TENANT.formatNumber(1000, 'sk'), /^1[\s  ]000$/);
  assert.equal(TENANT.formatDate(null, 'en'), 'n/a');
  assert.equal(TENANT.formatDate('not-a-date', 'en'), 'n/a');
  assert.equal(TENANT.formatDate('2026-10-01', 'en'), '1 October 2026');
  assert.match(TENANT.formatDate('2026-10-01', 'sk'), /2026/);
  assert.equal(TENANT.formatDateTime(null, 'sk'), 'n/a');
  assert.match(TENANT.formatDateTime('2026-09-05T08:00:05.564Z', 'en'), /2026/);
});

test('plan and status labels, plan relations, paid plans', () => {
  assert.equal(TENANT.planLabel('free', 'en'), 'Free');
  assert.equal(TENANT.planLabel('trial', 'sk'), 'Skúšobný');
  assert.equal(TENANT.planLabel('enterprise', 'en'), 'enterprise', 'unknown plan shows as-is');
  assert.equal(TENANT.planLabel('', 'en'), 'n/a');
  assert.equal(TENANT.statusLabel('ready', 'sk'), 'pripravený');
  assert.equal(TENANT.statusLabel('weird', 'sk'), 'weird');

  assert.equal(TENANT.planRelation('free', 'starter'), 'upgrade');
  assert.equal(TENANT.planRelation('free', 'pro'), 'upgrade');
  assert.equal(TENANT.planRelation('trial', 'starter'), 'upgrade');
  assert.equal(TENANT.planRelation('starter', 'starter'), 'current');
  assert.equal(TENANT.planRelation('starter', 'pro'), 'upgrade');
  assert.equal(TENANT.planRelation('pro', 'pro'), 'current');
  assert.equal(TENANT.planRelation('pro', 'starter'), 'lower');
  assert.equal(TENANT.planRelation('mystery', 'pro'), 'upgrade');

  assert.equal(TENANT.isPaidPlan('starter'), true);
  assert.equal(TENANT.isPaidPlan('pro'), true);
  assert.equal(TENANT.isPaidPlan('free'), false);
  assert.equal(TENANT.isPaidPlan('trial'), false);
});

test('PLAN_QUOTAS mirrors DEFAULT_QUOTAS in the worker', async () => {
  const { DEFAULT_QUOTAS } = await import('../worker/src/tenants.js');
  assert.deepEqual(TENANT.PLAN_QUOTAS, DEFAULT_QUOTAS);
});

// ----------------------------------------------------------- tenant html

test('tenant/index.html: noindex, i18n hooks, both Payment Links, Umami, no em-dash', () => {
  const html = read('demo/tenant/index.html');
  assert.ok(html.includes('<meta name="robots" content="noindex, nofollow" />'));
  assert.ok(html.includes('data-i18n="hero.h1"'));
  assert.ok(html.includes('id="btn-starter"') && html.includes('https://buy.stripe.com/5kQcMZ1fA6tZaoWaOh4ko03'));
  assert.ok(html.includes('id="btn-pro"') && html.includes('https://buy.stripe.com/14AdR30bw05BgNk3lP4ko04'));
  assert.ok(html.includes('data-umami-event="upgrade_click"'));
  assert.ok(html.includes('data-website-id="09cc54da-8172-43b3-8aa2-84e3ab5a17f1"'));
  assert.ok(html.includes('id="state-missing"') && html.includes('id="state-notfound"') && html.includes('id="state-network"'));
  assert.ok(html.includes('id="manage"'));
  assert.ok(!html.includes(EM_DASH), 'no em-dash in tenant page');
  assert.ok(!html.includes('Vložte pred </body>'), 'literal </body> inside a paragraph would break the page');
  for (const key of [...html.matchAll(/data-i18n(?:-html|-aria-label)?="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(I18N.DICT[key], `data-i18n key ${key} missing from tenant DICT`);
  }
});

// ------------------------------------------------------- demo page texts

test('demo texts: Stripe upgrade is live via the tenant page, plugin status is current', () => {
  const html = read('demo/index.html');
  const i18n = read('demo/i18n.js');
  const app = read('demo/app.js');
  const llms = read('demo/llms.txt');

  for (const [name, s] of [['index.html', html], ['i18n.js', i18n], ['llms.txt', llms]]) {
    assert.ok(!s.includes('napojenie na Stripe je v príprave'), `${name}: stale Stripe text (sk)`);
    assert.ok(!s.includes('Stripe wiring is in preparation'), `${name}: stale Stripe text (en)`);
    assert.ok(!s.includes('is not wired up yet'), `${name}: stale Stripe text`);
    assert.ok(!s.includes('data-stripe-link'), `${name}: pricing buttons no longer carry Stripe links`);
    assert.ok(!s.includes('Coming soon') && !s.includes('Čoskoro'), `${name}: no "coming soon" button`);
  }
  assert.ok(!app.includes('data-stripe-link') && !app.includes('cta.comingSoon'));
  assert.ok(html.includes('id="trial-tenant-link"'), 'embed block links to the tenant page');
  assert.ok(app.includes("'tenant/?t=' + encodeURIComponent(tenantId)"), 'app.js fills the tenant page link');
  assert.ok(html.includes('id="btn-plan-starter" href="#playground"') && html.includes('id="btn-plan-pro" href="#playground"'), 'paid plan buttons lead to the trial form');
  assert.ok(html.includes('wordpress.org a čaká na schválenie'), 'FAQ (sk) says the plugin awaits wordpress.org review');
  assert.ok(i18n.includes('submitted to wordpress.org and is awaiting review'), 'FAQ (en) says the plugin awaits wordpress.org review');
  assert.ok(html.includes('"name": "Pro", "price": "39"'), 'JSON-LD offer is named Pro like the plan id');
  assert.deepEqual(DEMO_I18N.findIncompleteEntries(), []);
  assert.equal(DEMO_I18N.t('s3.embed.tenantPage', 'en'), 'Usage and upgrade:');
  assert.match(DEMO_I18N.t('faq.billing.a', 'sk'), /Starter \(19 € mesačne, do 1 000 rozhovorov\)/);
  assert.match(DEMO_I18N.t('s2.note', 'en'), /Starter \(19 EUR a month, up to 1,000 conversations\) or Pro \(39 EUR a month, up to 3,000\)/);
  for (const [key, entry] of Object.entries(DEMO_I18N.DICT)) {
    assert.ok(!entry.sk.includes(EM_DASH) && !entry.en.includes(EM_DASH), `${key} contains an em-dash`);
  }
  for (const key of [...html.matchAll(/data-i18n(?:-html|-placeholder|-aria-label)?="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(DEMO_I18N.DICT[key], `data-i18n key ${key} missing from demo DICT`);
  }
});
