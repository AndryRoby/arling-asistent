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
    appendChild(child) { el.children.push(child); if (child && typeof child === 'object') child._parent = el; return child; },
    addEventListener(type, handler) { (el._listeners[type] = el._listeners[type] || []).push(handler); },
    removeEventListener() {},
    // Skutočné odobratie z rodiča (krok 1, W3): riadok „píše“ a chybový riadok musia naozaj zmiznúť.
    remove() {
      const p = el._parent;
      if (p) {
        const i = p.children.indexOf(el);
        if (i >= 0) p.children.splice(i, 1);
        el._parent = null;
      }
    },
    // Not a real focus manager (no notion of a single document.activeElement
    // or blur-on-disable, which is exactly the browser behaviour the focus
    // regression tests below cannot reproduce here): just a call counter, so
    // a test can assert that the widget code attempted to focus a given
    // element without needing a real DOM.
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

/** Minimal sessionStorage stand-in: a Map behind getItem/setItem, or one that throws (private mode, storage blocked). */
function makeSessionStorage({ throws = false, initial = {} } = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) { if (throws) throw new Error('storage blocked'); return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { if (throws) throw new Error('storage blocked'); store.set(key, String(value)); },
    _store: store,
  };
}

function makeFakeWindowAndDocument({ dataTenant = 'tenant-123', dataLang = 'sk', extraAttrs = {}, navigatorLanguage, sessionStorage } = {}) {
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
    // Run synchronously (a real browser defers to the next frame): nothing
    // in this file depends on that deferral, and running inline lets tests
    // observe the focus() calls boot() schedules through it (openPanel,
    // showGiftStep, setSending) without an extra microtask/rAF shim.
    requestAnimationFrame(fn) { fn(); },
  };
  if (navigatorLanguage != null) windowStub.navigator = { language: navigatorLanguage };
  if (sessionStorage) windowStub.sessionStorage = sessionStorage;

  return { windowStub, documentStub, scriptEl, body };
}

/** Texty celého stromu falošného DOM (textContent a innerHTML každého prvku). */
function vsetkyTexty(el) {
  return [el._text || '', el._html || '', ...el.children.map(vsetkyTexty)].join(' ');
}

function runWidget(documentStub, windowStub, fetchImpl, extra = {}) {
  const consoleStub = { error() {}, warn() {}, log() {} };
  // `extra`: napr. riadené časovače a AbortController pre testy časového limitu (krok 1, W3).
  const sandbox = { window: windowStub, document: documentStub, console: consoleStub, URL, Math, Date, fetch: fetchImpl, ...extra };
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

test('widget.js UI chrome falls back to English when data-lang is absent and navigator.language is missing or unsupported', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: null }); // no navigatorLanguage given
  runWidget(documentStub, windowStub);
  const host = body.children[0];
  const root = host.shadowRoot;

  const toggle = root.getElementById('toggle');
  toggle._listeners.click[0]();
  const messages = root.getElementById('messages');
  // Anglictina, nie slovencina: plugin je vo svetovom adresari WordPressu a
  // neznamy locale (fr, pl, it) nesmie dostat slovensky chat.
  assert.equal(messages.children[0].children[0].textContent, 'Hello, how can I help you choose?');
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

// ---------------------------------------------------------------------------
// Session id, quota_exceeded rendering, footer attribution
// ---------------------------------------------------------------------------

/** Boot the widget with a recording fetch stub, submit `text`, and return {sentBodies, root}. */
async function submitMessages(texts, { fetchResponse, ...opts } = {}) {
  const sentBodies = [];
  const fetchImpl = async (url, fetchOpts) => {
    sentBodies.push(JSON.parse(fetchOpts.body));
    return fetchResponse || { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument(opts);
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  for (const text of texts) {
    root.getElementById('input').value = text;
    root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { sentBodies, root, windowStub };
}

test('widget.js sends a 16-hex session id as "session" in every /v1/chat body, stable across messages in the same tab', async () => {
  const storage = makeSessionStorage();
  const { sentBodies } = await submitMessages(['Hello', 'And in blue?'], { sessionStorage: storage });
  assert.equal(sentBodies.length, 2);
  assert.match(sentBodies[0].session, /^[0-9a-f]{16}$/);
  assert.equal(sentBodies[1].session, sentBodies[0].session);
  assert.equal(storage._store.get('arling_asistent_session'), sentBodies[0].session); // persisted for the tab's lifetime
});

test('widget.js reuses the session id already in sessionStorage (same conversation after a page navigation)', async () => {
  const storage = makeSessionStorage({ initial: { arling_asistent_session: 'deadbeefdeadbeef' } });
  const { sentBodies } = await submitMessages(['Hello'], { sessionStorage: storage });
  assert.equal(sentBodies[0].session, 'deadbeefdeadbeef');
});

test('widget.js replaces a malformed stored session id and still works without sessionStorage or when it throws', async () => {
  const bad = makeSessionStorage({ initial: { arling_asistent_session: 'not-hex!' } });
  const replaced = await submitMessages(['Hello'], { sessionStorage: bad });
  assert.match(replaced.sentBodies[0].session, /^[0-9a-f]{16}$/);
  assert.equal(bad._store.get('arling_asistent_session'), replaced.sentBodies[0].session);

  const none = await submitMessages(['Hello']); // no sessionStorage on window at all
  assert.match(none.sentBodies[0].session, /^[0-9a-f]{16}$/);

  const throwing = await submitMessages(['Hello'], { sessionStorage: makeSessionStorage({ throws: true }) });
  assert.match(throwing.sentBodies[0].session, /^[0-9a-f]{16}$/);
});

test('widget.js two separate tabs (separate sessionStorage) get different session ids', async () => {
  const a = await submitMessages(['Hello'], { sessionStorage: makeSessionStorage() });
  const b = await submitMessages(['Hello'], { sessionStorage: makeSessionStorage() });
  assert.notEqual(a.sentBodies[0].session, b.sentBodies[0].session);
});

const QUOTA_MESSAGES = {
  sk: 'Asistent si dnes oddychuje. Použite prosím kontaktnú stránku obchodu.',
  cs: 'Asistent si dnes odpočívá. Použijte prosím kontaktní stránku obchodu.',
  en: "The assistant is resting today. Please use the shop's contact page.",
  de: 'Der Assistent macht heute Pause. Bitte nutzen Sie die Kontaktseite des Shops.',
};

for (const lang of Object.keys(QUOTA_MESSAGES)) {
  test(`widget.js renders the calm quota_exceeded message in ${lang} on a 429 {error:"quota_exceeded"}, with no mention of billing or limits`, async () => {
    const fetchResponse = { status: 429, ok: false, json: async () => ({ error: 'quota_exceeded' }) };
    const { root } = await submitMessages(['Hello'], { dataLang: lang, fetchResponse, sessionStorage: makeSessionStorage() });
    const messages = root.getElementById('messages');
    // children: the user's bubble row, then the assistant's reply row (thinking row was removed via remove(), which the fake DOM ignores, so filter by text instead).
    const texts = messages.children.map((row) => row.children[0].textContent);
    assert.ok(texts.includes(QUOTA_MESSAGES[lang]), `expected ${lang} message, got ${JSON.stringify(texts)}`);
    const reply = QUOTA_MESSAGES[lang];
    assert.doesNotMatch(reply, /billing|plan|quota|limit|upgrade|kvót|limit|tarif|Abo|Kontingent/i);
  });
}

test('widget.js renders the same calm quota_exceeded message on a 503 {error:"quota_exceeded"} (Workers AI account-wide capacity limit, not this tenant\'s usage)', async () => {
  const fetchResponse = { status: 503, ok: false, json: async () => ({ error: 'quota_exceeded' }) };
  const { root } = await submitMessages(['Hello'], { dataLang: 'en', fetchResponse, sessionStorage: makeSessionStorage() });
  const texts = root.getElementById('messages').children.map((row) => row.children[0].textContent);
  assert.ok(texts.includes(QUOTA_MESSAGES.en));
});

test('widget.js shows the rate-limited message (not the quota one) on a 429 without quota_exceeded', async () => {
  const fetchResponse = { status: 429, ok: false, json: async () => ({ error: 'rate_limited' }) };
  const { root } = await submitMessages(['Hello'], { dataLang: 'en', fetchResponse, sessionStorage: makeSessionStorage() });
  const texts = root.getElementById('messages').children.map((row) => row.children[0].textContent);
  assert.ok(texts.includes('Too many messages at once. Please try again shortly.'));
  assert.equal(texts.includes(QUOTA_MESSAGES.en), false);
});

test('widget.js keeps the "Powered by ARLing Shopping Assistant" footer link and tags it with utm_source=widget&utm_medium=referral', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'en' });
  runWidget(documentStub, windowStub);
  const html = body.children[0].shadowRoot.innerHTML;
  assert.match(html, /<div class="footer"><a href="https:\/\/arling\.sk\/asistent\/\?utm_source=widget&utm_medium=referral" target="_blank" rel="noopener">Powered by ARLing Shopping Assistant<\/a><\/div>/);
});

