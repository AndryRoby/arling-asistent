/*
 * onboarding.js
 *
 * Self-serve tenant creation: POST /v1/tenants {feed_url, domain, email}
 * validates the input, creates a 'pending' tenant row, and kicks off feed
 * ingestion (download, normalise, embed, upsert to Vectorize) in the
 * background via ctx.waitUntil so the HTTP response does not wait for the
 * whole feed to be embedded. GET /v1/tenants/:id/status lets the demo page
 * poll until ingestion finishes, and gives the shop's dashboard its monthly
 * usage (see tenantStatusResponse for the public contract).
 */

import {
  createTenant,
  setTenantStatus,
  setProductCount,
  setFeedUrl,
  setTenantPlan,
  getTenantById,
  getTenantByDomain,
  validateTenantInput,
  normaliseDomain,
  hostPatriDomene,
  feedPatriDomene,
  jeVerejnaPripona,
  bezWwwHost,
  ValidationError,
  DuplicateDomainError,
  D1ConstraintError,
  PLANS,
  conversationsUsedThisMonth,
  monthPeriod,
  usagePercent,
  publicPlanName,
} from './tenants.js';
import { fetchFeed, FeedUrlNotAllowedError, FEED_CHYBY, FEED_INA_DOMENA } from './feed.js';
import { embedAndUpsertProducts, embedTexts, znakyProduktov } from './embed.js';
import { parseAllowedOrigins, corsHeaders, bezpecnePorovnaj, checkRateLimit, SECURITY_HEADERS } from './security.js';
import { hasBudget, rezervujObnovu, spendObnova, vratObnovu, obnovaZaZnaky, jeOslovenieTenant, jeRezimUkazkyOslovenia } from './budget.js';
import { poVytvoreni, poNacitani, poZmenePlanu, nastavJazyk, jazykZoVstupu, zdrojZoVstupu, poOvereniMajitela, mozePrevziatOslovenie, prevezmiOslovenie, zapamatajVektory, vymenVektory, udalostiTenanta, jeDemo } from './zivotny-cyklus.js';
import { overenyEmailZBearer, klucObchodu, jeKlucObchodu } from './ucet.js';

export const TENANT_STATUS = {
  PENDING: 'pending',
  READY: 'ready',
  ERROR: 'error',
};

// How long a tenant can go without a successful ingestion before a repeat
// POST /v1/tenants for its domain (see createTenantFromRequest) triggers a
// fresh one on its own, even if the feed URL did not change.
const REINGEST_IF_STALE_MS = 24 * 60 * 60 * 1000;

function isIngestionStale(tenant, now) {
  // A tenant stuck on 'error' (e.g. the feed URL was briefly broken) is
  // always worth retrying on resubmission, regardless of the 24h window:
  // setTenantStatus stamps last_ingested_at on a failed attempt too (see
  // ingestFeedForTenant's catch branch), so relying on that timestamp alone
  // would treat a just-failed tenant as "fresh" and never retry it.
  if (tenant.status === TENANT_STATUS.ERROR) return true;
  if (!tenant.last_ingested_at) return true;
  return now.getTime() - new Date(tenant.last_ingested_at).getTime() > REINGEST_IF_STALE_MS;
}

/**
 * Počká, kým je katalóg naozaj dopytovateľný, nie len zapísaný.
 *
 * Naživo overené 7. 9. 2026: stav sa prepol na ready, hneď položená otázka
 * vrátila „nemám k tomu z produktov tohto obchodu istú odpoveď" a tá istá
 * otázka o pár desiatok sekúnd odpovedala správne. Vectorize je totiž po
 * zápise chvíľu nekonzistentný. Nový zákazník teda v administrácii videl
 * Ready, otvoril widget a asistent tvrdil, že o jeho obchode nič nevie. To je
 * prvý dojem, po ktorom sa človek druhýkrát nevráti.
 *
 * Preto sa po zápise raz spýtame do indexu na názov prvého produktu a na
 * ready čakáme, kým niečo vráti. Ak sa to do vyčerpania pokusov nestane,
 * stav sa aj tak prepne: nechať zákazníka navždy v stave „načítava sa" by
 * bolo horšie než jedna nepodarená prvá otázka.
 *
 * Chyba samotného dopytu nesmie zhodiť načítanie, preto try/catch: v testoch
 * ani nemusí byť VECTORIZE k dispozícii.
 */
// POZOR na dlzku okna. Prvy pokus mal 20 x 3 s, teda az minutu, a Cloudflare
// tu ulohu vo waitUntil ukoncil skor, nez sa stav prepol: zakaznik ostal
// navzdy v stave pending, hoci produkty uz mal nacitane. Preto je okno
// kratke a hlavne sa stav prepina PRED dopytom, nikdy po nom.
export const PROBE_ATTEMPTS = 5;
export const PROBE_WAIT_MS = 2000;

export async function waitForQueryableIndex(env, tenantId, products, opts = {}) {
  const attempts = opts.attempts != null ? opts.attempts : PROBE_ATTEMPTS;
  const waitMs = opts.waitMs != null ? opts.waitMs : PROBE_WAIT_MS;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const prvy = (products && products[0]) || null;
  const text = (prvy && (prvy.title || prvy.name)) || '';
  if (!env || !env.VECTORIZE || !env.AI || !text) return { probed: false, queryable: null, attempts: 0 };

  // Vektor sa pocita raz. Pri dvadsiatich pokusoch by dvadsat volani modelu
  // bolo cistym plytvanim, otazka je stale ta ista.
  let vector;
  try {
    [vector] = await embedTexts(env.AI, [text]);
  } catch (e) {
    return { probed: false, queryable: null, attempts: 0, probeError: String((e && e.message) || e) };
  }

  for (let i = 1; i <= attempts; i++) {
    try {
      const filtered = await env.VECTORIZE.query(vector, { topK: 1, filter: { tenant: tenantId } });
      let matches = (filtered && filtered.matches) || [];
      if (matches.length === 0) {
        // Ten istý ústupok ako v chat.js: filter na vlastnosti bez
        // metadátového indexu nechybuje, len nič nenájde.
        const wide = await env.VECTORIZE.query(vector, { topK: 5 });
        matches = ((wide && wide.matches) || []).filter((m) => String(m.id || '').startsWith(tenantId + '::'));
      }
      if (matches.length > 0) return { probed: true, queryable: true, attempts: i };
    } catch (e) {
      return { probed: false, queryable: null, attempts: i, probeError: String((e && e.message) || e) };
    }
    if (i < attempts) await sleep(waitMs);
  }
  return { probed: true, queryable: false, attempts };
}

/**
 * Koľko neurónov musí ostať v dennom strope, než sa pustí načítanie feedu,
 * ktoré si objednal niekto z internetu. Malý feed stojí rádovo desiatky,
 * feed s 5 000 produktmi tisíce (embed.js robí jeden vektor na kus textu,
 * budget.js NEURONS.embedPerText), takže bez tejto brány vie ktokoľvek
 * formulárom minúť celú dennú dávku Workers AI a umlčať asistenta všetkým
 * zákazníkom.
 */
export const INGEST_MIN_NEURONS = 200;

/**
 * Horná hranica znakov jedného produktu pred vektormi (názov najviac
 * feed.js TITLE_MAX_LEN, popis najviac 600, spolu jeden kus textu). Pred
 * samoobslužným načítaním sa rezervuje presný počet znakov (embed.js
 * znakyProduktov), ktorý nikdy nie je väčší ako produkty krát táto hodnota.
 */
export const ODHAD_ZNAKOV_NA_PRODUKT = 800;

/**
 * Download the tenant's feed, embed every product, and flip status to
 * ready/error. Safe to call again (re-ingestion on cron). Obchod, ktorý už
 * je ready, pri zlyhaní ready ostáva (zlyhanieNacitania, druhé kolo
 * kontroly 29. 9. 2026).
 *
 * `samoobsluzne` je true len pri načítaní, ktoré spustil formulár z internetu
 * (POST /v1/tenants). Vtedy sa pred prácou pozrie na denný strop neurónov;
 * denný cron a admin cesta sú naše vlastné a nekontrolujú sa, aby sa
 * pravidelná obnova katalógu nikdy nezastavila.
 */
