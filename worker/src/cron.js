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
 *                   pass for unchanged products; vektory produktov, ktoré z
 *                   feedu zmizli, maže onboarding.js po každom úspešnom
 *                   načítaní). Pred obnovou beží denná údržba
 *                   (zivotny-cyklus.js dennaUdrzba: old events, and only with
 *                   ASISTENT_MAZANIE = "zapnute" unused free accounts), aby ju
 *                   dlhá alebo zlyhaná obnova nikdy nezastavila.
 *   "*\/10 * * * *" Lifecycle catch-up every 10 minutes (zivotny-cyklus.js
 *                   dobeh): unsent e-mails, delayed E0 and WordPress E1, E2,
 *                   the 72-hour E3, and the "aktivny" event.
 */

import { listTenants, aktivneTenantyOd, dayKey, publicPlanName } from './tenants.js';
import { ingestFeedForTenant, readIngestError, readIngestLimit, INGEST_ERRORS, TENANT_STATUS } from './onboarding.js';
import { dobeh, dennaUdrzba, jeDemo } from './zivotny-cyklus.js';
import { hasObnovaBudget, jeOslovenieTenant } from './budget.js';
import { zmazStare } from './pocty.js';

export const CRON_DENNY = '0 3 * * *';
export const CRON_DOBEH = '*/10 * * * *';

/** Obchod bez rozhovoru za toľko dní a starší ako toľko dní sa obnovuje len raz týždenne (plán 2.2 bod 8). */
export const AKTIVNY_DNI = 30;
/** UTC deň týždňa (0 = nedeľa), keď sa obnovia aj neaktívne obchody. */
export const TYZDENNA_OBNOVA_DEN = 0;

/**
 * Celkový čas nočnej obnovy (druhé kolo bezpečnostnej kontroly 29. 9. 2026,
 * nález 4c): každý feed smie trvať 20 s (60 s pri stránkovaní) a obchodov
 * vie založiť ktokoľvek desať za hodinu, takže bez stropu by beh narazil na
 * limit Cloudflare a ostatné obchody by sa neobnovili. Po tomto čase sa nové
 * načítanie nezačne (preskocene: 'cas'), zvyšok príde na rad zajtra. Pod 15
 * minútami, ktoré Cloudflare dáva plánovanému behu, s rezervou na jedno
 * rozbehnuté načítanie.
 */
export const CRON_CAS_SPOLU_MS = 10 * 60 * 1000;
/** Zvyšok denného rozpočtu obnovy ostáva samoobslužným registráciám. */
export const CRON_PODIEL_OBNOVY = 0.7;

/**
 * Poradie obnovy: najprv platiace obchody, potom bežiace obchody zákazníkov,
 * potom bežiace ukážky (oslovenia, demo), potom obchody, ktoré ešte nikdy
 * nebežali, a úplne na konci tie, ktorých samoobslužné načítanie sa odložilo
 * pre rozpočet (kód ai_budget_exhausted). Nález 5 druhého kola: odložené
 * obchody (typicky obrovské cudzie feedy) sa predtým načítali v poradí z D1
 * a minuli rozpočet obnovy skôr, než prišli na rad noví zákazníci za nimi.
 * V skupine bežiacich zákazníkov majú prednosť skutočné rozhovory. Posledný
 * časový, CPU alebo veľkostný strop presúva obchod na koniec.
 */
async function skupinaObnovy(env, tenant) {
  const chyba = await readIngestError(env, tenant.id);
  if (await readIngestLimit(env, tenant.id)
    || /^(feed_timeout|feed_too_large|cpu_limit)$/.test(chyba || '')) return 5;
  if (publicPlanName(tenant.plan) !== 'free' && !jeDemo(env, tenant.domain)) return 0;
  if (tenant.status === TENANT_STATUS.READY) return jeOslovenieTenant(tenant) || jeDemo(env, tenant.domain) ? 2 : 1;
  return chyba === INGEST_ERRORS.AI_BUDGET ? 4 : 3;
}