test('widget.js sets no cookies and never touches localStorage (only sessionStorage for the session id)', () => {
  assert.doesNotMatch(widgetSource, /document\.cookie/);
  // The header comment may mention localStorage as something the widget
  // avoids; what must not exist is an actual access to it.
  assert.doesNotMatch(widgetSource, /localStorage\.\w/); // property access such as localStorage.setItem (the prose "localStorage. The" has a space after the dot)
  assert.doesNotMatch(widgetSource, /localStorage\s*\[/);
  assert.doesNotMatch(widgetSource, /['"]localStorage['"]/);
  assert.match(widgetSource, /sessionStorage/);
});

// ---------------------------------------------------------------------------
// Public API: window.ArlingAsistent.ask() (suggested-question buttons on a host page)
// ---------------------------------------------------------------------------

test('widget.js exposes window.ArlingAsistent.ask(), which opens the panel and sends the text like a typed message', async () => {
  const sentBodies = [];
  const fetchImpl = async (url, fetchOpts) => {
    sentBodies.push(JSON.parse(fetchOpts.body));
    return { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'sk' });
  runWidget(documentStub, windowStub, fetchImpl);
  const api = windowStub.ArlingAsistent;
  assert.ok(api && typeof api.ask === 'function' && typeof api.open === 'function' && typeof api.close === 'function');

  const root = body.children[0].shadowRoot;
  const panel = root.getElementById('panel');
  assert.equal(api.ask('  Aký kávovar do 100 eur?  '), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.hidden, false, 'ask() must open the panel');
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].messages[sentBodies[0].messages.length - 1].content, 'Aký kávovar do 100 eur?');
  assert.equal(sentBodies[0].lang, 'sk');

  // Empty text only opens the panel and sends nothing.
  assert.equal(api.ask('   '), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sentBodies.length, 1);

  // Text is capped at 2000 characters, the same limit as the composer input.
  assert.equal(api.ask('x'.repeat(2500)), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sentBodies[1].messages[sentBodies[1].messages.length - 1].content.length, 2000);
});

test('widget.js ArlingAsistent.ask() is ignored while a reply is still pending', async () => {
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const { windowStub, documentStub } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub, fetchImpl);
  const api = windowStub.ArlingAsistent;
  assert.equal(api.ask('prvá otázka'), true);
  assert.equal(api.ask('druhá otázka'), false, 'second ask while sending must be refused');
  resolveFetch({ status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(api.ask('tretia otázka'), true, 'after the reply arrived ask() works again');
});

// ---------------------------------------------------------------------------
// Focus and keyboard: Enter sends, Shift+Enter inserts a newline, and focus
// stays in #input across a send instead of forcing the visitor to click
// back into it (see widget/widget.js setSending()/trySend()). Previously
// #input was disabled while sending, and a disabled form control cannot
// hold focus in a real browser: this fake DOM has no such side effect, so
// these tests check what boot() itself does (readOnly vs. disabled, and
// how many times it calls .focus()) rather than a real blur.
// ---------------------------------------------------------------------------

test('widget.js makes #input read-only (never disabled) while a reply is pending, and plain again once it resolves', async () => {
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  const input = root.getElementById('input');

  input.value = 'Aky kavovar do 100 eur?';
  root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });

  assert.equal(input.readOnly, true, 'input must be read-only while a reply is pending');
  assert.notEqual(input.disabled, true, 'input must never be disabled: that blurs it in a real browser');
  assert.equal(root.getElementById('send-btn').disabled, true);

  resolveFetch({ status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(input.readOnly, false);
  assert.equal(root.getElementById('send-btn').disabled, false);
});

test('widget.js (re)focuses #input right when a send starts and again once the reply has rendered', async () => {
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  const input = root.getElementById('input');

  input.value = 'Aky kavovar do 100 eur?';
  const beforeSend = input._focusCalls || 0;
  root.getElementById('form')._listeners.submit[0]({ preventDefault() {} }); // as if #send-btn had just taken focus on click
  assert.ok((input._focusCalls || 0) > beforeSend, 'sending must claim focus back for the input, e.g. after a Send-button click');

  const afterSend = input._focusCalls;
  resolveFetch({ status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(input._focusCalls > afterSend, 'the input must be focused again once it is interactive, so the next question needs no extra click');
});

test('widget.js Enter sends the message; Shift+Enter is left alone so the textarea inserts its own newline', async () => {
  const sentBodies = [];
  const fetchImpl = async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    return { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  const input = root.getElementById('input');

  input.value = 'Prvy riadok';
  let prevented = false;
  input._listeners.keydown[0]({ key: 'Enter', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'Shift+Enter must not be intercepted: the browser inserts the newline itself');
  assert.equal(sentBodies.length, 0);
  assert.equal(input.value, 'Prvy riadok'); // untouched by a Shift+Enter

  input._listeners.keydown[0]({ key: 'Enter', shiftKey: false, preventDefault() { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prevented, true, 'a plain Enter must be intercepted so the textarea does not also add a newline');
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].messages[0].content, 'Prvy riadok');
  assert.equal(input.value, ''); // cleared exactly like a Send-button submit
});

test('widget.js Enter is ignored while a reply is already pending, same guard as the Send button', async () => {
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  const input = root.getElementById('input');

  input.value = 'Prva otazka';
  root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });

  input.value = 'Druha otazka';
  input._listeners.keydown[0]({ key: 'Enter', shiftKey: false, preventDefault() {} });
  assert.equal(input.value, 'Druha otazka', 'a second message must not be sent (or cleared) while the first is still pending');

  resolveFetch({ status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// ---------------------------------------------------------------------------
// data-answer-lang: lets the assistant auto-detect the reply language while
// data-lang keeps the widget's own chrome fixed (e.g. a single-language shop
// that still wants to serve a visitor typing in a different language).
// ---------------------------------------------------------------------------

test('widget.js data-answer-lang="auto" sends lang: "auto" to the server while the chrome stays on the fixed data-lang', async () => {
  let sentBody = null;
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({
    dataLang: 'sk',
    navigatorLanguage: 'en-US', // proves the chrome is not merely "coincidentally" Slovak
    extraAttrs: { 'data-answer-lang': 'auto' },
  });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;

  assert.match(root.innerHTML, /Napíšte otázku/); // sk placeholder: chrome follows the fixed data-lang, not the browser

  root.getElementById('input').value = 'hello';
  root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sentBody.lang, 'auto');
});

test('widget.js without data-answer-lang, a fixed data-lang still sends that same fixed lang to the server (unchanged behaviour)', async () => {
  let sentBody = null;
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'sk' });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  root.getElementById('input').value = 'hello';
  root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sentBody.lang, 'sk');
});

test('widget.js data-answer-lang is a no-op when data-lang is already absent or "auto" (chrome already implies auto-detected answers)', async () => {
  let sentBody = null;
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({
    dataLang: null,
    extraAttrs: { 'data-answer-lang': 'sk' }, // a nonsensical combination that must not break anything
  });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  root.getElementById('input').value = 'hello';
  root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sentBody.lang, 'auto');
});

test('widget.js stylesheet keeps the panel closed while its hidden attribute is set (author display:flex must not beat [hidden])', () => {
  // Regression guard: #panel is display:flex in the widget stylesheet, and an
  // author rule outranks the UA stylesheet's [hidden]{display:none}, so
  // without an explicit #panel[hidden] rule the empty panel was open on
  // every page load of every shop that embeds the widget.
  assert.match(widgetSource, /#panel\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub);
  const root = body.children[0].shadowRoot;
  assert.match(root.innerHTML, /<div id="panel"[^>]*\shidden>/, 'panel markup must start with the hidden attribute');
});

// ---------------------------------------------------------------------------
// Gift Finder (data-gift="1"): absent by default, opt-in second mode
// ---------------------------------------------------------------------------

test('widget.js renders no gift button, no gift markup, and no gift-related globals when data-gift is absent (byte-identical to before this feature existed)', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument();
  runWidget(documentStub, windowStub);
  const root = body.children[0].shadowRoot;
  assert.equal(root.getElementById('gift-toggle'), null);
  assert.doesNotMatch(root.innerHTML, /gift-panel/);
  assert.doesNotMatch(root.innerHTML, /gift-toggle/);
});

test('widget.js treats any data-gift value other than the exact string "1" as absent', () => {
  for (const value of ['true', '0', 'yes', '']) {
    const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ extraAttrs: { 'data-gift': value } });
    runWidget(documentStub, windowStub);
    const root = body.children[0].shadowRoot;
    assert.equal(root.getElementById('gift-toggle'), null, `data-gift="${value}" must not enable the feature`);
  }
});

test('widget.js adds a localized "find a gift" button next to the chat bubble for all four languages when data-gift="1"', () => {
  // v2: tlačidlo #gift-toggle je dlaždica v úvode (ikona a text giftButton), sk „Nájsť darček“ (SPEC 4.3, príloha A).
  const labels = { sk: 'Nájsť darček', cs: 'Najít dárek', en: 'Find a gift', de: 'Geschenk finden' };
  for (const lang of Object.keys(labels)) {
    const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: lang, extraAttrs: { 'data-gift': '1' } });
    runWidget(documentStub, windowStub);
    const root = body.children[0].shadowRoot;
    const giftToggle = root.getElementById('gift-toggle');
    assert.ok(giftToggle, `gift-toggle must exist for lang=${lang}`);
    assert.match(root.innerHTML, new RegExp('<button id="gift-toggle"[^>]*>(?:(?!</button>).)*' + labels[lang].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</span></button>'));
  }
});

/**
 * Boots the widget with data-gift="1" and drives the three-step flow:
 * click the gift toggle, pick a recipient chip, pick a budget chip, type
 * interests, click submit. Returns the sent request bodies and the shadow
 * root so a test can assert on the rendered result.
 */
async function runGiftFlow({ fetchResponse, dataLang = 'sk', recipientChipIndex = 0, budgetChipIndex = 1, interestsText = 'kava', umami, sessionStorage, extraAttrs = {}, navigatorLanguage } = {}) {
  const sentBodies = [];
  const fetchImpl = async (url, opts) => {
    sentBodies.push({ url: String(url), body: JSON.parse(opts.body) });
    return fetchResponse || { status: 200, ok: true, json: async () => ({ picks: [], candidates: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang, extraAttrs: { 'data-gift': '1', ...extraAttrs }, sessionStorage, navigatorLanguage });
  if (umami) windowStub.umami = umami;
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;

  root.getElementById('gift-toggle')._listeners.click[0]();
  root.getElementById('gift-recipient-chips').children[recipientChipIndex]._listeners.click[0]();
  root.getElementById('gift-budget-chips').children[budgetChipIndex]._listeners.click[0]();
  root.getElementById('gift-interests-input').value = interestsText;
  root.getElementById('gift-submit-btn')._listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { sentBodies, root, windowStub };
}

test('widget.js gift flow sends tenant/lang/recipient/budget/interests/session in the POST /v1/gift body, and tracks gift_open + gift_submit', async () => {
  const umamiCalls = [];
  const { sentBodies, root } = await runGiftFlow({
    recipientChipIndex: 1, // "Mama"
    budgetChipIndex: 2, // "do 100 €" -> {min:0, max:100}
    interestsText: 'zahrada a caj',
    umami: { track: (event, data) => umamiCalls.push({ event, data }) },
  });

  assert.equal(sentBodies.length, 1);
  assert.match(sentBodies[0].url, /\/v1\/gift$/);
  const sent = sentBodies[0].body;
  assert.equal(sent.tenant, 'tenant-123');
  assert.equal(sent.lang, 'sk');
  assert.equal(sent.recipient, 'Mama');
  assert.equal(sent.budget_min, 0);
  assert.equal(sent.budget_max, 100);
  assert.equal(sent.interests, 'zahrada a caj');
  assert.match(sent.session, /^[0-9a-f]{16}$/);

  assert.ok(umamiCalls.some((c) => c.event === 'gift_open'));
  assert.ok(umamiCalls.some((c) => c.event === 'gift_submit'));
  // No customer-typed text (recipient/interests) is ever sent as event data.
  for (const call of umamiCalls) {
    assert.doesNotMatch(JSON.stringify(call.data || {}), /zahrada|Mama/);
  }

  // The results step is now showing (thinking, then the resolved reply).
  assert.equal(root.getElementById('gift-step-results').hidden, false);
});

// Naživo 29. 9. 2026: ukážka posiela chatu "auto" a model pri darčeku pre „Mama“ písal dôvody po anglicky.
// Darček preto posiela jazyk rozhrania, v ktorom sú čipy aj celý formulár; chat ostáva na "auto".
test('widget.js gift flow posiela jazyk rozhrania aj pri "auto" odpovediach chatu', async () => {
  const a = await runGiftFlow({ dataLang: 'sk', extraAttrs: { 'data-answer-lang': 'auto' } });
  assert.equal(a.sentBodies[0].body.lang, 'sk');
  const b = await runGiftFlow({ dataLang: null, navigatorLanguage: 'de-DE' });
  assert.equal(b.sentBodies[0].body.lang, 'de');
});

test('widget.js gift flow supports an open budget ("100+"): the last chip sends budget_min=100 and budget_max=null', async () => {
  const { sentBodies } = await runGiftFlow({ budgetChipIndex: 3 });
  assert.equal(sentBodies[0].body.budget_min, 100);
  assert.equal(sentBodies[0].body.budget_max, null);
});

test('widget.js gift flow renders result cards with title, price and the model\'s "why" reason, and links track gift_product_click', async () => {
  const fetchResponse = {
    status: 200,
    ok: true,
    json: async () => ({
      picks: [{ title: 'Čajová súprava', url: 'https://shop.sk/p/1', image: 'https://shop.sk/i/1.jpg', price: 24.9, currency: 'EUR', why: 'Ladí so záľubou v čaji' }],
      candidates: [{ title: 'Čajová súprava', url: 'https://shop.sk/p/1', price: 24.9, currency: 'EUR' }],
      widened: false,
      few: false,
    }),
  };
  const umamiCalls = [];
  const { root } = await runGiftFlow({ fetchResponse, umami: { track: (event, data) => umamiCalls.push({ event, data }) } });

  const list = root.getElementById('gift-results-list');
  assert.equal(list.children.length, 1);
  // v2: položka zoznamu nesie rolu listitem, karta je odkaz v nej (K6); cena v miestnom formáte meny (K6).
  assert.equal(list.children[0].getAttribute('role'), 'listitem');
  const card = list.children[0].children[0];
  // Karta sa skladá z prvkov (createElement), nie z innerHTML: text celého stromu.
  const text = vsetkyTexty(card);
  assert.match(text, /Čajová súprava/);
  assert.match(text, /24,90\s€/);
  assert.match(text, /Ladí so záľubou v čaji/);
  assert.equal(card.href, 'https://shop.sk/p/1');

  card._listeners.click[0]();
  assert.ok(umamiCalls.some((c) => c.event === 'gift_product_click'));

  // No extra note (no widening, no scarcity, at least one pick).
  assert.equal(root.getElementById('gift-note').hidden, true);
  // Nothing left to show more of (candidates == picks here).
  assert.equal(root.getElementById('gift-show-more').hidden, true);
});

test('widget.js "Ukázať ďalšie" reveals the remaining candidates from the same response, with no second network request', async () => {
  const fetchResponse = {
    status: 200,
    ok: true,
    json: async () => ({
      picks: [{ title: 'A', url: 'https://x/a', price: 10, currency: 'EUR', why: 'ok' }],
      candidates: [
        { title: 'A', url: 'https://x/a', price: 10, currency: 'EUR' },
        { title: 'B', url: 'https://x/b', price: 12, currency: 'EUR' },
        { title: 'C', url: 'https://x/c', price: 14, currency: 'EUR' },
      ],
      widened: false,
      few: true,
    }),
  };
  const { root, sentBodies } = await runGiftFlow({ fetchResponse });

  const list = root.getElementById('gift-results-list');
  assert.equal(list.children.length, 1); // only the one pick shown initially
  const showMore = root.getElementById('gift-show-more');
  assert.equal(showMore.hidden, false);
  assert.equal(root.getElementById('gift-note').hidden, false); // "few" note shown

  showMore._listeners.click[0]();
  assert.equal(list.children.length, 3); // the two remaining candidates were appended
  assert.equal(sentBodies.length, 1); // still just the one POST /v1/gift
  assert.equal(showMore.hidden, true);
});

test('widget.js gift flow shows the widened-budget note honestly when the server reports widened:true', async () => {
  const fetchResponse = { status: 200, ok: true, json: async () => ({ picks: [{ title: 'A', url: 'https://x/a', price: 10, why: 'ok' }], candidates: [{ title: 'A', url: 'https://x/a', price: 10 }], widened: true, few: false }) };
  const { root } = await runGiftFlow({ fetchResponse, dataLang: 'en' });
  const note = root.getElementById('gift-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /widened/i);
});

test('widget.js gift flow shows an honest empty-result message when picks is empty, with no cards', async () => {
  const fetchResponse = { status: 200, ok: true, json: async () => ({ picks: [], candidates: [], widened: false, few: true }) };
  const { root } = await runGiftFlow({ fetchResponse, dataLang: 'en' });
  const list = root.getElementById('gift-results-list');
  assert.equal(list.children.length, 0);
  const note = root.getElementById('gift-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /could not find/i);
});

test('widget.js gift flow reuses the calm quota/rate-limit messages on a 429, same wording as chat, for all four languages', async () => {
  for (const [lang, quotaMsg] of Object.entries(QUOTA_MESSAGES)) {
    const fetchResponse = { status: 429, ok: false, json: async () => ({ error: 'quota_exceeded' }) };
    const { root } = await runGiftFlow({ fetchResponse, dataLang: lang });
    assert.equal(root.getElementById('gift-note').textContent, quotaMsg);
  }
  const rateLimited = await runGiftFlow({ fetchResponse: { status: 429, ok: false, json: async () => ({ error: 'rate_limited' }) }, dataLang: 'en' });
  assert.equal(rateLimited.root.getElementById('gift-note').textContent, 'Too many messages at once. Please try again shortly.');
});

test('widget.js gift flow shows the same calm quota message on a 503 {error:"quota_exceeded"}, same as chat', async () => {
  const fetchResponse = { status: 503, ok: false, json: async () => ({ error: 'quota_exceeded' }) };
  const { root } = await runGiftFlow({ fetchResponse, dataLang: 'en' });
  assert.equal(root.getElementById('gift-note').textContent, QUOTA_MESSAGES.en);
});

test('widget.js "Opýtať sa na niečo iné" closes the gift panel and opens the normal chat panel', async () => {
  const { root } = await runGiftFlow();
  assert.equal(root.getElementById('gift-panel').hidden, false);

  root.getElementById('gift-ask-else')._listeners.click[0]();

  assert.equal(root.getElementById('gift-panel').hidden, true);
  assert.equal(root.getElementById('panel').hidden, false);
  const messages = root.getElementById('messages');
  assert.equal(messages.children.length, 1); // the chat greeting, since no chat message had been sent yet
});

test('widget.js clicking the round chat bubble while the gift panel is open closes the gift panel', async () => {
  const { root } = await runGiftFlow();
  assert.equal(root.getElementById('gift-panel').hidden, false);

  root.getElementById('toggle')._listeners.click[0]();

  // v2: sprievodca je pohľad v paneli; spúšťač panel zavrie a s ním aj pohľad sprievodcu (SPEC 8.9).
  assert.equal(root.getElementById('gift-panel').hidden, true);
  assert.equal(root.getElementById('panel').hidden, true);
  assert.equal(root.getElementById('messages').hidden, false, 'pri ďalšom otvorení je vidno rozhovor');
});

test('widget.js gift recipient free-text input (no chip) is sent as-is, e.g. "babka" (not one of the preset chips)', async () => {
  const sentBodies = [];
  const fetchImpl = async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    return { status: 200, ok: true, json: async () => ({ picks: [], candidates: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ extraAttrs: { 'data-gift': '1' } });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;

  root.getElementById('gift-toggle')._listeners.click[0]();
  root.getElementById('gift-recipient-input').value = 'babka';
  root.getElementById('gift-recipient-next')._listeners.click[0]();
  root.getElementById('gift-budget-chips').children[0]._listeners.click[0]();
  root.getElementById('gift-interests-input').value = 'zahrada a caj';
  root.getElementById('gift-submit-btn')._listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sentBodies[0].recipient, 'babka');
});

// ---------------------------------------------------------------------------
// surface: "admin" len v administrácii WordPressu (zivotny-cyklus, test 29)
// ---------------------------------------------------------------------------

async function prvyChatBody(location) {
  const sentBodies = [];
  const fetchImpl = async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    return { status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ sessionStorage: makeSessionStorage() });
  windowStub.location = location;
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  root.getElementById('input').value = 'Hello';
  root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return sentBodies[0];
}

test('widget.js sends surface "admin" only on /wp-admin/ pages; elsewhere the field is absent', async () => {
  const admin = await prvyChatBody({ href: 'https://shop.sk/wp-admin/admin.php?page=arling-asistent', pathname: '/wp-admin/admin.php' });
  assert.equal(admin.surface, 'admin');
  const hrefOnly = await prvyChatBody({ href: 'https://shop.sk/wp-admin/admin.php?page=arling-asistent' });
  assert.equal(hrefOnly.surface, 'admin');
  const web = await prvyChatBody({ href: 'https://shop.sk/produkt/wp-admin-navod/', pathname: '/produkt/wp-admin-navod/' });
  assert.equal('surface' in web, false);
  const home = await prvyChatBody({ href: 'https://shop.sk/', pathname: '/' });
  assert.equal('surface' in home, false);
});

test('npm run build:widget output is current: worker/src/widget-src.js and demo/widget.js match widget/widget.js', async () => {
  const demo = fs.readFileSync(path.join(__dirname, '../demo/widget.js'), 'utf8');
  assert.equal(demo, widgetSource);
  // v2: tretí výstup, kópia pre arling.sk/asistent/ (SPEC 0.3), už nie ručne.
  const hub = fs.readFileSync(path.join(__dirname, '../../arling-sk/asistent/widget.js'), 'utf8');
  assert.equal(hub, widgetSource);
  const { default: servirovany } = await import('../worker/src/widget-src.js');
  assert.equal(servirovany, widgetSource);
});

// ---------------------------------------------------------------------------
// Krok 1 plánu (ops/asistent/genialny-plan.md 4.2): podpísaná relácia a 11. otázka
// ---------------------------------------------------------------------------

test('widget.js s workerom: 11 otazok v jednej karte, token relacie sa posiela dalej, najviac 6 sprav, ziadny networkError, 2 rozhovory', async () => {
  const { default: worker } = await import('../worker/src/index.js');
  const { createTenant, setTenantStatus } = await import('../worker/src/tenants.js');
  const { createMockD1 } = await import('./helpers/mock-d1.mjs');
  const { createMockAI, createMockVectorize, createMockKV } = await import('./helpers/mock-cf.mjs');
  const env = {
    DB: createMockD1(),
    AI: createMockAI({ embedDim: 4, chatResponse: JSON.stringify({ answer: 'Mame to.', products: [] }) }),
    VECTORIZE: createMockVectorize(),
    ASISTENT_CACHE: createMockKV(),
    ALLOWED_ORIGINS: 'arling.sk',
    UCET_TAJOMSTVO: 'dGVzdG92YWNpZS10YWpvbXN0dm8=',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
  };
  const tenant = await createTenant(env.DB, { domain: 'shop.example', feedUrl: 'https://shop.example/feed.xml', contactEmail: 'a@shop.example' });
  await setTenantStatus(env.DB, tenant.id, 'ready');
  // Platený obchod: bezplatný má od opravy nálezov kroku 1 len 10 otázok s
  // modelom na sieť IP a deň (security.js DENNY_LIMIT_IP_AI), 11. otázka by
  // bola odpoveď bez modelu. Tu ide o správanie widgetu pri 11. otázke.
  const { setTenantPlan } = await import('../worker/src/tenants.js');
  await setTenantPlan(env.DB, tenant.id, { plan: 'starter' });
  await env.VECTORIZE.upsert([{ id: `${tenant.id}::p1::0`, values: [1, 0, 0, 0], metadata: { tenant: tenant.id, productId: 'p1', title: 'Produkt', url: 'https://shop.example/p/1', availability: 'in_stock' } }]);

  const sent = [];
  const statuses = [];
  const replies = [];
  const fetchImpl = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    const res = await worker.fetch(new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example', 'CF-Connecting-IP': '5.5.5.5' },
      body: opts.body,
    }), env, {});
    statuses.push(res.status);
    const data = await res.json();
    replies.push(data);
    return { status: res.status, ok: res.ok, json: async () => data };
  };
  const storage = makeSessionStorage();
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataTenant: tenant.id, sessionStorage: storage });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  const input = root.getElementById('input');

  for (let i = 1; i <= 11; i++) {
    input.value = `Otazka ${i}`;
    root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
    for (let tick = 0; tick < 500 && (replies.length < i || input.readOnly); tick++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(replies.length, i, `odpoved na otazku ${i}`);
  }

  assert.deepEqual(statuses, new Array(11).fill(200));
  assert.equal(sent[0].relacia, undefined, 'prva otazka nema token');
  for (let i = 1; i < 11; i++) {
    assert.equal(sent[i].relacia, replies[i - 1].relacia, `otazka ${i + 1} posiela token z predoslej odpovede`);
  }
  for (const b of sent) assert.ok(b.messages.length <= 6, `poslanych sprav ${b.messages.length}`);
  assert.equal(sent[10].messages[sent[10].messages.length - 1].content, 'Otazka 11');
  assert.equal(storage._store.get('arling_asistent_relacia'), replies[10].relacia);
  assert.equal(env.DB._tenants.get(tenant.id).used_this_month, 2, '10 otazok je jeden rozhovor, 11. otazka zacina druhy');

  const texty = root.getElementById('messages').children.map((row) => row.children[0].textContent);
  assert.equal(texty.includes(STRINGS_NETWORK_ERROR_SK), false, 'widget nezobrazil networkError');
  assert.equal(texty.filter((t) => t === 'Mame to.').length, 11);
});