export async function ingestFeedForTenant(env, tenant, opts = {}) {
  // Životný cyklus (zivotny-cyklus.js): udalosť ready alebo chyba, e-mail E1
  // a ping. Stav pred načítaním rozhoduje, či ide o prvé ready (e-mail),
  // alebo o nočnú obnovu obchodu, ktorý bol ready už predtým (bez e-mailu).
  const bolReady = !!tenant && tenant.status === TENANT_STATUS.READY;
  const result = await nacitajFeed(env, tenant, opts);
  // Posledný časový alebo veľkostný strop rozhoduje o poradí ďalšej obnovy.
  // Odloženie pre rozpočet nesmie vymazať predchádzajúci náročný beh.
  if (result.code !== INGEST_ERRORS.AI_BUDGET && env.ASISTENT_CACHE) {
    const narocny = result.neuplny || /feed_timeout|feed_too_large|cpu|exceeded.*time/i.test(result.error || '');
    try {
      await env.ASISTENT_CACHE.put(`ingest-limit:${tenant.id}`, narocny ? '1' : '0', { expirationTtl: INGEST_ERROR_TTL_SECONDS });
    } catch (e) { /* Poradie obnovy nesmie zhodiť úspešné načítanie. */ }
  }
  await poNacitani(env, tenant, result, { bolReady });
  return result;
}

/**
 * Samoobslužné načítanie sa pre rozpočet odkladá na neskôr. Obchod, ktorý
 * ešte nebeží, dostane stav error s kódom ai_budget_exhausted (majiteľ vidí
 * prečo a skúsi znova). Obchod v stave ready ostáva ready (bezpečnostná
 * kontrola 29. 9. 2026): jeho katalóg vo Vectorize platí ďalej a vyčerpaný
 * rozpočet nesmie vypnúť asistenta, ktorý zákazníkom už odpovedá.
 */
async function odlozNacitanie(env, tenant, dovod) {
  console.warn(`[arling-asistent] ${dovod}, samoobsluzne nacitanie feedu odlozene`);
  if (tenant.status !== TENANT_STATUS.READY) {
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
    await zapisChybuNacitania(env, tenant.id, INGEST_ERRORS.AI_BUDGET);
  }
  return { ok: false, error: 'ai_budget_exhausted', code: INGEST_ERRORS.AI_BUDGET };
}

/**
 * Po vektoroch dorovná rezerváciu obnovy na skutočnosť: zvyšok vráti, chýbajúce
 * pripočíta (len rozdiel, nič sa nerátá dvakrát). Bez rezervácie (cron, admin)
 * sa pripočíta celý skutočný náklad ako doteraz.
 */
async function dorovnajObnovu(env, skutocne, rezervovane, casRezervacie, samoobsluha = false) {
  // Deň rezervácie, aby sa rozdiel nezapísal do nového dňa po polnoci; bez
  // rezervácie ako doteraz (deň zápisu).
  const kedy = rezervovane > 0 ? casRezervacie : undefined;
  if (skutocne > rezervovane) await spendObnova(env, skutocne - rezervovane, kedy, { samoobsluha: samoobsluha && rezervovane > 0 });
  else if (rezervovane > skutocne) await vratObnovu(env, rezervovane - skutocne, kedy, { samoobsluha });
}

/**
 * Doména, na ktorej musí byť feed aj každý skok presmerovania (feed.js
 * guardedFetch), alebo null bez kontroly: ukážka osloveného obchodu (feed na
 * našom serveri, zakladá ju len vytvor-ukazku.py s admin tokenom) a demo
 * obchod ARLing (README „Demo tenanti“).
 */
export function domenaFeeduObchodu(env, tenant, feedUrl = tenant?.feed_url) {
  if (!tenant || jeDemo(env, tenant.domain)) return null;
  if (jeOslovenieTenant(tenant) && !feedPatriDomene(feedUrl, tenant.domain)) return null;
  return tenant.domain;
}

/** Výnimka bez Bearera prijíma iba úplný verejný katalóg, bez filtrov. */
export function jeKanonickyFeed(feedUrl, domena) {
  if (!feedPatriDomene(feedUrl, domena)) return false;
  try {
    const u = new URL(feedUrl);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.hash) return false;
    const povolene = new Set(['rest_route', 'per_page', 'page', 'lang']);
    const videne = new Set();
    for (const [kluc] of u.searchParams) {
      if (!povolene.has(kluc) || videne.has(kluc)) return false;
      videne.add(kluc);
    }
    const route = u.searchParams.get('rest_route');
    // vlastná predpona REST (filter rest_url_prefix, napr. /api/wc/store/v1/products) ako isWooCommerceStoreApiUrl;
    // plugin 0.4.0 posiela get_rest_url(), útočník kola 3, nález 3
    const woo = /\/wc\/store\/v1\/products\/?$/.test(u.pathname);
    const jednoduche = u.pathname === '/' && /^\/wc\/store\/v1\/products\/?$/.test(route || '');
    if (route !== null && !/^\/wc\/store\/v1\/products\/?$/.test(route)) return false;
    return woo || jednoduche || (u.pathname === '/products.json' && route === null);
  } catch (e) {
    return false;
  }
}

