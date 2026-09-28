/*
 * ochrana.js
 *
 * Spoločná cesta každej otázky na /v1/chat a /v1/gift okolo volania modelu
 * (ops/asistent/genialny-plan.md 2.2 a 2.4, krok 1, a oprava nálezov jeho
 * kontroly v ops/asistent/stavba/krok1-ochrana.md). Obe cesty ju volajú v
 * rovnakom poradí, aby /v1/gift bol chránený presne ako /v1/chat.
 *
 * Hlavička Origin nie je ochrana: skript ju pridá jedným parametrom (curl
 * -H "Origin: ..."). Filtruje len neúmyselných klientov. Skutočnú ochranu dávajú
 * limity nižšie, ktoré sa REZERVUJÚ atomicky v D1 pred volaním modelu
 * (pocty.js), takže ich neobíde ani súbežná dávka požiadaviek.
 *
 * predOtazkou (pred modelom):
 *   1. relácia: podpísaný token (relacia.js); opakovanie staršieho tokenu je
 *      nový rozhovor; bez tajomstva staré `session` v KV,
 *   2. mesačná kvóta len pre nový rozhovor (vyčerpaná = 429 quota_exceeded),
 *   3. spoločná spotreba: pri 150 % stropu 503 (budget.js rozhodniRezim),
 *   4. 60 otázok za deň na (obchod, sieť IP), nad tým 429 rate_limited,
 *   5. rezervácia pre odpoveď modelom, všetko naraz a atomicky: spoločný strop
 *      (horný odhad neurónov), denný strop obchodu v otázkach aj v neurónoch,
 *      otázky s modelom na (obchod, sieť) a na sieť cez všetky obchody; pri
 *      novom rozhovore aj 5 na (obchod, sieť), denný strop nových rozhovorov
 *      obchodu a jeden rozhovor z mesačnej kvóty. Keď sa čokoľvek nezmestí,
 *      rezervácie sa vrátia a odpovedá kód bez modelu (nie chyba),
 *   6. odpoveď bez modelu má vlastný denný strop obchodu (nad ním 429) a nový
 *      rozhovor bez modelu sa do mesačnej kvóty nezapočíta.
 *
 * poOtazke (po úspešnej odpovedi): najprv náklady (doúčtovanie rezervácie na
 * skutočnosť, D1 counters, výstrahy), potom rozhovor (riadok counters, pingy
 * kvóty, životný cyklus), nakoniec nový token relácie.
 *
 * poChybe (výpočet zlyhal): rezervácie sa vrátia okrem ceny už vykonaných
 * platených volaní (W1, krok 1 asistenta), kvóta sa neodráta a zákazníkovi
 * nezostane minutý denný limit IP (nález 10).
 *
 * Do D1 ide len počet otázok, tokeny, neuróny a počet odpovedí bez modelu za
 * deň a obchod a v asistent_pocty kôš 0 až 65 535 namiesto IP. Nikdy text
 * otázky, id relácie ani IP (plán 1.3, úroveň A).
 */

import {
  checkConversationQuota,
  recordConversation,
  conversationsUsedThisMonth,
  isValidSessionId,
  conversationSessionKey,
  zapisNaklady,
  dayKey,
  monthKey,
  rezervujRozhovor,
  vratRozhovor,
  potvrdRozhovor,
} from './tenants.js';
import {
  bezpecnePorovnaj,
  kosIp,
  DENNY_LIMIT_IP_OTAZKY,
  DENNY_LIMIT_IP_ROZHOVORY,
  DENNY_LIMIT_IP_AI,
  DENNY_LIMIT_IP_AI_SPOLU,
} from './security.js';
import { overRelaciu, vydajRelaciu, noveIdRelacie, jeOpakovanie, zapamatajN } from './relacia.js';
import {
  isOurTest,
  rozhodniRezim,
  marzaPercento,
  prahNakladyDen,
  jeUkazka,
  dennyStropObchodu,
  neuronovePolozky,
  bezAiStropObchodu,
  dennyStropNovychRozhovorov,
  limitIpAiObchodu,
  jeRezimUkazkyOslovenia,
  MILI,
} from './budget.js';
import { rezervuj, vrat, pripocitaj, citaj, kluce } from './pocty.js';
import { maybeNotifyQuota, pingOchrana, zaznamenajChybuAI } from './notify.js';
import { poRozhovore } from './zivotny-cyklus.js';

