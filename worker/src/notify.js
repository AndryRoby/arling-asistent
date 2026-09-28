/*
 * notify.js
 *
 * Owner-facing quota notifications. When a tenant's monthly usage crosses
 * 80 % and then 100 % of monthly_quota, the worker pings the homelab
 * subscribe service (products/subscribe-service/app.py, events quota_80 and
 * quota_100 in PING_EVENTS), which turns it into an ntfy line for the owner:
 *
 *   GET {QUOTA_PING_URL}?e=quota_80|quota_100&t={tenantId}&p={usage_percent}
 *
 * Each threshold fires once per tenant per calendar month, remembered in
 * the KV key quota-notified:{tenant}:{YYYY-MM}:{80|100} (ASISTENT_CACHE).
 * Nothing here can fail the chat request: chat.js schedules it with
 * ctx.waitUntil, every error is swallowed, and a KV read failure errs on the
 * side of pinging (a duplicate line in ntfy beats a missed warning).
 *
 * E-mail to the tenant is deliberately out of scope here.
 */

import { monthKey, usagePercent } from './tenants.js';
import { pripocitaj, rezervuj, kluce } from './pocty.js';

export const DEFAULT_QUOTA_PING_URL = 'https://server.invalid/subscribe/api/ping';
export const QUOTA_THRESHOLDS = [80, 100];
// KV reminder lives a little longer than the longest month, so the "already
// notified" marker cannot expire mid-month; the key name carries the month,
// so a stale marker from last month never suppresses this month's ping.
export const QUOTA_NOTIFIED_TTL_SECONDS = 40 * 24 * 60 * 60;

export function quotaNotifiedKey(tenantId, month, threshold) {
  return `quota-notified:${tenantId}:${month}:${threshold}`;
}

/**
 * Which of QUOTA_THRESHOLDS did the counter cross when it moved from
 * `usedBefore` to `usedAfter` out of `quota`? A threshold counts as crossed
 * when the percentage was below it before and at or above it after, so a
 * single jump (e.g. an admin lowering the quota under the current usage)
 * can return both 80 and 100 at once, in ascending order.
 */
export function thresholdsCrossed(usedBefore, usedAfter, quota) {
  const before = usagePercent(usedBefore, quota);
  const after = usagePercent(usedAfter, quota);
  return QUOTA_THRESHOLDS.filter((t) => before < t && after >= t);
}

export function buildQuotaPingUrl(baseUrl, { event, tenantId, percent }) {
  const url = new URL(baseUrl);
  url.searchParams.set('e', event);
  url.searchParams.set('t', tenantId);
  url.searchParams.set('p', String(percent));
  return url.toString();
}

/**
 * The same ping shape without a percentage, for one-off events that are not
 * about a quota. Used by the paid SEPA file check (src/upload.js): when a
 * customer uploads their file, Andrej has 24 hours of promised work waiting,
 * so he needs to know immediately rather than by checking the bucket.
 */
export function buildEventPingUrl(baseUrl, { event, tenantId }) {
  const url = new URL(baseUrl);
  url.searchParams.set('e', event);
  url.searchParams.set('t', tenantId);
  return url.toString();
}

// Underscore like every other event name subscribe-service knows.
export const KONTROLA_UPLOAD_EVENT = 'kontrola_upload';

/**
 * Hlavičky pingu.
 *
 * Služba na homelabe (products/subscribe-service/app.py, ping_token_ok)
 * pýta pri udalostiach quota_80, quota_100 a kontrola_upload tajomstvo v
 * hlavičke X-Ping-Token. Worker ho dovtedy neposielal vôbec: v deň, keď sa
 * na homelabe nastaví PING_TOKEN, by každý ping skončil na 403 a majiteľ by
 * sa o zaplatenej kontrole za 149 € nedozvedel. Kým tajomstvo nastavené nie
 * je, ping ide ako doteraz bez hlavičky.
 */
function pingHeaders(env) {
  const token = env && env.PING_TOKEN;
  return token ? { 'X-Ping-Token': token } : {};
}

/**
 * Ping the owner that a paid file check has arrived, with the Stripe
 * Checkout Session id as the tenant field (that id is what identifies the
 * order everywhere else: the R2 prefix, the Stripe dashboard, the e-mail).
 *
 * Resolves to true only if the ping actually went out; never rejects, so
 * upload.js can fire it without a try/catch and the upload cannot fail
 * because of a notification.
 */