/** Posledné načítanie narazilo na čas, CPU alebo veľkosť. Bez KV nie je dôkaz. */
export async function readIngestLimit(env, tenantId) {
  try {
    return (await env.ASISTENT_CACHE?.get(`ingest-limit:${tenantId}`)) === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Načítanie zlyhalo. Obchod, ktorý bol ready, ostáva ready s doterajším
 * katalógom a len sa zapíše kód chyby (druhé kolo bezpečnostnej kontroly
 * 29. 9. 2026, nález 1c): predtým ho zlyhané sťahovanie, prázdny feed alebo
 * chyba vektorov prepli na error a chat všetkým jeho zákazníkom vracal 404.
 * To vedel spustiť ktokoľvek so zhodným e-mailom (samoobslužné načítanie) aj
 * nočný cron pri výpadku feedu. Obchod, ktorý ešte nebeží, dostane error s
 * kódom ako doteraz, aby majiteľ videl, čo opraviť.
 */
async function zlyhanieNacitania(env, tenant, code, error, { feedType = null, nulaProduktov = false } = {}) {
  const vysledok = { ok: false, error, code };
  if (feedType) vysledok.feedType = feedType;
  if (tenant.status === TENANT_STATUS.READY) {
    console.warn(`[arling-asistent] nacitanie feedu obchodu ${tenant.id} zlyhalo (${code}), obchod ostava ready s doterajsim katalogom`);
    await zapisChybuNacitania(env, tenant.id, code);
    vysledok.ponechanyReady = true;
    return vysledok;
  }
  if (nulaProduktov) await setProductCount(env.DB, tenant.id, 0);
  await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
  await zapisChybuNacitania(env, tenant.id, code);
  return vysledok;
}

/**
 * `samoobsluzne`: načítanie spustil formulár alebo plugin (kontrola denného
 * stropu chatu). `rezervovat`: pred vektormi sa atomicky rezervuje presný
 * náklad z rozpočtu obnovy (samoobsluha vždy, nočný cron tiež, cron.js).
 * `novyFeed`: adresa, ktorú obchod prevezme až po úspešnom načítaní
 * (bežiaci obchod mení feed, createTenantFromRequest); pri zlyhaní ostáva
 * doterajší feed aj katalóg.
 */
async function nacitajFeed(env, tenant, {
  samoobsluzne = false,
  rezervovat = samoobsluzne || publicPlanName(tenant.plan) === 'free' || jeDemo(env, tenant.domain),
  novyFeed = null,
  zmenenyFeed = false, minProduktov = 0, zachovatKatalog = false, podielObnovy = 1,
} = {}) {
  if (samoobsluzne) {
    const rozpocet = await hasBudget(env, INGEST_MIN_NEURONS);
    if (!rozpocet.ok) return odlozNacitanie(env, tenant, 'denny strop neuronov vycerpany');
  }
  const feedUrl = novyFeed || tenant.feed_url;
  const meniAdresu = zmenenyFeed || feedUrl !== tenant.feed_url;

  // Stiahnutie feedu má vlastný try: jeho chyby sú chyby obchodu (firewall,
  // prihlasovanie, vypnuté REST API) a majiteľ ich vie opraviť, preto dostanú
  // vlastný kód. Chyba až pri vektoroch je naša a hlási sa ako internal.
  let feed;
  try {
    feed = await fetchFeed(feedUrl, { fetchImpl: env.fetchImpl || fetch, domena: domenaFeeduObchodu(env, tenant, feedUrl) });
  } catch (err) {
    return zlyhanieNacitania(env, tenant, classifyFeedError(err), String((err && err.message) || err));
  }

  // Prázdny katalóg: nový obchod bez produktov (typický prvý test pluginu)
  // dostal doteraz stav ready a asistent potom na všetko odpovedal „neviem“.
  // Človek, ktorý to vidí, plugin zmaže. Poctivé je povedať mu, že nemáme čo
  // čítať. Obchod, ktorý už bežal, sa kvôli jednej prázdnej odpovedi
  // nevypína (zlyhanieNacitania): vo Vectorize ostávajú jeho produkty a
  // asistent nimi odpovedá ďalej; nič sa ani nemaže.
  if (feed.products.length === 0) {
    return zlyhanieNacitania(env, tenant, INGEST_ERRORS.NO_PRODUCTS, INGEST_ERRORS.NO_PRODUCTS, { feedType: feed.type, nulaProduktov: true });
  }

  // Rozpočet obnovy (plán 2.2 bod 8, nález 8 kontroly kroku 1): načítanie z
  // internetového formulára sa pustí, len keď sa celý feed zmestí do dnešného
  // rozpočtu obnovy. Chat tento rozpočet nečíta, takže cudzie feedy mu strop
  // neminú. Bezpečnostná kontrola 29. 9. 2026: predtým sa rozpočet len
  // prečítal a spotreba zapísala až po vektoroch, takže súbežné registrácie
  // prečítali tú istú nízku spotrebu a prešli všetky (strop sa prekročil
  // N-násobne). Teraz sa presný náklad (embed.js znakyProduktov, horná hranica
  // skutočnosti) PRED vektormi atomicky rezervuje (budget.js rezervujObnovu)
  // a po nich sa dorovná len rozdiel.
  // Kontrola pred prvým vektorom aj zápisom novej adresy.
  if (feed.products.length < minProduktov) {
    return zlyhanieNacitania(env, tenant, INGEST_ERRORS.NOT_READABLE, 'feed_product_count_drop');
  }
  let rezervovane = 0;
  const casRezervacie = Date.now();
  if (rezervovat) {
    const naklad = obnovaZaZnaky(znakyProduktov(feed.products));
    // samoobslužné načítanie má navyše vlastný strop 30 % (budget.js), cron posiela svojich 70 %
    if (!(await rezervujObnovu(env, naklad, casRezervacie, { podiel: podielObnovy, samoobsluha: samoobsluzne }))) return odlozNacitanie(env, tenant, 'denny rozpocet obnovy vycerpany');
    rezervovane = naklad;
  }

  const idsVektorov = [];
  try {
    const { products, type, truncated } = feed;
    const summary = await embedAndUpsertProducts(env, tenant.id, products, { ids: idsVektorov });
    // Nový feed bežiaceho obchodu platí až teraz, keď z neho sú vektory.
    if (novyFeed && novyFeed !== tenant.feed_url) {
      await setFeedUrl(env.DB, tenant.id, novyFeed);
      tenant.feed_url = novyFeed;
    }
    // Neúplná obnova rovnakého feedu a oprava ready bez Bearera nič nemažú.
    // Pri zmene zdroja sa staré produkty odstránia, okrem takejto opravy.
    const ponechat = zachovatKatalog || (feed.neuplny && !meniAdresu);
    let vymena = { zmazane: 0 };
    if (ponechat) await zapamatajVektory(env, tenant.id, idsVektorov);
    else vymena = await vymenVektory(env, tenant.id, idsVektorov);
    // Spotreba sa zapisuje vždy, aj pri cron obnove, do vlastného rozpočtu
    // obnovy (nie do spoločného stropu chatu) a v skutočných neurónoch
    // bge-m3 podľa dĺžky textov (predtým pevný 1 neurón na kus, asi 4-krát viac).
    // Pri samoobsluhe je už rezervovaná, dorovná sa len rozdiel. Pri chybe
    // vektorov (catch nižšie) rezervácia ostáva: časť vektorov mohla bežať a
    // nevieme koľko, radšej započítať viac než menej.
    await dorovnajObnovu(env, obnovaZaZnaky(summary.znakov), rezervovane, casRezervacie, samoobsluzne);
    await setProductCount(env.DB, tenant.id, ponechat
      ? Math.max(Number(tenant.product_count) || 0, summary.productCount)
      : summary.productCount);
    // Stav sa prepina ako prvy a bez podmienok. Zakaznik, ktory ma produkty
    // nacitane, nesmie ostat visiet na pending len preto, ze nam nieco
    // spadlo alebo trvalo prilis dlho.
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.READY);
    await zmazChybuNacitania(env, tenant.id);
    // Dopyt je uz len zistenie, ako dlho index potrebuje, nez zacne
    // odpovedat. Nic neblokuje a jeho vysledok ide do summary.
    const probe = await waitForQueryableIndex(env, tenant.id, products);
    return { ok: true, feedType: type, truncated, neuplny: feed.neuplny, ...summary, zmazaneVektory: vymena.zmazane, indexProbe: probe };
  } catch (err) {
    // Časť vektorov mohla byť zapísaná: ich id do zoznamu pre výmaz účtu a
    // ďalšie načítanie (nič sa nemaže, katalóg je neúplný).
    await zapamatajVektory(env, tenant.id, idsVektorov);
    const code = isAiCapacityMessage(err) ? INGEST_ERRORS.AI_BUDGET : INGEST_ERRORS.INTERNAL;
    return zlyhanieNacitania(env, tenant, code, String((err && err.message) || err));
  }
}

// ---------------------------------------------------------------------------
// Prečo sa katalóg nenačítal (kód pre majiteľa obchodu)
//
// Do verzie pluginu 0.2.1 videl majiteľ pri chybe len vetu „There was a
// problem processing your product feed“ a tlačidlo, ktoré chybu len znova
// prečítalo. Nevedel, či ho blokuje firewall, heslo na stránke alebo prázdny
// obchod, a nemal čo opraviť. Kód sa ukladá do KV (nie do D1, aby netreba
// meniť schému) a verejný GET /v1/tenants/:id/status ho vracia ako
// last_error, len kým je stav error. Kódy sú stabilné, plugin ich prekladá
// na vety s návodom.
// ---------------------------------------------------------------------------

export const INGEST_ERRORS = {
  NO_PRODUCTS: 'no_products',
  NOT_READABLE: 'feed_not_readable',
  UNREACHABLE: 'feed_unreachable',
  // Druhé kolo kontroly 29. 9. 2026: feed nad stropom (JSON nad 4 MB na stranu,
  // XML nad 20 MB bez jediného celého záznamu). Predtým feed_not_readable,
  // ktorý majiteľa posielal hľadať HTML stránku a firewall.
  TOO_LARGE: 'feed_too_large',
  // Adresa feedu alebo jej presmerovanie mimo domény obchodu.
  OTHER_DOMAIN: FEED_INA_DOMENA,
  AI_BUDGET: 'ai_budget_exhausted',
  INTERNAL: 'internal',
};

export const INGEST_ERROR_TTL_SECONDS = 30 * 24 * 60 * 60;

export function ingestErrorKey(tenantId) {
  return `ingest-error:${tenantId}`;
}

function isAiCapacityMessage(err) {
  const message = String((err && err.message) || err || '');
  return /daily free allocation/i.test(message) && /neurons/i.test(message);
}

/**
 * Chyba z fetchFeed -> stabilný kód:
 *   feed_url_private_host, feed_url_scheme, feed_url_invalid,
 *   feed_too_many_redirects, feed_other_domain
 *                            (adresu alebo skok presmerovania sme odmietli
 *                             ešte pred stiahnutím)
 *   feed_too_large           (telo nad stropom, feed.js FEED_CHYBY.PRILIS_VELKY)
 *   feed_http_NNN            (obchod odpovedal chybovým kódom HTTP)
 *   feed_not_readable        (odpoveď nie je JSON ani známy XML feed,
 *                             typicky HTML stránka firewallu či prihlásenia)
 *   feed_unreachable         (sieťová chyba, DNS, spojenie zlyhalo)
 */
export function classifyFeedError(err) {
  if (err instanceof FeedUrlNotAllowedError) return err.reason || 'feed_url_invalid';
  const message = String((err && err.message) || err || '');
  const http = message.match(/^feed_fetch_failed_(\d{3})$/);
  if (http) return `feed_http_${http[1]}`;
  // Telo nad stropom (feed.js MAX_FEED_BAJTOV, MAX_JSON_NA_STRANU): vlastný kód, nie „nečitateľný“.
  if (message === FEED_CHYBY.PRILIS_VELKY) return INGEST_ERRORS.TOO_LARGE;
  if (message === 'unrecognised_feed_format' || err instanceof SyntaxError) return INGEST_ERRORS.NOT_READABLE;
  // Časový limit sťahovania (feed.js CAS_NA_FEED_MS) je pre majiteľa to isté ako nedostupný server.
  if (message === FEED_CHYBY.CAS) return INGEST_ERRORS.UNREACHABLE;
  return INGEST_ERRORS.UNREACHABLE;
}

async function zapisChybuNacitania(env, tenantId, code) {
  if (!env || !env.ASISTENT_CACHE) return;
  try {
    await env.ASISTENT_CACHE.put(ingestErrorKey(tenantId), String(code), { expirationTtl: INGEST_ERROR_TTL_SECONDS });
  } catch (e) {
    console.warn('[arling-asistent] kod chyby nacitania sa nepodarilo zapisat:', (e && e.message) || e);
  }
}

async function zmazChybuNacitania(env, tenantId) {
  if (!env || !env.ASISTENT_CACHE || typeof env.ASISTENT_CACHE.delete !== 'function') return;
  try {
    await env.ASISTENT_CACHE.delete(ingestErrorKey(tenantId));
  } catch (e) {
    // Stará chyba v KV nevadí: status ju ukazuje len pri stave error.
  }
}

/** Posledný kód chyby načítania, alebo null (bez KV, bez záznamu, pri chybe KV). */
export async function readIngestError(env, tenantId) {
  if (!env || !env.ASISTENT_CACHE) return null;
  try {
    const value = await env.ASISTENT_CACHE.get(ingestErrorKey(tenantId));
    return value ? String(value) : null;
  } catch (e) {
    return null;
  }
}

/** Kick off ingestion via ctx.waitUntil when available; otherwise await it inline (e.g. in tests, with no Workers ctx). */
async function startIngestion(env, tenant, waitUntil, opts = {}) {
  const ingestion = ingestFeedForTenant(env, tenant, opts);
  if (typeof waitUntil === 'function') {
    waitUntil(ingestion);
  } else {
    await ingestion;
  }
}

// ---------------------------------------------------------------------------
// Obsadená doména a čerstvá skúška (bezpečnostná kontrola 29. 9. 2026)
// ---------------------------------------------------------------------------

/**
 * Vysvetlenie pre 409 domain_taken v jazyku žiadosti (formulár posiela jazyk
 * stránky, plugin jazyk WordPressu; bez jazyka angličtina). Plugin 0.4.0 ho
 * ukáže za vetou „Could not connect to ARLing Shopping Assistant:“ (pole
 * issues), formulár na arling.sk má vlastný text (app.js) a issues pri tomto
 * kóde nepripája. Nikdy neobsahuje adresu majiteľa.
 */
export const DOMENA_OBSADENA_TEXT = {
  sk: 'Tento obchod už má Asistenta ARLing, založeného s inou e-mailovou adresou. Pripojiť ho alebo zmeniť môže len majiteľ tej adresy. Ak je obchod váš a adresu nepoznáte, napíšte na podpora@arling.sk.',
  cs: 'Tento obchod už má Asistenta ARLing, založeného s jinou e-mailovou adresou. Připojit ho nebo změnit může jen majitel té adresy. Pokud je obchod váš a adresu neznáte, napište na podpora@arling.sk.',
  en: 'This shop already has an ARLing assistant, set up with a different e-mail address. Only the owner of that address can connect it or change it. If the shop is yours and you do not know the address, write to support@arling.sk.',
  de: 'Für diesen Shop gibt es bereits einen ARLing-Assistenten, eingerichtet mit einer anderen E-Mail-Adresse. Verbinden oder ändern kann ihn nur der Inhaber dieser Adresse. Wenn der Shop Ihnen gehört und Sie die Adresse nicht kennen, schreiben Sie an support@arling.sk.',
};

/**
 * Vysvetlenie pre 400 feed_other_domain v jazyku žiadosti (plugin 0.4.0 ho
 * ukáže za „Could not connect to ARLing Shopping Assistant:“, formulár na
 * arling.sk má vlastný text v app.js). `domena` je doména obchodu bez www.
 * Druhý tvar je pre doménu na úrovni verejnej prípony (sk, myshopify.com),
 * pod ktorou majú weby rôzni majitelia.
 */
export const FEED_INA_DOMENA_TEXT = {
  sk: (d) => `Adresa feedu musí byť na doméne obchodu ${d} alebo jej subdoméne, aby pod menom obchodu nemohol nikto pripojiť cudzí katalóg. Zadajte adresu zoznamu produktov z webu obchodu. Ak váš feed vytvára iná služba na inej adrese, napíšte na podpora@arling.sk.`,
  cs: (d) => `Adresa feedu musí být na doméně obchodu ${d} nebo její subdoméně, aby pod jménem obchodu nemohl nikdo připojit cizí katalog. Zadejte adresu seznamu produktů z webu obchodu. Pokud váš feed vytváří jiná služba na jiné adrese, napište na podpora@arling.sk.`,
  en: (d) => `The product feed must be on the shop's own domain ${d} or one of its subdomains, so that nobody can connect a different catalogue under the shop's name. Use the product list address from the shop's own website. If another service creates your feed at a different address, write to support@arling.sk.`,
  de: (d) => `Die Feed-Adresse muss auf der Domain des Shops ${d} oder einer ihrer Subdomains liegen, damit niemand unter dem Namen des Shops einen fremden Katalog verbinden kann. Verwenden Sie die Adresse der Produktliste von der Website des Shops. Wenn ein anderer Dienst Ihren Feed unter einer anderen Adresse erstellt, schreiben Sie an support@arling.sk.`,
};

export const SPOLOCNA_DOMENA_TEXT = {
  sk: (d) => `${d} je spoločná doména mnohých webov, nie doména jedného obchodu. Zadajte vlastnú doménu obchodu a feed na nej, alebo napíšte na podpora@arling.sk.`,
  cs: (d) => `${d} je společná doména mnoha webů, ne doména jednoho obchodu. Zadejte vlastní doménu obchodu a feed na ní, nebo napište na podpora@arling.sk.`,
  en: (d) => `${d} is a domain shared by many websites, not the domain of one shop. Use the shop's own domain and a feed on it, or write to support@arling.sk.`,
  de: (d) => `${d} ist eine gemeinsame Domain vieler Websites, nicht die Domain eines Shops. Verwenden Sie die eigene Domain des Shops und einen Feed darauf, oder schreiben Sie an support@arling.sk.`,
};

/**
 * Adresa feedu nie je na doméne obchodu ani jej subdoméne, alebo je doména
 * obchodu len verejnou príponou (druhé kolo bezpečnostnej kontroly
 * 29. 9. 2026, nález 1a a 2a). HTTP 400 feed_other_domain, nič sa nezaloží
 * ani nezmení a odpoveď neprezradí, či doména už má obchod.
 */
export class FeedOtherDomainError extends Error {
  constructor(domena, jazyk = null) {
    super(`feed_other_domain: ${domena}`);
    this.name = 'FeedOtherDomainError';
    this.domain = domena;
    const texty = jeVerejnaPripona(domena) ? SPOLOCNA_DOMENA_TEXT : FEED_INA_DOMENA_TEXT;
    this.sprava = (texty[jazyk] || texty.en)(domena);
  }
}

/**
 * Samoobslužné založenie alebo zmena: hostiteľ feedu musí byť doména obchodu
 * alebo jej subdoména (tenants.js hostPatriDomene, bez www, nie verejná
 * prípona), inak FeedOtherDomainError. Výnimka: demo obchod ARLing, keď je
 * naša (ALLOWED_ORIGINS) doména obchodu aj adresa feedu (ukazka.arling.sk s
 * feedom na arling.sk, README „Demo tenanti“). Neplatné vstupy nechá na
 * validateTenantInput (400 validation_failed ako doteraz).
 */
export function overFeedNaDomene(feedUrl, domain, jazyk = null, env = null) {
  const domena = normaliseDomain(domain);
  let feedHost = '';
  try {
    feedHost = new URL(String(feedUrl || '').trim()).hostname;
  } catch (e) {
    return;
  }
  if (!domena || !feedHost) return;
  if (hostPatriDomene(feedHost, domena)) return;
  if (env && jeDemo(env, domena) && jeDemo(env, feedHost)) return;
  throw new FeedOtherDomainError(bezWwwHost(domena), jazyk);
}

/**
 * Doména už patrí obchodu s iným e-mailom. Do 29. 9. 2026 dostal taký
 * odosielateľ id existujúceho obchodu (existing: true): útočník, ktorý doménu
 * obsadil skôr, tak skutočnému majiteľovi podstrčil vlastný katalóg, lebo
 * plugin aj formulár vrátené id bez otázok vložili na jeho web.
 */
export class DomainTakenError extends Error {
  constructor(domain, jazyk = null) {
    super(`domain_taken: ${domain}`);
    this.name = 'DomainTakenError';
    this.domain = domain;
    this.sprava = DOMENA_OBSADENA_TEXT[jazyk] || DOMENA_OBSADENA_TEXT.en;
  }
}

/** Ako dlho po založení smie neoverený majiteľ opraviť feed skúšky, ktorá nikdy nebežala. */
export const SKUSKA_OPRAVA_MS = 24 * 60 * 60 * 1000;

/**
 * Čerstvá skúška: obchod ešte nikdy nemal úspešné načítanie (nie je ready,
 * nemá produkty ani udalosť ready) a vznikol pred menej ako SKUSKA_OPRAVA_MS.
 * Od druhého kola kontroly 29. 9. 2026 rozhoduje už len o jazyku e-mailov:
 * ten smie neoverený majiteľ (zhoda e-mailu) zmeniť len čerstvej skúške. Feed
 * mení podľa domény (createTenantFromRequest), nie podľa tejto výnimky, takže
 * cudzí feed ňou už neprejde. Chyba pri čítaní udalostí = nie.
 */
export async function jeCerstvaSkuska(env, tenant, now = new Date()) {
  if (!tenant || tenant.status === TENANT_STATUS.READY) return false;
  if (Number(tenant.product_count) > 0) return false;
  const vznik = new Date(tenant.created_at || '').getTime();
  if (!Number.isFinite(vznik) || now.getTime() - vznik >= SKUSKA_OPRAVA_MS) return false;
  try {
    const udalosti = await udalostiTenanta(env.DB, tenant.id);
    if (udalosti.some((u) => u.typ === 'ready' || u.kluc === 'ready')) return false;
  } catch (e) {
    return false;
  }
  return true;
}

/**
 * POST /v1/tenants handler logic. `waitUntil` is Workers' ctx.waitUntil (or
 * a synchronous test stub).
 *
 * Idempotent on domain: `domain` is UNIQUE in schema.sql, so a second
 * self-serve submission for a domain that already has a tenant (a shop
 * owner re-running the onboarding form, for example) must not surface as a
 * hard failure. Instead this looks up the existing tenant and returns it
 * (flagged `existing: true`), refreshing it in the background when the
 * submitted feed_url differs from what is stored, or the last successful
 * ingestion is more than 24h old (or never happened), either way using the
 * same ingestFeedForTenant() the cron and admin re-ingest endpoint use, not
 * a separate code path. The stored contact_email of the existing tenant is
 * never part of the return value, since the caller resubmitting the form is
 * not necessarily the shop's original owner.
 *
 * KTO SMIE MENIŤ FEED UŽ EXISTUJÚCEHO OBCHODU (oprava z 21. 9. 2026)
 *
 * Presne to posledné bolo dovtedy dierou: cesta vyššie prepísala feed_url a
 * spustila načítanie KOMUKOĽVEK, kto poslal cudziu doménu. Jedna anonymná
 * požiadavka
 *
 *   POST /v1/tenants {"domain":"obchod-zakaznika.sk",
 *                     "feed_url":"https://utocnik.example/feed.xml",
 *                     "email":"ktokolvek@example.com"}
 *
 * teda vymenila katalóg platiaceho zákazníka za útočníkov a asistent na jeho
 * e-shope začal zákazníkom ponúkať cudzie "produkty" aj odkazy. Odteraz sa
 * feed_url zmení a načítanie spustí len vtedy, keď sa odoslaný e-mail zhoduje
 * s contact_email uloženým pri založení obchodu. Pre poctivého majiteľa sa
 * nič nemení (formulár aj WordPress plugin posielajú jeho vlastnú adresu),
 * pre každého iného je odpoveď rovnaká ako doteraz, len bez zásahu do
 * katalógu, takže cudzí človek sa z odpovede ani nedozvie, kto obchod
 * vlastní. Pravidelnú obnovu feedu naďalej robí denný cron, ten na nikoho
 * nečaká.
 *
 * OPRAVA 29. 9. 2026 (bezpečnostná kontrola pred oslovením e-shopov)
 *
 * Zhoda e-mailu nestačila: chat ten istý contact_email ukazoval každému
 * návštevníkovi (chat.js, opravené v ten istý deň), takže útočník ho zistil
 * jednou prázdnou otázkou a s ním vymenil feed platiaceho obchodu. A kto
 * doménu obsadil prvý, tomu patril asistent: skutočný majiteľ s iným
 * e-mailom dostal id cudzieho obchodu a plugin aj formulár si ho potichu
 * vložili na jeho web. Odteraz:
 *   - Iný e-mail než majiteľov nedostane id ani nič iné o obchode, len
 *     DomainTakenError (HTTP 409 domain_taken s vysvetlením v jazyku žiadosti).
 *   - Feed, jazyk a ďalšie nastavenia mení len OVERENÝ majiteľ: Bearer token
 *     z /v1/ucet/over pre contact_email (premenná overeny).
 *   - Výnimka pre opravu feedu hneď po skúške (formulár arling.sk/asistent po
 *     chybe feedu pošle tú istú doménu a e-mail s opravenou adresou): smie aj
 *     neoverený majiteľ, len kým obchod nikdy nebol ready a vznikol pred
 *     menej ako SKUSKA_OPRAVA_MS (jeCerstvaSkuska).
 *   - Opätovné načítanie ULOŽENÉHO feedu (plugin „Try again“, obchod v chybe
 *     alebo 24 h bez načítania) ostáva pri zhode e-mailu: číta len vlastný
 *     feed obchodu a strážia ho limity rozpočtu.
 *   - Keď neoverený majiteľ pošle iný feed, ktorý meniť nesmie, obchod ostane
 *     bez zmeny a odpoveď nesie feed_treba_overit: true (formulár vtedy pýta
 *     kód a prosí o nové odoslanie).
 *
 * TRETIE KOLO 29. 9. 2026
 *
 * Každý skok feedu sa viaže na doménu obchodu. Výnimka oslovenia platí len
 * pre snímku mimo domény. Prvé pripojenie snímky bez zhody e-mailu prijíma
 * len kanonický Store API alebo Shopify katalóg, bez filtrov.
 * Ready obchod bez Bearera mení feed len po chybe, na kanonický katalóg
 * s aspoň polovicou produktov; pri tejto oprave sa nič nemaže. Prechod zo
 * snímky je prvé pripojenie: platí polovica produktov, stará snímka sa zmaže.
 * Overený majiteľ smie zmeniť feed na doméne aj bez predchádzajúcej chyby.
 * Zamietnutá zmena vráti feed_treba_overit a nespustí žiadne načítanie.
 * Prevzatie: len Bearer pre doménový alebo adminom uložený verejný kontakt.
 * Kanonický verejný feed bez kódu vlastníctvo nepreukazuje. Príznak prevziat
 * zakazuje vytvorenie účtu; preberá sa výhradne existujúce ID ukážky.
 */
export async function createTenantFromRequest(env, { feedUrl, domain, email, lang, zdroj, userAgent, overenyEmail = null, povolitOslovenie = false, lenPrevzatie = false }, { waitUntil, now = new Date() } = {}) {
  // Jazyk e-mailov a odkiaľ účet vznikol (návrh ops/asistent/zivotny-cyklus.md 1.3).
  // Zdroj `oslovenie` (režim ukážky) len s overeným admin tokenom (nález 1).
  const jazyk = jazykZoVstupu(lang);
  const zdrojUctu = zdrojZoVstupu(zdroj, userAgent, { povolitOslovenie });
  // Zdroj oslovenie vznikne len s admin tokenom (zdrojZoVstupu): náš skript
  // vytvor-ukazku.py, ktorého feed je na našom serveri, nie na doméne obchodu.
  const nasSkriptOsloveni = zdrojUctu === 'oslovenie';
  // Neplatné vstupy najprv ako doteraz (400 validation_failed), potom väzba
  // feedu na doménu (400 feed_other_domain). Obe pred čímkoľvek v D1, takže
  // odpoveď ani neprezradí, či doména už má obchod.
  validateTenantInput({ domain, feedUrl, contactEmail: email });
  if (!nasSkriptOsloveni) overFeedNaDomene(feedUrl, domain, jazyk, env);
  // Adresa potvrdená 6-miestnym kódom (Bearer z /v1/ucet/over). Len vtedy
  // smú ísť automatické e-maily E0 a E1 bez ďalších podmienok
  // (zivotny-cyklus.js mozeIst, adverzárna kontrola 25. 9. 2026).
  const poslanyNorm = String(email || '').trim().toLowerCase();
  const overeny = !!overenyEmail && !!poslanyNorm && bezpecnePorovnaj(String(overenyEmail).trim().toLowerCase(), poslanyNorm);
  if (lenPrevzatie && !overeny) throw new DomainTakenError(normaliseDomain(domain), jazyk);
  // WordPress môže poslať www; existujúcu ukážku tej istej domény nesmieme duplikovať.
  const host = bezWwwHost(normaliseDomain(domain));
  const bezWww = await getTenantByDomain(env.DB, host);
  const sWww = await getTenantByDomain(env.DB, 'www.' + host);
  if (bezWww && sWww && bezWww.id !== sWww.id) throw new DomainTakenError(host, jazyk);
  domain = (bezWww || sWww)?.domain || host;
  let tenant;
  try {
    // Formulár prevzatia nikdy nezakladá účet, ani keď ukážku súbežne niekto vymazal.
    if (lenPrevzatie) throw new DuplicateDomainError(normaliseDomain(domain));
    tenant = await createTenant(env.DB, { domain, feedUrl, contactEmail: email });
  } catch (err) {
    if (!(err instanceof DuplicateDomainError)) throw err;

    const existing = await getTenantByDomain(env.DB, domain);
    if (!existing && lenPrevzatie) throw new DomainTakenError(normaliseDomain(domain), jazyk);
    if (lenPrevzatie && existing && !['oslovenie', 'prevzate'].includes(existing.zdroj)) throw new DomainTakenError(existing.domain, jazyk);
    if (!existing) throw err; // should not happen (the row that caused the conflict must exist), but never swallow silently

    if (existing.zdroj === 'mazanie_oslovenia') throw new DomainTakenError(existing.domain, jazyk);
    if (lenPrevzatie && existing.zdroj === 'oslovenie' && !mozePrevziatOslovenie(existing, poslanyNorm)) throw new DomainTakenError(existing.domain, jazyk);
    const prevzatie = !nasSkriptOsloveni && overeny && mozePrevziatOslovenie(existing, poslanyNorm);
    if (prevzatie && !(await prevezmiOslovenie(env, existing, poslanyNorm, { now }))) {
      throw new DomainTakenError(existing.domain, jazyk);
    }
    // Od tejto chvíle je kontakt zmenený len po kóde; ďalšie pokusy iných adries zlyhajú.
    const majitelEmail = String(existing.contact_email || '').trim().toLowerCase();
    const jeMajitel = !!poslanyNorm && bezpecnePorovnaj(poslanyNorm, majitelEmail);
    // Ukážku osloveného obchodu sme založili my s verejnou adresou obchodu;
    // majiteľ ju pripojí pluginom s adresou administrátora (druhé kolo, R2).
    const oslovenyNaSnimke = jeOslovenieTenant(existing) && !feedPatriDomene(existing.feed_url, existing.domain);
    const cleanFeedUrl = String(feedUrl || '').trim();
    const kanonicky = jeKanonickyFeed(cleanFeedUrl, existing.domain);
    const pripojenieSnimky = oslovenyNaSnimke && kanonicky;
    // Po pripojení vlastného feedu zdroj oslovenie už neudeľuje výnimku.
    if (!jeMajitel && !pripojenieSnimky && !(nasSkriptOsloveni && oslovenyNaSnimke)) {
      throw new DomainTakenError(existing.domain, jazyk);
    }

    // overenyMajitel = Bearer pre contact_email (poslaný e-mail je majiteľov a Bearer patrí jemu).
    const overenyMajitel = overeny && jeMajitel;
    const inyFeed = !!cleanFeedUrl && cleanFeedUrl !== existing.feed_url;
    const bezi = existing.status === TENANT_STATUS.READY;
    const skriptSnimky = nasSkriptOsloveni && oslovenyNaSnimke;
    const opravaBezBearera = jeMajitel && !overenyMajitel && !skriptSnimky
      && !pripojenieSnimky && bezi && kanonicky
      && (await readIngestError(env, existing.id)) !== null;
    const smieFeed = inyFeed && (
      (feedPatriDomene(cleanFeedUrl, existing.domain)
        && (overenyMajitel || !bezi || pripojenieSnimky || opravaBezBearera))
      || skriptSnimky
    );
    // Bežiaci obchod prevezme nový feed až po úspešnom načítaní; ostatné hneď.
    const feedPoNacitani = smieFeed && existing.status === TENANT_STATUS.READY;
    if (smieFeed && !feedPoNacitani) {
      await setFeedUrl(env.DB, existing.id, cleanFeedUrl);
      existing.feed_url = cleanFeedUrl;
    }
    // Jazyk našich e-mailov len overený majiteľ alebo čerstvá skúška (zhoda e-mailu).
    if (jazyk && (overenyMajitel || (jeMajitel && (await jeCerstvaSkuska(env, existing, now))))) {
      await nastavJazyk(env, existing.id, jazyk);
      existing.jazyk = jazyk;
    }
    // Majiteľ, ktorý adresu práve potvrdil kódom: zapísať overenie.
    if (overenyMajitel) await poOvereniMajitela(env, existing, { now, waitUntil });
    if (smieFeed || (!inyFeed && isIngestionStale(existing, now))) {
      // Obchod v stave error sa pri novom pokuse prepne na pending hneď,
      // ešte pred načítaním. Inak by plugin po kliknutí na „Try again“
      // ďalej ukazoval starú chybu, kým načítanie nedobehne, a majiteľ by
      // nevedel, či sa vôbec niečo deje. Obchod, ktorý je ready, sa na
      // pending neprepína nikdy: chat by počas obnovy prestal odpovedať.
      if (existing.status === TENANT_STATUS.ERROR) {
        await setTenantStatus(env.DB, existing.id, TENANT_STATUS.PENDING);
        existing.status = TENANT_STATUS.PENDING;
      }
      await startIngestion(env, existing, waitUntil, {
        samoobsluzne: true,
        novyFeed: feedPoNacitani ? cleanFeedUrl : null,
        zmenenyFeed: smieFeed,
        minProduktov: smieFeed && bezi && !overenyMajitel && !skriptSnimky
          ? Math.ceil((Number(existing.product_count) || 0) / 2) : 0,
        zachovatKatalog: opravaBezBearera,
      });
    }

    const vysledok = {
      id: existing.id,
      domain: existing.domain,
      status: existing.status,
      plan: existing.plan,
      monthly_quota: existing.monthly_quota,
      existing: true,
      overeny: !!overenyMajitel,
      prevzate: existing.zdroj === 'prevzate',
    };
    // Zamietnutá zmena sa nenačíta ani pri starom katalógu.
    if (inyFeed && !smieFeed) vysledok.feed_treba_overit = true;
    return vysledok;
  }

  // Najprv udalosť vytvoreny (a jazyk, zdroj), až potom načítanie: E1 po
  // prvom ready sa pozerá práve na ňu. Zdroj aj na objekte, keby ho
  // poVytvoreni pri chybe D1 nestihol nastaviť: podľa neho sa pri sťahovaní
  // rozhoduje o väzbe na doménu (domenaFeeduObchodu).
  await poVytvoreni(env, tenant, { jazyk, zdroj: zdrojUctu, overeny, now, waitUntil });
  if (!tenant.zdroj) tenant.zdroj = zdrojUctu;
  await startIngestion(env, tenant, waitUntil, { samoobsluzne: true });
  tenant.overeny = overeny;
  return tenant;
}

/**
 * The public GET /v1/tenants/:id/status body. The tenant id sits in the
 * embed script of every shop page, so this is a public capability: it
 * carries usage and plan facts the shop's own dashboard needs, and never
 * contact_email or billing_ref (the Stripe subscription id). Those stay
 * available to the admin-token routes only (`includeBilling`, used by
 * handleSetPlanRoute below).
 *
 * Contract (shared with the arling.sk dashboard page):
 *   { id, domain, plan ("free"|"starter"|"pro"), status, monthly_quota,
 *     conversations_used (current UTC calendar month), usage_percent
 *     (integer 0..100), period_start ("YYYY-MM-01"), period_end (first day
 *     of next month), product_count, valid_until (or null), last_ingest
 *     (ISO or null), last_error (stable code while status is "error",
 *     otherwise null), live_demo and outreach_demo (booleans for the live
 *     demo page, see zivaUkazkaPovolena) }
 * `used_this_month` and `last_ingested_at` are kept as aliases of
 * conversations_used / last_ingest for the WordPress plugin and the Shopify
 * admin page, which still read the older names.
 */
/**
 * Smie živá ukážka na arling.sk/asistent/live/ ukázať tento obchod pod jeho
 * doménou? (bezpečnostná kontrola 29. 9. 2026, nález 4.) Stránka predtým
 * brala id aj meno obchodu z odkazu, takže ktokoľvek s vlastným účtom a
 * vlastným feedom ukázal svoje karty a odkazy pod menom cudzieho obchodu a
 * pod značkou ARLing. Áno len pre:
 *   - ukážku osloveného obchodu (zdroj oslovenie vzniká len s admin tokenom,
 *     ops/oslovenia/vytvor-ukazku.py),
 *   - obchod, ktorého feed leží na jeho vlastnej doméne alebo jej subdoméne
 *     (formulár odvodzuje doménu z feedu, plugin posiela Store API toho istého
 *     webu): taký obchod ukáže len skutočné produkty tej domény, takže
 *     odkaz „Vyskúšať Asistenta“ z e-mailu E1 funguje ďalej.
 * Feed na cudzej adrese (útočník s doménou obete) nie. Doména na úrovni
 * verejnej prípony (sk, myshopify.com) tiež nie (druhé kolo kontroly
 * 29. 9. 2026): pod ňou by „subdoménou“ bol ľubovoľný cudzí web. Demo obchod
 * a obchod z vlastnej skúšky v tom istom prehliadači povoľuje live.js sám.
 */
export function zivaUkazkaPovolena(tenant) {
  if (!tenant) return false;
  if (jeOslovenieTenant(tenant)) return true;
  return feedPatriDomene(tenant.feed_url, tenant.domain);
}

export async function tenantStatusResponse(env, tenantId, { now = new Date(), includeBilling = false } = {}) {
  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return null;
  const conversationsUsed = conversationsUsedThisMonth(tenant, now);
  const period = monthPeriod(now);
  const lastIngest = tenant.last_ingested_at || null;
  const body = {
    id: tenant.id,
    domain: tenant.domain,
    plan: publicPlanName(tenant.plan),
    status: tenant.status,
    monthly_quota: tenant.monthly_quota,
    conversations_used: conversationsUsed,
    usage_percent: usagePercent(conversationsUsed, tenant.monthly_quota),
    period_start: period.period_start,
    period_end: period.period_end,
    product_count: tenant.product_count || 0,
    // Null until a PATCH /v1/tenants/:id/plan call sets it (see
    // handleSetPlanRoute below): a free/never-upgraded tenant has no expiry.
    valid_until: tenant.valid_until || null,
    last_ingest: lastIngest,
    // Stabilný kód, prečo sa katalóg nenačítal (INGEST_ERRORS a
    // classifyFeedError vyššie), len kým je stav error; inak null. Nie je v
    // ňom nič citlivé: je to to isté, čo o obchode vidí ktokoľvek, kto si
    // jeho verejnú adresu produktov otvorí sám.
    last_error: tenant.status === TENANT_STATUS.ERROR ? await readIngestError(env, tenant.id) : null,
    used_this_month: conversationsUsed,
    last_ingested_at: lastIngest,
    // Živá ukážka na arling.sk (live.js): smie obchod ukázať pod jeho doménou
    // a je to ukážka pre oslovený obchod (text „pripravili sme z verejného
    // zoznamu“ len vtedy). Doplnené 29. 9. 2026, staré polia sa nemenia.
    live_demo: zivaUkazkaPovolena(tenant),
    outreach_demo: jeRezimUkazkyOslovenia(tenant),
    feed_pripojeny: feedPatriDomene(tenant.feed_url, tenant.domain),
  };
  if (includeBilling) {
    body.billing_ref = tenant.billing_ref || null;
  }
  return body;
}

// ---------------------------------------------------------------------------
// HTTP route glue
// ---------------------------------------------------------------------------

function jsonResponse(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

/**
 * Koľko obchodov smie jedna adresa založiť či obnoviť za hodinu.
 *
 * Do 21. 9. 2026 tu limit nebol vôbec: POST /v1/tenants stiahne cudzí feed a
 * pošle ho po kusoch do modelu na vektory, takže jedna požiadavka s feedom na
 * 5 000 produktov minie tisíce neurónov z dennej dávky. Bez limitu stačilo
 * volať to v cykle a asistent všetkých zákazníkov stíchol (a pri platenom
 * pláne by prišla faktúra). Desať za hodinu je nad rámec toho, čo poctivý
 * majiteľ e-shopu pri vypĺňaní formulára potrebuje.
 */
export const TENANT_CREATE_LIMIT_PER_HOUR = 10;
export const TENANT_CREATE_WINDOW_SECONDS = 3600;

/**
 * CORS headers for one of this module's responses, using the same allowlist
 * (and the same security.js helpers) as chat.js: the ALLOWED_ORIGINS env var
 * plus, when known, the tenant's own domain. Every JSON response this module
 * returns must go through this so a browser can actually read the response
 * (previously only the router's OPTIONS preflight carried CORS headers, so
 * the real POST/GET responses were silently blocked by the browser even
 * though the preflight said they would be allowed).
 */
function corsHeadersForRequest(request, env, extraAllowedDomains = []) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  return corsHeaders(origin, [...extraAllowedDomains, ...allowed]) || {};
}

/** X-Admin-Token rovný ASISTENT_ADMIN_ZAPIS (bez tajomstva nikdy). */
export function jeAdminZapis(request, env) {
  const tajne = env && env.ASISTENT_ADMIN_ZAPIS;
  const token = request.headers.get('X-Admin-Token') || '';
  return Boolean(tajne) && Boolean(token) && bezpecnePorovnaj(token, tajne);
}

export async function handleCreateTenantRoute(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = await checkRateLimit(env.ASISTENT_CACHE, ip, {
    limit: TENANT_CREATE_LIMIT_PER_HOUR,
    windowSeconds: TENANT_CREATE_WINDOW_SECONDS,
    name: 'tenants',
  });
  if (!rate.allowed) {
    return jsonResponse({ error: 'rate_limited' }, 429, corsHeadersForRequest(request, env));
  }

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400, corsHeadersForRequest(request, env));
  }
  try {
    const tenant = await createTenantFromRequest(
      env,
      {
        feedUrl: body && body.feed_url,
        domain: body && body.domain,
        email: body && body.email,
        lang: body && body.lang,
        zdroj: body && body.zdroj,
        lenPrevzatie: body?.prevziat === true,
        userAgent: request.headers.get('User-Agent') || '',
        overenyEmail: await overenyEmailZBearer(request, env),
        // Režim ukážky osloveného obchodu smie zapnúť len náš autorizovaný
        // skript (ops/oslovenia/vytvor-ukazku.py s X-Admin-Token =
        // ASISTENT_ADMIN_ZAPIS). Verejná registrácia so zdroj „oslovenie“ bez
        // tokenu dostane bežný zdroj (pokus 2 brány 28. 9., nález 1).
        povolitOslovenie: jeAdminZapis(request, env),
      },
      { waitUntil: ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : undefined }
    );
    const headers = corsHeadersForRequest(request, env, [tenant.domain]);
    // A repeat submission for an already-known domain by its owner (same
    // e-mail, see createTenantFromRequest's DuplicateDomainError handling) is
    // not an error: it comes back here as the existing tenant with
    // `existing: true` set, and gets 200 instead of 201, same shape otherwise.
    // Anyone else gets 409 domain_taken below.
    if (tenant.existing) {
      const telo = { id: tenant.id, domain: tenant.domain, status: tenant.status, existing: true, overeny: !!tenant.overeny, prevzate: !!tenant.prevzate };
      // O-25: plán, kvóta a kľúč stavu len overenému majiteľovi (Bearer pre
      // contact_email). Samotná zhoda e-mailu nestačí: adresa obchodu sa dá
      // uhádnuť (info@...), a tá istá odpoveď by prezradila, kto platí.
      if (tenant.overeny) {
        telo.plan = tenant.plan;
        telo.monthly_quota = tenant.monthly_quota;
        const kluc = await klucObchodu(env, tenant.id);
        if (kluc) telo.kluc_stavu = kluc;
      }
      if (tenant.feed_treba_overit) telo.feed_treba_overit = true;
      return jsonResponse(telo, 200, headers);
    }
    // Nový obchod: kto ho práve založil, dostane aj kľúč stavu (doplnok ho uloží).
    const nove = { id: tenant.id, domain: tenant.domain, status: tenant.status, plan: tenant.plan, monthly_quota: tenant.monthly_quota, overeny: !!tenant.overeny };
    const klucNoveho = await klucObchodu(env, tenant.id);
    if (klucNoveho) nove.kluc_stavu = klucNoveho;
    return jsonResponse(nove, 201, headers);
  } catch (err) {
    const headers = corsHeadersForRequest(request, env);
    if (err instanceof ValidationError) {
      return jsonResponse({ error: 'validation_failed', issues: err.issues }, 400, headers);
    }
    // Doména patrí obchodu s iným e-mailom: bez id a bez údajov obchodu. Plugin
    // 0.4.0 berie 409 ako chybu a ukáže vetu z issues (nie „Reconnected“).
    if (err instanceof DomainTakenError) {
      return jsonResponse({ error: 'domain_taken', issues: [err.sprava] }, 409, headers);
    }
    // Feed mimo domény obchodu: plugin 0.4.0 ukáže vetu z issues ako chybu pripojenia.
    if (err instanceof FeedOtherDomainError) {
      return jsonResponse({ error: 'feed_other_domain', issues: [err.sprava] }, 400, headers);
    }
    // Any D1 constraint violation that is not the domain-uniqueness case
    // above (which createTenantFromRequest already turns into a 200/201, not
    // an error at all) is the caller's fault in some other way, not ours:
    // 409, not a generic 500.
    if (err instanceof D1ConstraintError) {
      return jsonResponse({ error: 'conflict' }, 409, headers);
    }
    return jsonResponse({ error: 'internal_error' }, 500, headers);
  }
}