/** Výstraha obchod_marza pri nákladoch nad týmto % denného čistého príjmu (NP:148). */
export const MARZA_PRAH_PERCENT = 50;

/** Náš interný beh minul svoj denný bazén (budget.js internyLimit): chyba len pre nás. */
export const INTERNY_STROP = Object.freeze({ status: 429, obj: Object.freeze({ error: 'interny_strop' }) });

/**
 * Naše meranie kvality na ukážke (ops/asistent/genialny-plan.md 4.3): hlavička
 * X-Arling-Meranie rovná tajomstvu MERANIE_TOKEN obíde len denné limity na IP.
 * Model, kvóta a stropy bežia normálne. Vlastné tajomstvo, nie ADMIN_TOKEN
 * (ten mení plány obchodov a do skriptu merania nepatrí).
 */
export function jeNaseMeranie(request, env) {
  if (!env || !env.MERANIE_TOKEN) return false;
  const hlavicka = request && request.headers && request.headers.get('X-Arling-Meranie');
  return Boolean(hlavicka) && bezpecnePorovnaj(hlavicka, env.MERANIE_TOKEN);
}

// Raz za izolát do logu (wrangler tail), či Workers AI vracia pole usage.
// Pole je NEOVERENÉ (NP:216); bez neho sú tokeny v counters odhad z dĺžky.
let usageOhlasene = false;

function naPozadi(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return Promise.resolve();
  }
  return promise;
}

/**
 * Vráti rezervácie požiadavky (chyba modelu, nezmestila sa iná rezervácia).
 * `okrem` = druh, ktorý ostáva (napr. 'ip': otázka sa započíta do denného
 * limitu siete, aj keď odpovedá kód bez modelu). Nikdy nehádže.
 */
async function vratRezervacie(env, k, { okrem = null, ponechatMili = 0 } = {}) {
  const db = env.DB;
  const zoznam = k.rezervacie.splice(0);
  // `ponechatMili` = cena už vykonaných platených volaní (vektory, model): v
  // každom počítadle neurónov ostane presne tá, zvyšok rezervácie sa vráti
  // (pokus 3 brány 28. 9., nález A; krok 1 asistenta, W1: aj pri výnimke a pri
  // internom odmietnutí). Keď rezervácia v počítadle nestačila, rozdiel sa
  // pripočíta: vykonaný výpočet je zaplatený, nesmie z počítadiel zmiznúť.
  const neuronove = new Set((k.neuronove || []).map(([kluc]) => kluc));
  const ponechat = Math.max(0, Math.ceil(Number(ponechatMili) || 0));
  const zostava = new Map();
  const ulohy = [];
  for (const r of zoznam) {
    if (okrem && r.druh === okrem) {
      k.rezervacie.push(r);
      continue;
    }
    if (ponechat > 0 && neuronove.has(r.kluc)) {
      const uz = zostava.get(r.kluc) || 0;
      const nechaj = Math.min(ponechat - uz, r.pocet);
      if (nechaj > 0) {
        zostava.set(r.kluc, uz + nechaj);
        k.rezervacie.push({ kluc: r.kluc, pocet: nechaj, druh: 'vektor' });
      }
      if (r.pocet - Math.max(0, nechaj) > 0) ulohy.push(vrat(db, r.kluc, r.pocet - Math.max(0, nechaj)));
      continue;
    }
    ulohy.push(vrat(db, r.kluc, r.pocet));
  }
  if (ponechat > 0) {
    for (const kluc of neuronove) {
      const chyba = ponechat - (zostava.get(kluc) || 0);
      if (chyba > 0) {
        ulohy.push(pripocitaj(db, kluc, k.den, chyba));
        k.rezervacie.push({ kluc, pocet: chyba, druh: 'vektor' });
      }
    }
  }
  if (k.mesacna) {
    ulohy.push(vratRozhovor(db, k.tenant.id));
    k.mesacna = null;
  }
  const vysledky = await Promise.allSettled(ulohy);
  for (const v of vysledky) {
    if (v.status === 'rejected') console.error('[arling-asistent] vratenie rezervacie zlyhalo:', (v.reason && v.reason.message) || v.reason);
  }
  k.odhadMili = ponechat;
}

