#!/usr/bin/env node
// vykon-v2.mjs (SPEC 10.5, v2.1 po overení 1): klávesnica v Chrome AJ vo Firefoxe (Andrejov prehliadač)
// a plynulosť animácií (Chrome headless a Firefox v skutočnom okne 1440 x 900 bez emulácie DPR).
// Otvára sa kliknutím myši na spúšťač ako zákazník: prvé (studené) otvorenie, 10 x prázdny panel
// a 5 x panel s rozhovorom (karty a porovnanie), plus pás kariet šípkami. Spúšťať cez zámok:
//   python ops/druhy-ucet/cakaj-zamok.py node products/arling-asistent/scripts/vykon-v2.mjs [--len-klavesnica] [--len-firefox]
// Výsledky: ops/asistent/v2/klavesnica.json a ops/asistent/v2/vykon.json. Server 8851 spustí a ukončí sám.

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const koren = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(koren, '..', '..');
const V2 = path.join(repo, 'ops', 'asistent', 'v2');
const PORT = 8851;
const URL = `http://127.0.0.1:${PORT}/asistent/ukazka/?farba=E0582A&rezim=svetly&upoutavka=0`;
const { default: puppeteer } = await import(pathToFileURL(path.join(repo, 'ops', 'video', 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href);
const pauza = (ms) => new Promise((r) => setTimeout(r, ms));
const zabi = (pr) => { try { execFileSync('taskkill', ['/PID', String(pr.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { pr.kill(); } };
const FX = (m) => JSON.stringify(JSON.parse(readFileSync(path.join(koren, 'tests', 'fixtures', 'v2', m + '.json'), 'utf8')).odpoved);
const LEN_KLAVESNICA = process.argv.includes('--len-klavesnica');
const LEN_FIREFOX = process.argv.includes('--len-firefox');

async function stranka(browser, emulovat = true) {
  // Skutočné okno Firefoxu: prvá karta (tá je viditeľná); inak vždy nová stránka.
  const page = emulovat ? await browser.newPage() : (await browser.pages())[0] || (await browser.newPage());
  if (emulovat) await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 }).catch(() => {});
  await page.setRequestInterception(true);
  let chat = 0;
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(`http://127.0.0.1:${PORT}/`)) return req.continue();
    if (/arling-asistent\.arling\.workers\.dev\/v1\/chat$/.test(u)) {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
      chat += 1;
      return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: chat > 1 ? FX('s5-porovnanie') : FX('s3-kavovar') });
    }
    return req.abort('blockedbyclient');
  });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ArlingAsistent && document.documentElement.getAttribute('data-vyrobky') === '64', { timeout: 15000 });
  await page.evaluate(() => {
    window.__R = () => document.querySelector('[data-arling-asistent]').shadowRoot;
    window.__meraj = (ms) => new Promise((res) => {
      const t = [];
      let p = performance.now();
      const start = p;
      const f = (now) => { t.push(now - p); p = now; if (now - start < ms) requestAnimationFrame(f); else res(t); };
      requestAnimationFrame(f);
    });
  });
  return page;
}

function stat(intervaly, animacii) {
  const v = intervaly.slice().sort((a, b) => a - b);
  const q = (x) => v[Math.min(v.length - 1, Math.floor(x * v.length))];
  const r = (x) => Math.round(x * 100) / 100;
  const s = { snimok: v.length, median_ms: r(q(0.5)), p95_ms: r(q(0.95)), max_ms: r(v[v.length - 1]), nad_33ms_na_animaciu: r(v.filter((x) => x > 33).length / animacii) };
  s.ok = s.median_ms <= 17.5 && s.p95_ms <= 20 && s.nad_33ms_na_animaciu <= 1;
  return s;
}