/**
 * Veľký audit 30. 9. 2026, oprava O-25 (nález 01 D9): id obchodu je verejne
 * v HTML každého obchodu s widgetom, takže plán, kvóta a spotreba vo
 * verejnom stave prezrádzali konkurencii, kto platí a koľko používa.
 * Verejne ostáva len to, čo verejné stránky naozaj potrebujú:
 *   id, status, product_count, live_demo   (zadanie O-25)
 *   domain, outreach_demo                  (živá ukážka live.js: meno obchodu
 *                                           a režim ukážky osloveného obchodu;
 *                                           návštevník sa prihlásiť nemôže)
 *   feed_pripojeny                         (prevzatie ukážky, prevzatie.js)
 * Doména je aj tak verejná (obchod sám), ostatné sú len áno/nie bez peňazí.
 */
export const VEREJNE_POLIA_STAVU = ['id', 'status', 'product_count', 'live_demo', 'domain', 'outreach_demo', 'feed_pripojeny'];

export function verejnyStavObchodu(status) {
  const out = {};
  for (const k of VEREJNE_POLIA_STAVU) if (k in status) out[k] = status[k];
  return out;
}

/**
 * Smie volajúci vidieť plný stav (plán, kvótu, spotrebu)? Áno pre
 * X-Admin-Token (ADMIN_TOKEN), pre kľúč stavu obchodu v X-Arling-Kluc
 * (doplnok WordPress od 0.4.1, ucet.js klucObchodu) a pre Bearer token účtu,
 * ktorého e-mail je contact_email obchodu. Nikdy nehádže.
 */