/**
 * Skúsi naraz rezervovať všetky položky [kluc, pocet, limit, dovod]. Buď sú
 * všetky zapísané (vracia null), alebo sa zapísané vrátia a vracia dôvod prvej,
 * ktorá sa nezmestila. Chyba D1 = 'chyba_d1' (odpovedá sa bez modelu).
 */
async function rezervujVsetko(env, k, polozky, druh = 'ai') {
  const db = env.DB;
  const vysledky = await Promise.all(
    polozky.map(async ([kluc, pocet, limit, dovod]) => {
      try {
        const v = await rezervuj(db, kluc, k.den, pocet, limit);
        return v == null ? { ok: false, dovod } : { ok: true, kluc, pocet };
      } catch (err) {
        console.error('[arling-asistent] rezervacia v D1 zlyhala, odpovedam bez modelu:', (err && err.message) || err);
        return { ok: false, dovod: 'chyba_d1' };
      }
    })
  );
  const ok = vysledky.filter((v) => v.ok);
  const zle = vysledky.find((v) => !v.ok);
  if (!zle) {
    k.rezervacie.push(...ok.map(({ kluc, pocet }) => ({ kluc, pocet, druh })));
    return null;
  }
  await Promise.allSettled(ok.map((v) => vrat(db, v.kluc, v.pocet)));
  return zle.dovod;
}

const DOVODY_ZNEUZITIA = {
  denny_strop: 'strop',
  limit_ip: 'ip',
  limit_ip_rozhovory: 'ip',
  nove_rozhovory: 'nove',
  bez_ai_strop: 'bezai',
  ip_otazky: 'ip',
};

/** Výstraha zneuzitie na pozadí (ctx.waitUntil), nie v ceste požiadavky (tretie kolo, nález 6). */
async function vystrahaZneuzitia(env, k, dovod, ctx) {
  const skupina = DOVODY_ZNEUZITIA[dovod];
  if (!skupina) return;
  await naPozadi(ctx, pingOchrana(env, { event: 'zneuzitie', tenantId: k.tenant.id, percent: 0, kluc: `${skupina}:${k.tenant.id}:${k.den}`, now: k.now }));
}

/**
 * Kontroly a rezervácie pred modelom. Vracia buď {chyba: {status, obj}, k?}
 * (odpoveď bez modelu a bez započítania), alebo {k} s kontextom pre poOtazke
 * a poChybe. `odhad` = horný odhad neurónov volania (budget.js NEURONS).
 */
