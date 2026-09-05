/*
 * widget.js
 *
 * Single-file embeddable chat widget for ARLing Asistent. No dependencies,
 * no build step: an e-shop adds one <script> tag and it works.
 *
 *   <script src="https://arling-asistent.arling.workers.dev/widget.js"
 *           data-tenant="TENANT_ID"
 *           data-lang="sk"
 *           data-color="auto"
 *           data-position="right"
 *           data-greeting="Vitajte, ako vam mozem pomoct?"
 *           data-title="Nas asistent"
 *           data-endpoint="https://arling-asistent.arling.workers.dev" defer></script>
 *
 * data-tenant   required, the tenant id returned by POST /v1/tenants.
 * data-lang     optional, one of sk/cs/en/de, or "auto" (default, and also
 *               the fallback for an absent attribute): the widget's own
 *               chrome (buttons, placeholder, greeting) follows the
 *               visitor's browser language (falling back to Slovak when
 *               that is missing or unsupported), and "auto" is sent to the
 *               server as-is so the assistant replies in whatever language
 *               the customer actually types in, message by message (see
 *               worker/src/chat.js).
 * data-color    optional, "auto" (default, follows the visitor's OS
 *               light/dark setting), "light" or "dark" to force one.
 * data-position optional, "right" (default) or "left": which bottom corner
 *               of the page the launcher button and chat panel sit in.
 * data-greeting optional, a custom first message the assistant shows when
 *               the panel is opened. Defaults to the language's own
 *               greeting string.
 * data-title    optional, a custom panel title (shown in the header bar and
 *               used as the dialog's accessible name). Defaults to the
 *               language's own title string.
 * data-endpoint optional, the worker's origin. Defaults to this script's
 *               own origin, which is normally correct.
 *
 * Everything renders inside a Shadow DOM root so the host page's CSS can
 * never leak in or be broken by the widget's styles.
 *
 * Public API (optional, for pages that want their own "ask the assistant"
 * buttons, e.g. suggested questions on a demo shop): once booted, the
 * widget sets window.ArlingAsistent = {open(), close(), ask(text)}.
 * ask(text) opens the panel and sends `text` exactly as if the visitor had
 * typed it (trimmed, capped at 2000 characters); it returns true when the
 * question was sent, false when the text was empty or a reply is still
 * pending (then it only opens the panel). Nothing else is exposed.
 *
 * Privacy: no cookies are set, and nothing is written to localStorage. The
 * only client-side state is a random session id (16 hex characters) kept in
 * sessionStorage for the lifetime of the browser tab, and the message list
 * for the current page view, kept in a JS variable and lost on reload. The
 * session id is sent as "session" with every /v1/chat request so the server
 * can count one conversation per session instead of one per message (see
 * worker/src/tenants.js); it identifies the tab, never the visitor, and is
 * never stored beyond a 24h dedupe key. The server itself stores no
 * conversation content either (see worker/src/chat.js).
 *
 * Load order matters in this file: every constant/helper that boot() uses
 * (STRINGS, normaliseLang, scriptOrigin, POWERED_BY_URL, getSessionId,
 * escapeHtml, safeUrl, formatPrice, buildMarkup, buildStyle) is defined
 * above boot(), and boot() itself is
 * only called at the very bottom, after all of them exist. (Previously
 * normaliseLang() was called - to compute LANG - before the STRINGS object
 * it reads was assigned, since `var` hoisting only hoists the declaration,
 * not the assignment: STRINGS was still undefined at that point and the
 * widget threw on every page load.)
 */