const STRINGS_NETWORK_ERROR_SK = 'Odpoveď sa nepodarilo načítať. Skúste to prosím znova.';

test('widget.js ulozi token relacie z odpovede /v1/chat a posle ho s dalsou otazkou; neplatny token neulozi', async () => {
  const token = 'r1.eyJ0IjoidCJ9.podpis_A-b';
  const sentBodies = [];
  const fetchImpl = async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    const odpoved = sentBodies.length === 1 ? { answer: 'ok', products: [], relacia: token } : { answer: 'ok', products: [], relacia: '<script>' };
    return { status: 200, ok: true, json: async () => odpoved };
  };
  const storage = makeSessionStorage();
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ sessionStorage: storage });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  for (const text of ['Prva', 'Druha', 'Tretia']) {
    root.getElementById('input').value = text;
    root.getElementById('form')._listeners.submit[0]({ preventDefault() {} });
    for (let tick = 0; tick < 50; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(sentBodies[1].relacia, token);
  assert.equal(sentBodies[2].relacia, token, 'neplatny token z odpovede sa neulozil');
  assert.equal(storage._store.get('arling_asistent_relacia'), token);
});

// ---------------------------------------------------------------------------
// Ukážky oslovených obchodov (28. 9. 2026): jeden pozdrav, tlačidlá navrhy
// ---------------------------------------------------------------------------

