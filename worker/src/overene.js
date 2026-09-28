/*
 * overene.js
 *
 * Overené odpovede ukážok pre oslovené obchody (28. 9. 2026, NALIEHAVÉ).
 *
 * Prečo: 28. 9. ráno odišli oslovenia s odkazom na živú ukážku
 * (arling.sk/asistent/live/?t=<tenant>&shop=...&q=...). Denný strop AI v tej
 * chvíli vyčerpali naše vlastné nočné testy a príprava ukážok, takže obchodník
 * po kliknutí na pripravenú otázku čítal „Asistent si dnes oddychuje“.
 *
 * Riešenie: pre obchod so zdrojom `oslovenie` (tenants.zdroj, zivotny-cyklus.js
 * ZDROJE) sa skontrolovaná odpoveď z prípravy (ops/oslovenia/fronta/*.json,
 * pole overenie) uloží do KV. Otázka, ktorá sa po normalizácii zhoduje s
 * pripravenou, dostane presne túto odpoveď a karty bez volania AI, bez vektora
 * a bez zápisu do ktoréhokoľvek stropu. Karty sú uložené celé (názov, adresa,
 * cena, mena, obrázok), lebo v KV nie je nič, z čoho by sa dali dopočítať.
 *
 * Zápis: PUT /v1/admin/asistent/overene/:tenant s X-Admin-Token rovným
 * ASISTENT_ADMIN_ZAPIS (ten istý vzor ako výmaz účtu). GET vráti uložené,
 * DELETE ich zmaže (pri výmaze ukážky). Dáta pripraví
 * ops/oslovenia/predohrej-ukazky.py.
 *
 * Keď je rezerva ukážok minutá (budget.js rezervaOslovenia), ukážka nepovie
 * „oddychuje“, ale vecnú vetu a ponúkne pripravené otázky (demoVycerpane).
 */

import { SECURITY_HEADERS, bezpecnePorovnaj } from './security.js';
import { jeRezimUkazkyOslovenia } from './budget.js';

export const OVERENE_MAX_POLOZIEK = 6;
export const OVERENE_MAX_KARIET = 3;
const MAX_OTAZKA = 300;
const MAX_ODPOVED = 2000;
const MAX_NAZOV = 300;
const MAX_URL = 1000;
/**
 * Najväčšie telo PUT v bajtoch (pokus 2 brány 28. 9., nález 8). Plné telo
 * podľa limitov polí vyššie (6 položiek, 3 karty) má asi 60 000 znakov;
 * skutočné ukážky majú pod 5 kB. Nad limitom 413, aj bez Content-Length.
 */
export const OVERENE_MAX_BAJTOV = 64 * 1024;

export const kluceOverene = (tenantId) => `overene:${tenantId}`;

/**
 * Aktívna ukážka osloveného obchodu: zdroj `oslovenie` a plán bez platby.
 * Platiaci obchod pevné odpovede nikdy nedostane (budget.js, nález 2).
 */
export const jeOslovenie = jeRezimUkazkyOslovenia;

/**
 * Otázka na porovnanie: bez diakritiky, malé písmená, interpunkcia a medzery
 * zlúčené. „Akú kávu odporúčate do moka kanvičky?“ = „aku kavu odporucate do
 * moka kanvicky“. Tlačidlo na stránke posiela presný text, ručne písaná
 * otázka sa líši najviac v diakritike a otázniku.
 *
 * Znaky s významom v čísle ostávajú (pokus 2 brány 28. 9., nález 7: „1,5 kg“
 * a „1-5 kg“ dávali rovnaký kľúč „1 5 kg“): desatinná čiarka alebo bodka
 * medzi číslicami je „.“, pomlčka medzi číslami (rozsah) „-“, lomka „/“,
 * percento po čísle „%“. „1,5 kg“ = „1.5 kg“, ale nie „1-5 kg“ ani „15 kg“.
 * Mínus pred číslom, nie po písmene ani číslici, je znamienko: „-5 °C“ dáva
 * „-5 c“, nie „5 c“ (pokus 3 brány 28. 9., nález D).
 * To isté pravidlo má ops/oslovenia/predohrej-ukazky.py normalizuj(), spoločné
 * prípady sú v tests/fixtures/normalizacia-otazok.json.
 */
const ZN = { '.': '', '-': '', '/': '', '%': '' };
export function normalizujOtazku(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Číslice ako \d v Pythone (Unicode Nd), aby obe strany dali ten istý kľúč.
    .replace(/(\p{Nd})[.,](?=\p{Nd})/gu, `$1${ZN['.']}`)
    .replace(/(\p{Nd})\s*[-‐-―−]\s*(?=\p{Nd})/gu, `$1${ZN['-']}`)
    // Záporné znamienko (pokus 3 brány 28. 9., nález D): mínus priamo pred
    // číslom, ktorému nepredchádza písmeno ani číslica. „-5 °C“ nie je „5 °C“.
    .replace(/(?<![\p{L}\p{N}])[-‐-―−](?=\p{Nd})/gu, ZN['-'])
    .replace(/(\p{Nd})\s*\/\s*(?=\p{Nd})/gu, `$1${ZN['/']}`)
    .replace(/(\p{Nd})\s*%/gu, `$1${ZN['%']}`)
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .trim()
    .replace(/[-]/g, (z) => Object.keys(ZN).find((k) => ZN[k] === z));
}