export async function predOtazkou(request, env, { tenant, body, odhad, now = new Date(), ctx = null } = {}) {
  const kv = env.ASISTENT_CACHE;
  const db = env.DB;
  const test = isOurTest(request, env);
  const meranie = !test && jeNaseMeranie(request, env);
  const den = dayKey(now);
  const ukazka = jeUkazka(env, tenant);
  // Ukážka osloveného obchodu, na ktorú sa nepýtame my (budget.js, rezerva
  // ukážok). Mesačná kvóta a denný strop nových rozhovorov sa jej netýkajú:
  // 28. 9. ich minuli naše testy s novou reláciou na každú otázku a obchodník
  // potom čítal „oddychuje“. Strop drží rezerva ukážok a limity siete.
  // Platiaci obchod (starter, pro) so zdrojom oslovenie ide bežnou platenou
  // cestou (nález 2 pokusu 2): mesačná kvóta, spoločný strop, bez rezervy.
  const oslovenie = !test && !meranie && jeRezimUkazkyOslovenia(tenant);
  const bezKvoty = oslovenie || meranie;

  // 1. Relácia.
  const relacia = await overRelaciu(env, tenant.id, body && body.relacia, { now: now.getTime() });
  let novy = true;
  let sessionKey = null;
  let opakovanie = false;
  if (relacia.stav === 'vypnuta') {
    // Starý režim bez UCET_TAJOMSTVO: (obchod, session) v KV na 24 hodín.
    sessionKey = kv && isValidSessionId(body && body.session) ? conversationSessionKey(tenant.id, body.session) : null;
    if (sessionKey) {
      try {
        novy = (await kv.get(sessionKey)) == null;
      } catch (err) {
        console.warn('[arling-asistent] conversation session KV get failed, counting this request:', (err && err.message) || err);
      }
    }
  } else if (relacia.stav === 'platna') {
    opakovanie = await jeOpakovanie(env, tenant.id, relacia);
    novy = opakovanie;
  }

  // 2. Mesačná kvóta, len keď začína nový rozhovor (rýchla kontrola; atomická rezervácia je v kroku 5).
  let kvota;
  if (novy && !bezKvoty) {
    kvota = await checkConversationQuota(db, tenant.id, { now, tenant });
    if (!kvota.allowed) return { chyba: { status: 429, obj: { error: 'quota_exceeded' } } };
  } else {
    const used = conversationsUsedThisMonth(tenant, now);
    const quota = Number(tenant.monthly_quota) || 0;
    kvota = { allowed: true, used, quota, remaining: Math.max(0, quota - used) };
  }

  const k = {
    tenant, novy, opakovanie, relacia, sessionKey, kvota, test, now, den, ukazka, oslovenie, meranie,
    rezim: null, rezervacie: [], mesacna: null, odhadMili: 0,
    // Počítadlá neurónov s limitmi (budget.js neuronovePolozky): do nich ide
    // odhad, dorezervovanie hornej hranice aj doúčtovanie skutočnosti.
    neuronove: neuronovePolozky(env, tenant, den, { ukazka, meranie, oslovenie }),
  };
  if (test) return { k };

  // 3. Spoločná spotreba (čítanie): 503 až pri 150 % stropu.
  const rozhodnutie = await rozhodniRezim(env, tenant, { odhad, now: now.getTime(), ukazka, oslovenie, meranie });
  k.rezim = { rezim: rozhodnutie.rezim, dovod: rozhodnutie.dovod, used: rozhodnutie.used, limit: rozhodnutie.limit };
  if (rozhodnutie.rezim === 'stop') {
    console.warn('[arling-asistent] tvrdy strop neuronov (150 %):', { used: rozhodnutie.used, limit: rozhodnutie.limit });
    return { chyba: { status: 503, obj: { error: 'quota_exceeded' }, zivotnyCyklus: true }, k };
  }
  if (rozhodnutie.rezim === 'interny_strop') return { chyba: INTERNY_STROP, k };

  // 4. Tvrdý denný limit otázok na (obchod, sieť IP). Naše meranie ho obchádza.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const kos = ip && ip !== 'unknown' && !meranie ? await kosIp(ip, den, env.UCET_TAJOMSTVO || '') : null;
  if (kos != null) {
    const zle = await rezervujVsetko(env, k, [[kluce.ipOtazky(tenant.id, den, kos), 1, DENNY_LIMIT_IP_OTAZKY, 'ip_otazky']], 'ip');
    if (zle === 'ip_otazky') {
      await vystrahaZneuzitia(env, k, zle, ctx);
      return { chyba: { status: 429, obj: { error: 'rate_limited' } } };
    }
  }

  // 5. Rezervácia pre odpoveď modelom. Neuróny idú naraz do všetkých
  // počítadiel z neuronovePolozky: platiaci proti stropu platených, bezplatný
  // a ukážka proti 80 % (bazén free), atomicky aj pri súbehu (nález K8).
  let rezim = rozhodnutie.rezim;
  let dovod = rozhodnutie.dovod;
  if (rezim === 'ai') {
    const odhadMili = Math.ceil(odhad * MILI);
    const polozky = k.neuronove.map(([kluc, limit, d]) => [kluc, odhadMili, limit, d]);
    // Denné otázky obchodu náš interný beh nezapočítava: inak by príprava
    // ukážky minula osloveného obchodu jeho denný strop otázok.
    if (!meranie) polozky.push([kluce.ai(tenant.id, den), 1, dennyStropObchodu(tenant), 'denny_strop']);
    if (kos != null) {
      polozky.push([kluce.ipAi(tenant.id, den, kos), 1, limitIpAiObchodu(tenant, { ukazka, limity: DENNY_LIMIT_IP_AI }), 'limit_ip']);
      polozky.push([kluce.ipAiSpolu(den, kos), 1, DENNY_LIMIT_IP_AI_SPOLU, 'limit_ip']);
    }
    if (novy) {
      if (kos != null) polozky.push([kluce.ipRozhovory(tenant.id, den, kos), 1, DENNY_LIMIT_IP_ROZHOVORY, 'limit_ip_rozhovory']);
      if (!bezKvoty) polozky.push([kluce.nove(tenant.id, den), 1, dennyStropNovychRozhovorov(tenant), 'nove_rozhovory']);
    }
    const zle = await rezervujVsetko(env, k, polozky);
    if (zle && meranie) {
      // Náš beh nejde bez modelu ani do rezervy ukážok: vráti chybu len nám.
      await vratRezervacie(env, k);
      return { chyba: INTERNY_STROP, k };
    }
    if (zle) {
      rezim = 'bez_ai';
      dovod = zle;
    } else {
      k.odhadMili = odhadMili;
      if (novy && !bezKvoty) {
        let m;
        try {
          // Mesiac už vynulovala kontrola v kroku 2; druhé vynulovanie by pri
          // súbehu na prelome mesiaca zmazalo rozhovor inej požiadavky.
          m = await rezervujRozhovor(db, tenant.id, { now, tenant: { ...tenant, quota_month: monthKey(now) } });
        } catch (err) {
          await vratRezervacie(env, k);
          throw err;
        }
        if (!m.ok) {
          // Súbeh o posledné miesto mesačnej kvóty: prehral, nič sa neodráta.
          await vratRezervacie(env, k);
          return { chyba: { status: 429, obj: { error: 'quota_exceeded' } } };
        }
        k.mesacna = m;
      }
    }
  }

  // 6. Odpoveď bez modelu: vlastný denný strop obchodu v tisícoch (nález 4
  // tretieho kola). Nad ním 429 `obchod_limit`, nie `rate_limited`: zákazník,
  // ktorý poslal prvú správu, nemá čítať „príliš veľa správ naraz“; widget
  // ukáže vetu s kontaktnou stránkou obchodu.
  if (rezim === 'bez_ai') {
    const zle = await rezervujVsetko(env, k, [[kluce.bezAi(tenant.id, den), 1, bezAiStropObchodu(tenant), 'bez_ai_strop']]);
    if (zle === 'bez_ai_strop') {
      await vratRezervacie(env, k);
      await vystrahaZneuzitia(env, k, zle, ctx);
      return { chyba: { status: 429, obj: { error: 'obchod_limit' } } };
    }
    await vystrahaZneuzitia(env, k, dovod, ctx);
  }

  k.rezim = { rezim, dovod, used: rozhodnutie.used, limit: rozhodnutie.limit };
  k.ctx = ctx;
  return { k };
}