const POZDRAV_SK = 'Dobrý deň, ako vám môžem pomôcť s výberom?';
const pocetPozdravov = (root) => root.getElementById('messages').children.filter((row) => row.children[0].textContent === POZDRAV_SK).length;

test('widget.js pozdrav len raz: bublina, potom open() a ask() (tlacidlo zivej ukazky), zavriet a znova otvorit', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) });
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'sk' });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  const api = windowStub.ArlingAsistent;
  root.getElementById('toggle')._listeners.click[0]();
  assert.equal(pocetPozdravov(root), 1);
  // Stará live.js volala open() a hneď ask() pri už otvorenom okne.
  api.open();
  api.ask('Akú kávu odporúčate do moka kanvičky?');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pocetPozdravov(root), 1, 'druhý pozdrav po open() pri otvorenom okne');
  api.close();
  api.open();
  assert.equal(pocetPozdravov(root), 1, 'druhý pozdrav po zatvorení a otvorení');
});

test('widget.js pozdrav len raz aj bez otazky: dvakrat bublina (zavriet, otvorit) a open() pri otvorenom okne', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'sk' });
  runWidget(documentStub, windowStub);
  const root = body.children[0].shadowRoot;
  const toggle = root.getElementById('toggle');
  toggle._listeners.click[0]();
  windowStub.ArlingAsistent.open();
  toggle._listeners.click[0]();
  toggle._listeners.click[0]();
  assert.equal(pocetPozdravov(root), 1);
});

