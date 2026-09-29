/**
 * Denný strop na Workers AI a presné počítanie nákladov.
 *
 * Prečo existuje: 5. 9. 2026 sa vyčerpala bezplatná denná dávka 10 000 neurónov
 * a Asistent prestal odpovedať. Väčšinu z nej spotrebovali NAŠE vlastné testy.
 * Cloudflare na platenom pláne účtuje 0,011 USD za 1 000 neurónov nad dávku,
 * takže bez stropu vie zle napísaný test cez noc minúť viac než celý plán.
 *
 * Od kroku 1 plánu (ops/asistent/genialny-plan.md 2.2, 2.4) a opravy nálezov
 * jeho kontroly (ops/asistent/stavba/krok1-ochrana.md):
 *   - Náklad každej odpovede sa počíta zo skutočných tokenov (pole `usage`,
 *     ak ho Workers AI vráti), inak z dĺžky promptu a odpovede (znaky / 3,5).
 *     Do D1 `counters` ide na otázku zaokrúhlený (prehľad), do stropov presne
 *     v tisícinách neurónu (predtým Math.ceil: vektor krátkej otázky za 0,004
 *     neurónu sa rátal ako 1, nález 7).
 *   - Dnešná spotreba = atomické počítadlo `neurony:<deň>` v D1 (pocty.js),
 *     do ktorého sa horný odhad REZERVUJE pred volaním modelu a po odpovedi sa
 *     doúčtuje skutočnosť (ochrana.js). Predtým sa súčet čítal pred modelom a
 *     zapisoval až po ňom, takže súbežná dávka prešla celá (nález 1).
 *   - Načítanie feedov má vlastný rozpočet `obnova:<deň>` (plán 2.2 bod 8,
 *     nález 8), chat ho nečíta: štyri cudzie feedy už nezhodia chat všetkým.
 *   - Spoločný strop je poistka: bezplatné obchody a ukážka majú spolu
 *     vlastný bazén 80 % základného stropu (`neurony-free:<deň>`), ktorý sa
 *     rezervuje ATOMICKY spolu so spoločným počítadlom (tretie kolo, nález
 *     K8: predtým sa 80 % len čítalo a súbežná dávka free išla až po 100 %).
 *     Platiace obchody rezervujú proti vlastnému stropu
 *     AI_DAILY_NEURON_BUDGET_PLATENE (nález K1, plán 2.2 bod 4 „po prvej
 *     platbe 150 000“); bez neho proti základnému. Nad stropom odpovedá kód
 *     bez modelu (stojí len vektor otázky), 503 až pri 150 %.
 *   - Rezervácia pred modelom je horná hranica: najprv odhad (NEURONS), po
 *     zostavení promptu sa dorezervuje rozdiel do hornej hranice z dĺžky
 *     promptu a max_tokens (hornaHranicaMili, tretie kolo, nález 1). Čo sa
 *     nezmestí, odpovedá bez modelu.
 *   - Každý obchod má denný strop otázok podľa plánu a podiel v neurónoch
 *     (bezplatný 30 % základného stropu, ukážka 20 %, platený aspoň denný
 *     strop otázok krát odhad): jeden bezplatný obchod neminie celý bazén.
 *
 * Strop sa nastavuje premennou AI_DAILY_NEURON_BUDGET vo wrangler.toml, v
 * skutočných neurónoch. Predvolená hodnota bez premennej ostáva opatrných 9 500.
 */

import { publicPlanName, PLANS, dayKey } from './tenants.js';
import { bezpecnePorovnaj, parseAllowedOrigins, domainMatches } from './security.js';
import { citaj, pripocitaj, rezervuj, vrat, kluce } from './pocty.js';

export const DEFAULT_DAILY_BUDGET = 9500;
/** Vlastný denný rozpočet načítania feedov v skutočných neurónoch (AI_DAILY_OBNOVA_BUDGET). */
export const DEFAULT_OBNOVA_BUDGET = 5000;
/** Neuróny sa v počítadlách vedú v tisícinách. */
export const MILI = 1000;

/**
 * Horný odhad na jednu otázku, ktorý sa rezervuje PRED volaním modelu.
 * Skutočný náklad sa po odpovedi počíta z tokenov a rezervácia sa doúčtuje.
 * 150 podľa merania NP:9 (134 neurónov na ukážke, 171 pri dlhých popisoch).
 */
export const NEURONS = {
  chatTurn: 150,
  giftTurn: 200, // dlhší prompt, päť výrobkov
  embedPerText: 1, // starý pevný odhad na kus feedu, od opravy sa nepoužíva (pozri obnovaZaZnaky)
};