export async function smieVidietPlnyStav(request, env, tenantId) {
  try {
    const admin = request.headers.get('X-Admin-Token') || '';
    if (admin && env.ADMIN_TOKEN && bezpecnePorovnaj(admin, env.ADMIN_TOKEN)) return true;
    if (await jeKlucObchodu(env, tenantId, request.headers.get('X-Arling-Kluc') || '')) return true;
    if (request.headers.get('Authorization')) {
      const overeny = await overenyEmailZBearer(request, env);
      if (!overeny) return false;
      const tenant = await getTenantById(env.DB, tenantId);
      const majitel = String((tenant && tenant.contact_email) || '').trim().toLowerCase();
      return !!majitel && bezpecnePorovnaj(overeny, majitel);
    }
  } catch (e) {
    console.warn('[arling-asistent] overenie plneho stavu zlyhalo:', (e && e.message) || e);
  }
  return false;
}

export async function handleTenantStatusRoute(request, env, tenantId) {
  const status = await tenantStatusResponse(env, tenantId);
  const headers = corsHeadersForRequest(request, env, status ? [status.domain] : []);
  if (!status) return jsonResponse({ error: 'not_found' }, 404, headers);
  // ASISTENT_STATUS_VEREJNY = "plny" je len prechodný vypínač pre doplnok
  // WordPress 0.4.0 a starší (bez kľúča by platiacemu obchodu ukázal „Free“);
  // predvolene je verejný stav úzky.
  if (env.ASISTENT_STATUS_VEREJNY === 'plny' || (await smieVidietPlnyStav(request, env, tenantId))) {
    return jsonResponse(status, 200, headers);
  }
  return jsonResponse(verejnyStavObchodu(status), 200, headers);
}