test('widget.js navrhy z odpovede (vycerpana ukazka) su tlacidla, klik posle presne tu otazku', async () => {
  const sentBodies = [];
  let n = 0;
  const fetchImpl = async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    n += 1;
    const data = n === 1
      ? { answer: 'Táto ukážka už dnes minula svoj limit odpovedí, na ďalšie otázky teraz neodpovie. Pripravené otázky nižšie odpovedajú aj teraz.', products: [], navrhy: ['Akú kávu odporúčate do moka kanvičky?', '  '] }
      : { answer: 'Odporúčame Colombia.', products: [] };
    return { status: 200, ok: true, json: async () => data };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'sk' });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  windowStub.ArlingAsistent.ask('Máte bezkofeínovú kávu?');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const riadok = root.getElementById('messages').children.find((row) => /pripravené otázky/i.test(row.children[0].textContent));
  assert.ok(riadok, 'veta vyčerpanej ukážky');
  const box = riadok.children.find((c) => c.className === 'suggestions');
  assert.ok(box, 'tlačidlá navrhy');
  assert.equal(box.children.length, 1, 'prázdny návrh sa nevykreslí');
  assert.equal(box.children[0].tagName, 'button');
  assert.equal(box.children[0].textContent, 'Akú kávu odporúčate do moka kanvičky?');
  box.children[0]._listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[1].messages[sentBodies[1].messages.length - 1].content, 'Akú kávu odporúčate do moka kanvičky?');
});