/** Neuróny za milión tokenov podľa cenníka Workers AI (NP:20-21, overené 25. 9. 2026). */
export const NEURONY_ZA_MILION = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { vstup: 26668, vystup: 204805 },
  '@cf/baai/bge-m3': { vstup: 1075, vystup: 0 },
};

/** Odhad tokenov z dĺžky textu, keď Workers AI `usage` nevráti (NP:216 NEOVERENÉ). */
export const ZNAKOV_NA_TOKEN = 3.5;

/** Cena nad dennú dávku, USD za 1 000 neurónov (NP:19). */
export const USD_ZA_TISIC_NEURONOV = 0.011;

/** Denný strop otázok s modelom na obchod podľa plánu (plán 2.1). Neznámy plán = free. */
export const DENNY_STROP_OTAZOK = {
  [PLANS.FREE]: 60,
  [PLANS.STARTER]: 400,
  [PLANS.PRO]: 1200,
};

/**
 * Najväčší podiel stropu, ktorý smie jeden obchod za deň minúť v neurónoch.
 *   - Bezplatný: 30 % ZÁKLADNÉHO stropu (AI_DAILY_NEURON_BUDGET). Pri 20 000 je
 *     to 6 000 neurónov, asi 44 otázok po 137 dnes a 60 a viac po štíhlom
 *     prompte kroku 2 (plán 2.1 sľubuje 60). Tretie kolo, nález K2: 10 % dávalo
 *     ľudovke asi 16 otázok a dve siete jej vzali model na celý deň.
 *     Všetky bezplatné obchody a ukážka spolu nikdy neprekročia bazén 80 %
 *     základného stropu (STISENIE_FREE_PODIEL), takže platiacim neuberú.
 *   - Platený: podiel stropu platených (AI_DAILY_NEURON_BUDGET_PLATENE), ale
 *     nikdy menej ako denný strop otázok plánu krát odhad otázky (nález K1:
 *     pri 20 000 dostal Starter asi 57 otázok namiesto 400).
 */
export const PODIEL_OBCHODU = {
  [PLANS.FREE]: 0.3,
  [PLANS.STARTER]: 0.35,
  [PLANS.PRO]: 0.7,
};

/**
 * Podiel ukážky ARLing (doména v ALLOWED_ORIGINS) zo základného stropu. Ukážka
 * má plán pro, ale je verejná (tenant id aj Origin) a nič neplatí: s podielom
 * pro minula sama 70 % stropu (tretie kolo, nález 3 riziko 2).
 */
export const PODIEL_UKAZKA = 0.2;

/**
 * Odpovede bez modelu na obchod za deň; nad nimi 429 `obchod_limit`.
 * Tretie kolo, nález 4: pri 300 stačilo asi 380 požiadaviek z 8 sietí a
 * skutočný zákazník ľudovky dostal 429 na prvú správu až do polnoci. Odpoveď
 * bez modelu stojí vektor krátkej otázky (asi 0,004 neurónu) a jeden dopyt
 * Vectorize, takže strop je v tisícoch a brzdu robí limit siete (60 otázok za
 * deň na obchod a sieť, 30 za minútu).
 */
export const BEZ_AI_DENNY_STROP = {
  [PLANS.FREE]: 3000,
  [PLANS.STARTER]: 10000,
  [PLANS.PRO]: 30000,
};

/** Od tohto podielu spoločného stropu odpovedajú bezplatné obchody a ukážka bez modelu (plán 2.2 bod 4). */
export const STISENIE_FREE_PODIEL = 0.8;
/** Od tohto podielu 503: odpovede bez modelu stoja len vektor otázky, do 150 % sa dostane len chyba. */
export const TVRDY_STROP_PODIEL = 1.5;

/** Čistý mesačný príjem v EUR po Managed Payments (NP:92), pre výstrahu obchod_marza. */
export const CISTY_PRIJEM_EUR = {
  [PLANS.STARTER]: 13.81,
  [PLANS.PRO]: 28.67,
};

/** Výstraha naklady_den: pri prekročení menšieho z týchto dvoch prahov (NP:148, plán 2.2 bod 7). */
export const NAKLADY_DEN_PRAH_NEURONOV = 50000;
export const NAKLADY_DEN_PRAH_PODIEL = 0.8;

function denUtc(now) {
  return dayKey(new Date(now));
}