/**
 * Po zostavení promptu, tesne pred env.AI.run (tretie kolo, nález 1): dorezervuje
 * atomicky rozdiel medzi hornou hranicou volania (budget.js hornaHranicaMili)
 * a odhadom z kroku 5, do tých istých počítadiel (spoločný strop, bazén free,
 * podiel obchodu). Po tomto kroku je rezervácia horná hranica nákladu, takže
 * súbežná dávka s dlhým promptom neprerazí podiel ani strop.
 *
 * Vracia true (model sa smie volať) alebo false: rozdiel sa nezmestil, všetky
 * rezervácie odpovede modelom (okrem denného limitu otázok siete) sa vrátili a
 * volajúci odpovie bez modelu z už nájdených kandidátov. Nový rozhovor sa
 * vtedy do mesačnej kvóty nezapočíta (poOtazke s bezAi).
 */
export async function dorezervuj(env, k, hornaMili, { vektoryMili = 0 } = {}) {
  if (!k || k.test || !k.rezim || k.rezim.rezim !== 'ai') return true;
  const rozdiel = Math.ceil(Number(hornaMili) || 0) - k.odhadMili;
  if (rozdiel <= 0) return true;
  const zle = await rezervujVsetko(env, k, k.neuronove.map(([kluc, limit, d]) => [kluc, rozdiel, limit, d]));
  if (!zle) {
    k.odhadMili += rozdiel;
    return true;
  }
  if (k.meranie) {
    // Náš interný beh nejde bez modelu: vráti rezervácie a volajúci pošle 429
    // interny_strop. Vektor otázky už bežal a je zaplatený: ostane vo všetkých
    // troch počítadlách (spoločné, bazén, interné), inak by opakované odmietnutia
    // míňali vektory bez stopy (krok 1 asistenta, W1).
    await vratRezervacie(env, k, { ponechatMili: vektoryMili });
    k.rezim = { ...k.rezim, rezim: 'interny_strop', dovod: 'interny_strop' };
    return false;
  }
  // Vektor otázky už bežal a je zaplatený: ostane započítaný v rezervácii
  // (pokus 3 brány, nález A), vráti sa len zvyšok odhadu.
  await vratRezervacie(env, k, { okrem: 'ip', ponechatMili: vektoryMili });
  // Odpoveď bez modelu sa započíta do svojho stropu; nad ním sa aj tak odpovie,
  // lebo vektor otázky je už zaplatený a zákazník čaká.
  await rezervujVsetko(env, k, [[kluce.bezAi(k.tenant.id, k.den), 1, bezAiStropObchodu(k.tenant), 'bez_ai_strop']]);
  k.rezim = { ...k.rezim, rezim: 'bez_ai', dovod: zle };
  await vystrahaZneuzitia(env, k, zle, k.ctx);
  return false;
}

