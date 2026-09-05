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

test('widget.js keeps the "Powered by ARLing Asistent" footer link and tags it with utm_source=widget&utm_medium=referral', () => {
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: 'en' });
  runWidget(documentStub, windowStub);
  const html = body.children[0].shadowRoot.innerHTML;
  assert.match(html, /<div class="footer"><a href="https:\/\/arling\.sk\/asistent\/\?utm_source=widget&utm_medium=referral" target="_blank" rel="noopener">Powered by ARLing Asistent<\/a><\/div>/);
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
  const labels = { sk: 'Nájdi darček', cs: 'Najít dárek', en: 'Find a gift', de: 'Geschenk finden' };
  for (const lang of Object.keys(labels)) {
    const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang: lang, extraAttrs: { 'data-gift': '1' } });
    runWidget(documentStub, windowStub);
    const root = body.children[0].shadowRoot;
    const giftToggle = root.getElementById('gift-toggle');
    assert.ok(giftToggle, `gift-toggle must exist for lang=${lang}`);
    assert.match(root.innerHTML, new RegExp('<button id="gift-toggle"[^>]*>' + labels[lang].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

/**
 * Boots the widget with data-gift="1" and drives the three-step flow:
 * click the gift toggle, pick a recipient chip, pick a budget chip, type
 * interests, click submit. Returns the sent request bodies and the shadow
 * root so a test can assert on the rendered result.
 */
async function runGiftFlow({ fetchResponse, dataLang = 'sk', recipientChipIndex = 0, budgetChipIndex = 1, interestsText = 'kava', umami, sessionStorage } = {}) {
  const sentBodies = [];
  const fetchImpl = async (url, opts) => {
    sentBodies.push({ url: String(url), body: JSON.parse(opts.body) });
    return fetchResponse || { status: 200, ok: true, json: async () => ({ picks: [], candidates: [] }) };
  };
  const { windowStub, documentStub, body } = makeFakeWindowAndDocument({ dataLang, extraAttrs: { 'data-gift': '1' }, sessionStorage });
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
  const card = list.children[0];
  assert.match(card.innerHTML, /Čajová súprava/);
  assert.match(card.innerHTML, /24\.90 EUR/);
  assert.match(card.innerHTML, /Ladí so záľubou v čaji/);
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

  assert.equal(root.getElementById('gift-panel').hidden, true);
  assert.equal(root.getElementById('panel').hidden, false);
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
