// widget-v2.mjs: spoločný falošný DOM pre testy widgetu v2 (widget-v2, farby-v2).
//
// Rovnaký princíp ako tests/widget.test.mjs (plytký DOM, žiadne parsovanie HTML, id z innerHTML),
// navyše: style.setProperty zapisuje do el._styl, dokument si pamätá poslucháčov, časovače
// sa dajú riadiť (hodiny) a skript widgetu sa skompiluje raz (vm.Script) kvôli 400 spusteniam.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const widgetPath = path.join(__dirname, '../../widget/widget.js');
export const widgetSource = fs.readFileSync(widgetPath, 'utf8');
const skript = new vm.Script(widgetSource, { filename: 'widget.js' });

export function makeElement(tag) {
  const el = {
    tagName: tag,
    attrs: {},
    children: [],
    _listeners: {},
    _text: '',
    _html: '',
    _className: '',
    _styl: {},
    setAttribute(name, value) { el.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    removeAttribute(name) { delete el.attrs[name]; },
    appendChild(child) {
      if (child && child._parent) child.remove();
      el.children.push(child);
      if (child && typeof child === 'object') child._parent = el;
      return child;
    },
    addEventListener(type, handler) { (el._listeners[type] = el._listeners[type] || []).push(handler); },
    removeEventListener(type, handler) {
      const l = el._listeners[type] || [];
      const i = l.indexOf(handler);
      if (i >= 0) l.splice(i, 1);
    },
    remove() {
      const p = el._parent;
      if (p) {
        const i = p.children.indexOf(el);
        if (i >= 0) p.children.splice(i, 1);
        el._parent = null;
      }
    },
    focus() { el._focusCalls = (el._focusCalls || 0) + 1; },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; },
    get className() { return el._className; },
    set className(v) { el._className = v; },
    get innerHTML() { return el._html; },
    set innerHTML(html) {
      el._html = html;
      el._idMap = new Map();
      const re = /id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html))) el._idMap.set(m[1], makeElement('div'));
    },
    getElementById(id) { return (el._idMap && el._idMap.get(id)) || null; },
    attachShadow() {
      const shadow = makeElement('shadow-root');
      el.shadowRoot = shadow;
      return shadow;
    },
  };
  el.style = {
    setProperty(k, v) { el._styl[k] = String(v); },
    removeProperty(k) { delete el._styl[k]; },
  };
  return el;
}

/** sessionStorage: Map za getItem/setItem. */
export function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    _store: store,
  };
}

/** Riadené časovače: test ich spustí sám. */
export function hodiny() {
  const cakajuce = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { id += 1; cakajuce.set(id, { fn, ms }); return id; },
    clearTimeout(i) { cakajuce.delete(i); },
    spusti() { const v = [...cakajuce.values()]; cakajuce.clear(); v.forEach((c) => c.fn()); return v.map((c) => c.ms); },
    get pocet() { return cakajuce.size; },
    get cakajuce() { return [...cakajuce.values()].map((c) => c.ms); },
  };
}

export const tik = () => new Promise((r) => setTimeout(r, 0));

/** fetch, ktorý vracia odpovede zo zoznamu po poradí a pamätá si poslané telá. */
export function fetchZoznam(odpovede) {
  const poslane = [];
  let n = 0;
  const f = async (url, init) => {
    poslane.push({ url: String(url), body: JSON.parse(init.body) });
    const o = odpovede[Math.min(n, odpovede.length - 1)];
    n += 1;
    return { status: o.status || 200, ok: (o.status || 200) < 400, json: async () => o.data || o };
  };
  f.poslane = poslane;
  return f;
}

/**
 * Spustí widget. `attrs` = data-* atribúty skriptu, `window`/`document` = doplnky stubov,
 * `sandbox` = ďalšie globály (napr. CSSStyleSheet), `timers` = hodiny().
 */
export function spusti({ attrs = {}, lang = 'sk', fetch, storage, timers, window: w = {}, document: d = {}, sandbox = {}, createElement } = {}) {
  const scriptEl = makeElement('script');
  scriptEl.src = 'https://arling-asistent.arling.workers.dev/widget.js';
  scriptEl.setAttribute('data-tenant', 'tenant-123');
  if (lang) scriptEl.setAttribute('data-lang', lang);
  Object.keys(attrs).forEach((k) => scriptEl.setAttribute(k, attrs[k]));
  const body = makeElement('body');
  const docListeners = {};
  const documentStub = {
    currentScript: scriptEl,
    body,
    createElement: createElement || ((tag) => makeElement(tag)),
    getElementsByTagName: () => [scriptEl],
    addEventListener(type, f) { (docListeners[type] = docListeners[type] || []).push(f); },
    removeEventListener(type, f) {
      const l = docListeners[type] || [];
      const i = l.indexOf(f);
      if (i >= 0) l.splice(i, 1);
    },
    ...d,
  };
  const windowStub = { location: { href: 'https://shop.example/' }, requestAnimationFrame(fn) { fn(); }, ...w };
  if (storage) windowStub.sessionStorage = storage;
  const g = { window: windowStub, document: documentStub, console: { error() {}, warn() {}, log() {} }, URL, Math, Date, fetch, ...sandbox };
  if (timers) {
    g.setTimeout = timers.setTimeout;
    g.clearTimeout = timers.clearTimeout;
  }
  skript.runInContext(vm.createContext(g));
  const host = body.children[0] || null;
  return { host, root: host && host.shadowRoot, windowStub, documentStub, scriptEl, body, docListeners };
}

export const radky = (root) => root.getElementById('messages').children;

/** Texty celého stromu (textContent a innerHTML každého prvku). */
export function vsetkyTexty(el) {
  return [el._text || '', el._html || '', ...el.children.map(vsetkyTexty)].join(' ');
}

/** CSS widgetu, ako ho dostane <style> v shadow root (bez CSSStyleSheet). */
export function cssZRoot(root) {
  const st = root.children.find((c) => c.tagName === 'style');
  return st ? String(st.textContent) : '';
}

export const dieta = (el, trieda) => el.children.find((c) => (' ' + c.className + ' ').includes(' ' + trieda + ' '));

/** WCAG 2.x kontrast, nezávislá implementácia pre testy. */
export function kontrastWcag(a, b) {
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