function httpUrl(u, { povinne = false } = {}) {
  const s = String(u == null ? '' : u).trim();
  if (!s) {
    if (povinne) throw new Error('chyba_url');
    return '';
  }
  let p;
  try {
    p = new URL(s);
  } catch (e) {
    throw new Error('zla_url');
  }
  if (!/^https?:$/.test(p.protocol) || s.length > MAX_URL) throw new Error('zla_url');
  return s;
}

function text(v, max, nazov) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw new Error(`prazdne_${nazov}`);
  if (s.length > max) throw new Error(`dlhe_${nazov}`);
  return s;
}

/**
 * Kontrola tela PUT. Vracia {polozky:[{otazka, odpoved, karty:[{title, url,
 * price, currency, image}]}]} alebo hádže Error s krátkym kódom.
 */
export function validujOverene(body) {
  const zoznam = body && Array.isArray(body.polozky) ? body.polozky : null;
  if (!zoznam || !zoznam.length) throw new Error('chybaju_polozky');
  if (zoznam.length > OVERENE_MAX_POLOZIEK) throw new Error('vela_poloziek');
  const videne = new Set();
  const polozky = zoznam.map((p) => {
    const otazka = text(p && p.otazka, MAX_OTAZKA, 'otazka');
    const kluc = normalizujOtazku(otazka);
    if (!kluc) throw new Error('prazdne_otazka');
    if (videne.has(kluc)) throw new Error('dvakrat_otazka');
    videne.add(kluc);
    const odpoved = text(p.odpoved, MAX_ODPOVED, 'odpoved');
    const karty = Array.isArray(p.karty) ? p.karty : [];
    if (karty.length > OVERENE_MAX_KARIET) throw new Error('vela_kariet');
    return {
      otazka,
      odpoved,
      karty: karty.map((k) => {
        const cena = k && k.price != null && k.price !== '' ? Number(k.price) : null;
        if (cena != null && !Number.isFinite(cena)) throw new Error('zla_cena');
        return {
          title: text(k && k.title, MAX_NAZOV, 'nazov'),
          url: httpUrl(k.url, { povinne: true }),
          price: cena,
          currency: String(k.currency || '').trim().slice(0, 8),
          image: httpUrl(k.image),
        };
      }),
    };
  });
  return { polozky };
}

/** Uložené overené odpovede obchodu, alebo null. Chyba KV = null (odpovie sa bežnou cestou). */
export async function nacitajOverene(env, tenantId) {
  const kv = env && env.ASISTENT_CACHE;
  if (!kv || !tenantId) return null;
  try {
    const d = await kv.get(kluceOverene(tenantId), 'json');
    return d && Array.isArray(d.polozky) ? d : null;
  } catch (e) {
    console.error('[arling-asistent] overene odpovede sa nedali nacitat:', (e && e.message) || e);
    return null;
  }
}

export function najdiOverenu(data, otazka) {
  const kluc = normalizujOtazku(otazka);
  if (!kluc || !data || !Array.isArray(data.polozky)) return null;
  return data.polozky.find((p) => normalizujOtazku(p.otazka) === kluc) || null;
}

// ---------------------------------------------------------------------------
// Ukážka pri minutej rezerve
// ---------------------------------------------------------------------------

/*
 * Vety podľa príčiny (pokus 2 brány 28. 9., nález 6). Nesľubujú nič, čo
 * systém nezaručí: žiadne „od zajtra“ (obnovenie modelu po výpadku nie je
 * isté a limit sa obnoví o polnoci UTC, nie ráno). Pripravené otázky sa
 * spomenú, len keď naozaj existujú (widget ich ukáže ako tlačidlá).
 *   limit:    dnešný limit ukážky (rezerva, spoločný strop, kvóta) je minutý,
 *   vypadok:  model zlyhal (technický výpadok),
 *   navrhy:   doplnok, keď sú pripravené otázky.
 */
const VYCERPANE = {
  limit: {
    sk: 'Táto ukážka už dnes minula svoj limit odpovedí, na ďalšie otázky teraz neodpovie.',
    cs: 'Tato ukázka už dnes vyčerpala svůj limit odpovědí, na další otázky teď neodpoví.',
    en: 'This demo has used up its answer limit for today, so it cannot answer further questions right now.',
    de: 'Diese Vorschau hat ihr Antwortlimit für heute aufgebraucht und beantwortet jetzt keine weiteren Fragen.',
  },
  vypadok: {
    sk: 'Na ďalšie otázky teraz neviem odpovedať, nastala technická chyba.',
    cs: 'Na další otázky teď neumím odpovědět, nastala technická chyba.',
    en: 'I cannot answer further questions right now because of a technical error.',
    de: 'Wegen eines technischen Fehlers kann ich weitere Fragen gerade nicht beantworten.',
  },
  navrhy: {
    sk: 'Pripravené otázky nižšie odpovedajú aj teraz.',
    cs: 'Připravené otázky níže odpovídají i teď.',
    en: 'The prepared questions below still work.',
    de: 'Die vorbereiteten Fragen unten funktionieren weiterhin.',
  },
};

