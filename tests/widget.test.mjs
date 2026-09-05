// widget.test.mjs
//
// Loads widget/widget.js itself (not a unit under worker/src/) in a
// jsdom-free way: a minimal fake window/document object is built by hand
// and the script is run against it with node:vm, so this exercises the
// exact top-to-bottom execution order of the real file, including the
// module-load-time bug this test was written to catch (normaliseLang() was
// called before the STRINGS object it reads was assigned, so the widget
// threw a TypeError on every single page load, before any user interaction
// was even possible).
//
// The fake DOM below is deliberately shallow: it does not parse HTML into a
// real node tree, it just remembers, for each element, every id="..."
// found in a string assigned to .innerHTML, and getElementById() looks
// those up. That is enough for boot() to run to completion and wire up its
// event listeners without throwing, which is all this test needs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widgetSource = fs.readFileSync(path.join(__dirname, '../widget/widget.js'), 'utf8');

function makeElement(tag) {
  const el = {
    tagName: tag,
    attrs: {},
    children: [],
    style: {},
    _listeners: {},
    _text: '',
    _html: '',
    _className: '',
    setAttribute(name, value) { el.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    removeAttribute(name) { delete el.attrs[name]; },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener(type, handler) { (el._listeners[type] = el._listeners[type] || []).push(handler); },
    removeEventListener() {},
    remove() {},
    focus() {},
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
      while ((m = re.exec(html))) {
        el._idMap.set(m[1], makeElement('div'));
      }
    },
    getElementById(id) { return (el._idMap && el._idMap.get(id)) || null; },
    attachShadow() {
      const shadow = makeElement('shadow-root');
      el.shadowRoot = shadow;
      return shadow;
    },
  };
  return el;
}

function makeFakeWindowAndDocument({ dataTenant = 'tenant-123', dataLang = 'sk', extraAttrs = {}, navigatorLanguage } = {}) {
  const scriptEl = makeElement('script');
  scriptEl.src = 'https://arling-asistent.arling.workers.dev/widget.js';
  if (dataTenant != null) scriptEl.setAttribute('data-tenant', dataTenant);
  if (dataLang != null) scriptEl.setAttribute('data-lang', dataLang);
  Object.keys(extraAttrs).forEach((name) => scriptEl.setAttribute(name, extraAttrs[name]));

  const body = makeElement('body');

  const documentStub = {
    currentScript: scriptEl,
    body,
    createElement: (tag) => makeElement(tag),
    getElementsByTagName: () => [scriptEl],
    addEventListener() {},
    removeEventListener() {},
  };

  const windowStub = {
    location: { href: 'https://shop.example/' },
    requestAnimationFrame() {},
  };
  if (navigatorLanguage != null) windowStub.navigator = { language: navigatorLanguage };

  return { windowStub, documentStub, scriptEl, body };
}

function runWidget(documentStub, windowStub, fetchImpl) {
  const consoleStub = { error() {}, warn() {}, log() {} };
  const sandbox = { window: windowStub, document: documentStub, console: consoleStub, URL, Math, Date, fetch: fetchImpl };
  const context = vm.createContext(sandbox);
  vm.runInContext(widgetSource, context, { filename: 'widget.js' });
  return sandbox;
}

test('widget.js loads without throwing and creates a shadow-DOM host element on document.body', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();

  assert.doesNotThrow(() => runWidget(documentStub, windowStub));

  assert.equal(body.children.length, 1);
  const host = body.children[0];
  assert.equal(host.getAttribute('data-arling-asistent'), '');
  assert.ok(host.shadowRoot, 'host element must have a shadow root attached');
  // The toggle button (and the rest of the markup) must have been rendered
  // into the shadow root and be reachable by id, proving boot() ran all the
  // way through instead of throwing partway (which is exactly what the
  // STRINGS-before-normaliseLang ordering bug used to do).
  assert.ok(host.shadowRoot.getElementById('toggle'));
  assert.ok(host.shadowRoot.getElementById('panel'));
  assert.ok(host.shadowRoot.getElementById('form'));
});

test('widget.js does not start (and does not throw) when the required data-tenant attribute is missing', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataTenant: null });

  assert.doesNotThrow(() => runWidget(documentStub, windowStub));
  assert.equal(body.children.length, 0);
});