/** Klik myšou na spúšťač (skutočný pohyb a klik ako zákazník), meranie od kliku do konca prechodu. */
async function otvorMysou(page, ms = 650) {
  const b = await page.evaluate(() => { const r = window.__R().getElementById('toggle').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const m = page.evaluate((x) => window.__meraj(x), ms);
  await page.mouse.click(b[0], b[1]);
  return (await m).slice(1);
}

async function zatvor(page) {
  const m = page.evaluate(() => window.__meraj(450));
  await page.keyboard.press('Escape');
  return (await m).slice(1);
}

async function plynulost(page) {
  await pauza(1200);
  const out = {};
  out.idle = stat((await page.evaluate(() => window.__meraj(1000))).slice(1), 1);
  out.prve_otvorenie = stat(await otvorMysou(page, 700), 1);
  const z0 = await zatvor(page);
  await pauza(300);
  const otv = [];
  const zat = [...z0];
  for (let i = 0; i < 10; i++) {
    otv.push(...(await otvorMysou(page)));
    zat.push(...(await zatvor(page)));
    await pauza(200);
  }
  out.otvaranie_prazdny_10x = stat(otv, 10);
  out.zatvaranie_11x = stat(zat, 11);
  // s rozhovorom: 4 karty a porovnanie dvoch
  await otvorMysou(page);
  await pauza(600);
  await page.keyboard.type('Aký kávovar do 100 eur?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__R().querySelectorAll('.product-card').length >= 4, { timeout: 10000 });
  await pauza(1200);
  await page.evaluate(() => window.__R().querySelector('.pas-akcie .suggestion').click());
  await page.waitForFunction(() => !!window.__R().querySelector('.porovnanie') && !window.__R().getElementById('thinking-row'), { timeout: 10000 });
  await pauza(1000);
  await zatvor(page);
  await pauza(600);
  const otv2 = [];
  for (let i = 0; i < 5; i++) {
    otv2.push(...(await otvorMysou(page)));
    await zatvor(page);
    await pauza(600);
  }
  out.otvaranie_s_rozhovorom_5x = stat(otv2, 5);
  // pás kariet šípkami
  await otvorMysou(page);
  await pauza(700);
  await page.evaluate(() => { const p = window.__R().querySelector('.products'); p.scrollIntoView({ block: 'center' }); });
  await pauza(700);
  const pas = [];
  for (let i = 0; i < 10; i++) {
    const m = page.evaluate(() => window.__meraj(600));
    await page.evaluate((smer) => window.__R().querySelectorAll('.pas-sipka')[smer].click(), i % 2 === 0 ? 1 : 0);
    pas.push(...(await m).slice(1));
    await pauza(100);
  }
  out.pas_kariet = stat(pas, 10);
  out.ok = ['prve_otvorenie', 'otvaranie_prazdny_10x', 'zatvaranie_11x', 'otvaranie_s_rozhovorom_5x', 'pas_kariet'].every((k) => out[k].ok);
  return out;
}

async function klavesnica(page) {
  const oznac = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || !a.hasAttribute('data-arling-asistent')) return 'stranka:' + (a ? a.tagName : '');
    const e = a.shadowRoot.activeElement;
    if (!e) return 'host';
    if (e.id) return e.id;
    if (e.closest('.footer')) return 'footer';
    return (e.className.match(/dlazdica|kategoria|suggestion|product-card/) || [e.tagName])[0];
  });
  // Na spúšťač: Tab z posledného odkazu obchodu (päta), nie cez 150 odkazov katalógu (Firefox by to robil minúty).
  await page.evaluate(() => { const a = [...document.querySelectorAll('.pata a')].pop(); a.focus(); });
  let krokov = 0;
  while (krokov < 20 && (await oznac()) !== 'toggle') { await page.keyboard.press('Tab'); krokov += 1; }
  const out = { tabov_z_paty_na_spustac: krokov, na_spustaci: (await oznac()) === 'toggle' };
  await page.keyboard.press('Enter');
  await pauza(900);
  out.po_otvoreni = await oznac();
  const poradie = [out.po_otvoreni];
  for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); poradie.push(await oznac()); }
  out.poradie = poradie;
  // v2.1: v úvode najviac 3 otázky (overenie 1).
  const ocakavane = ['input', 'send-btn', 'footer', 'reset-btn', 'close-btn', 'gift-toggle', 'dlazdica', 'dlazdica', 'kategoria', 'kategoria', 'kategoria', 'suggestion', 'suggestion', 'suggestion'];
  out.ocakavane = ocakavane;
  out.poradie_a3 = ocakavane.every((x, i) => poradie[i] === x) && poradie[ocakavane.length] === 'input';
  out.pasca_drzi = poradie.every((x) => !x.startsWith('stranka:'));
  for (let i = 0; i < 16 && (await oznac()) !== 'input'; i++) await page.keyboard.press('Tab');
  const spat = [];
  for (let i = 0; i < 16; i++) { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); spat.push(await oznac()); }
  out.shift_tab = spat;
  out.shift_tab_ok = spat.slice(0, ocakavane.length).join() === ocakavane.slice().reverse().join();
  await page.keyboard.press('Escape');
  await pauza(600);
  out.po_esc = await oznac();
  out.panel_zatvoreny = await page.evaluate(() => window.__R().getElementById('panel').hidden);
  out.esc_vratil_fokus = out.po_esc === 'toggle' && out.panel_zatvoreny;
  out.ok = out.na_spustaci && out.poradie_a3 && out.pasca_drzi && out.shift_tab_ok && out.esc_vratil_fokus;
  return out;
}

