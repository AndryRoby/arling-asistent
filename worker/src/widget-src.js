// widget-src.js
// GENERATED FILE: do not edit directly, it will be overwritten.
// Source of truth is ../../widget/widget.js. Regenerate both this file
// and the demo/widget.js copy with `npm run build:widget` (see
// scripts/build-widget.mjs) after any change to widget/widget.js.
//
// Served verbatim by GET /widget.js (see src/index.js) so e-shops can
// load the widget from the worker's own origin instead of needing a
// separate static host.

export default `/*
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
 * data-gift     optional, "1" to add a second "Najst darcek" / "Find a gift"
 *               button next to the chat bubble (Gift Finder: three short
 *               questions - recipient, budget, interests - then up to 5
 *               products from the shop's own feed with a one-line reason
 *               each, via POST /v1/gift, see worker/src/gift.js). Absent (the
 *               default) changes nothing at all: no extra button, no extra
 *               markup, no extra network call, so every shop already
 *               embedding this widget is unaffected until it opts in.
 *
 * Everything renders inside a Shadow DOM root so the host page's CSS can
 * never leak in or be broken by the widget's styles.
 *
 * Public API (optional, for pages that want their own "ask the assistant"
 * buttons, e.g. suggested questions on a demo shop): once booted, the
 * widget sets window.ArlingAsistent = {open(), close(), ask(text)}.
 * ask(text) opens the panel and sends \`text\` exactly as if the visitor had
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
 * it reads was assigned, since \`var\` hoisting only hoists the declaration,
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
      giftButton: 'Nájdi darček',
      giftOpenLabel: 'Otvoriť hľadač darčekov',
      giftTitle: 'Hľadač darčekov',
      giftRecipientQuestion: 'Pre koho hľadáte darček?',
      giftRecipients: ['Partner/ka', 'Mama', 'Otec', 'Dieťa', 'Kolega', 'Kamarát/ka', 'Sebe'],
      giftRecipientPlaceholder: 'Alebo napíšte pre koho (napr. babka)',
      giftBudgetQuestion: 'Aký je rozpočet?',
      giftBudgetLabels: ['do 20 €', 'do 50 €', 'do 100 €', 'nad 100 €'],
      giftInterestsQuestion: 'Čo má rád/rada?',
      giftInterestsPlaceholder: 'Napríklad záhrada, káva, knihy...',
      giftNext: 'Ďalej',
      giftBack: 'Späť',
      giftSubmit: 'Nájsť darčeky',
      giftThinking: 'Hľadám vhodné darčeky…',
      giftShowMore: 'Ukázať ďalšie',
      giftAskElse: 'Opýtať sa na niečo iné',
      giftWidenedNote: 'Pri tomto rozpočte sme nenašli dosť darčekov, tak sme ho mierne rozšírili.',
      giftFewNote: 'Pre tento výber sme našli len niekoľko vhodných darčekov.',
      giftEmptyNote: 'Pre tento výber sme nenašli vhodný darček. Skúste iný rozpočet alebo záujmy.',
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
      giftButton: 'Najít dárek',
      giftOpenLabel: 'Otevřít hledač dárků',
      giftTitle: 'Hledač dárků',
      giftRecipientQuestion: 'Pro koho hledáte dárek?',
      giftRecipients: ['Partner/ka', 'Máma', 'Táta', 'Dítě', 'Kolega', 'Kamarád/ka', 'Sobě'],
      giftRecipientPlaceholder: 'Nebo napište pro koho (např. babička)',
      giftBudgetQuestion: 'Jaký je rozpočet?',
      giftBudgetLabels: ['do 20 Kč', 'do 50 Kč', 'do 100 Kč', 'nad 100 Kč'],
      giftInterestsQuestion: 'Co má rád/ráda?',
      giftInterestsPlaceholder: 'Například zahrada, káva, knihy...',
      giftNext: 'Další',
      giftBack: 'Zpět',
      giftSubmit: 'Najít dárky',
      giftThinking: 'Hledám vhodné dárky…',
      giftShowMore: 'Zobrazit další',
      giftAskElse: 'Zeptat se na něco jiného',
      giftWidenedNote: 'Pro tento rozpočet jsme nenašli dost dárků, tak jsme ho mírně rozšířili.',
      giftFewNote: 'Pro tento výběr jsme našli jen několik vhodných dárků.',
      giftEmptyNote: 'Pro tento výběr jsme nenašli vhodný dárek. Zkuste jiný rozpočet nebo zájmy.',
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
      quotaExceeded: 'The assistant is resting today. Please use the shop\\'s contact page.',
      poweredBy: 'Powered by ARLing Asistent',
      relatedProducts: 'Related products',
      giftButton: 'Find a gift',
      giftOpenLabel: 'Open gift finder',
      giftTitle: 'Gift finder',
      giftRecipientQuestion: 'Who is the gift for?',
      giftRecipients: ['Partner', 'Mum', 'Dad', 'Child', 'Colleague', 'Friend', 'Myself'],
      giftRecipientPlaceholder: 'Or type who it is for (e.g. grandma)',
      giftBudgetQuestion: 'What is the budget?',
      giftBudgetLabels: ['up to €20', 'up to €50', 'up to €100', 'over €100'],
      giftInterestsQuestion: 'What do they like?',
      giftInterestsPlaceholder: 'For example gardening, coffee, books...',
      giftNext: 'Next',
      giftBack: 'Back',
      giftSubmit: 'Find gifts',
      giftThinking: 'Looking for good gifts…',
      giftShowMore: 'Show more',
      giftAskElse: 'Ask something else',
      giftWidenedNote: 'We did not find enough gifts at this budget, so we widened it slightly.',
      giftFewNote: 'We only found a few gifts that fit this search.',
      giftEmptyNote: 'We could not find a matching gift. Try a different budget or interests.',
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
      giftButton: 'Geschenk finden',
      giftOpenLabel: 'Geschenkfinder öffnen',
      giftTitle: 'Geschenkfinder',
      giftRecipientQuestion: 'Für wen ist das Geschenk?',
      giftRecipients: ['Partner/in', 'Mama', 'Papa', 'Kind', 'Kollege/in', 'Freund/in', 'Mich selbst'],
      giftRecipientPlaceholder: 'Oder schreiben Sie für wen (z. B. Oma)',
      giftBudgetQuestion: 'Wie hoch ist das Budget?',
      giftBudgetLabels: ['bis 20 €', 'bis 50 €', 'bis 100 €', 'über 100 €'],
      giftInterestsQuestion: 'Was mag die Person?',
      giftInterestsPlaceholder: 'Zum Beispiel Garten, Kaffee, Bücher...',
      giftNext: 'Weiter',
      giftBack: 'Zurück',
      giftSubmit: 'Geschenke finden',
      giftThinking: 'Suche passende Geschenke…',
      giftShowMore: 'Mehr anzeigen',
      giftAskElse: 'Etwas anderes fragen',
      giftWidenedNote: 'Bei diesem Budget haben wir zu wenige Geschenke gefunden, daher haben wir es leicht erweitert.',
      giftFewNote: 'Für diese Auswahl haben wir nur wenige passende Geschenke gefunden.',
      giftEmptyNote: 'Wir haben kein passendes Geschenk gefunden. Versuchen Sie ein anderes Budget oder andere Interessen.',
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
  // Gift Finder (data-gift="1" only): budget chip values, aligned by index
  // with each language's giftBudgetLabels above. Ranges come from the
  // product spec's fallback (20/50/100/100+); the tenant's own price spread
  // is not exposed by GET /v1/tenants/:id/status today, so every tenant
  // gets this same fixed fallback (see the build report for the alternative
  // this rules out). "100+" is an open upper bound: max stays null.
  // ---------------------------------------------------------------------
  var GIFT_BUDGET_RANGES = [
    { min: 0, max: 20 },
    { min: 0, max: 50 },
    { min: 0, max: 100 },
    { min: 100, max: null },
  ];

  /**
   * Best-effort Umami event, only when the host page already loads Umami
   * (true for arling.sk's own demo page; a no-op on every other shop, which
   * is correct: the widget must never load its own tracker onto someone
   * else's site). No customer-typed text (recipient/interests) is ever sent
   * as event data, only fixed, non-identifying fields.
   */
  function trackUmami(event, data) {
    try {
      if (window.umami && typeof window.umami.track === 'function') window.umami.track(event, data || {});
    } catch (e) {
      /* tracking must never break the widget */
    }
  }

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

  function buildMarkup(strings, giftEnabled) {
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
      '</div>' +
      (giftEnabled ? buildGiftMarkup(strings) : '')
    );
  }

  /**
   * Gift Finder markup (data-gift="1" only): a second launcher button plus
   * its own dialog with three steps (recipient, budget, interests) and a
   * results step, all inside the same shadow root as the chat panel above.
   * Never called, and never present in the rendered markup, when the
   * data-gift attribute is absent (see buildMarkup): a shop that has not
   * opted in gets byte-identical behaviour to before this feature existed.
   */
  function buildGiftMarkup(strings) {
    return (
      '<button id="gift-toggle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="' + escapeHtml(strings.giftOpenLabel) + '">' + escapeHtml(strings.giftButton) + '</button>' +
      '<div id="gift-panel" role="dialog" aria-modal="true" aria-label="' + escapeHtml(strings.giftTitle) + '" hidden>' +
        '<div class="panel-head">' +
          '<span class="panel-title">' + escapeHtml(strings.giftTitle) + '</span>' +
          '<button id="gift-close-btn" type="button" aria-label="' + escapeHtml(strings.closeLabel) + '">&times;</button>' +
        '</div>' +
        '<div id="gift-live" class="sr-only" aria-live="polite"></div>' +
        '<div id="gift-body" class="gift-body">' +
          '<div id="gift-step-recipient" class="gift-step">' +
            '<p class="gift-question">' + escapeHtml(strings.giftRecipientQuestion) + '</p>' +
            '<div id="gift-recipient-chips" class="gift-chips" role="group" aria-label="' + escapeHtml(strings.giftRecipientQuestion) + '"></div>' +
            '<label class="sr-only" for="gift-recipient-input">' + escapeHtml(strings.giftRecipientPlaceholder) + '</label>' +
            '<input id="gift-recipient-input" type="text" autocomplete="off" placeholder="' + escapeHtml(strings.giftRecipientPlaceholder) + '">' +
            '<div class="gift-actions"><button type="button" id="gift-recipient-next" class="gift-btn-primary">' + escapeHtml(strings.giftNext) + '</button></div>' +
          '</div>' +
          '<div id="gift-step-budget" class="gift-step" hidden>' +
            '<p class="gift-question">' + escapeHtml(strings.giftBudgetQuestion) + '</p>' +
            '<div id="gift-budget-chips" class="gift-chips" role="group" aria-label="' + escapeHtml(strings.giftBudgetQuestion) + '"></div>' +
            '<div class="gift-actions"><button type="button" id="gift-budget-back" class="gift-btn-secondary">' + escapeHtml(strings.giftBack) + '</button></div>' +
          '</div>' +
          '<div id="gift-step-interests" class="gift-step" hidden>' +
            '<p class="gift-question">' + escapeHtml(strings.giftInterestsQuestion) + '</p>' +
            '<div id="gift-interests-chips" class="gift-chips"></div>' +
            '<label class="sr-only" for="gift-interests-input">' + escapeHtml(strings.giftInterestsPlaceholder) + '</label>' +
            '<input id="gift-interests-input" type="text" autocomplete="off" placeholder="' + escapeHtml(strings.giftInterestsPlaceholder) + '">' +
            '<div class="gift-actions"><button type="button" id="gift-interests-back" class="gift-btn-secondary">' + escapeHtml(strings.giftBack) + '</button><button type="button" id="gift-submit-btn" class="gift-btn-primary">' + escapeHtml(strings.giftSubmit) + '</button></div>' +
          '</div>' +
          '<div id="gift-step-results" class="gift-step" hidden>' +
            '<p id="gift-note" class="gift-note" hidden></p>' +
            '<div id="gift-results-list" class="gift-results" role="list" aria-label="' + escapeHtml(strings.giftTitle) + '"></div>' +
            '<div class="gift-actions">' +
              '<button type="button" id="gift-show-more" class="gift-btn-secondary" hidden>' + escapeHtml(strings.giftShowMore) + '</button>' +
              '<button type="button" id="gift-ask-else" class="gift-btn-secondary">' + escapeHtml(strings.giftAskElse) + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
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
      // Gift Finder (data-gift="1" only): these rules simply have no effect
      // when the widget renders without the gift markup at all.
      '#gift-toggle {' +
      '  position:absolute; bottom:8px; right:64px; white-space:nowrap;' +
      '  padding:0 14px; height:40px; border-radius:20px; border:1px solid var(--line);' +
      '  background:var(--paper); color:var(--ink); font:600 13px/1 var(--sans); cursor:pointer;' +
      '  box-shadow:0 4px 14px rgba(0,0,0,.14);' +
      '}' +
      '#gift-toggle:hover { border-color:var(--accent); color:var(--accent); }' +
      '#gift-toggle:focus-visible { outline:2px solid var(--ink); outline-offset:2px; }' +
      ':host(.position-left) #gift-toggle { right:auto; left:64px; }' +
      '#gift-panel {' +
      '  position:absolute; bottom:68px; right:0; width:340px; max-width:calc(100vw - 40px);' +
      '  height:480px; max-height:70vh; background:var(--paper); border:1px solid var(--line);' +
      '  border-radius:8px; display:flex; flex-direction:column; overflow:hidden;' +
      '  box-shadow:0 8px 28px rgba(0,0,0,.18); color:var(--ink);' +
      '}' +
      ':host(.position-left) #gift-panel { right:auto; left:0; }' +
      '#gift-panel[hidden] { display:none; }' +
      '.gift-body { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; }' +
      '.gift-step[hidden] { display:none; }' +
      '.gift-question { font:600 14px/1.4 var(--sans); margin:0 0 10px; }' +
      '.gift-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }' +
      '.gift-chip {' +
      '  border:1px solid var(--line); background:var(--paper-2); color:var(--ink);' +
      '  border-radius:16px; padding:6px 12px; font:13px/1 var(--sans); cursor:pointer;' +
      '}' +
      '.gift-chip:hover { border-color:var(--accent); color:var(--accent); }' +
      '.gift-chip:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }' +
      '#gift-recipient-input, #gift-interests-input {' +
      '  width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:6px;' +
      '  background:var(--paper); color:var(--ink); font:14px/1.4 var(--sans); margin-bottom:10px;' +
      '}' +
      '#gift-recipient-input:focus-visible, #gift-interests-input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }' +
      '.gift-actions { display:flex; gap:8px; margin-top:auto; padding-top:4px; }' +
      '.gift-btn-primary, .gift-btn-secondary {' +
      '  border-radius:6px; padding:9px 14px; font:600 13px/1 var(--sans); cursor:pointer;' +
      '}' +
      '.gift-btn-primary { border:1px solid var(--accent); background:var(--accent); color:#fff; }' +
      '.gift-btn-primary:hover { filter:brightness(1.08); }' +
      '.gift-btn-secondary { border:1px solid var(--line); background:var(--paper-2); color:var(--ink); }' +
      '.gift-btn-secondary:hover { border-color:var(--accent); color:var(--accent); }' +
      '.gift-btn-primary:focus-visible, .gift-btn-secondary:focus-visible { outline:2px solid var(--ink); outline-offset:1px; }' +
      '.gift-note { font:13px/1.5 var(--sans); color:var(--ink-2); background:var(--accent-soft); border-radius:6px; padding:8px 10px; margin:0 0 10px; }' +
      '.gift-note[hidden] { display:none; }' +
      '.gift-results { display:flex; flex-direction:column; gap:8px; overflow-y:auto; flex:1; }' +
      '.gift-card { align-items:flex-start; }' +
      '.gift-why { font:12px/1.4 var(--sans); color:var(--ink-2); }' +
      '@media (max-width:480px) {' +
      '  :host { bottom:12px; right:12px; }' +
      '  :host(.position-left) { right:auto; left:12px; }' +
      '  #panel, #gift-panel {' +
      '    position:fixed; left:0; right:0; bottom:0; width:100%; max-width:100%;' +
      '    height:min(78vh, 560px); max-height:78vh; border-radius:14px 14px 0 0; border-bottom:none;' +
      '  }' +
      '  #gift-toggle { bottom:64px; right:0; }' +
      '  :host(.position-left) #gift-toggle { left:0; }' +
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
        if (/widget\\.js(\\?|$)/.test(scripts[i].src)) return scripts[i];
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
    var ENDPOINT = (scriptEl.getAttribute('data-endpoint') || scriptOrigin(scriptEl)).replace(/\\/$/, '');
    // Absent (the default): no gift button, no gift markup, no gift network
    // call, ever. Any value other than the exact "1" is treated as absent.
    var GIFT_ENABLED = scriptEl.getAttribute('data-gift') === '1';

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
    root.innerHTML = buildMarkup(t, GIFT_ENABLED);
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
      // giftEls/isGiftOpen below are declared with \`var\` inside the
      // \`if (GIFT_ENABLED)\` block further down: \`var\` is hoisted to this
      // whole function regardless of that block, so this reference is valid
      // (and simply undefined/false, doing nothing here) even when the gift
      // feature is not enabled at all.
      if (GIFT_ENABLED && giftEls && !giftEls.panel.hidden) {
        giftEls.panel.hidden = true;
        giftEls.toggle.setAttribute('aria-expanded', 'false');
        isGiftOpen = false;
      }
      isOpen ? closePanel() : openPanel();
    });
    els.closeBtn.addEventListener('click', closePanel);

    // -------------------------------------------------------------------
    // Gift Finder (data-gift="1" only): three short steps (recipient,
    // budget, interests), then up to 5 cards from POST /v1/gift. Every
    // element referenced below only exists when GIFT_ENABLED is true (see
    // buildGiftMarkup), so this whole block is a no-op, touching nothing,
    // when the attribute is absent: no button, no markup, no request.
    // -------------------------------------------------------------------

    var giftEls, isGiftOpen = false;

    if (GIFT_ENABLED) {
      giftEls = {
        toggle: root.getElementById('gift-toggle'),
        panel: root.getElementById('gift-panel'),
        closeBtn: root.getElementById('gift-close-btn'),
        live: root.getElementById('gift-live'),
        recipientChips: root.getElementById('gift-recipient-chips'),
        recipientInput: root.getElementById('gift-recipient-input'),
        recipientNext: root.getElementById('gift-recipient-next'),
        budgetChips: root.getElementById('gift-budget-chips'),
        budgetBack: root.getElementById('gift-budget-back'),
        interestsInput: root.getElementById('gift-interests-input'),
        interestsBack: root.getElementById('gift-interests-back'),
        submitBtn: root.getElementById('gift-submit-btn'),
        note: root.getElementById('gift-note'),
        resultsList: root.getElementById('gift-results-list'),
        showMoreBtn: root.getElementById('gift-show-more'),
        askElseBtn: root.getElementById('gift-ask-else'),
      };

      var isGiftSending = false;
      var giftRecipientValue = '';
      var giftBudgetMin = null;
      var giftBudgetMax = null;
      var giftRemainingCandidates = [];

      function buildGiftChips(container, labels, onPick) {
        labels.forEach(function (label) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'gift-chip';
          btn.textContent = label;
          btn.addEventListener('click', function () { onPick(label); });
          container.appendChild(btn);
        });
      }

      buildGiftChips(giftEls.recipientChips, t.giftRecipients, function (label) {
        giftRecipientValue = label;
        giftEls.recipientInput.value = label;
        showGiftStep('budget');
      });

      buildGiftChips(giftEls.budgetChips, t.giftBudgetLabels, function (label) {
        var range = GIFT_BUDGET_RANGES[t.giftBudgetLabels.indexOf(label)];
        giftBudgetMin = range.min;
        giftBudgetMax = range.max;
        showGiftStep('interests');
      });

      /** The first real interactive control of each step, for the focus-on-step-change below (a step's own heading paragraph is not focusable). */
      function firstGiftFocusTarget(name) {
        if (name === 'recipient') return giftEls.recipientInput;
        if (name === 'budget') return (giftEls.budgetChips.children && giftEls.budgetChips.children[0]) || giftEls.budgetBack;
        if (name === 'interests') return giftEls.interestsInput;
        if (name === 'results') return giftEls.askElseBtn;
        return null;
      }

      function showGiftStep(name) {
        ['recipient', 'budget', 'interests', 'results'].forEach(function (key) {
          var stepEl = root.getElementById('gift-step-' + key);
          if (stepEl) stepEl.hidden = key !== name;
        });
        window.requestAnimationFrame(function () {
          var focusTarget = firstGiftFocusTarget(name);
          if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
        });
      }

      function resetGiftFlow() {
        giftRecipientValue = '';
        giftBudgetMin = null;
        giftBudgetMax = null;
        giftEls.recipientInput.value = '';
        giftEls.interestsInput.value = '';
        giftEls.note.hidden = true;
        giftEls.resultsList.innerHTML = '';
        giftEls.showMoreBtn.hidden = true;
        giftRemainingCandidates = [];
      }

      function openGiftPanel() {
        if (isOpen) closePanel();
        isGiftOpen = true;
        resetGiftFlow();
        giftEls.panel.hidden = false;
        giftEls.toggle.setAttribute('aria-expanded', 'true');
        showGiftStep('recipient');
        document.addEventListener('keydown', onGiftKeydown, true);
        trackUmami('gift_open', {});
      }

      function closeGiftPanel() {
        isGiftOpen = false;
        giftEls.panel.hidden = true;
        giftEls.toggle.setAttribute('aria-expanded', 'false');
        giftEls.toggle.focus();
        document.removeEventListener('keydown', onGiftKeydown, true);
      }

      function onGiftKeydown(evt) {
        if (evt.key === 'Escape' && isGiftOpen) {
          evt.stopPropagation();
          closeGiftPanel();
        }
      }

      giftEls.toggle.addEventListener('click', function () {
        isGiftOpen ? closeGiftPanel() : openGiftPanel();
      });
      giftEls.closeBtn.addEventListener('click', closeGiftPanel);

      giftEls.recipientNext.addEventListener('click', function () {
        var val = giftEls.recipientInput.value.trim();
        if (val) giftRecipientValue = val;
        showGiftStep('budget');
      });
      giftEls.budgetBack.addEventListener('click', function () { showGiftStep('recipient'); });
      giftEls.interestsBack.addEventListener('click', function () { showGiftStep('budget'); });

      function appendGiftCard(list, item, withWhy) {
        var card = document.createElement('a');
        card.className = 'product-card gift-card';
        card.setAttribute('role', 'listitem');
        var productUrl = safeUrl(item.url);
        card.href = productUrl || '#';
        card.target = '_blank';
        card.rel = 'noopener';
        card.addEventListener('click', function () { trackUmami('gift_product_click', {}); });
        var imageUrl = safeUrl(item.image);
        var imgHtml = imageUrl ? '<img class="product-img" src="' + escapeHtml(imageUrl) + '" alt="" loading="lazy">' : '';
        var priceText = formatPrice(item);
        var whyHtml = withWhy && item.why ? '<span class="gift-why">' + escapeHtml(item.why) + '</span>' : '';
        card.innerHTML =
          imgHtml +
          '<span class="product-body">' +
          '<span class="product-title">' + escapeHtml(item.title || '') + '</span>' +
          (priceText ? '<span class="product-price">' + escapeHtml(priceText) + '</span>' : '') +
          whyHtml +
          '</span>';
        list.appendChild(card);
      }

      function showGiftNote(text) {
        giftEls.note.hidden = false;
        giftEls.note.textContent = text;
      }

      function showGiftThinking() {
        showGiftStep('results');
        giftEls.resultsList.innerHTML = '';
        giftEls.showMoreBtn.hidden = true;
        showGiftNote(t.giftThinking);
      }

      function renderGiftResults(data) {
        var picks = Array.isArray(data.picks) ? data.picks : [];
        var candidates = Array.isArray(data.candidates) ? data.candidates : [];
        giftEls.resultsList.innerHTML = '';
        var shownUrls = {};
        picks.forEach(function (p) {
          shownUrls[p.url] = true;
          appendGiftCard(giftEls.resultsList, p, true);
        });
        giftRemainingCandidates = candidates.filter(function (c) { return !shownUrls[c.url]; });
        giftEls.showMoreBtn.hidden = giftRemainingCandidates.length === 0;

        if (picks.length === 0) {
          showGiftNote(t.giftEmptyNote);
        } else if (data.widened) {
          showGiftNote(t.giftWidenedNote);
        } else if (data.few) {
          showGiftNote(t.giftFewNote);
        } else {
          giftEls.note.hidden = true;
        }
        giftEls.live.textContent = t.giftTitle + ': ' + picks.length;
      }

      giftEls.showMoreBtn.addEventListener('click', function () {
        giftRemainingCandidates.forEach(function (c) { appendGiftCard(giftEls.resultsList, c, false); });
        giftEls.showMoreBtn.hidden = true;
      });

      giftEls.askElseBtn.addEventListener('click', function () {
        closeGiftPanel();
        openPanel();
      });

      function doGiftSubmit() {
        if (isGiftSending) return;
        var interests = giftEls.interestsInput.value.trim();
        isGiftSending = true;
        giftEls.submitBtn.disabled = true;
        showGiftThinking();
        trackUmami('gift_submit', {});

        fetch(ENDPOINT + '/v1/gift', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant: TENANT,
            lang: API_LANG,
            recipient: giftRecipientValue,
            budget_min: giftBudgetMin,
            budget_max: giftBudgetMax,
            interests: interests,
            session: SESSION_ID,
          }),
        }).then(function (res) {
          if (res.status === 429) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              var msg = body && body.error === 'quota_exceeded' ? t.quotaExceeded : t.rateLimited;
              giftEls.resultsList.innerHTML = '';
              giftEls.showMoreBtn.hidden = true;
              showGiftNote(msg);
            });
          }
          if (!res.ok) {
            giftEls.resultsList.innerHTML = '';
            giftEls.showMoreBtn.hidden = true;
            showGiftNote(t.networkError);
            return undefined;
          }
          return res.json().then(function (data) {
            renderGiftResults(data || {});
          });
        }).catch(function () {
          giftEls.resultsList.innerHTML = '';
          giftEls.showMoreBtn.hidden = true;
          showGiftNote(t.networkError);
        }).then(function () {
          isGiftSending = false;
          giftEls.submitBtn.disabled = false;
        });
      }

      giftEls.submitBtn.addEventListener('click', doGiftSubmit);
    }

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
`;