test('widget.js defaults to the right-side position when data-position is absent', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  assert.doesNotMatch(host.className, /position-left/);
});

test('widget.js applies the position-left host class when data-position="left"', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ extraAttrs: { 'data-position': 'left' } });
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  assert.match(host.className, /position-left/);
});

test('widget.js falls back to the right-side position for any data-position value other than "left"', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ extraAttrs: { 'data-position': 'top' } });
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  assert.doesNotMatch(host.className, /position-left/);
});

test('widget.js uses data-title for the panel title and data-greeting for the first assistant message', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({
    extraAttrs: { 'data-title': 'Moj obchodny asistent', 'data-greeting': 'Ahoj, co hladate?' },
  });
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  const root = host.shadowRoot;

  // buildMarkup(t) rendered the custom title into both the header bar text
  // and the dialog's aria-label.
  assert.match(root.innerHTML, /Moj obchodny asistent/);
  assert.doesNotMatch(root.innerHTML, /Asistent obchodu/); // the sk default title must not also be present

  // Opening the panel (simulated by invoking the toggle's click listener
  // directly, since this fake DOM has no real event dispatch) appends the
  // custom greeting as the first assistant message instead of the default.
  const toggle = root.getElementById('toggle');
  toggle._listeners.click[0]();
  const messages = root.getElementById('messages');
  assert.equal(messages.children.length, 1);
  assert.equal(messages.children[0].children[0].textContent, 'Ahoj, co hladate?');
});

test('widget.js falls back to the default title and greeting when data-title/data-greeting are absent', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  const root = host.shadowRoot;

  assert.match(root.innerHTML, /Asistent obchodu/);

  const toggle = root.getElementById('toggle');
  toggle._listeners.click[0]();
  const messages = root.getElementById('messages');
  assert.equal(messages.children[0].children[0].textContent, 'Dobrý deň, ako vám môžem pomôcť s výberom?');
});

test('widget.js UI chrome follows navigator.language when data-lang is absent (the new default is "auto")', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: null, navigatorLanguage: 'de-DE' });
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  const root = host.shadowRoot;

  const toggle = root.getElementById('toggle');
  toggle._listeners.click[0]();
  const messages = root.getElementById('messages');
  assert.equal(messages.children[0].children[0].textContent, 'Hallo, wie kann ich Ihnen bei der Auswahl helfen?');
});

test('widget.js UI chrome falls back to Slovak when data-lang is absent and navigator.language is missing or unsupported', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: null }); // no navigatorLanguage given
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  const root = host.shadowRoot;

  const toggle = root.getElementById('toggle');
  toggle._listeners.click[0]();
  const messages = root.getElementById('messages');
  assert.equal(messages.children[0].children[0].textContent, 'Dobrý deň, ako vám môžem pomôcť s výberom?');
});

test('widget.js sends lang: "auto" to the server by default, but a fixed data-lang value unchanged', async () => {
  async function submitAndCaptureLang({ dataLang, navigatorLanguage }) {
    let sentBody = null;
    const fetchImpl = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
    };
    const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang, navigatorLanguage });
    runWidget(documentStub, windowStub, fetchImpl);
    const root = body.children[0].shadowRoot;
    root.getElementById('input').value = 'Hello';
    root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget sendMessage() reach fetch()
    return sentBody && sentBody.lang;
  }

  assert.equal(await submitAndCaptureLang({ dataLang: null }), 'auto'); // absent data-lang: new default
  assert.equal(await submitAndCaptureLang({ dataLang: 'auto' }), 'auto'); // explicit "auto"
  assert.equal(await submitAndCaptureLang({ dataLang: 'sk' }), 'sk'); // a fixed lang code is sent through unchanged
});

test('widget.js only ever initialises once per page even if the script were somehow run twice', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();

  runWidget(documentStub, windowStub);
  assert.equal(body.children.length, 1);

  // Re-running the exact same source against the same window (which now has
  // __arlingAsistentInit set) must be a no-op, not a second host element.
  const sandbox = { window: windowStub, document: documentStub, console: { error() {}, warn() {}, log() {} }, URL, Math, Date };
  const context = vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(widgetSource, context, { filename: 'widget.js' }));
  assert.equal(body.children.length, 1);
});
