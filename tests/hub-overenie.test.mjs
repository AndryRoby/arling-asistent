// hub-overenie.test.mjs
//
// Formulár skúšobného účtu na arling.sk (products/arling-sk/asistent/app.js):
// po vytvorení účtu pošle 6-miestny kód (POST /v1/ucet/kod), po jeho zadaní
// získa token (POST /v1/ucet/over) a potvrdí adresu účtu (POST
// /v1/tenants/:id/overenie s Bearer). Pri ďalšom obchode s tou istou adresou
// pošle token rovno s POST /v1/tenants a kód už nepýta. Beží vo vm s malým
// falošným DOM a falošným fetch, žiadna sieť.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const tu = path.dirname(fileURLToPath(import.meta.url));
const SUBOR = path.join(tu, '..', '..', 'arling-sk', 'asistent', 'app.js');
const src = fs.readFileSync(SUBOR, 'utf8');

class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {};
    this.hidden = false; this.className = ''; this.textContent = ''; this.value = ''; this.style = {}; this.parentNode = null; this.disabled = false;
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  querySelector(sel) {
    const cls = sel.slice(1);
    const walk = (e) => { for (const c of e.children) { if ((' ' + c.className + ' ').includes(' ' + cls + ' ')) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this);
  }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
  checkValidity() { return true; }
  reportValidity() {}
  focus() {}
  scrollIntoView() {}
  fire(t) { for (const f of this.listeners[t] || []) f({ preventDefault() {} }); }
}

function prostredie({ overenyPriVytvoreni = false } = {}) {
  const ids = {};
  const kontajner = new El('div');
  for (const id of ['trial-form', 'trial-feed-url', 'trial-email', 'trial-lang', 'trial-submit', 'trial-status', 'trial-widget-note']) ids[id] = new El(id === 'trial-form' ? 'form' : 'input');
  kontajner.appendChild(ids['trial-status']);
  ids['trial-lang'].value = 'sk';
  const ulozisko = new Map();
  const volania = [];
  const odpovede = {
    '/v1/tenants': () => ({ status: 201, body: { id: 't-1', domain: 'shop.sk', status: 'pending', overeny: overenyPriVytvoreni } }),
    '/v1/ucet/kod': () => ({ status: 200, body: { ok: true } }),
    '/v1/ucet/over': () => ({ status: 200, body: { token: 'tok-123', email: 'majitel@gmail.com' } }),
    '/v1/tenants/t-1/overenie': () => ({ status: 200, body: { overeny: true } }),
    '/v1/tenants/t-1/status': () => ({ status: 200, body: { status: 'pending' } }),
  };
  const fetch = async (url, init = {}) => {
    const cesta = new URL(url).pathname;
    volania.push({ cesta, init });
    const o = (odpovede[cesta] || (() => ({ status: 404, body: {} })))();
    return { ok: o.status < 400, status: o.status, json: async () => o.body };
  };
  const document = {
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => new El(tag),
    documentElement: { getAttribute: () => 'sk' },
    readyState: 'complete',
    currentScript: { src: 'https://arling.sk/asistent/app.js' },
    body: new El('body'),
  };
  const window = {
    location: { search: '', href: 'https://arling.sk/asistent/' },
    localStorage: { getItem: (k) => (ulozisko.has(k) ? ulozisko.get(k) : null), setItem: (k, v) => ulozisko.set(k, String(v)), removeItem: (k) => ulozisko.delete(k) },
    addEventListener() {},
  };
  const kontext = { window, document, fetch, URL, URLSearchParams, setTimeout: () => 0, console, navigator: {} };
  vm.runInNewContext(src, kontext);
  return { ids, volania, ulozisko, kontajner };
}

const cakaj = () => new Promise((r) => setImmediate(r));
async function vsetko() { for (let i = 0; i < 10; i++) await cakaj(); }

test('formulár: bez tokenu vytvorí účet, pošle kód, po zadaní kódu potvrdí adresu Bearer tokenom a zapamätá si ho', async () => {
  const p = prostredie();
  p.ids['trial-feed-url'].value = 'https://shop.sk/feed.xml';
  p.ids['trial-email'].value = 'Majitel@Gmail.com';
  p.ids['trial-form'].fire('submit');
  await vsetko();
  const vytvor = p.volania.find((v) => v.cesta === '/v1/tenants');
  assert.equal(vytvor.init.headers.Authorization, undefined);
  const kod = p.volania.find((v) => v.cesta === '/v1/ucet/kod');
  assert.deepEqual(JSON.parse(kod.init.body), { email: 'majitel@gmail.com', jazyk: 'sk' });
  const box = p.kontajner.querySelector('.trial-verify');
  assert.ok(box, 'pole na kód sa zobrazilo');
  assert.match(box.children[0].textContent, /majitel@gmail\.com/);
  const formKod = box.querySelector('.trial-verify-form');
  formKod.querySelector('.field').children[1].value = '123456';
  formKod.fire('submit');
  await vsetko();
  const over = p.volania.find((v) => v.cesta === '/v1/ucet/over');
  assert.deepEqual(JSON.parse(over.init.body), { email: 'majitel@gmail.com', kod: '123456' });
  const potvrd = p.volania.find((v) => v.cesta === '/v1/tenants/t-1/overenie');
  assert.equal(potvrd.init.headers.Authorization, 'Bearer tok-123');
  assert.equal(JSON.parse(p.ulozisko.get('arling_asistent_overenie')).token, 'tok-123');
  assert.match(box.querySelector('.trial-verify-msg').textContent, /Adresa je overená/);
});

test('formulár: s uloženým tokenom ho pošle pri vytvorení a pri overeny: true kód nepýta', async () => {
  const p = prostredie({ overenyPriVytvoreni: true });
  p.ulozisko.set('arling_asistent_overenie', JSON.stringify({ email: 'majitel@gmail.com', token: 'tok-123' }));
  p.ids['trial-feed-url'].value = 'https://shop.sk/feed.xml';
  p.ids['trial-email'].value = 'majitel@gmail.com';
  p.ids['trial-form'].fire('submit');
  await vsetko();
  assert.equal(p.volania.find((v) => v.cesta === '/v1/tenants').init.headers.Authorization, 'Bearer tok-123');
  assert.equal(p.volania.filter((v) => v.cesta === '/v1/ucet/kod').length, 0);
  assert.equal(p.kontajner.querySelector('.trial-verify'), null);
});

test('formulár: neplatný uložený token (overeny: false) sa zahodí a kód sa pošle', async () => {
  const p = prostredie({ overenyPriVytvoreni: false });
  p.ulozisko.set('arling_asistent_overenie', JSON.stringify({ email: 'majitel@gmail.com', token: 'stary' }));
  p.ids['trial-feed-url'].value = 'https://shop.sk/feed.xml';
  p.ids['trial-email'].value = 'majitel@gmail.com';
  p.ids['trial-form'].fire('submit');
  await vsetko();
  assert.equal(p.ulozisko.has('arling_asistent_overenie'), false);
  assert.equal(p.volania.filter((v) => v.cesta === '/v1/ucet/kod').length, 1);
});

test('formulár: texty overenia bez pomlčiek a vo všetkých troch jazykoch stránky', () => {
  assert.ok(!/[–—]/.test(src));
  for (const k of ['verifyIntro', 'verifyLabel', 'verifyButton', 'verifyOk', 'verifyBad', 'verifyExpired', 'verifyFailed', 'codeFailed']) {
    assert.equal((src.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 3, k);
  }
});