export async function notifyKontrolaUpload(env, { sessionId, test = false } = {}) {
  try {
    const baseUrl = env && env.QUOTA_PING_URL !== undefined ? env.QUOTA_PING_URL : DEFAULT_QUOTA_PING_URL;
    if (!baseUrl || !sessionId) return false;
    const fetchImpl = (env && env.fetchImpl) || fetch;
    // Skúška majiteľa testovacou kartou musí byť v ntfy na prvý pohľad
    // odlíšiteľná od zaplatenej objednávky za 149 €. Malé písmená zámerne:
    // subscribe-service z parametra t vyhadzuje všetko okrem a-z, 0-9 a
    // spojovníka, takže veľké TEST by z názvu ticho zmizlo.
    const znacka = test ? `test-${sessionId}` : sessionId;
    const res = await fetchImpl(buildEventPingUrl(baseUrl, { event: KONTROLA_UPLOAD_EVENT, tenantId: znacka }), {
      method: 'GET',
      headers: pingHeaders(env),
    });
    // Odpoveď 403 (chýbajúce tajomstvo) alebo 5xx znamená, že sa majiteľ o
    // zaplatenej kontrole nedozvedel. Vrátiť true by bola predstieraná
    // funkcia, hoci samotné nahratie súboru zlyhať nesmie.
    if (res && res.ok === false) {
      console.warn(`[arling-asistent] kontrola_upload ping for ${sessionId} returned HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[arling-asistent] kontrola_upload ping failed:', (err && err.message) || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Výstrahy ochrany pre Fable (plán 2.2 bod 7, krok 1)
//
//   naklady_den   dnešná spotreba neurónov prekročila prah (budget.js prahNakladyDen), p = % stropu
//   obchod_marza  platiaci obchod dnes minul na AI viac ako 50 % denného čistého príjmu, p = %
//   zneuzitie     obchod narazil na denný limit IP, strop nových rozhovorov alebo na denný strop otázok, p = 0
//   ai_vypadok    aspoň 10 chýb modelu v tej istej hodine (UTC), raz za hodinu, p = počet chýb
//
// Rovnaký tvar pingu ako quota_80 (?e=&t=&p=), rovnaká hlavička X-Ping-Token.
// Titulky v ntfy pridá Fable v products/subscribe-service (PING_EVENTS); kým
// ich služba nepozná, ostáva vypínač ASISTENT_NTFY_OCHRANA na "vypnute"
// (wrangler.toml) a nič sa neposiela. Titulok nikdy nesmie znieť ako platba.
// Každá výstraha ide najviac raz za `kluc` (deň, obchod a deň, hodina),
// značka atomicky v D1 (pocty.js). Nikdy nič nezhodí, nikdy nič neodmietne.
// ---------------------------------------------------------------------------

export const OCHRANA_UDALOSTI = ['naklady_den', 'obchod_marza', 'zneuzitie', 'ai_vypadok'];
export const AI_VYPADOK_PRAH_ZA_HODINU = 10;

export function ochranaZapnuta(env) {
  return Boolean(env && env.ASISTENT_NTFY_OCHRANA === 'zapnute');
}

/**
 * Pošle jednu výstrahu ochrany, najviac raz za (udalosť, kluc). Vracia true,
 * len keď ping naozaj odišiel s odpoveďou ok.
 */
export async function pingOchrana(env, { event, tenantId = 'asistent', percent = 0, kluc = '', now = new Date() } = {}) {
  try {
    if (!ochranaZapnuta(env) || !OCHRANA_UDALOSTI.includes(event)) return false;
    const baseUrl = env.QUOTA_PING_URL !== undefined ? env.QUOTA_PING_URL : DEFAULT_QUOTA_PING_URL;
    if (!baseUrl) return false;
    // Značka „už poslané“ sa zaberá ATOMICKY v D1 (tretie kolo, nález 6):
    // predtým KV get a potom put, takže dávka 25 požiadaviek poslala 25 pingov
    // a pri chybe KV sa pingalo aj tak. Bez D1 alebo pri jej chybe sa nepinga:
    // radšej jedna chýbajúca výstraha ako záplava ntfy počas útoku.
    const db = env.DB;
    if (!db) return false;
    const den = now.toISOString().slice(0, 10);
    const prva = await rezervuj(db, kluce.znacka(event, kluc || tenantId), den, 1, 1);
    if (prva == null) return false;
    const fetchImpl = env.fetchImpl || fetch;
    const res = await fetchImpl(buildQuotaPingUrl(baseUrl, { event, tenantId, percent: Math.max(0, Math.round(Number(percent) || 0)) }), {
      method: 'GET',
      headers: pingHeaders(env),
    });
    if (res && res.ok === false) {
      console.warn(`[arling-asistent] ochrana ping ${event} vratil HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[arling-asistent] ochrana ping zlyhal:', (err && err.message) || err);
    return false;
  }
}

/**
 * Započíta chybu modelu do hodinového počítadla a od
 * AI_VYPADOK_PRAH_ZA_HODINU-tej chyby pošle ai_vypadok, najviac raz za hodinu.
 * Vracia počet chýb v hodine.
 *
 * Počítadlo je atomické v D1 (pocty.js), nie v KV (nález 9 kontroly kroku 1):
 * pri skutočnom výpadku prídu chyby naraz, KV z 20 súbežných uložilo 1 a prah
 * `=== 10` sa nedosiahol. Teraz `>= 10` a značka hodiny sa zaberá atomicky.
 */
export async function zaznamenajChybuAI(env, { now = new Date() } = {}) {
  try {
    const db = env && env.DB;
    if (!db) return 0;
    const hodina = now.toISOString().slice(0, 13);
    const den = hodina.slice(0, 10);
    const pocet = await pripocitaj(db, kluce.aiChyby(hodina), den, 1);
    if (pocet >= AI_VYPADOK_PRAH_ZA_HODINU) {
      // Značku hodiny zaberá atomicky pingOchrana (kľúč znacka:ai_vypadok:<hodina>).
      await pingOchrana(env, { event: 'ai_vypadok', tenantId: 'asistent', percent: pocet, kluc: hodina, now });
    }
    return pocet;
  } catch (err) {
    console.warn('[arling-asistent] pocitadlo chyb AI zlyhalo:', (err && err.message) || err);
    return 0;
  }
}

/**
 * Fire the quota_80 / quota_100 pings that `usedBefore` -> `usedAfter` just
 * crossed, once per tenant per month. Resolves to the list of events that
 * were actually sent (for logging and tests); never rejects.
 *
 * `env` needs ASISTENT_CACHE (KV) and may carry QUOTA_PING_URL (an empty
 * string disables pinging entirely) and fetchImpl (tests). Threshold
 * markers are written before the ping goes out, so two concurrent requests
 * crossing the same threshold at the same moment race only on KV, the same
 * best-effort behaviour as the rate limiter, never on the counter itself.
 */
export async function maybeNotifyQuota(env, { tenantId, usedBefore, usedAfter, quota, now = new Date() } = {}) {
  const sent = [];
  try {
    const baseUrl = env && env.QUOTA_PING_URL !== undefined ? env.QUOTA_PING_URL : DEFAULT_QUOTA_PING_URL;
    if (!baseUrl || !tenantId) return sent;

    const crossed = thresholdsCrossed(usedBefore, usedAfter, quota);
    if (crossed.length === 0) return sent;

    const kv = env.ASISTENT_CACHE;
    const fetchImpl = env.fetchImpl || fetch;
    const month = monthKey(now);
    const percent = usagePercent(usedAfter, quota);

    for (const threshold of crossed) {
      const key = quotaNotifiedKey(tenantId, month, threshold);
      let alreadyNotified = false;
      if (kv) {
        try {
          alreadyNotified = (await kv.get(key)) != null;
        } catch (err) {
          console.warn('[arling-asistent] quota-notified KV get failed, pinging anyway:', (err && err.message) || err);
        }
      }
      if (alreadyNotified) continue;

      if (kv) {
        try {
          await kv.put(key, now.toISOString(), { expirationTtl: QUOTA_NOTIFIED_TTL_SECONDS });
        } catch (err) {
          console.warn('[arling-asistent] quota-notified KV put failed:', (err && err.message) || err);
        }
      }

      const event = `quota_${threshold}`;
      try {
        const res = await fetchImpl(buildQuotaPingUrl(baseUrl, { event, tenantId, percent }), { method: 'GET', headers: pingHeaders(env) });
        if (res && res.ok === false) {
          console.warn(`[arling-asistent] quota ping ${event} for ${tenantId} returned HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(`[arling-asistent] quota ping ${event} for ${tenantId} failed:`, (err && err.message) || err);
      }
      sent.push(event);
    }
  } catch (err) {
    console.warn('[arling-asistent] quota notification failed:', (err && err.message) || err);
  }
  return sent;
}