// ---------------------------------------------------------------------------
// Admin: manual re-ingestion (POST /v1/tenants/:id/reingest)
// ---------------------------------------------------------------------------

/**
 * Re-run feed ingestion for one tenant on demand, e.g. right after fixing a
 * feed URL, or after creating a Vectorize metadata index that did not exist
 * at the tenant's original onboarding time. Uses the exact same
 * ingestFeedForTenant() the daily cron calls (see cron.js), so this is not a
 * separate code path to keep in sync.
 *
 * Protected by a shared secret header (not tenant- or session-based auth,
 * since this MVP has no admin login yet): the caller must send
 * `X-Admin-Token` matching the `ADMIN_TOKEN` secret
 * (`wrangler secret put ADMIN_TOKEN`, see README). If that secret is not
 * configured at all, the route refuses every request rather than silently
 * allowing unauthenticated re-ingestion.
 */
export async function handleReingestRoute(request, env, tenantId) {
  const headers = corsHeadersForRequest(request, env);
  const providedToken = request.headers.get('X-Admin-Token') || '';
  // Porovnanie v konstantnom case, rovnako ako isAdmin v upload.js.
  if (!env.ADMIN_TOKEN || !bezpecnePorovnaj(providedToken, env.ADMIN_TOKEN)) {
    return jsonResponse({ error: 'unauthorized' }, 401, headers);
  }

  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return jsonResponse({ error: 'not_found' }, 404, headers);

  const result = await ingestFeedForTenant(env, tenant);
  return jsonResponse(result, result.ok ? 200 : 502, headers);
}

