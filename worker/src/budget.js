/**
 * Denný strop na Workers AI.
 *
 * Prečo existuje: 5. 9. 2026 sa vyčerpala bezplatná denná dávka 10 000 neurónov
 * a Asistent prestal odpovedať. Väčšinu z nej spotrebovali NAŠE vlastné testy.
 * Cloudflare na platenom pláne účtuje 0,011 USD za 1 000 neurónov nad dávku,
 * takže bez stropu vie zle napísaný test cez noc minúť viac než celý plán.
 *
 * Ako to funguje:
 *   - Počítadlo je v KV pod kľúčom `neurons:RRRR-MM-DD` (UTC, lebo dávka sa
 *     resetuje o polnoci UTC), s dobou platnosti dva dni.
 *   - Pred každým volaním modelu sa pozrieme, či sa dnešné číslo ešte zmestí
 *     pod strop; ak nie, vrátime úprimné "dnes už nie" namiesto chyby.
 *   - Po volaní pripočítame odhad. Odhad stačí: nejde o účtovníctvo, ale o
 *     poistku. Presné čísla sú vo faktúre Cloudflare.
 *
 * Strop sa nastavuje premennou AI_DAILY_NEURON_BUDGET vo wrangler.toml.
 * Predvolených 9 500 je zámerne pod bezplatnou dávkou 10 000, takže kým to
 * nezmeníme, nad rámec paušálu nezaplatíme nič.
 */

export const DEFAULT_DAILY_BUDGET = 9500;

/** Neuróny podľa nameraných hodnôt z company/naklady-asistent.md. */
export const NEURONS = {
  chatTurn: 90,     // 1 500 vstupných + 200 výstupných tokenov
  giftTurn: 140,    // dlhší prompt, päť výrobkov
  embedPerText: 1,  // bge-m3, krátky text
};

function dnesnyKluc(now) {
  const d = new Date(now);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `neurons:${d.getUTCFullYear()}-${m}-${day}`;
}

export function budgetLimit(env) {
  const raw = Number(env && env.AI_DAILY_NEURON_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

/** True, keď je požiadavka náš vlastný test a nemá sa volať model ani počítať dávka. */
export function isOurTest(request, env) {
  if (!env || !env.ADMIN_TOKEN) return false;
  const hlavicka = request && request.headers && request.headers.get('X-Arling-Test');
  return Boolean(hlavicka) && hlavicka === env.ADMIN_TOKEN;
}

/**
 * Koľko neurónov sme dnes minuli. Keď KV nie je alebo zlyhá, vraciame 0.
 *
 * Zámerne "fails open": výpadok KV nesmie umlčať Asistenta. Strop je poistka
 * proti nečakanej faktúre, nie ďalšia vec, ktorá vie pokaziť odpoveď zákazníkovi.
 * Bez tohto zachytenia zhodila výnimka z KV celú požiadavku na 500 (chytené
 * dvoma existujúcimi testami na padajúce KV).
 */
export async function usedToday(env, now = Date.now()) {
  if (!env || !env.ASISTENT_CACHE) return 0;
  try {
    const v = await env.ASISTENT_CACHE.get(dnesnyKluc(now));
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    console.error('[arling-asistent] KV nedostupne pri citani spotreby:', e && e.message);
    return 0;
  }
}

/**
 * Zmestí sa ďalšie volanie do dnešného stropu?
 * Vracia { ok, used, limit, remaining }.
 */
export async function hasBudget(env, cost = NEURONS.chatTurn, now = Date.now()) {
  const limit = budgetLimit(env);
  const used = await usedToday(env, now);
  const remaining = limit - used;
  return { ok: remaining >= cost, used, limit, remaining };
}

/** Pripočíta minuté neuróny. Chyba KV nesmie zhodiť odpoveď zákazníkovi. */
export async function spend(env, cost, now = Date.now()) {
  if (!env || !env.ASISTENT_CACHE || !(cost > 0)) return;
  try {
    const kluc = dnesnyKluc(now);
    const used = await usedToday(env, now);
    await env.ASISTENT_CACHE.put(kluc, String(used + cost), { expirationTtl: 172800 });
  } catch (e) {
    console.error('[arling-asistent] nepodarilo sa zapísať spotrebu neurónov:', e && e.message);
  }
}