test('widget.js bez pola navrhy ziadne tlacidla (bezne odpovede sa nemenia)', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ answer: 'ok', products: [] }) });
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'sk' });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  windowStub.ArlingAsistent.ask('Máte kávu?');
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const row of root.getElementById('messages').children) {
    assert.equal(row.children.some((c) => c.className === 'suggestions'), false);
  }
});

// ---------------------------------------------------------------------------
// Brána živej ukážky 28. 9. 2026 (ops/ai/kontrola/2026-09-28-ziva-ukazka.md):
// jeden rozhovor na stránke (data-mount), obrázky bez /undefined, označenie
// pripravenej odpovede, kontrast a veľkosť terčov. Pokus 2 stránky, pokus 3 workera (E, F).
// ---------------------------------------------------------------------------

/** Falošný DOM s prvkom na vloženie widgetu (data-mount). */
function sMiestom(opts = {}) {
  const f = makeFakeWindowAndDocument({ dataLang: 'sk', ...opts, extraAttrs: { 'data-mount': 'miesto', ...(opts.extraAttrs || {}) } });
  const miesto = makeElement('div');
  f.documentStub.getElementById = (id) => (id === 'miesto' ? miesto : null);
  return { ...f, miesto };
}

const radky = (root) => root.getElementById('messages').children;

test('nalez 3: safeUrl nevytvori /undefined ani /null: karta bez obrazka ma pismenovy stvorec, nie <img>; bez URL nie je odkaz', async () => {
  const produkty = [
    { title: 'Bez obrázka', url: 'https://shop.sk/a', price: 5, currency: 'EUR' },
    { title: 'null obrázok', url: 'https://shop.sk/b', image: null },
    { title: 'prázdny obrázok', url: 'https://shop.sk/c', image: '  ' },
    { title: 'reťazec undefined', url: 'https://shop.sk/d', image: 'undefined' },
    { title: 'Bez adresy', image: 'javascript:alert(1)' },
  ];
  const fetchResponse = { status: 200, ok: true, json: async () => ({ answer: 'Tu sú.', products: produkty }) };
  const { root } = await submitMessages(['Máte?'], { fetchResponse });
  const odpoved = radky(root).find((r) => r.children[0].textContent === 'Tu sú.');
  // v2: položky zoznamu (role listitem) nesú kartu, obrázok je v bielej tácke (K6, T8).
  const polozky = odpoved.children.find((c) => c.className === 'products').children;
  assert.ok(polozky.every((p) => p.getAttribute('role') === 'listitem'));
  const karty = polozky.map((p) => p.children[0]);
  assert.equal(karty.length, 5);
  for (const k of karty) {
    assert.equal(k.children[0].children[0].tagName, 'span', `${k.children[1].children[0].textContent}: žiadny <img>`);
    assert.equal(k.children[0].children[0].className, 'product-ph');
  }
  assert.equal(karty[0].children[0].children[0].textContent, 'B');
  assert.equal(karty[4].tagName, 'div', 'bez adresy produktu nie je odkaz na #');
  assert.equal(karty[4].href, undefined);
  assert.equal(karty[0].tagName, 'a');
  assert.equal(karty[0].href, 'https://shop.sk/a');
});

test('nalez 3: skutocny obrazok sa nacita; ked zlyha, nahradi ho pismenovy stvorec (ziadny rozbity obrazok)', async () => {
  const fetchResponse = { status: 200, ok: true, json: async () => ({ answer: 'Jeden.', products: [{ title: 'Káva', url: 'https://shop.sk/k', image: 'https://shop.sk/k.jpg', price: 7, currency: 'EUR' }] }) };
  const { root } = await submitMessages(['Máte kávu?'], { fetchResponse });
  // v2: položka zoznamu, v nej odkaz, v ňom tácka s obrázkom (K6, T8).
  const karta = radky(root).find((r) => r.children[0].textContent === 'Jeden.').children.find((c) => c.className === 'products').children[0].children[0];
  const img = karta.children[0].children[0];
  assert.equal(img.tagName, 'img');
  assert.equal(img.src, 'https://shop.sk/k.jpg');
  assert.equal(img.alt, '');
  let nahradene = null;
  img.parentNode = { replaceChild: (novy, stary) => { nahradene = { novy, stary }; } };
  img._listeners.error[0]();
  assert.equal(nahradene.stary, img);
  assert.equal(nahradene.novy.className, 'product-ph');
  assert.equal(nahradene.novy.textContent, 'K');
});

test('nalez 1 a F: data-mount vlozi widget do stranky: jedno okno, otvorene, region (nie dialog), bez bubliny a zatvorenia, bez fokusu pri nacitani', () => {
  const { windowStub, documentStub, body, miesto } = sMiestom({ extraAttrs: { 'data-questions': JSON.stringify(['Máte menšie balenie?', '  ', 'Čo pre šteňa?']) } });
  runWidget(documentStub, windowStub);
  assert.equal(body.children.length, 0, 'nič nepláva nad stránkou');
  assert.equal(miesto.children.length, 1);
  const host = miesto.children[0];
  assert.match(host.className, /\binline\b/);
  const root = host.shadowRoot;
  assert.match(root.innerHTML, /<div id="panel" role="region" aria-label="[^"]*" hidden>/);
  assert.doesNotMatch(root.innerHTML, /id="panel"[^>]*aria-modal/);
  assert.equal(root.getElementById('panel').hidden, false, 'otvorené hneď');
  assert.equal(root.getElementById('input')._focusCalls || 0, 0, 'fokus by na mobile otvoril klávesnicu');
  const pozdrav = radky(root)[0];
  assert.equal(pozdrav.children[0].textContent, 'Dobrý deň, ako vám môžem pomôcť s výberom?');
  const navrhy = pozdrav.children.find((c) => c.className === 'suggestions').children.map((b) => b.textContent);
  assert.deepEqual(navrhy, ['Máte menšie balenie?', 'Čo pre šteňa?']);
  windowStub.ArlingAsistent.close();
  assert.equal(root.getElementById('panel').hidden, false, 'vložený rozhovor sa nezatvára');
  assert.ok(widgetSource.includes(':host(.inline) #toggle, :host(.inline) #close-btn { display:none; }'));
});

test('nalez 1: data-mount s neexistujucim prvkom ostane plavajuca bublina (preklep nezhodi asistenta)', () => {
  const f = makeFakeWindowAndDocument({ extraAttrs: { 'data-mount': 'nie-je' } });
  f.documentStub.getElementById = () => null;
  runWidget(f.documentStub, f.windowStub);
  assert.equal(f.body.children.length, 1);
  assert.doesNotMatch(f.body.children[0].className, /inline/);
});

