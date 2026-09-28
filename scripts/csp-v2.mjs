#!/usr/bin/env node
// csp-v2.mjs (SPEC 10.6): widget na stránke s prísnou CSP (default-src 'self'; style-src 'self'; ...)
// v Chrome aj vo Firefoxe. Očakáva 0 udalostí securitypolicyviolation a spúšťač s pozadím farby obchodu.
// Spúšťať cez zámok: python ops/druhy-ucet/cakaj-zamok.py node products/arling-asistent/scripts/csp-v2.mjs
// Server 127.0.0.1:8852 spustí sám a vždy ukončí; výsledok zapíše do ops/asistent/v2/csp/vysledok.json.

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const koren = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(koren, '..', '..');
const DIR = path.join(repo, 'ops', 'asistent', 'v2', 'csp');
const IMG = path.join(repo, 'products', 'arling-sk', 'asistent', 'ukazka', 'img');
const PORT = 8852;
const { default: puppeteer } = await import(pathToFileURL(path.join(repo, 'ops', 'video', 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href);
const pauza = (ms) => new Promise((r) => setTimeout(r, ms));
const zabi = (pr) => { try { execFileSync('taskkill', ['/PID', String(pr.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { pr.kill(); } };

copyFileSync(path.join(koren, 'widget', 'widget.js'), path.join(DIR, 'widget.js'));
const s3 = JSON.parse(readFileSync(path.join(koren, 'tests', 'fixtures', 'v2', 's3-kavovar.json'), 'utf8')).odpoved;
const odpoved = JSON.stringify({ ...s3, products: s3.products.map((p) => ({ ...p, image: `http://127.0.0.1:${PORT}/img/` + path.basename(p.image) })) });

const server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
const vysledok = { kedy: new Date().toISOString(), prehliadace: {} };
try {
  for (let i = 0; i < 40; i++) { await pauza(250); try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* štart */ } }
  for (const meno of ['chrome', 'firefox']) {
    const browser = meno === 'chrome'
      ? await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
      : await puppeteer.launch({ browser: 'firefox', executablePath: 'C:/Program Files/Mozilla Firefox/firefox.exe', headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        if (u === `http://127.0.0.1:${PORT}/v1/chat`) return req.respond({ status: 200, contentType: 'application/json', body: odpoved });
        const img = new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/img/([A-Z]{3}-\\d{3}\\.svg)$`).exec(u);
        if (img) return req.respond({ status: 200, contentType: 'image/svg+xml', body: readFileSync(path.join(IMG, img[1])) });
        return req.continue();
      });
      await page.evaluateOnNewDocument(() => {
        window.__porusenia = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__porusenia.push(e.violatedDirective + ' ' + (e.blockedURI || '')));
      });
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ArlingAsistent, { timeout: 10000 });
      await page.evaluate(() => { window.ArlingAsistent.open(); window.ArlingAsistent.ask('Aký kávovar do 100 eur?'); });
      await page.waitForFunction(() => document.querySelector('[data-arling-asistent]').shadowRoot.querySelectorAll('.product-card').length === 4, { timeout: 10000 });
      await pauza(1200);
      const stav = await page.evaluate(() => {
        const host = document.querySelector('[data-arling-asistent]');
        const R = host.shadowRoot;
        const toggle = R.getElementById('toggle');
        const panel = R.getElementById('panel');
        return {
          porusenia: window.__porusenia,
          konstruovany_styl: (R.adoptedStyleSheets || []).length,
          style_prvky: R.querySelectorAll('style').length,
          spustac_pozadie: getComputedStyle(toggle).backgroundColor,
          farba_plna: getComputedStyle(host).getPropertyValue('--a-farba-plna').trim(),
          panel_fixed: getComputedStyle(panel).position,
          panel_sirka: Math.round(panel.getBoundingClientRect().width),
          obrazky: [...R.querySelectorAll('.product-img')].filter((i) => i.complete && i.naturalWidth > 0).length,
        };
      });
      const hex = (rgb) => '#' + (rgb.match(/\d+/g) || []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
      stav.spustac_ma_farbu_obchodu = hex(stav.spustac_pozadie) === stav.farba_plna.toUpperCase();
      stav.ok = stav.porusenia.length === 0 && stav.spustac_ma_farbu_obchodu && stav.panel_fixed === 'fixed';
      vysledok.prehliadace[meno] = stav;
      console.log(meno, stav.ok ? 'OK' : 'NÁLEZ', JSON.stringify(stav));
    } finally {
      await browser.close();
    }
  }
} finally {
  zabi(server);
  vysledok.ok = Object.values(vysledok.prehliadace).every((v) => v.ok);
  writeFileSync(path.join(DIR, 'vysledok.json'), JSON.stringify(vysledok, null, 1));
}