export function budgetLimit(env) {
  const raw = Number(env && env.AI_DAILY_NEURON_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

/**
 * Strop pre platiace obchody (AI_DAILY_NEURON_BUDGET_PLATENE, plán 2.2 bod 4:
 * „po prvej platbe 150 000“). Používajú ho len obchody s plánom starter alebo
 * pro (Stripe), nikdy bezplatné ani ukážka, takže bez platiaceho obchodu sa
 * nikdy nemíňa viac ako základný strop. Bez premennej, alebo menší ako
 * základný, platí základný.
 */
export function platenyLimit(env) {
  const zaklad = budgetLimit(env);
  const raw = Number(env && env.AI_DAILY_NEURON_BUDGET_PLATENE);
  return Number.isFinite(raw) && raw > zaklad ? raw : zaklad;
}

export function obnovaLimit(env) {
  const raw = Number(env && env.AI_DAILY_OBNOVA_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OBNOVA_BUDGET;
}

// ---------------------------------------------------------------------------
// Rezerva ukážok pre oslovené obchody a interný rozpočet (28. 9. 2026)
//
// 28. 9. ráno ukážky pre oslovené obchody (tenants.zdroj = 'oslovenie')
// odpovedali „Asistent si dnes oddychuje“, lebo strop minuli naše vlastné
// nočné testy a príprava ukážok. Odteraz:
//   - Oslovené obchody majú vlastný bazén `neurony-osl:<deň>` s limitom
//     AI_REZERVA_OSLOVENIE a smú ísť až po 100 % spoločného stropu. Nikto iný
//     z tohto bazénu nečerpá.
//   - Bezplatné obchody, ukážka ARLing aj náš interný beh majú spolu jeden
//     bazén `neurony-free:<deň>` s limitom 80 % základného stropu mínus
//     rezerva (bazenFreeLimit), takže neplatiaca a interná prevádzka vrátane
//     ukážok oslovení spolu nikdy neprekročí 80 % a platiacim ostane aspoň
//     20 % (pokus 2 brány, nález 4). Platiace obchody idú po celý strop.
//   - Režim ukážky má len obchod so zdrojom `oslovenie` BEZ platby
//     (jeRezimUkazkyOslovenia, nález 2); zdroj nastaví len náš autorizovaný
//     postup (onboarding.js, nález 1).
//   - Pred modelom sa rezervuje horná hranica nákladu (hornaHranicaMili,
//     ochrana.js dorezervuj volané z chat.js a gift.js, nález 3).
//   - Náš interný beh (hlavička X-Arling-Meranie = MERANIE_TOKEN: príprava
//     dávky, brány, testy) má vlastný denný bazén `interne:<deň>` s limitom
//     AI_DAILY_INTERNE_BUDGET, nezapočítava sa do mesačnej kvóty, denných
//     otázok ani podielu obchodu a po vyčerpaní dostane 429 interny_strop
//     (len my, nikdy zákazník).
// ---------------------------------------------------------------------------

/** Predvolená rezerva ukážok oslovených obchodov v neurónoch (asi 20 odpovedí AI po 150). */
export const DEFAULT_REZERVA_OSLOVENIE = 3000;
/** Predvolený denný rozpočet našich interných behov v neurónoch. */
export const DEFAULT_INTERNE_BUDGET = 4000;

/**
 * Rezerva ukážok oslovených obchodov (AI_REZERVA_OSLOVENIE), najviac 20 %
 * základného stropu: bezplatné obchody sa stišujú už pri 80 %
 * (STISENIE_FREE_PODIEL), takže rezerva je vyhradený kus z tých 20 %, ktoré
 * doteraz ostávali len platiacim. Pri strope 20 000 je to 3 000.
 */
export const REZERVA_MAX_PODIEL = 0.2;

export function rezervaOslovenia(env) {
  const raw = Number(env && env.AI_REZERVA_OSLOVENIE);
  const r = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REZERVA_OSLOVENIE;
  return Math.min(r, budgetLimit(env) * REZERVA_MAX_PODIEL);
}

/** Denný rozpočet našich interných behov (AI_DAILY_INTERNE_BUDGET). */
export function internyLimit(env) {
  const raw = Number(env && env.AI_DAILY_INTERNE_BUDGET);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERNE_BUDGET;
}

/**
 * Spoločný bazén neplatiacej a internej prevádzky okrem rezervy ukážok
 * (`neurony-free:<deň>`, pokus 2 brány 28. 9., nález 4): bezplatné obchody,
 * ukážka ARLing aj náš interný beh spolu najviac 80 % základného stropu mínus
 * rezerva ukážok. Rezerva ukážok má vlastný bazén, takže všetka neplatiaca
 * prevádzka spolu nikdy neprekročí 80 % základného stropu a platiacim ostane
 * vždy aspoň 20 % (pri 20 000 je to 13 000 + 3 000 = 16 000, platiacim 4 000).
 * Predtým interný beh išiel len do spoločného počítadla po strop mínus rezerva
 * a s bezplatnými a ukážkami oslovení vedel zobrať celý strop.
 */
export function bazenFreeLimit(env) {
  return Math.max(0, budgetLimit(env) * STISENIE_FREE_PODIEL - rezervaOslovenia(env));
}

/** Oslovený obchod podľa zdroja registrácie (historický údaj, zivotny-cyklus.js ZDROJE). */
export function jeOslovenieTenant(tenant) {
  return String((tenant && tenant.zdroj) || '').trim().toLowerCase() === 'oslovenie';
}

/**
 * Aktívny režim ukážky osloveného obchodu (rezerva ukážok, overené odpovede,
 * vecná veta pri vyčerpaní). Zdroj registrácie je len história: keď obchod
 * zaplatí (plán starter alebo pro), ide bežnou platenou cestou ako každý
 * platiaci zákazník (pokus 2 brány 28. 9., nález 2). Zdroj `oslovenie` smie
 * nastaviť len autorizovaný postup (onboarding.js, ASISTENT_ADMIN_ZAPIS).
 */
export function jeRezimUkazkyOslovenia(tenant) {
  return jeOslovenieTenant(tenant) && !jePlateny(tenant);
}

/** Dnešná spotreba bazénu ukážok oslovených obchodov v neurónoch. Chyba D1 vráti 0. */
export async function usedOslovenieToday(env, now = Date.now()) {
  if (!env || !env.DB) return 0;
  try {
    return (await citaj(env.DB, kluce.neuronyOslovenie(denUtc(now)))) / MILI;
  } catch (e) {
    console.error('[arling-asistent] D1 nedostupne pri citani rezervy oslovenia:', e && e.message);
    return 0;
  }
}

/** True, keď je požiadavka náš vlastný test a nemá sa volať model ani počítať dávka. */
export function isOurTest(request, env) {
  if (!env || !env.ADMIN_TOKEN) return false;
  const hlavicka = request && request.headers && request.headers.get('X-Arling-Test');
  return Boolean(hlavicka) && bezpecnePorovnaj(hlavicka, env.ADMIN_TOKEN);
}

// ---------------------------------------------------------------------------
// Tokeny a neuróny jednej odpovede
// ---------------------------------------------------------------------------

export function odhadTokenov(text) {
  const n = String(text == null ? '' : text).length;
  return n ? Math.ceil(n / ZNAKOV_NA_TOKEN) : 0;
}

/**
 * Tokeny jednej odpovede modelu: z `usage` (prompt_tokens, completion_tokens),
 * ak ho Workers AI vrátil, inak odhad z dĺžky vstupu a výstupu.
 * Vracia {vstup, vystup, odhad}.
 */
export function tokenyOdpovede(modelResponse, vstupText, vystupText) {
  const usage = modelResponse && typeof modelResponse === 'object' ? modelResponse.usage : null;
  const pt = Number(usage && usage.prompt_tokens);
  const ct = Number(usage && usage.completion_tokens);
  if (usage && Number.isFinite(pt) && pt >= 0 && Number.isFinite(ct) && ct >= 0) {
    return { vstup: pt, vystup: ct, odhad: false };
  }
  return { vstup: odhadTokenov(vstupText), vystup: odhadTokenov(vystupText), odhad: true };
}

/** Neuróny (desatinné) za tokeny daného modelu. Neznámy model sa počíta ako 70B (horný odhad). */
export function neuronyZaTokeny(model, vstup, vystup) {
  const cena = NEURONY_ZA_MILION[model] || NEURONY_ZA_MILION['@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
  return ((Number(vstup) || 0) * cena.vstup + (Number(vystup) || 0) * cena.vystup) / 1e6;
}

/**
 * Náklad jednej otázky: volanie modelu (ak bolo) plus vektory otázky.
 * `volania`: [{model, modelResponse, vstupText, vystupText}], `vektory`: texty
 * poslané do bge-m3. Vracia {tokenyVstup, tokenyVystup, neurony, mili, odhad}:
 * tokeny sú len tokeny jazykového modelu, `neurony` zaokrúhlené na celé (do
 * prehľadu v counters), `mili` tisíciny neurónu zaokrúhlené nahor (do stropov).
 */
export function spocitajNaklady({ volania = [], vektory = [] } = {}) {
  let tokenyVstup = 0;
  let tokenyVystup = 0;
  let neurony = 0;
  let odhad = false;
  for (const v of volania) {
    const t = tokenyOdpovede(v.modelResponse, v.vstupText, v.vystupText);
    tokenyVstup += t.vstup;
    tokenyVystup += t.vystup;
    if (t.odhad) odhad = true;
    neurony += neuronyZaTokeny(v.model, t.vstup, t.vystup);
  }
  for (const text of vektory) neurony += neuronyZaTokeny('@cf/baai/bge-m3', odhadTokenov(text), 0);
  return { tokenyVstup, tokenyVystup, neurony: Math.round(neurony), mili: Math.ceil(neurony * MILI), odhad };
}

/**
 * Náklad vektorov pre texty v tisícinách neurónu, presne ako ich započíta
 * spocitajNaklady (tá istá cena bge-m3 a ten istý odhad tokenov). Rezervuje sa
 * pred vektorom odpovede bez modelu (ochrana.js rezervujVektor, nález A pokusu 3).
 */
export function vektorMili(texty = []) {
  let n = 0;
  for (const text of texty) n += neuronyZaTokeny('@cf/baai/bge-m3', odhadTokenov(text), 0);
  return Math.ceil(n * MILI);
}

/** Skutočný náklad vektorov pre `znakov` znakov textu (načítanie feedu), v tisícinách neurónu. */
export function obnovaZaZnaky(znakov) {
  return Math.ceil(neuronyZaTokeny('@cf/baai/bge-m3', Math.ceil((Number(znakov) || 0) / ZNAKOV_NA_TOKEN), 0) * MILI);
}

/**
 * Horná hranica tokenov vstupu z bajtov UTF-8 (tretie kolo, nález 1). Tokenizér
 * Llama 3 je BPE nad bajtmi: každý token má aspoň jeden bajt, takže tokenov
 * nikdy nie je viac ako bajtov, ani pri texte, ktorý útočník zloží z
 * vzácnych znakov (vlastný feed, otázka). Pokus 2 brány 28. 9., nález 3:
 * predtým 2 bajty na token, čo bežný text splní (3 až 4 znaky na token), ale
 * zámerne zložený nie. Odhad bez `usage` (znaky / 3,5) je vždy pod touto
 * hranicou, lebo bajtov je aspoň toľko ako znakov.
 */
export const BAJTOV_NA_TOKEN_HORNA = 1;
/** Tokeny šablóny rozhovoru okolo správ (hlavičky system a user), s rezervou. */
export const REZIA_SABLONY_TOKENOV = 64;

/**
 * Horná hranica nákladu jedného volania modelu v tisícinách neurónu, z hotového
 * promptu PRED volaním: vstup z bajtov, výstup max_tokens, plus vektory, ktoré
 * požiadavka už poslala. Rezervuje sa pred env.AI.run (ochrana.js dorezervuj),
 * takže súbežná dávka s dlhým promptom (vlastný feed útočníka) neprerazí podiel
 * obchodu ani spoločný strop. Predtým sa rezervovalo pevných 150 a skutočnosť
 * (až 755 pri dlhých poliach) sa doúčtovala bez limitu.
 */
export function hornaHranicaMili({ model, vstupText = '', maxTokens = 0, vektory = [] } = {}) {
  const bajty = new TextEncoder().encode(String(vstupText == null ? '' : vstupText)).length;
  const vstup = Math.ceil(bajty / BAJTOV_NA_TOKEN_HORNA) + REZIA_SABLONY_TOKENOV;
  let n = neuronyZaTokeny(model, vstup, Math.max(0, Number(maxTokens) || 0));
  for (const text of vektory) n += neuronyZaTokeny('@cf/baai/bge-m3', odhadTokenov(text), 0);
  return Math.ceil(n * MILI);
}

// ---------------------------------------------------------------------------
// Dnešná spotreba
// ---------------------------------------------------------------------------

/**
 * Dnešná spoločná spotreba chatu a darčeka v neurónoch (z D1 `neurony:<deň>`).
 * Chyba D1 vráti 0: čítanie je len pre rozhodnutie pred rezerváciou a pre
 * bránu samoobslužného načítania; samotná rezervácia je atomická (ochrana.js).
 */
export async function usedToday(env, now = Date.now()) {
  if (!env || !env.DB) return 0;
  try {
    return (await citaj(env.DB, kluce.neurony(denUtc(now)))) / MILI;
  } catch (e) {
    console.error('[arling-asistent] D1 nedostupne pri citani spotreby:', e && e.message);
    return 0;
  }
}

/** Dnešná spotreba bazénu bezplatných obchodov a ukážky v neurónoch. Chyba D1 vráti 0. */
export async function usedFreeToday(env, now = Date.now()) {
  if (!env || !env.DB) return 0;
  try {
    return (await citaj(env.DB, kluce.neuronyFree(denUtc(now)))) / MILI;
  } catch (e) {
    console.error('[arling-asistent] D1 nedostupne pri citani bazenu free:', e && e.message);
    return 0;
  }
}

/** Dnešná spotreba načítania feedov v neurónoch. Chyba D1 vráti 0. */
export async function usedObnovaToday(env, now = Date.now()) {
  if (!env || !env.DB) return 0;
  try {
    return (await citaj(env.DB, kluce.obnova(denUtc(now)))) / MILI;
  } catch (e) {
    console.error('[arling-asistent] D1 nedostupne pri citani obnovy:', e && e.message);
    return 0;
  }
}

/**
 * Zmestí sa ďalšie volanie do dnešného spoločného stropu?
 * Vracia { ok, used, limit, remaining }.
 */
export async function hasBudget(env, cost = NEURONS.chatTurn, now = Date.now()) {
  const limit = budgetLimit(env);
  const used = await usedToday(env, now);
  const remaining = limit - used;
  return { ok: remaining >= cost, used, limit, remaining };
}

/** Zmestí sa načítanie feedu s odhadom `cost` neurónov do dnešného rozpočtu obnovy? */
export async function hasObnovaBudget(env, cost = 0, now = Date.now()) {
  const limit = obnovaLimit(env);
  const used = await usedObnovaToday(env, now);
  const remaining = limit - used;
  return { ok: remaining >= cost, used, limit, remaining };
}

/**
 * Pripočíta skutočný náklad načítania feedu (tisíciny neurónu) do rozpočtu
 * obnovy. Chat tento kľúč nečíta. Chyba D1 nič nezhodí.
 */
export async function spendObnova(env, mili, now = Date.now()) {
  if (!env || !env.DB || !(mili > 0)) return;
  try {
    await pripocitaj(env.DB, kluce.obnova(denUtc(now)), denUtc(now), mili);
  } catch (e) {
    console.error('[arling-asistent] nepodarilo sa zapisat spotrebu obnovy:', e && e.message);
  }
}

/**
 * Atomicky zaberie `mili` z dnešného rozpočtu obnovy PRED vektormi (tretie
 * kolo, nález 5): počet znakov je známy z embed.js znakyProduktov, takže
 * súbežné registrácie s veľkými feedmi už neprejdú všetky na jedno čítanie.
 * Vracia true, keď sa zmestí. Chyba D1 = false (radšej zajtra ako bez limitu).
 * Volá ju onboarding.js pri samoobslužnom načítaní (bezpečnostná kontrola
 * 29. 9. 2026: do vtedy sa nevolala nikde a brána len čítala).
 */
export async function rezervujObnovu(env, mili, now = Date.now()) {
  const m = Math.max(0, Math.ceil(Number(mili) || 0));
  if (!env || !env.DB) return false;
  if (m === 0) return true;
  try {
    const den = denUtc(now);
    return (await rezervuj(env.DB, kluce.obnova(den), den, m, Math.floor(obnovaLimit(env) * MILI))) != null;
  } catch (e) {
    console.error('[arling-asistent] rezervacia rozpoctu obnovy zlyhala:', e && e.message);
    return false;
  }
}

/**
 * Vráti nevyužitú časť rezervácie obnovy (tisíciny neurónu) do toho istého
 * dňa, v ktorom sa rezervovala (`now` rezervácie). Nikdy pod nulu, chyba D1
 * nič nezhodí.
 */
export async function vratObnovu(env, mili, now = Date.now()) {
  const m = Math.max(0, Math.floor(Number(mili) || 0));
  if (!env || !env.DB || m === 0) return;
  try {
    await vrat(env.DB, kluce.obnova(denUtc(now)), m);
  } catch (e) {
    console.error('[arling-asistent] vratenie rezervacie obnovy zlyhalo:', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// Pravidlá na obchod
// ---------------------------------------------------------------------------

/** Ukážka ARLing (doména v ALLOWED_ORIGINS): pri stíšení ako bezplatný obchod (nález B1). */
export function jeUkazka(env, tenant) {
  const d = String((tenant && tenant.domain) || '').toLowerCase();
  if (!d) return false;
  return parseAllowedOrigins(env && env.ALLOWED_ORIGINS).some((a) => domainMatches(d, a));
}

export function jePlateny(tenant, { ukazka = false } = {}) {
  if (ukazka) return false;
  const plan = publicPlanName(tenant && tenant.plan);
  return plan === PLANS.STARTER || plan === PLANS.PRO;
}

function planObchodu(tenant) {
  const plan = publicPlanName(tenant && tenant.plan);
  return DENNY_STROP_OTAZOK[plan] ? plan : PLANS.FREE;
}

export function dennyStropObchodu(tenant) {
  return DENNY_STROP_OTAZOK[planObchodu(tenant)];
}

/**
 * Denný strop obchodu v tisícinách neurónu. Ukážka 20 % a bezplatný obchod
 * 30 % základného stropu; platený podiel stropu platených, najmenej denný
 * strop otázok plánu krát odhad otázky (nález K1).
 */
export function neuronovyStropObchodu(env, tenant, { ukazka = false } = {}) {
  if (ukazka) return Math.floor(budgetLimit(env) * PODIEL_UKAZKA * MILI);
  if (!jePlateny(tenant)) return Math.floor(budgetLimit(env) * PODIEL_OBCHODU[PLANS.FREE] * MILI);
  const plan = planObchodu(tenant);
  const podiel = platenyLimit(env) * PODIEL_OBCHODU[plan];
  const podlaha = DENNY_STROP_OTAZOK[plan] * NEURONS.chatTurn;
  return Math.floor(Math.max(podiel, podlaha) * MILI);
}

/**
 * Počítadlá neurónov, do ktorých sa rezervuje odpoveď modelom, s limitmi v
 * tisícinách: [[kluc, limit, dovod], ...]. Všetky sa rezervujú naraz a
 * atomicky (ochrana.js), odhad pred modelom aj dorezervovanie hornej hranice.
 *   - platiaci: spoločné počítadlo proti stropu platených,
 *   - bezplatný a ukážka: spoločné počítadlo proti 80 % stropu platených a
 *     bazén free proti 80 % základného stropu (nález K8: stíšenie atomicky),
 *   - vždy podiel obchodu (`mili:`); naše meranie (MERANIE_TOKEN) ho obchádza.
 * Neplatiaci (bezplatný, ukážka, náš interný beh) idú do spoločného bazénu
 * `neurony-free` (bazenFreeLimit), ukážky oslovení do rezervy; oba spolu
 * najviac 80 % základného stropu, zvyšok patrí platiacim (nález 4).
 */
export function neuronovePolozky(env, tenant, den, { ukazka = false, meranie = false, oslovenie = false } = {}) {
  const celkovy = platenyLimit(env);
  const rezerva = rezervaOslovenia(env);
  const stisenie = Math.floor(Math.max(0, Math.min(celkovy * STISENIE_FREE_PODIEL, celkovy - rezerva)) * MILI);
  // Náš interný beh: vlastný denný bazén, spoločný bazén neplatiacich a nikdy
  // rezerva ukážok; podiel obchodu neberie (inak by príprava ukážky minula
  // denný podiel osloveného obchodu).
  if (meranie) {
    return [
      [kluce.neurony(den), stisenie, 'interny_strop'],
      [kluce.neuronyFree(den), Math.floor(bazenFreeLimit(env) * MILI), 'interny_strop'],
      [kluce.interne(den), Math.floor(internyLimit(env) * MILI), 'interny_strop'],
    ];
  }
  const obchod = [kluce.mili(tenant.id, den), neuronovyStropObchodu(env, tenant, { ukazka }), 'denny_strop'];
  if (oslovenie) {
    return [
      [kluce.neurony(den), Math.floor(celkovy * MILI), 'spolocny_strop'],
      [kluce.neuronyOslovenie(den), Math.floor(rezerva * MILI), 'rezerva_oslovenia'],
      obchod,
    ];
  }
  if (jePlateny(tenant, { ukazka })) {
    return [[kluce.neurony(den), Math.floor(celkovy * MILI), 'spolocny_strop'], obchod];
  }
  return [
    [kluce.neurony(den), stisenie, 'stisenie'],
    [kluce.neuronyFree(den), Math.floor(bazenFreeLimit(env) * MILI), 'stisenie'],
    obchod,
  ];
}

export function bezAiStropObchodu(tenant) {
  return BEZ_AI_DENNY_STROP[planObchodu(tenant)];
}

/** Započítané nové rozhovory obchodu za deň: 3-násobok denného priemeru mesačnej kvóty, aspoň 10 (nález 5). */
export function dennyStropNovychRozhovorov(tenant) {
  const kvota = Number(tenant && tenant.monthly_quota) || 0;
  return Math.max(10, Math.ceil((kvota * 3) / 30));
}

/** Otázky s modelom z jednej siete na obchod za deň (nález 3). */
export function limitIpAiObchodu(tenant, { ukazka = false, limity } = {}) {
  const l = limity || { free: 10, platene: 30 };
  return jePlateny(tenant, { ukazka }) ? l.platene : l.free;
}

/**
 * Rozhodnutie pred rezerváciou, len podľa spotreby (čítanie; o hraniciach
 * rozhoduje až atomická rezervácia neuronovePolozky v ochrana.js):
 *   - 'stop'   (503): spotreba je na TVRDY_STROP_PODIEL stropu platených,
 *   - 'bez_ai' dovod 'spolocny_strop': model by strop prekročil (odpovedá kód),
 *   - 'bez_ai' dovod 'stisenie': bezplatný obchod alebo ukážka pri 80 %
 *     spoločného stropu alebo bazénu free,
 *   - 'ai': skúsiť rezerváciu (ochrana.js), ktorá ešte môže skončiť bez modelu.
 * Vracia {rezim, dovod, used, limit, celkovy}; `limit` je základný strop.
 */
export async function rozhodniRezim(env, tenant, { odhad = NEURONS.chatTurn, now = Date.now(), ukazka = false, oslovenie = false, meranie = false } = {}) {
  const limit = budgetLimit(env);
  const celkovy = platenyLimit(env);
  const used = await usedToday(env, now);
  const zaklad = { used, limit, celkovy };
  if (used >= celkovy * TVRDY_STROP_PODIEL) return { rezim: 'stop', dovod: 'tvrdy_strop', ...zaklad };
  // Náš interný beh nikdy nesiahne na rezervu ukážok a nikdy nejde bez modelu:
  // chceme vedieť, že nemáme, nie dostať iný druh odpovede (ochrana.js 429).
  if (meranie) {
    const strop = Math.min(celkovy * STISENIE_FREE_PODIEL, celkovy - rezervaOslovenia(env));
    if (strop - used < odhad || bazenFreeLimit(env) - (await usedFreeToday(env, now)) < odhad) {
      return { rezim: 'interny_strop', dovod: 'interny_strop', ...zaklad };
    }
    return { rezim: 'ai', dovod: null, ...zaklad };
  }
  if (celkovy - used < odhad) return { rezim: 'bez_ai', dovod: 'spolocny_strop', ...zaklad };
  // Oslovený obchod má vlastný bazén: stíšenie free pri 80 % sa ho netýka.
  if (oslovenie) {
    if (rezervaOslovenia(env) - (await usedOslovenieToday(env, now)) < odhad) return { rezim: 'bez_ai', dovod: 'rezerva_oslovenia', ...zaklad };
    return { rezim: 'ai', dovod: null, ...zaklad };
  }
  if (!jePlateny(tenant, { ukazka })) {
    if (used >= celkovy * STISENIE_FREE_PODIEL) return { rezim: 'bez_ai', dovod: 'stisenie', ...zaklad };
    const usedFree = await usedFreeToday(env, now);
    if (bazenFreeLimit(env) - usedFree < odhad) return { rezim: 'bez_ai', dovod: 'stisenie', ...zaklad };
  }
  return { rezim: 'ai', dovod: null, ...zaklad };
}

/** Náklad v USD za neuróny (bez odpočtu bezplatnej dávky, teda horný odhad). */
export function usdZaNeurony(neurony) {
  return ((Number(neurony) || 0) / 1000) * USD_ZA_TISIC_NEURONOV;
}

/**
 * Percento denného čistého príjmu obchodu, ktoré dnes minul na AI, alebo
 * null pre bezplatný plán (nemá príjem). USD a EUR sa tu nerozlišujú: pri
 * kurze okolo 0,9 EUR za USD je to opatrný odhad nákladu.
 */
export function marzaPercento(tenant, neuronyDnes) {
  const prijem = CISTY_PRIJEM_EUR[publicPlanName(tenant && tenant.plan)];
  if (!prijem) return null;
  return Math.round((usdZaNeurony(neuronyDnes) / (prijem / 30)) * 100);
}

/** Prah výstrahy naklady_den v neurónoch pre daný denný strop. */
export function prahNakladyDen(limit) {
  return Math.min(NAKLADY_DEN_PRAH_NEURONOV, Math.floor(limit * NAKLADY_DEN_PRAH_PODIEL));
}