test('nalez 1: po odpovedi na prvu otazku ostanu ponuknute len nepolozene otazky, polozena je vsade vypnuta', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ answer: 'Odpoveď.', products: [] }) });
  const { windowStub, documentStub, miesto } = sMiestom({ extraAttrs: { 'data-questions': JSON.stringify(['Prvá?', 'Druhá?']) } });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = miesto.children[0].shadowRoot;
  const prva = radky(root)[0].children.find((c) => c.className === 'suggestions').children[0];
  prva._listeners.click[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(prva.disabled, true);
  const odpoved = radky(root).find((r) => r.children[0].textContent === 'Odpoveď.');
  assert.deepEqual(odpoved.children.find((c) => c.className === 'suggestions').children.map((b) => b.textContent), ['Druhá?']);
  assert.equal(root.getElementById('input')._focusCalls || 0, 0, 'ťuknutá otázka neotvorí klávesnicu');
  windowStub.ArlingAsistent.open();
  assert.ok(root.getElementById('input')._focusCalls > 0, 'open() (Napísať vlastnú otázku) dá fokus do poľa');
});

test('nalez E a 5: pripravena odpoved (meta.overene) ma pri sebe oznacenie, ziva odpoved nie', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    const data = n === 1 ? { answer: 'Uložená.', products: [], meta: { overene: true } } : { answer: 'Živá.', products: [], meta: {} };
    return { status: 200, ok: true, json: async () => data };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'sk' });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = body.children[0].shadowRoot;
  windowStub.ArlingAsistent.ask('A?');
  await new Promise((r) => setTimeout(r, 0));
  windowStub.ArlingAsistent.ask('B?');
  await new Promise((r) => setTimeout(r, 0));
  const ulozena = radky(root).find((r) => r.children[0].textContent === 'Uložená.');
  const ziva = radky(root).find((r) => r.children[0].textContent === 'Živá.');
  const pozn = ulozena.children.find((c) => c.className === 'note');
  assert.ok(pozn, 'označenie');
  assert.match(vsetkyTexty(pozn), /Vopred skontrolovaná odpoveď/);
  assert.equal(ziva.children.some((c) => c.className === 'note'), false);
  assert.equal((widgetSource.match(/preparedNote: '/g) || []).length, 4, 'vo všetkých štyroch jazykoch');
});

test('lenPripravene: prva otazka stranky sa spyta len na ulozenu odpoved; bez nej sa nezobrazi nic, ani otazka', async () => {
  const sent = [];
  let odpoved = { answer: '', products: [], meta: { nepripravene: true } };
  const fetchImpl = async (url, o) => { sent.push(JSON.parse(o.body)); return { status: 200, ok: true, json: async () => odpoved }; };
  const { windowStub, documentStub, miesto } = sMiestom({ extraAttrs: { 'data-questions': JSON.stringify(['Prvá?']) } });
  runWidget(documentStub, windowStub, fetchImpl);
  const root = miesto.children[0].shadowRoot;
  windowStub.ArlingAsistent.ask('Prvá?', { lenPripravene: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent[0].lenPripravene, true);
  assert.equal(radky(root).length, 1, 'len pozdrav');
  assert.equal(radky(root)[0].children.find((c) => c.className === 'suggestions').children[0].disabled, false, 'otázka ostáva na ťuknutie');
  odpoved = { answer: 'Uložená odpoveď.', products: [{ title: 'Granule', url: 'https://g.sk/1', price: 4.5, currency: 'EUR' }], meta: { overene: true } };
  windowStub.ArlingAsistent.ask('Prvá?', { lenPripravene: true });
  await new Promise((r) => setTimeout(r, 0));
  const texty = radky(root).map((r) => r.children[0].textContent);
  assert.deepEqual(texty.slice(1), ['Prvá?', 'Uložená odpoveď.']);
  assert.ok(radky(root)[2].children.some((c) => c.className === 'note'));
  assert.equal(sent.filter((b) => !b.lenPripravene).length, 0);
});

test('nalez 1: kontrast textu na akcente aspon 4,5 : 1 v svetlom aj tmavom, zatvorenie a odoslanie aspon 44 px, nazvy produktov sa lamu', () => {
  // v2: nahrádza ho test tokenov T1 a T2 (A6) a farieb obchodu T3 vo farby-v2.test.mjs; tu ostávajú
  // rozmery z nálezu 1 v novom štýle: 44 px zatvorenie, 48 px Odoslať, 44 px čipy, názov na 2 riadky.
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const kontrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const meno of ['SVETLY', 'TMAVY']) {
    const riadok = widgetSource.match(new RegExp(`var ${meno} = '([^']+)'`))[1];
    const v = (k) => riadok.match(new RegExp(`--a-${k}:(#[0-9A-F]{6})`))[1];
    assert.ok(kontrast(v('farba-plna'), v('na-farbe')) >= 4.5, `${meno}: text na farbe obchodu`);
    for (const pod of ['pozadie', 'povrch']) {
      assert.ok(kontrast(v(pod), v('jemny')) >= 4.5, `${meno}: jemný text na ${pod}`);
      assert.ok(kontrast(v(pod), v('text')) >= 7, `${meno}: telo na ${pod}`);
      assert.ok(kontrast(v(pod), v('farba-text')) >= 4.5, `${meno}: text vo farbe obchodu na ${pod}`);
    }
  }
  assert.match(widgetSource, /'\.h-btn,\.u-zavriet,\.pas-sipka\{flex:none;width:44px;height:44px;/, 'zatvorenie 44 px');
  assert.match(widgetSource, /#send-btn\{flex:none;width:48px;height:48px;/, 'odoslanie 48 px');
  assert.match(widgetSource, /\.suggestion\{display:inline-flex;align-items:center;gap:8px;min-height:44px;/, 'otázky 44 px');
  const nazov = widgetSource.match(/\.product-title\{([^}]*)\}/)[1];
  assert.doesNotMatch(nazov, /nowrap|ellipsis/);
  assert.match(widgetSource, /\.product-title,\.por-nazov\{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;/);
  assert.ok(widgetSource.includes('@media (prefers-reduced-motion: reduce)'));
});

// ---------------------------------------------------------------------------
// Krok 1 asistenta (28. 9. 2026), W3 posudku ops/ai/kontrola/2026-09-28-ukazka-pokus3.md:
// automatická prvá otázka (a žiadna iná) nesmie zamknúť rozhovor. Trieda zlyhaní:
// visiaca požiadavka, visiace telo odpovede, sieťové odmietnutie, chyba servera,
// nečitateľné telo; pre tichú (lenPripravene) aj bežnú otázku.
// ---------------------------------------------------------------------------

/** Riadené časovače: test ich spustí sám, nič nečaká naozaj. */
function hodiny() {
  const cakajuce = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { id += 1; cakajuce.set(id, { fn, ms }); return id; },
    clearTimeout(i) { cakajuce.delete(i); },
    spusti() { const v = [...cakajuce.values()]; cakajuce.clear(); v.forEach((c) => c.fn()); return v.map((c) => c.ms); },
    get pocet() { return cakajuce.size; },
  };
}
const tik = () => new Promise((r) => setTimeout(r, 0));
const nikdy = () => new Promise(() => {});

function s3Otazkami(fetchImpl) {
  const h = hodiny();
  const zrusene = [];
  class AbortControllerStub {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; zrusene.push(this.signal); }
  }
  const f = sMiestom({ extraAttrs: { 'data-questions': JSON.stringify(['Prvá?', 'Druhá?']) } });
  runWidget(f.documentStub, f.windowStub, fetchImpl, { setTimeout: h.setTimeout, clearTimeout: h.clearTimeout, AbortController: AbortControllerStub });
  const root = f.miesto.children[0].shadowRoot;
  const tlacidlo = (text) => radky(root)[0].children.find((c) => c.className === 'suggestions').children.find((b) => b.textContent === text);
  return { ...f, h, root, zrusene, tlacidlo, api: f.windowStub.ArlingAsistent };
}

function overOdomknute(o, text) {
  assert.equal(o.root.getElementById('input').readOnly, false, 'pole nie je zamknuté');
  assert.equal(o.root.getElementById('send-btn').disabled, false, 'odoslanie funguje');
  assert.equal(radky(o.root).some((r) => r.id === 'thinking-row'), false, 'žiadne „píše“ navždy');
  if (text) {
    assert.equal(o.tlacidlo(text).disabled, false, 'otázka je znova na ťuknutie');
    assert.equal(o.tlacidlo(text).hidden, false);
  }
}

const chybovyRiadok = (root) => radky(root).find((r) => /msg-error/.test(r.className));

const PRVA_ZLYHANIA = [
  ['visiaca požiadavka (časový limit)', () => nikdy(), true],
  ['visiace telo odpovede (časový limit)', async () => ({ status: 200, ok: true, json: nikdy }), true],
  ['sieťové odmietnutie', async () => { throw new TypeError('Failed to fetch'); }, false],
  ['chyba servera 500', async () => ({ status: 500, ok: false, json: async () => ({ error: 'internal_error' }) }), false],
  ['nečitateľné telo 200', async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('bad json'); } }), false],
];