/**
 * Pred vektorom odpovede bez modelu (pokus 3 brány 28. 9. 2026, nález A):
 * náklad vektora (`mili`, budget.js vektorMili) sa atomicky rezervuje do tých
 * istých počítadiel ako odpoveď modelom (spoločný strop, bazén neplatiacich,
 * rezerva ukážok, podiel obchodu). Predtým sa vektor len pripočítal po odpovedi
 * bez limitu, takže tisíce odpovedí bez modelu jedného bezplatného obchodu
 * prerazili bazén aj spoločný strop a platiaci potom nedostal model.
 * Vracia true (vektor smie bežať) alebo false: nezmestí sa alebo D1 zlyhala,
 * volajúci odpovie bez ďalšieho plateného výpočtu. Nikdy nehádže.
 */
export async function rezervujVektor(env, k, mili) {
  if (!k || k.test) return true;
  const m = Math.max(0, Math.ceil(Number(mili) || 0));
  if (m === 0) return true;
  const zle = await rezervujVsetko(env, k, (k.neuronove || []).map(([kluc, limit, d]) => [kluc, m, limit, d]), 'vektor');
  if (zle) {
    k.vektorZamietnuty = zle;
    return false;
  }
  k.odhadMili += m;
  return true;
}

/**
 * Životný cyklus bez započítania: zapojenie na webe obchodu sa zaznamená aj
 * vtedy, keď odpoveď neprišla (strop, chyba modelu), ako pred krokom 1.
 */
export function zivotnyCyklusBezZapoctu(env, ctx, k, { origin = '', surface = 'web' } = {}) {
  if (!k) return Promise.resolve();
  const quota = { allowed: true, counted: false, used: k.kvota.used, quota: k.kvota.quota, remaining: k.kvota.remaining };
  return naPozadi(ctx, poRozhovore(env, k.tenant, { origin, surface, quota, now: k.now }));
}

/**
 * Model zlyhal: vráti rezervácie (kvóta, stropy, denné limity IP), započíta
 * chybu do ai_vypadok a zaznamená zapojenie ako pred krokom 1.
 */
export async function poChybe(env, ctx, k, { origin = '', surface = 'web', vykonaneMili = 0 } = {}) {
  if (!k) return;
  // `vykonaneMili`: cena volaní, ktoré pred chybou úspešne prebehli (vektor pred
  // zlyhaním Vectorize, model pred chybou spracovania). Ostane započítaná (W1).
  await vratRezervacie(env, k, { ponechatMili: vykonaneMili });
  await zaznamenajChybuAI(env, { now: k.now });
  await zivotnyCyklusBezZapoctu(env, ctx, k, { origin, surface });
}

async function nakladyAVystrahy(env, k, naklady, bezAi) {
  const db = env.DB;
  const { tenant, den } = k;
  const t = tenant.id;
  // Doúčtovanie: rezervovaná horná hranica (dorezervuj) sa nahradí
  // skutočnosťou (tisíciny neurónu) vo všetkých počítadlách, do ktorých sa
  // rezervovalo, aj v bazéne neplatiacich (pokus 2, nález 4: bez vrátenia by
  // horná hranica, asi dvojnásobok skutočnosti, zbytočne ubrala bezplatným).
  // Skutočnosť je pri modeli vždy pod rezervovanou hranicou, takže sa tu len
  // vracia; pripočíta sa len vektor odpovede bez modelu (tisíciny neurónu).
  const rozdiel = (Number(naklady.mili) || 0) - k.odhadMili;
  const doucti = (k.neuronove || []).map(([kluc]) => kluc);
  if (rozdiel > 0) {
    for (const kluc of doucti) await pripocitaj(db, kluc, den, rozdiel);
  } else if (rozdiel < 0) {
    for (const kluc of doucti) await vrat(db, kluc, -rozdiel);
  }
  k.odhadMili = 0;
  await zapisNaklady(db, t, { ...naklady, bezAi, now: k.now });

  const r = k.rezim;
  if (!r) return;
  const spolu = (await citaj(db, kluce.neurony(den))) / MILI;
  if (spolu >= prahNakladyDen(r.limit)) {
    await pingOchrana(env, { event: 'naklady_den', tenantId: 'asistent', percent: (spolu / r.limit) * 100, kluc: den });
  }
  const marza = marzaPercento(tenant, (await citaj(db, kluce.mili(t, den))) / MILI);
  if (marza != null && marza > MARZA_PRAH_PERCENT) {
    await pingOchrana(env, { event: 'obchod_marza', tenantId: t, percent: marza, kluc: `${t}:${den}` });
  }
}