const server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', path.join(repo, 'products', 'arling-sk')], { stdio: 'ignore' });
const cestaVykon = path.join(V2, 'vykon.json');
const vykon = { kedy: new Date().toISOString() };
const klav = { kedy: new Date().toISOString() };
try {
  for (let i = 0; i < 40; i++) { await pauza(250); try { if ((await fetch(URL)).ok) break; } catch { /* štart */ } }
  if (!LEN_FIREFOX) {
    const chrome = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    try {
      klav.chrome = await klavesnica(await stranka(chrome));
      console.log('klávesnica chrome', klav.chrome.ok ? 'OK' : 'NÁLEZ', JSON.stringify(klav.chrome.poradie.slice(0, 16)));
      if (!LEN_KLAVESNICA) {
        vykon.chrome_headless = await plynulost(await stranka(chrome));
        console.log('chrome', JSON.stringify(vykon.chrome_headless));
      }
    } finally {
      await chrome.close();
    }
  }
  // Firefox: klávesnica headless, plynulosť v skutočnom okne (Andrej používa Firefox).
  const ffH = await puppeteer.launch({ browser: 'firefox', executablePath: 'C:/Program Files/Mozilla Firefox/firefox.exe', headless: true });
  try {
    klav.firefox = await klavesnica(await stranka(ffH));
    console.log('klávesnica firefox', klav.firefox.ok ? 'OK' : 'NÁLEZ', JSON.stringify(klav.firefox.poradie.slice(0, 16)));
  } finally {
    await Promise.race([ffH.close(), pauza(10000)]);
  }
  if (!LEN_KLAVESNICA) {
    const ff = await puppeteer.launch({ browser: 'firefox', executablePath: 'C:/Program Files/Mozilla Firefox/firefox.exe', headless: false, defaultViewport: null, args: ['--width=1440', '--height=900'] });
    try {
      const page = await stranka(ff, false);
      vykon.firefox_okno = { okno: await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })), ...(await plynulost(page)) };
      console.log('firefox', JSON.stringify(vykon.firefox_okno));
    } finally {
      await Promise.race([ff.close(), pauza(10000)]);
      try { ff.process() && ff.process().kill('SIGKILL'); } catch { /* nič */ }
    }
  }
} finally {
  zabi(server);
  klav.ok = Object.values(klav).every((v) => typeof v !== 'object' || v.ok);
  writeFileSync(path.join(V2, 'klavesnica.json'), JSON.stringify(klav, null, 1));
  if (!LEN_KLAVESNICA) writeFileSync(cestaVykon, JSON.stringify(vykon, null, 1));
}
