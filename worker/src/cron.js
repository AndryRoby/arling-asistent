/*
 * cron.js
 *
 * Scheduled handler (wrangler.toml [triggers] crons), two schedules:
 *
 *   "0 3 * * *"     Refreshes product feeds (active shops daily, the rest on
 *                   Sundays, from the separate refresh budget, see
 *                   refreshAllFeeds):
 *                   re-downloads the feed, re-embeds, and re-upserts into
 *                   Vectorize (Vectorize upsert overwrites vectors with the
 *                   same id, so this naturally handles price/availability/
 *                   description changes without needing a separate delete
 *                   pass for unchanged products). Then the daily lifecycle
 *                   upkeep (zivotny-cyklus.js dennaUdrzba: old events, and
 *                   only with ASISTENT_MAZANIE = "zapnute" unused free accounts).
 *   "*\/10 * * * *" Lifecycle catch-up every 10 minutes (zivotny-cyklus.js
 *                   dobeh): unsent e-mails, delayed E0 and WordPress E1, E2,
 *                   the 72-hour E3, and the "aktivny" event.
 */

import { listTenants, aktivneTenantyOd, dayKey } from './tenants.js';
import { ingestFeedForTenant } from './onboarding.js';
import { dobeh, dennaUdrzba } from './zivotny-cyklus.js';
import { hasObnovaBudget } from './budget.js';
import { zmazStare } from './pocty.js';

export const CRON_DENNY = '0 3 * * *';
export const CRON_DOBEH = '*/10 * * * *';

/** Obchod bez rozhovoru za toľko dní a starší ako toľko dní sa obnovuje len raz týždenne (plán 2.2 bod 8). */
export const AKTIVNY_DNI = 30;
/** UTC deň týždňa (0 = nedeľa), keď sa obnovia aj neaktívne obchody. */
export const TYZDENNA_OBNOVA_DEN = 0;

function posun(now, dni) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - dni);
  return d;
}

/**
 * Obnoví feedy. Denne len obchody s rozhovorom za posledných 30 dní alebo
 * založené za posledných 30 dní, ostatné raz týždenne (nedeľa UTC). Každé
 * načítanie ide z vlastného rozpočtu obnovy (budget.js AI_DAILY_OBNOVA_BUDGET),
 * nie zo spoločného stropu chatu (nález 8 kontroly kroku 1: štyri cudzie
 * feedy po 5 000 produktov zhodili chat všetkým každú noc). Keď sa rozpočet
 * minie, ostatné obchody sa preskočia bez zmeny stavu a prídu na rad zajtra.
 * Returns a per-tenant outcome array (used in logs/tests).
 */
export async function refreshAllFeeds(env, { now = new Date() } = {}) {
  const tenants = await listTenants(env.DB);
  const hranica = posun(now, AKTIVNY_DNI);
  let aktivne = null;
  try {
    aktivne = await aktivneTenantyOd(env.DB, dayKey(hranica));
  } catch (err) {
    console.warn('[arling-asistent] zoznam aktivnych obchodov zlyhal, obnovujem vsetky:', (err && err.message) || err);
  }
  const tyzdenna = now.getUTCDay() === TYZDENNA_OBNOVA_DEN;
  const outcomes = [];
  for (const tenant of tenants) {
    const novy = tenant.created_at && new Date(tenant.created_at).getTime() >= hranica.getTime();
    if (aktivne && !tyzdenna && !novy && !aktivne.has(tenant.id)) {
      outcomes.push({ tenantId: tenant.id, ok: false, preskocene: 'neaktivny' });
      continue;
    }
    // Rozpočet vždy za skutočný dnešok: tam zapisuje aj načítanie (onboarding.js spendObnova).
    const rozpocet = await hasObnovaBudget(env, 0);
    if (!rozpocet.ok || rozpocet.remaining <= 0) {
      outcomes.push({ tenantId: tenant.id, ok: false, preskocene: 'rozpocet_obnovy' });
      continue;
    }
    try {
      const result = await ingestFeedForTenant(env, tenant);
      outcomes.push({ tenantId: tenant.id, ...result });
    } catch (err) {
      outcomes.push({ tenantId: tenant.id, ok: false, error: String((err && err.message) || err) });
    }
  }
  return outcomes;
}

async function dennyBeh(env) {
  const outcomes = await refreshAllFeeds(env);
  await dennaUdrzba(env);
  // Denné počítadlá ochrany (pocty.js) starších dní preč: v D1 nič navyše.
  try {
    await zmazStare(env.DB, dayKey(new Date()));
  } catch (err) {
    console.warn('[arling-asistent] mazanie starych pocitadiel zlyhalo:', (err && err.message) || err);
  }
  return outcomes;
}

export default {
  async scheduled(event, env, ctx) {
    // Starý jediný spúšťač nemal event.cron porovnávaný vôbec; čokoľvek iné
    // než 10-minútový beh je preto denný beh, ako doteraz.
    if (event && event.cron === CRON_DOBEH) {
      ctx.waitUntil(dobeh(env));
      return;
    }
    ctx.waitUntil(dennyBeh(env));
  },
};