/**
 * Po úspešnej odpovedi: náklady (prvé, aby ich spoločný strop videl aj pri
 * chybe zápisu rozhovoru), rozhovor, pingy, životný cyklus, nový token.
 * `naklady` = budget.js spocitajNaklady (pri našom teste null).
 * Vracia {relacia: token|null, quota}.
 */
export async function poOtazke(env, ctx, k, { naklady = null, bezAi = false, origin = '', surface = 'web' } = {}) {
  const { tenant, now } = k;

  if (naklady && !k.test) {
    if (!usageOhlasene && !bezAi) {
      usageOhlasene = true;
      console.log(`[arling-asistent] Workers AI usage: ${naklady.odhad ? 'chyba, tokeny su odhad zo znakov / 3,5' : 'je, tokeny su presne'}`);
    }
    const zapis = (async () => {
      try {
        await nakladyAVystrahy(env, k, naklady, bezAi);
      } catch (err) {
        console.error('[arling-asistent] zapis nakladov zlyhal:', (err && err.message) || err);
      }
    })();
    await naPozadi(ctx, zapis);
  }

  let quota;
  try {
    if (k.test && k.novy) {
      quota = await recordConversation(env.DB, tenant.id, { now, sessionKey: k.sessionKey, kv: env.ASISTENT_CACHE });
    } else if (k.mesacna) {
      quota = await potvrdRozhovor(env.DB, tenant.id, { now, used: k.mesacna.used, quota: k.mesacna.quota, sessionKey: k.sessionKey, kv: env.ASISTENT_CACHE });
    } else {
      quota = { allowed: true, counted: false, used: k.kvota.used, quota: k.kvota.quota, remaining: k.kvota.remaining, session: !k.novy };
    }
  } catch (err) {
    // Odpoveď zákazník dostane aj pri chybe zápisu (nález 12). Rezervovaný
    // rozhovor je v used_this_month už odrátaný.
    console.error('[arling-asistent] zapis rozhovoru zlyhal:', (err && err.message) || err);
    quota = k.mesacna
      ? { allowed: true, counted: true, used: k.mesacna.used, quota: k.mesacna.quota, remaining: Math.max(0, k.mesacna.quota - k.mesacna.used) }
      : { allowed: true, counted: false, used: k.kvota.used, quota: k.kvota.quota, remaining: k.kvota.remaining };
  }

  if (quota.counted) {
    await naPozadi(ctx, maybeNotifyQuota(env, { tenantId: tenant.id, usedBefore: quota.used - 1, usedAfter: quota.used, quota: quota.quota, now }));
  }
  await naPozadi(ctx, poRozhovore(env, tenant, { origin, surface, quota, now }));

  // Nový rozhovor bez modelu sa nezapočítal, takže nedostane ani token: ďalšia
  // otázka je znova nový rozhovor (a s modelom sa už započíta).
  if (bezAi && k.novy && !k.test) return { relacia: null, quota };

  const pokracuje = !k.novy && k.relacia && k.relacia.stav === 'platna';
  const id = pokracuje ? k.relacia.id : noveIdRelacie();
  const n = pokracuje ? k.relacia.n + 1 : 1;
  const relacia = await vydajRelaciu(env, {
    tenantId: tenant.id,
    id,
    zaciatok: pokracuje ? k.relacia.zaciatok : undefined,
    n,
    now: now.getTime(),
  });
  if (relacia) await zapamatajN(env, tenant.id, id, n);
  return { relacia, quota };
}
