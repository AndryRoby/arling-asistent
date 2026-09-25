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
  ValidationError,
  DuplicateDomainError,
  D1ConstraintError,
  PLANS,
  conversationsUsedThisMonth,
  monthPeriod,
  usagePercent,
  publicPlanName,
} from './tenants.js';
import { fetchFeed, FeedUrlNotAllowedError } from './feed.js';
import { embedAndUpsertProducts, embedTexts } from './embed.js';
import { parseAllowedOrigins, corsHeaders, bezpecnePorovnaj, checkRateLimit, SECURITY_HEADERS } from './security.js';
import { hasBudget, spend, NEURONS } from './budget.js';
import { poVytvoreni, poNacitani, poZmenePlanu, nastavJazyk, jazykZoVstupu, zdrojZoVstupu, poOvereniMajitela, zapamatajVektory } from './zivotny-cyklus.js';
import { overenyEmailZBearer } from './ucet.js';

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
 * Download the tenant's feed, embed every product, and flip status to
 * ready/error. Safe to call again (re-ingestion on cron).
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
  await poNacitani(env, tenant, result, { bolReady });
  return result;
}

async function nacitajFeed(env, tenant, { samoobsluzne = false } = {}) {
  if (samoobsluzne) {
    const rozpocet = await hasBudget(env, INGEST_MIN_NEURONS);
    if (!rozpocet.ok) {
      console.warn('[arling-asistent] denny strop neuronov vycerpany, samoobsluzne nacitanie feedu odlozene:', rozpocet);
      await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
      await zapisChybuNacitania(env, tenant.id, INGEST_ERRORS.AI_BUDGET);
      return { ok: false, error: 'ai_budget_exhausted', code: INGEST_ERRORS.AI_BUDGET };
    }
  }

  // Stiahnutie feedu má vlastný try: jeho chyby sú chyby obchodu (firewall,
  // prihlasovanie, vypnuté REST API) a majiteľ ich vie opraviť, preto dostanú
  // vlastný kód. Chyba až pri vektoroch je naša a hlási sa ako internal.
  let feed;
  try {
    feed = await fetchFeed(tenant.feed_url, { fetchImpl: env.fetchImpl || fetch });
  } catch (err) {
    const code = classifyFeedError(err);
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
    await zapisChybuNacitania(env, tenant.id, code);
    return { ok: false, error: String((err && err.message) || err), code };
  }

  // Prázdny katalóg: nový obchod bez produktov (typický prvý test pluginu)
  // dostal doteraz stav ready a asistent potom na všetko odpovedal „neviem“.
  // Človek, ktorý to vidí, plugin zmaže. Poctivé je povedať mu, že nemáme čo
  // čítať. Obchod, ktorý už bežal, sa pri dennej obnove kvôli jednej prázdnej
  // odpovedi nevypína: vo Vectorize ostávajú jeho produkty a asistent nimi
  // odpovedá ďalej.
  if (feed.products.length === 0 && (samoobsluzne || tenant.status !== TENANT_STATUS.READY)) {
    await setProductCount(env.DB, tenant.id, 0);
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
    await zapisChybuNacitania(env, tenant.id, INGEST_ERRORS.NO_PRODUCTS);
    return { ok: false, error: INGEST_ERRORS.NO_PRODUCTS, code: INGEST_ERRORS.NO_PRODUCTS, feedType: feed.type };
  }

  try {
    const { products, type, truncated } = feed;
    const idsVektorov = [];
    const summary = await embedAndUpsertProducts(env, tenant.id, products, { ids: idsVektorov });
    // Zoznam id vektorov pre úplný výmaz účtu (zivotny-cyklus.js zmazTenanta):
    // Vectorize nevie vypísať vektory podľa metadát. Chyba zápisu nič nezhodí.
    await zapamatajVektory(env, tenant.id, idsVektorov);
    // Spotreba sa zapisuje vždy, aj pri cron obnove: je to najväčší žrút
    // neurónov v tejto službe a strop, ktorý ho nevidí, nechráni pred ničím.
    await spend(env, summary.chunkCount * NEURONS.embedPerText);
    await setProductCount(env.DB, tenant.id, summary.productCount);
    // Stav sa prepina ako prvy a bez podmienok. Zakaznik, ktory ma produkty
    // nacitane, nesmie ostat visiet na pending len preto, ze nam nieco
    // spadlo alebo trvalo prilis dlho.
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.READY);
    await zmazChybuNacitania(env, tenant.id);
    // Dopyt je uz len zistenie, ako dlho index potrebuje, nez zacne
    // odpovedat. Nic neblokuje a jeho vysledok ide do summary.
    const probe = await waitForQueryableIndex(env, tenant.id, products);
    return { ok: true, feedType: type, truncated, ...summary, indexProbe: probe };
  } catch (err) {
    const code = isAiCapacityMessage(err) ? INGEST_ERRORS.AI_BUDGET : INGEST_ERRORS.INTERNAL;
    await setTenantStatus(env.DB, tenant.id, TENANT_STATUS.ERROR);
    await zapisChybuNacitania(env, tenant.id, code);
    return { ok: false, error: String((err && err.message) || err), code };
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
 *   feed_too_many_redirects  (adresu sme odmietli ešte pred stiahnutím)
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
  if (message === 'unrecognised_feed_format' || err instanceof SyntaxError) return INGEST_ERRORS.NOT_READABLE;
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
 */
export async function createTenantFromRequest(env, { feedUrl, domain, email, lang, zdroj, userAgent, overenyEmail = null }, { waitUntil, now = new Date() } = {}) {
  // Jazyk e-mailov a odkiaľ účet vznikol (návrh ops/asistent/zivotny-cyklus.md 1.3).
  const jazyk = jazykZoVstupu(lang);
  const zdrojUctu = zdrojZoVstupu(zdroj, userAgent);
  // Adresa potvrdená 6-miestnym kódom (Bearer z /v1/ucet/over). Len vtedy
  // smú ísť automatické e-maily E0 a E1 bez ďalších podmienok
  // (zivotny-cyklus.js mozeIst, adverzárna kontrola 25. 9. 2026).
  const poslanyNorm = String(email || '').trim().toLowerCase();
  const overeny = !!overenyEmail && !!poslanyNorm && bezpecnePorovnaj(String(overenyEmail).trim().toLowerCase(), poslanyNorm);
  let tenant;
  try {
    tenant = await createTenant(env.DB, { domain, feedUrl, contactEmail: email });
  } catch (err) {
    if (!(err instanceof DuplicateDomainError)) throw err;

    const existing = await getTenantByDomain(env.DB, domain);
    if (!existing) throw err; // should not happen (the row that caused the conflict must exist), but never swallow silently

    const poslanyEmail = String(email || '').trim().toLowerCase();
    const majitelEmail = String(existing.contact_email || '').trim().toLowerCase();
    const jeMajitel = !!poslanyEmail && bezpecnePorovnaj(poslanyEmail, majitelEmail);

    const cleanFeedUrl = String(feedUrl || '').trim();
    const feedUrlChanged = jeMajitel && cleanFeedUrl && cleanFeedUrl !== existing.feed_url;
    if (feedUrlChanged) {
      await setFeedUrl(env.DB, existing.id, cleanFeedUrl);
      existing.feed_url = cleanFeedUrl;
    }
    // Len overený majiteľ smie zmeniť jazyk našich e-mailov.
    if (jeMajitel && jazyk) {
      await nastavJazyk(env, existing.id, jazyk);
      existing.jazyk = jazyk;
    }
    // Majiteľ, ktorý adresu práve potvrdil kódom: zapísať overenie.
    if (jeMajitel && overeny) await poOvereniMajitela(env, existing, { now, waitUntil });
    if (jeMajitel && (feedUrlChanged || isIngestionStale(existing, now))) {
      // Obchod v stave error sa pri novom pokuse prepne na pending hneď,
      // ešte pred načítaním. Inak by plugin po kliknutí na „Try again“
      // ďalej ukazoval starú chybu, kým načítanie nedobehne, a majiteľ by
      // nevedel, či sa vôbec niečo deje. Obchod, ktorý je ready, sa na
      // pending neprepína nikdy: chat by počas obnovy prestal odpovedať.
      if (existing.status === TENANT_STATUS.ERROR) {
        await setTenantStatus(env.DB, existing.id, TENANT_STATUS.PENDING);
        existing.status = TENANT_STATUS.PENDING;
      }
      await startIngestion(env, existing, waitUntil, { samoobsluzne: true });
    }

    return {
      id: existing.id,
      domain: existing.domain,
      status: existing.status,
      plan: existing.plan,
      monthly_quota: existing.monthly_quota,
      existing: true,
      overeny: !!(jeMajitel && overeny),
    };
  }

  // Najprv udalosť vytvoreny (a jazyk, zdroj), až potom načítanie: E1 po
  // prvom ready sa pozerá práve na ňu.
  await poVytvoreni(env, tenant, { jazyk, zdroj: zdrojUctu, overeny, now, waitUntil });
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
 *     otherwise null) }
 * `used_this_month` and `last_ingested_at` are kept as aliases of
 * conversations_used / last_ingest for the WordPress plugin and the Shopify
 * admin page, which still read the older names.
 */
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
        userAgent: request.headers.get('User-Agent') || '',
        overenyEmail: await overenyEmailZBearer(request, env),
      },
      { waitUntil: ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : undefined }
    );
    const headers = corsHeadersForRequest(request, env, [tenant.domain]);
    // A repeat submission for an already-known domain (see
    // createTenantFromRequest's DuplicateDomainError handling) is not an
    // error: it comes back here as the existing tenant with `existing: true`
    // set, and gets 200 instead of 201, same shape otherwise.
    if (tenant.existing) {
      return jsonResponse({ id: tenant.id, domain: tenant.domain, status: tenant.status, plan: tenant.plan, monthly_quota: tenant.monthly_quota, existing: true, overeny: !!tenant.overeny }, 200, headers);
    }
    return jsonResponse({ id: tenant.id, domain: tenant.domain, status: tenant.status, plan: tenant.plan, monthly_quota: tenant.monthly_quota, overeny: !!tenant.overeny }, 201, headers);
  } catch (err) {
    const headers = corsHeadersForRequest(request, env);
    if (err instanceof ValidationError) {
      return jsonResponse({ error: 'validation_failed', issues: err.issues }, 400, headers);
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

export async function handleTenantStatusRoute(request, env, tenantId) {
  const status = await tenantStatusResponse(env, tenantId);
  const headers = corsHeadersForRequest(request, env, status ? [status.domain] : []);
  if (!status) return jsonResponse({ error: 'not_found' }, 404, headers);
  return jsonResponse(status, 200, headers);
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
