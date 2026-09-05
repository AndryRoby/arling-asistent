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

function makeFakeWindowAndDocument({ dataTenant = 'tenant-123', dataLang = 'sk' } = {}) {
  const scriptEl = makeElement('script');
  scriptEl.src = 'https://arling-asistent.arling.workers.dev/widget.js';
  if (dataTenant != null) scriptEl.setAttribute('data-tenant', dataTenant);
  if (dataLang != null) scriptEl.setAttribute('data-lang', dataLang);

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

  return { windowStub, documentStub, scriptEl, body };
}

function runWidget(documentStub, windowStub) {
  const consoleStub = { error() {}, warn() {}, log() {} };
  const sandbox = { window: windowStub, document: documentStub, console: consoleStub, URL, Math, Date };
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