(function () {
  'use strict';

  if (window.__arlingAsistentInit) return;
  window.__arlingAsistentInit = true;

  // ---------------------------------------------------------------------
  // i18n
  // ---------------------------------------------------------------------

  var STRINGS = {
    sk: {
      openLabel: 'Otvoriť chat s asistentom',
      closeLabel: 'Zavrieť chat',
      title: 'Asistent obchodu',
      placeholder: 'Napíšte otázku...',
      send: 'Odoslať',
      thinking: 'Asistent píše odpoveď…',
      greeting: 'Dobrý deň, ako vám môžem pomôcť s výberom?',
      networkError: 'Odpoveď sa nepodarilo načítať. Skúste to prosím znova.',
      rateLimited: 'Príliš veľa správ naraz. Skúste to o chvíľu.',
      quotaExceeded: 'Asistent si dnes oddychuje. Použite prosím kontaktnú stránku obchodu.',
      poweredBy: 'Napájané ARLing Asistentom',
      relatedProducts: 'Súvisiace produkty',
    },
    cs: {
      openLabel: 'Otevřít chat s asistentem',
      closeLabel: 'Zavřít chat',
      title: 'Asistent obchodu',
      placeholder: 'Napište otázku...',
      send: 'Odeslat',
      thinking: 'Asistent píše odpověď…',
      greeting: 'Dobrý den, jak vám mohu pomoci s výběrem?',
      networkError: 'Odpověď se nepodařilo načíst. Zkuste to prosím znovu.',
      rateLimited: 'Příliš mnoho zpráv najednou. Zkuste to za chvíli.',
      quotaExceeded: 'Asistent si dnes odpočívá. Použijte prosím kontaktní stránku obchodu.',
      poweredBy: 'Poháněno ARLing Asistentem',
      relatedProducts: 'Související produkty',
    },
    en: {
      openLabel: 'Open shop assistant chat',
      closeLabel: 'Close chat',
      title: 'Shop assistant',
      placeholder: 'Type your question...',
      send: 'Send',
      thinking: 'The assistant is typing…',
      greeting: 'Hello, how can I help you choose?',
      networkError: 'Could not load a reply. Please try again.',
      rateLimited: 'Too many messages at once. Please try again shortly.',
      quotaExceeded: 'The assistant is resting today. Please use the shop\'s contact page.',
      poweredBy: 'Powered by ARLing Asistent',
      relatedProducts: 'Related products',
    },
    de: {
      openLabel: 'Chat mit dem Assistenten öffnen',
      closeLabel: 'Chat schließen',
      title: 'Shop-Assistent',
      placeholder: 'Frage eingeben...',
      send: 'Senden',
      thinking: 'Der Assistent schreibt…',
      greeting: 'Hallo, wie kann ich Ihnen bei der Auswahl helfen?',
      networkError: 'Antwort konnte nicht geladen werden. Bitte erneut versuchen.',
      rateLimited: 'Zu viele Nachrichten auf einmal. Bitte in Kürze erneut versuchen.',
      quotaExceeded: 'Der Assistent macht heute Pause. Bitte nutzen Sie die Kontaktseite des Shops.',
      poweredBy: 'Bereitgestellt von ARLing Asistent',
      relatedProducts: 'Passende Produkte',
    },
  };

  function normaliseLang(lang) {
    var l = String(lang || '').toLowerCase().slice(0, 2);
    return STRINGS[l] ? l : 'sk';
  }

  /** Resolve the widget's own UI language for data-lang="auto" (also the default): the visitor's browser language, falling back to Slovak when it is missing or not one of the four supported languages. */
  function resolveAutoLang() {
    var nav = window.navigator || {};
    var navLang = nav.language || (nav.languages && nav.languages[0]) || '';
    return normaliseLang(navLang);
  }

  function scriptOrigin(el) {
    try {
      return new URL(el.src).origin;
    } catch (e) {
      return '';
    }
  }

  // The "Powered by" footer link. The UTM pair lets Umami on arling.sk
  // attribute visits that came from a shop's widget, without any tracking
  // on the shop's page itself.
  var POWERED_BY_URL = 'https://arling.sk/asistent/?utm_source=widget&utm_medium=referral';

  // ---------------------------------------------------------------------
  // Session id: one per browser tab, so the server counts one conversation
  // per tab (per 24h), not one per message. 16 hex characters, random,
  // meaningless outside this tab. sessionStorage may be unavailable
  // (private mode, storage blocked, sandboxed iframe): then the id simply
  // lives in memory for this page view and a reload starts a new session.
  // ---------------------------------------------------------------------

  var SESSION_STORAGE_KEY = 'arling_asistent_session';
  var SESSION_ID_RE = /^[0-9a-f]{16}$/;

  function randomSessionId() {
    var bytes = null;
    var cryptoObj = window.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      try {
        bytes = cryptoObj.getRandomValues(new Uint8Array(8));
      } catch (e) {
        bytes = null;
      }
    }
    var out = '';
    for (var i = 0; i < 8; i++) {
      var b = bytes ? bytes[i] : Math.floor(Math.random() * 256);
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }

  function getSessionId() {
    var storage = null;
    try {
      storage = window.sessionStorage;
    } catch (e) {
      storage = null;
    }
    if (storage) {
      try {
        var existing = storage.getItem(SESSION_STORAGE_KEY);
        if (existing && SESSION_ID_RE.test(existing)) return existing;
      } catch (e) {
        /* fall through to a fresh id */
      }
    }
    var fresh = randomSessionId();
    if (storage) {
      try {
        storage.setItem(SESSION_STORAGE_KEY, fresh);
      } catch (e) {
        /* storage full or blocked: in-memory only */
      }
    }
    return fresh;
  }

  // ---------------------------------------------------------------------
  // Rendering helpers (pure, used inside boot() below)
  // ---------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Only ever render http(s) URLs (product data comes from a feed, not from the visitor, but is still third-party input). */
  function safeUrl(url) {
    try {
      var parsed = new URL(url, window.location.href);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
    } catch (e) {
      return '';
    }
  }

  function formatPrice(p) {
    if (p.price == null) return '';
    var amount = Number(p.price);
    var text = Number.isFinite(amount) ? amount.toFixed(2) : String(p.price);
    return text + ' ' + (p.currency || '');
  }

  function buildMarkup(strings) {
    return (
      '<button id="toggle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="' + escapeHtml(strings.openLabel) + '">' +
      '<span class="toggle-icon" aria-hidden="true">•••</span>' +
      '</button>' +
      '<div id="panel" role="dialog" aria-modal="true" aria-label="' + escapeHtml(strings.title) + '" hidden>' +
      '<div class="panel-head">' +
      '<span class="panel-title">' + escapeHtml(strings.title) + '</span>' +
      '<button id="close-btn" type="button" aria-label="' + escapeHtml(strings.closeLabel) + '">&times;</button>' +
      '</div>' +
      '<div id="messages" class="messages" aria-live="off"></div>' +
      '<div id="live" class="sr-only" aria-live="polite"></div>' +
      '<form id="form" class="composer">' +
      '<label class="sr-only" for="input">' + escapeHtml(strings.placeholder) + '</label>' +
      '<input id="input" type="text" autocomplete="off" placeholder="' + escapeHtml(strings.placeholder) + '">' +
      '<button id="send-btn" type="submit">' + escapeHtml(strings.send) + '</button>' +
      '</form>' +
      '<div class="footer"><a href="' + POWERED_BY_URL + '" target="_blank" rel="noopener">' + escapeHtml(strings.poweredBy) + '</a></div>' +
      '</div>'
    );
  }

  function buildStyle() {
    var style = document.createElement('style');
    style.textContent =
      ':host {' +
      '  --paper:#f6f2ea; --paper-2:#fbf9f4; --ink:#1b1a17; --ink-2:#4a4741; --muted:#7a766e; --line:#d9d2c4;' +
      '  --accent:#b23a1d; --accent-soft:#f3e2dc;' +
      '  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;' +
      '  --sans:system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      '  all: initial;' +
      '  font-family: var(--sans);' +
      '  position: fixed; z-index: 2147483000; bottom: 20px; right: 20px;' +
      '}' +
      ':host(.position-left) { right: auto; left: 20px; }' +
      '@media (prefers-color-scheme: dark) {' +
      '  :host(:not(.force-light)) { --paper:#151412; --paper-2:#1d1b18; --ink:#efe9de; --ink-2:#c9c2b5; --muted:#8f887b; --line:#2e2b26; --accent:#e0623f; --accent-soft:#3a1f17; }' +
      '}' +
      ':host(.force-dark) { --paper:#151412; --paper-2:#1d1b18; --ink:#efe9de; --ink-2:#c9c2b5; --muted:#8f887b; --line:#2e2b26; --accent:#e0623f; --accent-soft:#3a1f17; }' +
      ':host(.force-light) { --paper:#f6f2ea; --paper-2:#fbf9f4; --ink:#1b1a17; --ink-2:#4a4741; --muted:#7a766e; --line:#d9d2c4; --accent:#b23a1d; --accent-soft:#f3e2dc; }' +
      '* { box-sizing: border-box; }' +
      '.sr-only { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }' +
      '#toggle {' +
      '  width:56px; height:56px; border-radius:50%; border:1px solid var(--line);' +
      '  background:var(--accent); color:#fff; font:600 13px/1 var(--sans); cursor:pointer;' +
      '  display:flex; align-items:center; justify-content:center;' +
      '}' +
      '#toggle:hover { filter:brightness(1.08); }' +
      '#toggle:focus-visible { outline:2px solid var(--ink); outline-offset:2px; }' +
      '.toggle-icon { letter-spacing:1px; }' +
      '#panel {' +
      '  position:absolute; bottom:68px; right:0; width:340px; max-width:calc(100vw - 40px);' +
      '  height:480px; max-height:70vh; background:var(--paper); border:1px solid var(--line);' +
      '  border-radius:8px; display:flex; flex-direction:column; overflow:hidden;' +
      '  box-shadow:0 8px 28px rgba(0,0,0,.18); color:var(--ink);' +
      '}' +
      ':host(.position-left) #panel { right:auto; left:0; }' +
      // The author display:flex above would otherwise beat the UA stylesheet's
      // [hidden]{display:none}, leaving the (empty) panel open on every page load.
      '#panel[hidden] { display:none; }' +
      '.panel-head {' +
      '  display:flex; align-items:center; justify-content:space-between; padding:12px 14px;' +
      '  border-bottom:1px solid var(--line); background:var(--paper-2);' +
      '}' +
      '.panel-title { font:600 15px/1 var(--serif); }' +
      '#close-btn {' +
      '  border:none; background:transparent; color:var(--ink-2); font-size:16px; line-height:1;' +
      '  cursor:pointer; padding:4px 6px; border-radius:4px;' +
      '}' +
      '#close-btn:hover { color:var(--accent); }' +
      '#close-btn:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }' +
      '.messages { flex:1; overflow-y:auto; padding:12px 14px; display:flex; flex-direction:column; gap:10px; }' +
      '.msg { display:flex; flex-direction:column; gap:6px; max-width:88%; }' +
      '.msg-user { align-self:flex-end; align-items:flex-end; }' +
      '.msg-assistant { align-self:flex-start; align-items:flex-start; }' +
      '.bubble {' +
      '  font:14px/1.5 var(--sans); padding:8px 11px; border-radius:10px; overflow-wrap:anywhere; white-space:pre-wrap;' +
      '}' +
      '.msg-user .bubble { background:var(--accent); color:#fff; border-bottom-right-radius:2px; }' +
      '.msg-assistant .bubble { background:var(--paper-2); border:1px solid var(--line); border-bottom-left-radius:2px; }' +
      '.bubble.thinking { color:var(--muted); font-style:italic; }' +
      '.products { display:flex; flex-direction:column; gap:6px; width:100%; }' +
      '.product-card {' +
      '  display:flex; align-items:center; gap:8px; padding:6px; border:1px solid var(--line); border-radius:6px;' +
      '  background:var(--paper); text-decoration:none; color:inherit;' +
      '}' +
      '.product-card:hover { border-color:var(--accent); }' +
      '.product-card:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }' +
      '.product-img { width:36px; height:36px; object-fit:cover; border-radius:4px; flex-shrink:0; background:var(--paper-2); }' +
      '.product-body { display:flex; flex-direction:column; gap:2px; min-width:0; }' +
      '.product-title { font:13px/1.3 var(--sans); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }' +
      '.product-price { font:600 12px/1 var(--sans); color:var(--accent); }' +
      '.composer { display:flex; gap:6px; padding:10px; border-top:1px solid var(--line); background:var(--paper-2); }' +
      '#input {' +
      '  flex:1; min-width:0; padding:9px 10px; border:1px solid var(--line); border-radius:6px;' +
      '  background:var(--paper); color:var(--ink); font:14px/1.4 var(--sans);' +
      '}' +
      '#input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }' +
      '#send-btn {' +
      '  border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px;' +
      '  padding:9px 12px; font:600 13px/1 var(--sans); cursor:pointer;' +
      '}' +
      '#send-btn:hover { filter:brightness(1.08); }' +
      '#send-btn:disabled { opacity:.6; cursor:default; }' +
      '#send-btn:focus-visible { outline:2px solid var(--ink); outline-offset:1px; }' +
      '.footer { padding:6px 10px; border-top:1px solid var(--line); background:var(--paper-2); text-align:center; }' +
      '.footer a { font:11px/1 var(--sans); color:var(--muted); text-decoration:none; }' +
      '.footer a:hover { color:var(--accent); }' +
      '@media (max-width:480px) {' +
      '  :host { bottom:12px; right:12px; }' +
      '  :host(.position-left) { right:auto; left:12px; }' +
      '  #panel {' +
      '    position:fixed; left:0; right:0; bottom:0; width:100%; max-width:100%;' +
      '    height:min(78vh, 560px); max-height:78vh; border-radius:14px 14px 0 0; border-bottom:none;' +
      '  }' +
      '}';
    return style;
  }

  // ---------------------------------------------------------------------
  // Boot: one widget instance for this page. Called once, at the bottom of
  // this file, after every constant/helper above it already exists.
  // ---------------------------------------------------------------------

  function boot() {
    var scriptEl = document.currentScript || (function () {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (/widget\.js(\?|$)/.test(scripts[i].src)) return scripts[i];
      }
      return null;
    })();

    if (!scriptEl) return;

    var TENANT = scriptEl.getAttribute('data-tenant');
    var LANG_ATTR = scriptEl.getAttribute('data-lang');
    // An absent attribute, or an explicit "auto", both mean: let the server
    // detect the reply language per message (API_LANG, sent as-is with every
    // /v1/chat request, see chat.js isAutoLang/detectLangFromText), while the
    // widget's own chrome (LANG, below) still needs one concrete language to
    // render buttons/placeholder/greeting in right now.
    var IS_AUTO_LANG = !LANG_ATTR || String(LANG_ATTR).trim().toLowerCase() === 'auto';
    var API_LANG = IS_AUTO_LANG ? 'auto' : normaliseLang(LANG_ATTR);
    var LANG = IS_AUTO_LANG ? resolveAutoLang() : API_LANG;
    var COLOR = scriptEl.getAttribute('data-color') || 'auto';
    var POSITION = scriptEl.getAttribute('data-position') === 'left' ? 'left' : 'right';
    var ENDPOINT = (scriptEl.getAttribute('data-endpoint') || scriptOrigin(scriptEl)).replace(/\/$/, '');

    if (!TENANT) {
      console.error('[arling-asistent] widget.js: missing required data-tenant attribute, widget not started.');
      return;
    }

    var SESSION_ID = getSessionId();

    // t starts as the plain per-language strings object, then gets a
    // shallow copy with data-title/data-greeting overrides applied on top
    // when present, so every other string (placeholder, send, thinking...)
    // keeps coming from STRINGS unchanged.
    var t = STRINGS[LANG];
    var titleAttr = scriptEl.getAttribute('data-title');
    var greetingAttr = scriptEl.getAttribute('data-greeting');
    if ((titleAttr && titleAttr.trim()) || (greetingAttr && greetingAttr.trim())) {
      t = Object.assign({}, t);
      if (titleAttr && titleAttr.trim()) t.title = titleAttr.trim();
      if (greetingAttr && greetingAttr.trim()) t.greeting = greetingAttr.trim();
    }

    // -------------------------------------------------------------------
    // DOM / Shadow root
    // -------------------------------------------------------------------

    var host = document.createElement('div');
    host.setAttribute('data-arling-asistent', '');
    var hostClasses = [];
    if (COLOR === 'light') hostClasses.push('force-light');
    if (COLOR === 'dark') hostClasses.push('force-dark');
    if (POSITION === 'left') hostClasses.push('position-left');
    host.className = hostClasses.join(' ');
    document.body.appendChild(host);

    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = buildMarkup(t);
    root.appendChild(buildStyle());

    var els = {
      toggle: root.getElementById('toggle'),
      panel: root.getElementById('panel'),
      closeBtn: root.getElementById('close-btn'),
      messages: root.getElementById('messages'),
      form: root.getElementById('form'),
      input: root.getElementById('input'),
      sendBtn: root.getElementById('send-btn'),
      live: root.getElementById('live'),
    };

    var conversation = []; // {role: 'user'|'assistant', content: string}
    var isOpen = false;
    var isSending = false;

    // -------------------------------------------------------------------
    // Open / close
    // -------------------------------------------------------------------

    function openPanel() {
      isOpen = true;
      els.panel.hidden = false;
      els.toggle.setAttribute('aria-expanded', 'true');
      if (conversation.length === 0) appendMessage('assistant', t.greeting, []);
      window.requestAnimationFrame(function () {
        els.input.focus();
      });
      document.addEventListener('keydown', onKeydown, true);
    }

    function closePanel() {
      isOpen = false;
      els.panel.hidden = true;
      els.toggle.setAttribute('aria-expanded', 'false');
      els.toggle.focus();
      document.removeEventListener('keydown', onKeydown, true);
    }

    function onKeydown(evt) {
      if (evt.key === 'Escape' && isOpen) {
        evt.stopPropagation();
        closePanel();
      }
    }

    els.toggle.addEventListener('click', function () {
      isOpen ? closePanel() : openPanel();
    });
    els.closeBtn.addEventListener('click', closePanel);

    // -------------------------------------------------------------------
    // Messages
    // -------------------------------------------------------------------

    function appendMessage(role, text, products) {
      var row = document.createElement('div');
      row.className = 'msg msg-' + role;

      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      row.appendChild(bubble);

      if (products && products.length) {
        var list = document.createElement('div');
        list.className = 'products';
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', t.relatedProducts);
        products.forEach(function (p) {
          var card = document.createElement('a');
          card.className = 'product-card';
          card.setAttribute('role', 'listitem');
          var productUrl = safeUrl(p.url);
          card.href = productUrl || '#';
          card.target = '_blank';
          card.rel = 'noopener';
          var imageUrl = safeUrl(p.image);
          var imgHtml = imageUrl ? '<img class="product-img" src="' + escapeHtml(imageUrl) + '" alt="" loading="lazy">' : '';
          var priceText = formatPrice(p);
          card.innerHTML =
            imgHtml +
            '<span class="product-body">' +
            '<span class="product-title">' + escapeHtml(p.title || '') + '</span>' +
            (priceText ? '<span class="product-price">' + escapeHtml(priceText) + '</span>' : '') +
            '</span>';
          list.appendChild(card);
        });
        row.appendChild(list);
      }

      els.messages.appendChild(row);
      els.messages.scrollTop = els.messages.scrollHeight;
      els.live.textContent = (role === 'assistant' ? t.title + ': ' : '') + text;
    }

    function appendThinking() {
      var row = document.createElement('div');
      row.className = 'msg msg-assistant';
      row.id = 'thinking-row';
      var bubble = document.createElement('div');
      bubble.className = 'bubble thinking';
      bubble.textContent = t.thinking;
      row.appendChild(bubble);
      els.messages.appendChild(row);
      els.messages.scrollTop = els.messages.scrollHeight;
    }

    function removeThinking() {
      var row = root.getElementById('thinking-row');
      if (row) row.remove();
    }

    function setSending(sending) {
      isSending = sending;
      els.input.disabled = sending;
      els.sendBtn.disabled = sending;
    }

    // -------------------------------------------------------------------
    // Networking
    // -------------------------------------------------------------------

    async function sendMessage(text) {
      conversation.push({ role: 'user', content: text });
      appendMessage('user', text, []);
      appendThinking();
      setSending(true);

      try {
        var res = await fetch(ENDPOINT + '/v1/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenant: TENANT, messages: conversation, lang: API_LANG, session: SESSION_ID }),
        });

        removeThinking();

        if (res.status === 429) {
          var body = await res.json().catch(function () { return {}; });
          var msg = body && body.error === 'quota_exceeded' ? t.quotaExceeded : t.rateLimited;
          appendMessage('assistant', msg, []);
          return;
        }

        if (!res.ok) {
          appendMessage('assistant', t.networkError, []);
          return;
        }

        var data = await res.json();
        conversation.push({ role: 'assistant', content: data.answer });
        appendMessage('assistant', data.answer, Array.isArray(data.products) ? data.products : []);
      } catch (err) {
        removeThinking();
        appendMessage('assistant', t.networkError, []);
      } finally {
        setSending(false);
      }
    }

    els.form.addEventListener('submit', function (evt) {
      evt.preventDefault();
      if (isSending) return;
      var text = els.input.value.trim();
      if (!text) return;
      els.input.value = '';
      sendMessage(text);
    });

    // -------------------------------------------------------------------
    // Public API: window.ArlingAsistent (see the header comment)
    // -------------------------------------------------------------------

    function askQuestion(text) {
      var clean = String(text == null ? '' : text).trim().slice(0, 2000);
      if (!isOpen) openPanel();
      if (!clean || isSending) return false;
      els.input.value = '';
      sendMessage(clean);
      return true;
    }

    window.ArlingAsistent = { open: openPanel, close: closePanel, ask: askQuestion };
  }

  boot();
})();