// ---------------------------------------------------------------------------
// Admin: set plan / quota (PATCH or POST /v1/tenants/:id/plan)
// ---------------------------------------------------------------------------

const VALID_PLANS = new Set([PLANS.FREE, PLANS.STARTER, PLANS.PRO]);

/**
 * The one place a paid plan actually changes what a tenant is allowed to
 * use. Body: {plan: "free"|"starter"|"pro", monthly_quota?, billing_ref?,
 * valid_until?}. `monthly_quota` defaults to the plan's normal quota (see
 * DEFAULT_QUOTAS in tenants.js) when omitted; `billing_ref` and
 * `valid_until` are stored as-is (or cleared to null when omitted, e.g. a
 * downgrade to `free` clears a stale subscription id/expiry).
 *
 * This is what licence-service/app.py's Stripe webhook calls (with its own
 * ASISTENT_ADMIN_TOKEN, matching this worker's ADMIN_TOKEN) whenever a
 * checkout or renewal for an "asistent-*" plan arrives, and what the daily
 * expire_asistent_plans() cron there calls (with plan: "free") once
 * valid_until has passed. Same admin-token protection as
 * handleReingestRoute above: without ADMIN_TOKEN configured, every request
 * is refused, never silently allowed through.
 */
export async function handleSetPlanRoute(request, env, tenantId) {
  const headers = corsHeadersForRequest(request, env);
  const providedToken = request.headers.get('X-Admin-Token') || '';
  // Porovnanie v konstantnom case, rovnako ako isAdmin v upload.js.
  if (!env.ADMIN_TOKEN || !bezpecnePorovnaj(providedToken, env.ADMIN_TOKEN)) {
    return jsonResponse({ error: 'unauthorized' }, 401, headers);
  }

  let body;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400, headers);
  }

  const plan = body && body.plan;
  if (!VALID_PLANS.has(plan)) {
    return jsonResponse({ error: 'validation_failed', issues: ['plan must be one of free, starter, pro'] }, 400, headers);
  }

  const tenant = await getTenantById(env.DB, tenantId);
  if (!tenant) return jsonResponse({ error: 'not_found' }, 404, headers);

  const rawQuota = body && body.monthly_quota;
  const monthlyQuota = typeof rawQuota === 'number' && Number.isFinite(rawQuota) && rawQuota > 0 ? rawQuota : undefined;
  const billingRef = body && body.billing_ref != null ? String(body.billing_ref) : null;
  const validUntil = body && body.valid_until != null ? String(body.valid_until) : null;

  await setTenantPlan(env.DB, tenantId, { plan, monthlyQuota, billingRef, validUntil });
  // Udalosť plan (a zruseny pri páde z plateného na free) pre Twenty CRM.
  await poZmenePlanu(env, tenant, { plan, billingRef, validUntil });

  // Admin caller (licence-service webhook): echo billing_ref back so it can
  // confirm what was stored. The public status route never includes it.
  const updated = await tenantStatusResponse(env, tenantId, { includeBilling: true });
  return jsonResponse(updated, 200, headers);
}