for (const [nazov, zlyhanie, casom] of PRVA_ZLYHANIA) {
  test(`W3 prva otazka lenPripravene, ${nazov}: okno sa odomkne, otazka ostane, vysvetlenie a Skusit znova bez modelu`, async () => {
    const poslane = [];
    let n = 0;
    const o = s3Otazkami(async (url, init) => {
      poslane.push(JSON.parse(init.body));
      n += 1;
      if (n === 1) return zlyhanie();
      return { status: 200, ok: true, json: async () => ({ answer: 'Uložená odpoveď.', products: [], meta: { overene: true } }) };
    });
    assert.equal(o.api.ask('Prvá?', { lenPripravene: true }), true);
    await tik();
    // Počas čakania: vidno „píše“, do poľa sa dá písať (tichá otázka ho nezamyká).
    assert.equal(radky(o.root).some((r) => r.id === 'thinking-row'), casom, 'počas čakania ukazovateľ');
    if (casom) {
      assert.equal(o.root.getElementById('input').readOnly, false);
      assert.deepEqual(o.h.spusti(), [8000], 'limit uloženej odpovede 8 s');
      await tik();
      assert.equal(o.zrusene.length, 1, 'visiaca požiadavka je zrušená (abort)');
    }
    overOdomknute(o, 'Prvá?');
    const chyba = chybovyRiadok(o.root);
    assert.ok(chyba, 'vysvetlenie chyby');
    assert.equal(chyba.children[0].textContent, 'Pripravenú odpoveď sa nepodarilo načítať.');
    assert.equal(radky(o.root).some((r) => r.children[0].textContent === 'Prvá?'), false, 'otázka bez odpovede sa nezobrazí');
    assert.equal(o.h.pocet, 0, 'žiadny zabudnutý časovač');
    // Opakovanie: tá istá tichá otázka, nikdy model.
    const znova = chyba.children.find((c) => c.className === 'suggestions').children[0];
    assert.equal(znova.textContent, 'Skúsiť znova');
    znova._listeners.click[0]();
    await tik();
    assert.equal(poslane.length, 2);
    assert.ok(poslane.every((b) => b.lenPripravene === true), 'opakovanie ide len po uloženú odpoveď');
    assert.equal(chybovyRiadok(o.root), undefined, 'chybový riadok zmizne');
    assert.deepEqual(radky(o.root).slice(1).map((r) => r.children[0].textContent), ['Prvá?', 'Uložená odpoveď.']);
    // Ďalšia otázka po zlyhaní funguje (predtým ask vracal false navždy).
    assert.equal(o.api.ask('Druhá?'), true);
  });
}

test('W3 prva otazka: po zlyhani a pred opakovanim ide hned polozit inu otazku (ask vrati true, poslana je bezna)', async () => {
  const poslane = [];
  const o = s3Otazkami(async (url, init) => {
    poslane.push(JSON.parse(init.body));
    if (poslane.length === 1) return nikdy();
    return { status: 200, ok: true, json: async () => ({ answer: 'Živá.', products: [] }) };
  });
  o.api.ask('Prvá?', { lenPripravene: true });
  await tik();
  o.h.spusti();
  await tik();
  assert.equal(o.api.ask('Druhá?'), true);
  await tik();
  assert.equal(poslane[1].lenPripravene, undefined);
  assert.ok(radky(o.root).some((r) => r.children[0].textContent === 'Živá.'));
});

const BEZNE_ZLYHANIA = [
  ['visiaca požiadavka', () => nikdy(), 45000],
  ['visiace telo', async () => ({ status: 200, ok: true, json: nikdy }), 45000],
  ['sieťové odmietnutie', async () => { throw new TypeError('Failed to fetch'); }, null],
  ['chyba servera 502', async () => ({ status: 502, ok: false, json: async () => ({}) }), null],
];

for (const [nazov, zlyhanie, limit] of BEZNE_ZLYHANIA) {
  test(`W3 bezna otazka, ${nazov}: chyba s opakovanim, pole odomknute, opakovanie neposle otazku dvakrat`, async () => {
    const poslane = [];
    const o = s3Otazkami(async (url, init) => {
      poslane.push(JSON.parse(init.body));
      if (poslane.length === 1) return zlyhanie();
      return { status: 200, ok: true, json: async () => ({ answer: 'Živá odpoveď.', products: [] }) };
    });
    o.tlacidlo('Druhá?')._listeners.click[0]();
    await tik();
    if (limit) {
      assert.equal(o.root.getElementById('input').readOnly, true, 'bežná otázka pole počas čakania zamkne');
      assert.deepEqual(o.h.spusti(), [limit]);
      await tik();
    }
    overOdomknute(o);
    const chyba = chybovyRiadok(o.root);
    assert.equal(chyba.children[0].textContent, 'Odpoveď sa nepodarilo načítať. Skúste to prosím znova.');
    chyba.children.find((c) => c.className === 'suggestions').children[0]._listeners.click[0]();
    await tik();
    assert.equal(poslane.length, 2);
    assert.equal(poslane[1].lenPripravene, undefined);
    assert.deepEqual(poslane[1].messages.filter((m) => m.role === 'user').map((m) => m.content), ['Druhá?'], 'otázka v rozhovore raz');
    assert.ok(radky(o.root).some((r) => r.children[0].textContent === 'Živá odpoveď.'));
  });
}

test('W3 uspesna odpoved zrusi casovac a nic nezostane cakat', async () => {
  const o = s3Otazkami(async () => ({ status: 200, ok: true, json: async () => ({ answer: 'Hneď.', products: [] }) }));
  o.api.ask('Prvá?', { lenPripravene: true });
  await tik();
  assert.equal(o.h.pocet, 0);
  o.api.ask('Druhá?');
  await tik();
  assert.equal(o.h.pocet, 0);
  assert.equal(chybovyRiadok(o.root), undefined);
});

test('W3 texty chyby pripravenej odpovede a opakovania su vo vsetkych styroch jazykoch', () => {
  assert.equal((widgetSource.match(/preparedFailed: '/g) || []).length, 4);
  assert.equal((widgetSource.match(/retry: '/g) || []).length, 4);
});