export async function poradieObnovy(env, tenants, aktivne = new Set()) {
  const sSkupinou = await Promise.all((tenants || []).map(async (tenant, i) => ({ tenant, i, skupina: await skupinaObnovy(env, tenant) })));
  return sSkupinou.sort((a, b) => a.skupina - b.skupina
    || (a.skupina === 1 ? Number(aktivne?.has(b.tenant.id)) - Number(aktivne?.has(a.tenant.id)) : 0)
    || a.i - b.i).map((x) => x.tenant);
}

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
 * Všetky obchody vrátane ready rezervujú náklad pred vektormi. Cron smie
 * využiť najviac 70 % denného rozpočtu obnovy, zvyšok ostáva registráciám.
 * Po CRON_CAS_SPOLU_MS sa ďalšie načítanie nezačne.
 * Returns a per-tenant outcome array (used in logs/tests).
 */
export async function refreshAllFeeds(env, { now = new Date(), casSpoluMs = CRON_CAS_SPOLU_MS, hodiny = Date.now } = {}) {
  const zaciatok = hodiny();
  const zoznam = await listTenants(env.DB);
  const hranica = posun(now, AKTIVNY_DNI);
  let aktivne = null;
  try {
    aktivne = await aktivneTenantyOd(env.DB, dayKey(hranica));
  } catch (err) {
    console.warn('[arling-asistent] zoznam aktivnych obchodov zlyhal, obnovujem vsetky:', (err && err.message) || err);
  }
  const tenants = await poradieObnovy(env, zoznam, aktivne);
  const tyzdenna = now.getUTCDay() === TYZDENNA_OBNOVA_DEN;
  const outcomes = [];
  for (const tenant of tenants) {
    if (hodiny() - zaciatok >= casSpoluMs) {
      outcomes.push({ tenantId: tenant.id, ok: false, preskocene: 'cas' });
      continue;
    }
    const novy = tenant.created_at && new Date(tenant.created_at).getTime() >= hranica.getTime();
    if (aktivne && !tyzdenna && !novy && !aktivne.has(tenant.id)) {
      outcomes.push({ tenantId: tenant.id, ok: false, preskocene: 'neaktivny' });
      continue;
    }
    // Rozpočet vždy za skutočný dnešok: tam zapisuje aj načítanie (onboarding.js spendObnova).
    const rozpocet = await hasObnovaBudget(env, 0);
    if (!rozpocet.ok || rozpocet.used >= rozpocet.limit * CRON_PODIEL_OBNOVY) {
      outcomes.push({ tenantId: tenant.id, ok: false, preskocene: 'rozpocet_obnovy' });
      continue;
    }
    try {
      const result = await ingestFeedForTenant(env, tenant, {
        rezervovat: true, podielObnovy: CRON_PODIEL_OBNOVY,
      });
      outcomes.push({ tenantId: tenant.id, ...result,
        ...(result.code === INGEST_ERRORS.AI_BUDGET ? { preskocene: 'rozpocet_obnovy' } : {}),
      });
    } catch (err) {
      outcomes.push({ tenantId: tenant.id, ok: false, error: String((err && err.message) || err) });
    }
  }
  return outcomes;
}

/**
 * Denný beh: najprv údržba a mazanie starých počítadiel, potom obnova feedov.
 * Druhé kolo kontroly 29. 9. 2026 (nález 4c): údržba predtým bežala až po
 * obnove, takže keď obnova narazila na limit behu alebo vyhodila chybu,
 * údržba v tú noc nezbehla vôbec. Každá časť má vlastný try, jedna nezastaví
 * druhú.
 */
export async function dennyBeh(env, opts = {}) {
  try {
    await dennaUdrzba(env);
  } catch (err) {
    console.warn('[arling-asistent] denna udrzba zlyhala:', (err && err.message) || err);
  }
  // Denné počítadlá ochrany (pocty.js) starších dní preč: v D1 nič navyše.
  try {
    await zmazStare(env.DB, dayKey(new Date()));
  } catch (err) {
    console.warn('[arling-asistent] mazanie starych pocitadiel zlyhalo:', (err && err.message) || err);
  }
  try {
    return await refreshAllFeeds(env, opts);
  } catch (err) {
    console.warn('[arling-asistent] nocna obnova feedov zlyhala:', (err && err.message) || err);
    return [];
  }
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