/**
 * Odpoveď ukážky osloveného obchodu, keď na AI nezostalo (`druh` 'limit':
 * rezerva ukážok, spoločný strop, mesačná kvóta) alebo model zlyhal
 * ('vypadok'). Stojí nula: bez vektora, bez modelu. `navrhy` sú pripravené
 * otázky; widget z nich spraví tlačidlá a veta ich spomenie len vtedy.
 */
export function demoVycerpane(lang, data, druh = 'limit') {
  const l = ['sk', 'cs', 'en', 'de'].includes(lang) ? lang : 'sk';
  const navrhy = data && Array.isArray(data.polozky) ? data.polozky.map((p) => p.otazka).filter(Boolean).slice(0, OVERENE_MAX_POLOZIEK) : [];
  const veta = (VYCERPANE[druh] || VYCERPANE.limit)[l];
  return { answer: navrhy.length ? `${veta} ${VYCERPANE.navrhy[l]}` : veta, products: [], navrhy };
}

// ---------------------------------------------------------------------------
// Admin cesta
// ---------------------------------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS },
  });
}

/**
 * Telo požiadavky ako text, najviac `max` bajtov, inak null (413). Content-Length
 * nad limitom sa odmietne hneď; bez neho (alebo keď klame) sa prúd číta po
 * kúskoch a čítanie sa zastaví pri prvom bajte nad limitom, takže sa celé
 * veľké telo nikdy nenačíta do pamäte (pokus 2 brány 28. 9., nález 8).
 */
export async function citajTeloSLimitom(request, max) {
  const dlzka = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(dlzka) && dlzka > max) return null;
  if (!request.body) return '';
  const citac = request.body.getReader();
  const kusy = [];
  let spolu = 0;
  for (;;) {
    const { done, value } = await citac.read();
    if (done) break;
    spolu += value.byteLength;
    if (spolu > max) {
      await citac.cancel().catch(() => {});
      return null;
    }
    kusy.push(value);
  }
  const vsetko = new Uint8Array(spolu);
  let o = 0;
  for (const k of kusy) {
    vsetko.set(k, o);
    o += k.byteLength;
  }
  return new TextDecoder().decode(vsetko);
}

/**
 * GET/PUT/DELETE /v1/admin/asistent/overene/:tenant (X-Admin-Token =
 * ASISTENT_ADMIN_ZAPIS). PUT prepíše všetky overené odpovede obchodu naraz.
 * Len pre obchod so zdrojom `oslovenie`: platiacemu zákazníkovi sa pevné
 * odpovede nikdy nepodstrčia (409 nie_oslovenie).
 */
export async function handleOvereneRoute(request, env, tenantId, deps = {}) {
  if (!env || !env.ASISTENT_ADMIN_ZAPIS) return json({ error: 'admin_zapis_nenastaveny' }, 503);
  const token = request.headers.get('X-Admin-Token') || '';
  if (!token || !bezpecnePorovnaj(token, env.ASISTENT_ADMIN_ZAPIS)) return json({ error: 'unauthorized' }, 401);
  if (!env.ASISTENT_CACHE) return json({ error: 'kv_chyba' }, 503);

  const tenantsMod = deps.tenants || (await import('./tenants.js'));
  const tenant = await tenantsMod.getTenantById(env.DB, tenantId);
  if (!tenant) return json({ error: 'unknown_tenant' }, 404);
  if (!jeOslovenie(tenant)) return json({ error: 'nie_oslovenie' }, 409);

  const kluc = kluceOverene(tenant.id);
  if (request.method === 'GET') {
    return json({ tenant: tenant.id, domena: tenant.domain, ...((await nacitajOverene(env, tenant.id)) || { polozky: [] }) });
  }
  if (request.method === 'DELETE') {
    await env.ASISTENT_CACHE.delete(kluc);
    return json({ ok: true, zmazane: kluc });
  }

  const text = await citajTeloSLimitom(request, OVERENE_MAX_BAJTOV);
  if (text == null) return json({ error: 'body_too_large', max_bajtov: OVERENE_MAX_BAJTOV }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'invalid_json' }, 400);
  }
  let data;
  try {
    data = validujOverene(body);
  } catch (e) {
    return json({ error: 'validation_failed', dovod: e.message }, 400);
  }
  // Ukážka sa maže do 30 dní (arling.sk/privacy/#s8a): KV záznam po 35 dňoch sám zmizne.
  await env.ASISTENT_CACHE.put(kluc, JSON.stringify({ ...data, zapisane: new Date().toISOString() }), { expirationTtl: 35 * 24 * 3600 });
  return json({ ok: true, tenant: tenant.id, domena: tenant.domain, polozky: data.polozky.length });
}
