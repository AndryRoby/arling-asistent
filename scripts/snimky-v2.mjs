#!/usr/bin/env node
// snimky-v2.mjs (SPEC 10.1 až 10.4): snímky widgetu v2 nad ukážkovým obchodom a automatická kontrola.
//
// Spúšťať LEN cez zámok, jeden prehliadač naraz:
//   python ops/druhy-ucet/cakaj-zamok.py node products/arling-asistent/scripts/snimky-v2.mjs [voľby]
// Voľby: --sada kontrolna|vsetko (predvolené kontrolna, 29 snímok zo SPEC 10.3)
//        --prehliadac chrome|firefox|oba   --stavy S2,S3   --sirky 1440,390   --kandidati (WebP pre landing)
// Statický server 127.0.0.1:8851 spustí skript sám a v každom prípade ho ukončí. Všetko mimo
// 127.0.0.1:8851 je zablokované (Umami, Stripe), POST /v1/chat a /v1/gift obslúžia fixtúry
// tests/fixtures/v2 (node scripts/fixtury-v2.mjs). Snímky a kontrola.json idú do ops/asistent/v2/snimky/.

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const koren = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(koren, '..', '..');
const web = path.join(repo, 'products', 'arling-sk');
const OUT = path.join(repo, 'ops', 'asistent', 'v2', 'snimky');
const KANDIDATI = path.join(web, 'asistent', 'snimky', 'v2');
const PORT = 8851;
const BASE = `http://127.0.0.1:${PORT}/asistent/ukazka/`;
const { default: puppeteer } = await import(pathToFileURL(path.join(repo, 'ops', 'video', 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href);

const arg = (meno, zaloha) => {
  const i = process.argv.indexOf('--' + meno);
  return i > 0 ? process.argv[i + 1] : zaloha;
};
const SADA = arg('sada', 'kontrolna');
const PREHLIADAC = arg('prehliadac', 'oba');
const LEN_STAVY = arg('stavy', '') ? arg('stavy', '').split(',') : null;
const LEN_SIRKY = arg('sirky', '') ? arg('sirky', '').split(',').map(Number) : null;
const S_KANDIDATMI = process.argv.includes('--kandidati');

const FIX = (m) => JSON.parse(readFileSync(path.join(koren, 'tests', 'fixtures', 'v2', m + '.json'), 'utf8'));
const fx = { s3: FIX('s3-kavovar'), s4: FIX('s4-darcek'), s5: FIX('s5-porovnanie'), s6: FIX('s6-chyba') };

const STAVY = ['S1', 'S1b', 'S2', 'S3', 'S4a', 'S4b', 'S5', 'S6'];
const VARIANTY = [['svetly', 'E0582A'], ['svetly', '1F6FEB'], ['tmavy', 'E0582A'], ['tmavy', '1F6FEB']];

/** Zoznam snímok: kontrolná sada zo SPEC 10.3, alebo celá matica 128. */
function plan() {
  const p = [];
  const pridaj = (prehliadac, rezim, farba, stavy, sirky) => {
    for (const stav of stavy) for (const sirka of sirky) p.push({ prehliadac, rezim, farba, stav, sirka });
  };
  if (SADA === 'vsetko') {
    for (const prehliadac of ['chrome', 'firefox']) for (const [rezim, farba] of VARIANTY) pridaj(prehliadac, rezim, farba, STAVY, [1440, 390]);
  } else {
    pridaj('chrome', 'svetly', 'E0582A', STAVY, [1440, 390]);
    pridaj('firefox', 'svetly', '1F6FEB', ['S1', 'S2', 'S3', 'S5'], [1440, 390]);
    pridaj('chrome', 'tmavy', 'E0582A', ['S2', 'S3', 'S4b'], [390]);
    pridaj('chrome', 'tmavy', 'E0582A', ['S3'], [1440]);
    pridaj('firefox', 'tmavy', '1F6FEB', ['S3'], [390]);
  }
  return p.filter((s) => (PREHLIADAC === 'oba' || s.prehliadac === PREHLIADAC) && (!LEN_STAVY || LEN_STAVY.includes(s.stav)) && (!LEN_SIRKY || LEN_SIRKY.includes(s.sirka)));
}

const pauza = (ms) => new Promise((r) => setTimeout(r, ms));
const zabiStrom = (pr) => {
  try {
    execFileSync('taskkill', ['/PID', String(pr.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    pr.kill();
  }
};

// v2.2: ten istý http.server, len s dlhšou frontou spojení. Fotky výrobkov (asi 40 kB na kus) načíta
// katalóg obchodu naraz a pri predvolenej fronte 5 Chrome občas hlásil ERR_CONNECTION_TIMED_OUT.
const SERVER_PY = 'import functools, http.server, sys\n' +
  'http.server.ThreadingHTTPServer.request_queue_size = 128\n' +
  'h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[2])\n' +
  "http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), h).serve_forever()\n";

async function spustiServer() {
  const server = spawn('python', ['-c', SERVER_PY, String(PORT), web], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await pauza(250);
    try {
      if ((await fetch(BASE)).ok) return server;
    } catch {
      /* ešte štartuje */
    }
  }
  zabiStrom(server);
  throw new Error('statický server sa nespustil');
}

// ---------------------------------------------------------------------------
// V stránke: pomocníci a automatická kontrola (SPEC 10.4)
// ---------------------------------------------------------------------------

const V_STRANKE = `
window.__R = () => document.querySelector('[data-arling-asistent]').shadowRoot;
window.__kontrola = (stav) => {
  const R = __R();
  const vw = innerWidth, vh = innerHeight;
  const rgb = (s) => { const m = String(s).match(/[\\d.]+/g) || [0, 0, 0, 0]; return { r: +m[0], g: +m[1], b: +m[2], a: m[3] == null ? 1 : +m[3] }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const kon = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const pozadie = (el) => { for (let e = el; e; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const vid = (el) => el && el.getClientRects().length && el.getBoundingClientRect().width > 0;
  const panel = R.getElementById('panel');
  const otvoreny = panel && !panel.hidden;
  const out = { stav };
  // pole_volne (P9)
  if (otvoreny) {
    const form = R.getElementById('form'), foot = R.querySelector('.footer');
    const inp = R.getElementById('input').getBoundingClientRect(), send = R.getElementById('send-btn').getBoundingClientRect(), f = foot.getBoundingClientRect();
    const body = [[inp.left + inp.width / 2, inp.top + inp.height / 2], [inp.left + 12, inp.top + inp.height / 2], [inp.right - 12, inp.top + inp.height / 2], [send.left + send.width / 2, send.top + send.height / 2], [f.left + f.width / 2, f.top + f.height / 2]];
    out.pole_body = body.map(([x, y]) => { const e = R.elementFromPoint(x, y); return e ? (form.contains(e) || foot.contains(e) ? 'ok' : (e.id || e.className || e.tagName)) : 'nic'; });
    out.pole_volne = out.pole_body.every((x) => x === 'ok');
    const r = panel.getBoundingClientRect();
    out.panel_v_okne = r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;
  }
  out.bez_posunu = document.documentElement.scrollWidth <= vw;
  // obrázky v kartách a kategóriách: viditeľné musia byť načítané (lazy mimo pohľadu sa načítať nemusia)
  const imgs = [...R.querySelectorAll('.product-card img, .kategoria img, .porovnanie img')];
  const vPohlade = imgs.filter((i) => { const b = i.getBoundingClientRect(); return b.width > 0 && b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw; });
  out.obrazky = { vsetky: imgs.length, v_pohlade: vPohlade.length, nacitane_v_pohlade: vPohlade.filter((i) => i.complete && i.naturalWidth > 0).length };
  out.obrazky_nacitane = vPohlade.every((i) => i.complete && i.naturalWidth > 0);
  // upútavka (U2)
  const teaser = R.getElementById('teaser'), toggle = R.getElementById('toggle');
  if (stav === 'S1b' && vw < 600) {
    // v2.1: na telefóne sa upútavka na stránke produktu neukazuje (zakryla by cenu).
    out.upoutavka_nekryje = teaser.hidden === true;
  } else if (stav === 'S1' || stav === 'S1b') {
    const a = teaser.getBoundingClientRect(), b = toggle.getBoundingClientRect();
    out.upoutavka_viditelna = !teaser.hidden && getComputedStyle(teaser).opacity === '1';
    out.upoutavka_nekryje = out.upoutavka_viditelna && (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) && a.left >= 0 && a.top >= 0 && a.right <= vw && a.bottom <= vh;
  }
  // ciele 44 px (A8)
  const male = [...R.querySelectorAll('button, a[href]')].filter((e) => vid(e) && !e.closest('.product-card') && !e.classList.contains('sr-only')).map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ r }) => r.width < 43.5 || r.height < 43.5);
  out.male_ciele = male.map(({ e, r }) => (e.id || e.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  out.ciele_44 = male.length === 0;
  // kontrast (A6)
  const par = (sel, ciel, spolu) => { const e = R.querySelector(sel); if (!vid(e)) return null; const c = spolu ? rgb(getComputedStyle(e)[spolu]) : rgb(getComputedStyle(e).color); return Math.round(kon(c, pozadie(e)) * 100) / 100; };
  out.kontrasty = {
    pole_text: par('#input', 4.5), odpoved: par('.msg-assistant:not(.msg-uvod):not(#thinking-row) .bubble', 4.5) ?? par('.uvitanie', 4.5), zakaznik: par('.msg-user .bubble', 4.5),
    dlazdica: par('.dlazdica .dl-text', 4.5), cena: par('.product-price', 4.5) ?? par('.por-cena', 4.5), stitok_upoutavky: par('.u-stitok', 4.5),
    // v2.1: rám nesie obal .pole (pole a Odoslať v jednom), meria sa jeho rám bez fokusu voči lište.
    ikona_dlazdice: par('.dl-ikona', 3), ram_pola: (() => { const e = R.querySelector('.pole'); return vid(e) && !e.matches(':focus-within') ? Math.round(kon(rgb(getComputedStyle(e).borderTopColor), pozadie(R.querySelector('.composer'))) * 100) / 100 : null; })(),
  };
  const HRANICA = { ikona_dlazdice: 3, ram_pola: 3 };
  out.kontrast = Object.entries(out.kontrasty).every(([k, v]) => v == null || v >= (HRANICA[k] || 4.5));
  // bez pretečenia: viditeľný obsah nikde nevytŕča (orezanie s trojbodkou alebo line-clamp je zámer)
  const vsetky = [...R.querySelectorAll('*')].filter((e) => vid(e) && !e.closest('.sr-only'));
  out.pretecenie = vsetky.filter((e) => {
    // Pás kariet ide zámerne až po okraj panela (K8: margin-inline -20px), riadok s ním preto nie je chyba.
    if (e.matches('.products, textarea, .msg:has(> .products)')) return false;
    const cs = getComputedStyle(e);
    if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') return false;
    return e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0;
  }).map((e) => (e.id || e.className || e.tagName) + ' ' + e.scrollWidth + '>' + e.clientWidth);
  out.bez_pretecenia = out.pretecenie.length === 0;
  return out;
};
`;

async function cakajNa(page, fn, arg, ms = 15000) {
  await page.waitForFunction(fn, { timeout: ms, polling: 100 }, arg);
}

/** Skutočné kliknutie myšou na prvok v shadow DOM (ako zákazník, nie programové click()). */
async function klik(page, vyraz) {
  const h = await page.evaluateHandle(`(() => ${vyraz})()`);
  const el = h.asElement();
  if (!el) throw new Error('nenájdené: ' + vyraz);
  await el.click();
  await h.dispose();
}

async function nacitajObrazky(page) {
  await cakajNa(page, () => {
    const R = window.__R();
    const imgs = [...R.querySelectorAll('.product-card img, .kategoria img, .porovnanie img')].filter((i) => {
      const b = i.getBoundingClientRect();
      return b.width > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
    });
    return imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, undefined, 10000).catch(() => {});
}

async function otvorPanel(page) {
  await klik(page, "__R().getElementById('toggle')");
  await pauza(900);
}

async function odoslat(page, text) {
  await page.evaluate((q) => window.ArlingAsistent.ask(q), text);
  await cakajNa(page, () => { const R = window.__R(); return !R.getElementById('thinking-row') && R.querySelectorAll('.msg-assistant:not(.msg-uvod)').length > 0; });
}

/** Jeden stav: nová stránka v novom kontexte (nová relácia), fixtúry cez zachytenie. */
async function snimka(browser, s, zaznam) {
  const kontext = await browser.createBrowserContext();
  const page = await kontext.newPage();
  const siet = { chyby: [], fonty: [], zablokovane: 0, api: [] };
  let chyba500 = s.stav === 'S6';
  try {
    const mobil = s.sirka < 600;
    try {
      await page.setViewport({ width: s.sirka, height: mobil ? 844 : 900, deviceScaleFactor: mobil ? 2 : 1, isMobile: mobil && s.prehliadac === 'chrome', hasTouch: mobil && s.prehliadac === 'chrome' });
    } catch {
      await page.setViewport({ width: s.sirka, height: mobil ? 844 : 900, deviceScaleFactor: mobil ? 2 : 1 });
    }
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url)) siet.fonty.push(url.replace(`http://127.0.0.1:${PORT}`, ''));
      if (url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:')) return req.continue();
      const api = /^https:\/\/arling-asistent\.arling\.workers\.dev\/v1\/(chat|gift)$/.exec(url);
      if (api) {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
        if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
        // Poradie otázok v stave (postData nie je vo Firefoxe cez BiDi vždy k dispozícii).
        let f;
        if (api[1] === 'gift') f = fx.s4;
        else if (chyba500) f = fx.s6;
        else f = (siet.chat = (siet.chat || 0) + 1) > 1 && s.stav === 'S5' ? fx.s5 : fx.s3;
        siet.api.push(api[1] + ':' + (f.status || 200));
        return req.respond({ status: f.status || 200, headers: cors, contentType: 'application/json', body: JSON.stringify(f.odpoved) });
      }
      siet.zablokovane += 1;
      return req.abort('blockedbyclient');
    });
    page.on('requestfailed', (req) => {
      const u = req.url();
      // v2.1: prehliadač zrušil lenivý obrázok katalógu obchodu (ERR_ABORTED / NS_BINDING_ABORTED), keď
      // panel zamkol posun stránky; nie je to chyba siete. Obrázky widgetu stráži obrazky_nacitane.
      const dovod = String((req.failure() && req.failure().errorText) || '');
      if (/ABORTED/i.test(dovod) && /\/asistent\/ukazka\/img\//.test(u)) {
        siet.zrusene = (siet.zrusene || 0) + 1;
        return;
      }
      if (u.startsWith(`http://127.0.0.1:${PORT}/`)) siet.chyby.push('zlyhalo ' + u + ' ' + dovod);
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !(chyba500 && /\/v1\/chat$/.test(res.url()))) siet.chyby.push(res.status() + ' ' + res.url());
    });
    const upoutavka = s.stav === 'S1' || s.stav === 'S1b' ? 'hned' : '0';
    const url = `${BASE}?farba=${s.farba}&rezim=${s.rezim}&upoutavka=${upoutavka}${s.stav === 'S1b' ? '#p-KAV-003' : ''}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(V_STRANKE);
    await cakajNa(page, () => window.ArlingAsistent && document.querySelector('[data-arling-asistent]') && document.documentElement.getAttribute('data-vyrobky') === '64');
    if (s.stav === 'S1b' && mobil) {
      await pauza(1500);
    } else if (s.stav === 'S1' || s.stav === 'S1b') {
      await cakajNa(page, () => window.__R().getElementById('teaser').getAttribute('data-stav') === 'otvoreny', undefined, 8000);
      await pauza(800);
    } else {
      await otvorPanel(page);
      if (s.stav === 'S3' || s.stav === 'S5') {
        await odoslat(page, fx.s3.otazka);
        if (s.stav === 'S5') {
          await klik(page, "__R().querySelector('.pas-akcie .suggestion')");
          await cakajNa(page, () => !!window.__R().querySelector('.porovnanie') && !window.__R().getElementById('thinking-row'));
        }
        await pauza(900);
        await nacitajObrazky(page);
      } else if (s.stav === 'S4a' || s.stav === 'S4b') {
        await klik(page, "__R().getElementById('gift-toggle')");
        await pauza(400);
        await klik(page, "__R().getElementById('gift-recipient-chips').children[1]");
        await pauza(900);
        if (s.stav === 'S4b') {
          await klik(page, "__R().getElementById('gift-budget-chips').children[1]");
          await pauza(500);
          await klik(page, "__R().getElementById('gift-submit-btn')");
          await cakajNa(page, () => window.__R().querySelectorAll('#gift-results-list .gift-card').length === 5);
          await pauza(900);
          await nacitajObrazky(page);
        }
      } else if (s.stav === 'S6') {
        await odoslat(page, 'Máte niečo na darček pre babku?');
        await pauza(700);
      }
    }
    const meno = `${s.stav}-${s.sirka}-${s.prehliadac}-${s.rezim}-${s.farba}`;
    // v2.1: myš preč z widgetu, aby snímka neukazovala náhodný hover (overenie 1).
    await page.mouse.move(2, 2).catch(() => {});
    await pauza(200);
    await page.screenshot({ path: path.join(OUT, meno + '.png'), type: 'png' });
    if (S_KANDIDATMI && s.prehliadac === 'chrome' && s.rezim === 'svetly' && s.farba === 'E0582A') {
      const k = { 'S2-1440': 'v2-uvod-1440', 'S3-390': 'v2-karty-390', 'S4b-390': 'v2-darcek-390', 'S5-1440': 'v2-porovnanie-1440' }[s.stav + '-' + s.sirka];
      if (k) {
        mkdirSync(KANDIDATI, { recursive: true });
        await page.screenshot({ path: path.join(KANDIDATI, k + '.webp'), type: 'webp', quality: 82 });
      }
    }
    const k = await page.evaluate((stav) => window.__kontrola(stav), s.stav);
    k.ziadna_sietova_chyba = siet.chyby.length === 0;
    k.siet = siet;
    k.ziadny_font = siet.fonty.every((f) => f === '/fonts/arling-sans.woff2');
    const polia = ['pole_volne', 'bez_posunu', 'obrazky_nacitane', 'panel_v_okne', 'upoutavka_nekryje', 'ciele_44', 'kontrast', 'bez_pretecenia', 'ziadna_sietova_chyba', 'ziadny_font'];
    k.vsetko_true = polia.every((p) => k[p] === undefined || k[p] === true);
    zaznam[meno] = k;
    console.log(meno, k.vsetko_true ? 'OK' : 'NÁLEZ ' + polia.filter((p) => k[p] === false).join(', '));
  } finally {
    await kontext.close().catch(() => {});
  }
}

async function spustiPrehliadac(meno) {
  if (meno === 'chrome') {
    return puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--disable-gpu', '--hide-scrollbars'] });
  }
  return puppeteer.launch({ browser: 'firefox', executablePath: 'C:/Program Files/Mozilla Firefox/firefox.exe', headless: true });
}

const POPIS_STAVU = {
  S1: 'upútavka na úvode obchodu', S1b: 'upútavka na detaile výrobku', S2: 'otvorený úvod', S3: 'odpoveď s kartami',
  S4a: 'darček, krok rozpočtu', S4b: 'darček, výsledky', S5: 'porovnanie dvoch', S6: 'chyba siete a Skúsiť znova',
};

/** Interná galéria (SPEC 9.8): kandidáti pre landing hore, potom kontrolná sada a zvyšok matice. Nič sa nezverejňuje. */
function galeria(zaznam) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const mena = Object.keys(zaznam).sort((a, b) => STAVY.indexOf(a.split('-')[0]) - STAVY.indexOf(b.split('-')[0]) || a.localeCompare(b));
  const kandidati = [['v2-uvod-1440', 'S2-1440-chrome-svetly-E0582A'], ['v2-karty-390', 'S3-390-chrome-svetly-E0582A'], ['v2-darcek-390', 'S4b-390-chrome-svetly-E0582A'], ['v2-porovnanie-1440', 'S5-1440-chrome-svetly-E0582A']];
  const dlazdica = (m) => {
    const [stav, sirka, prehliadac, rezim, farba] = m.split('-');
    const k = zaznam[m];
    return `<figure><a href="${esc(m)}.png"><img src="${esc(m)}.png" alt="${esc(POPIS_STAVU[stav] || stav)}, ${sirka} px, ${prehliadac}" loading="lazy"></a>` +
      `<figcaption><b>${esc(stav)}</b> ${esc(POPIS_STAVU[stav] || '')}<br>${sirka} px, ${prehliadac}, ${rezim === 'tmavy' ? 'tmavý' : 'svetlý'} režim, #${farba}` +
      `<br><span class="${k && k.vsetko_true ? 'ok' : 'nie'}">${k && k.vsetko_true ? 'automatická kontrola v poriadku' : 'nález v automatickej kontrole'}</span></figcaption></figure>`;
  };
  const html = `<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snímky widgetu v2</title>
<style>
body{margin:0;background:#FBFAF7;color:#1B1A17;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
main{max-width:1280px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:26px;margin:0 0 8px}h2{font-size:19px;margin:40px 0 12px}
p{max-width:70ch;margin:0 0 8px;color:#4A4640}
.mriezka{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}
.kandidati .mriezka{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
figure{margin:0;background:#fff;border:1px solid #ECE8E1;border-radius:14px;overflow:hidden}
figure img{display:block;width:100%;height:220px;object-fit:cover;object-position:top;background:#F3EFE8}
figcaption{padding:10px 12px 12px;font-size:13.5px;color:#4A4640}
.stitok{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#FCEEEA;color:#B84822;font-size:12.5px;font-weight:600}
.ok{color:#15803D}.nie{color:#B42318}
</style>
</head>
<body>
<main>
<h1>Snímky widgetu v2</h1>
<p>Interná galéria, nič sa odtiaľto nezverejňuje. Snímky vznikli nad ukážkovým obchodom Dobrá domácnosť s odpoveďami z fixtúr (tests/fixtures/v2), nie zo živého workera.</p>
<p>Automatická kontrola: ${Object.values(zaznam).filter((v) => v.vsetko_true).length} z ${Object.keys(zaznam).length} snímok v poriadku (kontrola.json).</p>
<section class="kandidati">
<h2>Kandidáti pre landing <span class="stitok">náhľad z fixtúry</span></h2>
<p>Pred zverejnením ich treba nahradiť snímkami živých odpovedí (SPEC 12.2), landing ukazuje len skutočné odpovede.</p>
<div class="mriezka">${kandidati.filter(([, m]) => zaznam[m]).map(([k, m]) => dlazdica(m).replace('</figcaption>', `<br>${k}.webp</figcaption>`)).join('\n')}</div>
</section>
<h2>Všetky snímky</h2>
<div class="mriezka">${mena.map(dlazdica).join('\n')}</div>
</main>
</body>
</html>
`;
  writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');
}

mkdirSync(OUT, { recursive: true });
const cesta = path.join(OUT, 'kontrola.json');
const zaznam = existsSync(cesta) ? JSON.parse(readFileSync(cesta, 'utf8')).snimky || {} : {};
if (process.argv.includes('--len-galeria')) {
  galeria(zaznam);
  console.log('galéria:', path.join(OUT, 'index.html'));
  process.exit(0);
}
const zoznam = plan();
console.log(`snímok: ${zoznam.length} (sada ${SADA})`);
let server = null;
let browser = null;
try {
  server = await spustiServer();
  for (const meno of ['chrome', 'firefox']) {
    const moje = zoznam.filter((s) => s.prehliadac === meno);
    if (!moje.length) continue;
    browser = await spustiPrehliadac(meno);
    for (const s of moje) {
      try {
        await snimka(browser, s, zaznam);
      } catch (e) {
        const m = `${s.stav}-${s.sirka}-${s.prehliadac}-${s.rezim}-${s.farba}`;
        zaznam[m] = { chyba: String(e && e.message || e), vsetko_true: false };
        console.log(m, 'CHYBA', e && e.message);
      }
    }
    await browser.close();
    browser = null;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) zabiStrom(server);
  const vysl = Object.values(zaznam);
  writeFileSync(cesta, JSON.stringify({ kedy: new Date().toISOString(), pocet: vysl.length, vsetko_true: vysl.every((v) => v.vsetko_true), snimky: zaznam }, null, 1));
  galeria(zaznam);
  console.log('kontrola.json:', vysl.filter((v) => v.vsetko_true).length + '/' + vysl.length, 'v poriadku');
}
