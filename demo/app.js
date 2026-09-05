/*
 * app.js
 *
 * Wires the "try it now" form on the ARLing Asistent demo page: submits the
 * visitor's own feed URL + e-mail to the worker's POST /v1/tenants, polls
 * GET /v1/tenants/:id/status until ingestion finishes, then injects the
 * real widget/widget.js <script> tag on this same page pointed at the new
 * tenant, so the visitor can chat with their own shop's assistant without
 * leaving arling.sk. No build step, no inline <script> (see the CSP meta
 * tag in index.html), no dependencies.
 *
 * The worker is not deployed yet (see README "what is not built yet"): the
 * default ENDPOINT below is a placeholder. For local testing against
 * `wrangler dev`, append ?endpoint=http://localhost:8787 to this page's URL
 * (and temporarily add that origin to the CSP meta's connect-src).
 *
 * Also wires the two paid-plan pricing buttons to their Stripe Payment Links
 * (see "Stripe Payment Link pricing buttons" below and README "Platby cez
 * Stripe"): this part does not depend on the trial worker being deployed.
 */
(function () {
  'use strict';

  var DEFAULT_ENDPOINT = 'https://arling-asistent.arling.workers.dev';
  var ENDPOINT = (new URLSearchParams(window.location.search).get('endpoint') || DEFAULT_ENDPOINT).replace(/\/$/, '');
  var POLL_INTERVAL_MS = 3000;
  var POLL_MAX_TRIES = 40; // ~2 minutes

  // Slovak text for every error code POST /v1/tenants can return (see
  // worker/src/index.js and worker/src/onboarding.js), so a rejected trial
  // signup tells the visitor (or Andrej, debugging live) what actually went
  // wrong instead of always showing the same generic "check the fields"
  // text regardless of cause.
  var TENANT_ERROR_MESSAGES = {
    invalid_json: 'Neplatná požiadavka (poškodené dáta formulára).',
    validation_failed: 'Skontrolujte polia formulára.',
    origin_not_allowed: 'Táto stránka nemá povolený prístup k API (CORS).',
    rate_limited: 'Príliš veľa požiadaviek naraz. Skúste to o chvíľu.',
    payload_too_large: 'Požiadavka je príliš veľká.',
    quota_exceeded: 'Dnešný limit skúšobných účtov bol dosiahnutý.',
    internal_error: 'Nastala chyba na strane servera.',
  };

  /** Turn a POST /v1/tenants error response body into a Slovak-language detail string, or null if there is nothing usable to show. */
  function describeTenantError(err) {
    if (!err) return null;
    var code = typeof err === 'string' ? err : err.error;
    if (!code) return null;
    var text = TENANT_ERROR_MESSAGES[code] || code;
    var issues = err && Array.isArray(err.issues) && err.issues.length ? ' (' + err.issues.join(', ') + ')' : '';
    return text + issues;
  }

  // ── Stripe Payment Link pricing buttons ─────────────────────────────────
  // The two paid-plan buttons in the pricing table (#btn-plan-starter,
  // #btn-plan-pro, see index.html) carry a data-stripe-link attribute the
  // owner fills in with a real Stripe Payment Link URL once Stripe is set
  // up (STRIPE_LINK_STARTER / STRIPE_LINK_PRO placeholders, see README
  // "Platby cez Stripe"). Until then (or if a button is left empty on
  // purpose) it shows "Coming soon" and is inert. Once a trial tenant has
  // been created on this page (see the form handler below), a configured
  // button's href gets `?client_reference_id=<tenant id>` appended so the
  // licence-service webhook (see products/licence-service/app.py) knows
  // which tenant to upgrade after a successful Stripe checkout.
  var PRICING_LINK_SELECTOR = '[data-stripe-link]';

  function pricingLinkComingSoonText() {
    return (window.ASISTENT_I18N && typeof window.ASISTENT_I18N.t === 'function') ? window.ASISTENT_I18N.t('cta.comingSoon') : 'Čoskoro';
  }

  function markPricingButtonComingSoon(btn) {
    btn.classList.add('btn-disabled');
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('href');
    btn.dataset.comingSoon = '1';
    btn.setAttribute('data-i18n', 'cta.comingSoon');
    btn.textContent = pricingLinkComingSoonText();
  }

  function initPricingButtons() {
    document.querySelectorAll(PRICING_LINK_SELECTOR).forEach(function (btn) {
      var link = (btn.getAttribute('data-stripe-link') || '').trim();
      if (!link) markPricingButtonComingSoon(btn);
    });
  }

  /** Called once a trial tenant exists (see the form handler below): rewrites every configured, not-"coming soon" pricing button to the tenant's own Stripe Payment Link. */
  function activatePricingLinks(tenantId) {
    if (!tenantId) return;
    document.querySelectorAll(PRICING_LINK_SELECTOR).forEach(function (btn) {
      if (btn.dataset.comingSoon) return;
      var link = (btn.getAttribute('data-stripe-link') || '').trim();
      if (!link) return;
      var sep = link.indexOf('?') === -1 ? '?' : '&';
      btn.setAttribute('href', link + sep + 'client_reference_id=' + encodeURIComponent(tenantId));
      btn.setAttribute('target', '_blank');
      btn.setAttribute('rel', 'noopener');
    });
  }

  initPricingButtons();

  var form = document.getElementById('trial-form');
  if (!form) return;

  var feedInput = document.getElementById('trial-feed-url');
  var emailInput = document.getElementById('trial-email');
  var langSelect = document.getElementById('trial-lang');
  var submitBtn = document.getElementById('trial-submit');
  var statusEl = document.getElementById('trial-status');
  var widgetMount = document.getElementById('trial-widget-note');

  // ── "Your embed code" block ──────────────────────────────────────────
  // Shown once the trial tenant is ready (see poll() below): the tenant id
  // (for reference / support) and the real <script> snippet a visitor
  // pastes into their own theme, each with its own Copy button. The
  // widget.js origin here is always the production one, independent of the
  // ?endpoint= override used to test this demo page itself against
  // `wrangler dev` (see the file header comment).
  var WIDGET_SCRIPT_ORIGIN = 'https://arling-asistent.arling.workers.dev';
  var embedBlock = document.getElementById('trial-embed');
  var embedIdInput = document.getElementById('trial-embed-id');
  var embedSnippetPre = document.getElementById('trial-embed-snippet');
  var embedCopyIdBtn = document.getElementById('trial-embed-copy-id');
  var embedCopySnippetBtn = document.getElementById('trial-embed-copy-snippet');

  function embedSnippetFor(tenantId) {
    return '<script src="' + WIDGET_SCRIPT_ORIGIN + '/widget.js" data-tenant="' + tenantId + '" data-lang="auto" defer></script>';
  }

  function showEmbedCode(tenantId) {
    if (!embedBlock) return;
    if (embedIdInput) embedIdInput.value = tenantId;
    if (embedSnippetPre) embedSnippetPre.textContent = embedSnippetFor(tenantId);
    embedBlock.hidden = false;
  }

  function copyLabel() {
    return (window.ASISTENT_I18N && typeof window.ASISTENT_I18N.t === 'function') ? window.ASISTENT_I18N.t('s3.embed.copy') : 'Kopírovať';
  }

  function copiedLabel() {
    return (window.ASISTENT_I18N && typeof window.ASISTENT_I18N.t === 'function') ? window.ASISTENT_I18N.t('s3.embed.copied') : 'Skopírované';
  }

  /** Copies `text` to the clipboard and flashes the triggering button's label to "Copied" for 1.5s. */
  function copyToClipboard(text, btn) {
    function flash(ok) {
      if (!btn) return;
      btn.textContent = ok ? copiedLabel() : copyLabel();
      setTimeout(function () { btn.textContent = copyLabel(); }, 1500);
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () { flash(true); }, function () { flash(false); });
      return;
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      flash(true);
    } catch (e) {
      flash(false);
    }
  }

  if (embedCopyIdBtn) {
    embedCopyIdBtn.addEventListener('click', function () {
      copyToClipboard(embedIdInput ? embedIdInput.value : '', embedCopyIdBtn);
    });
  }
  if (embedCopySnippetBtn) {
    embedCopySnippetBtn.addEventListener('click', function () {
      copyToClipboard(embedSnippetPre ? embedSnippetPre.textContent : '', embedCopySnippetBtn);
    });
  }

  function setStatus(text, tone) {
    statusEl.textContent = text;
    statusEl.className = 'trial-status' + (tone ? ' trial-status-' + tone : '');
    statusEl.hidden = !text;
  }

  function track(event, data) {
    try {
      if (window.umami && typeof window.umami.track === 'function') window.umami.track(event, data || {});
    } catch (e) {
      /* analytics must never break the demo */
    }
  }

  function domainFromFeedUrl(feedUrl) {
    try {
      return new URL(feedUrl).hostname;
    } catch (e) {
      return '';
    }
  }

  function injectWidget(tenantId, lang) {
    if (window.__arlingAsistentInit) return; // already injected once on this page
    var script = document.createElement('script');
    script.src = './widget.js';
    script.setAttribute('data-tenant', tenantId);
    script.setAttribute('data-lang', lang || 'sk');
    script.setAttribute('data-color', 'auto');
    script.setAttribute('data-endpoint', ENDPOINT);
    script.defer = true;
    document.body.appendChild(script);
    if (widgetMount) widgetMount.hidden = false;
  }

  function poll(tenantId, lang, triesLeft) {
    if (triesLeft <= 0) {
      setStatus('Spracovanie feedu trva dlhšie ako obvykle. Skúste obnoviť stránku o chvíľu, alebo napíšte na andrej@arling.sk.', 'warn');
      return;
    }
    fetch(ENDPOINT + '/v1/tenants/' + encodeURIComponent(tenantId) + '/status')
      .then(function (res) {
        if (!res.ok) throw new Error('status_failed_' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data.status === 'ready') {
          setStatus('Hotovo. Otvorte chat vpravo dole a opýtajte sa niečo o vašich produktoch.', 'ok');
          track('trial_ready', { lang: lang });
          injectWidget(tenantId, lang);
          showEmbedCode(tenantId);
        } else if (data.status === 'error') {
          setStatus('Feed sa nepodarilo spracovať. Skontrolujte URL feedu, alebo napíšte na andrej@arling.sk.', 'error');
          track('trial_error', { lang: lang });
        } else {
          setTimeout(function () { poll(tenantId, lang, triesLeft - 1); }, POLL_INTERVAL_MS);
        }
      })
      .catch(function () {
        setTimeout(function () { poll(tenantId, lang, triesLeft - 1); }, POLL_INTERVAL_MS);
      });
  }

  form.addEventListener('submit', function (evt) {
    evt.preventDefault();

    var feedUrl = feedInput.value.trim();
    var email = emailInput.value.trim();
    var lang = langSelect ? langSelect.value : 'sk';
    var domain = domainFromFeedUrl(feedUrl);

    if (!feedInput.checkValidity()) { feedInput.reportValidity(); return; }
    if (!emailInput.checkValidity()) { emailInput.reportValidity(); return; }
    if (!domain) {
      setStatus('URL feedu musí byť platná adresa (https://vaseshop.sk/feed.xml).', 'error');
      return;
    }

    submitBtn.disabled = true;
    setStatus('Sťahujeme a spracúvame váš feed produktov...', 'pending');
    track('trial_start', { lang: lang });

    fetch(ENDPOINT + '/v1/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed_url: feedUrl, domain: domain, email: email }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (body) { throw body; });
        return res.json();
      })
      .then(function (tenant) {
        activatePricingLinks(tenant.id);
        poll(tenant.id, lang, POLL_MAX_TRIES);
      })
      .catch(function (err) {
        var detail = describeTenantError(err);
        var message = detail
          ? 'Nepodarilo sa vytvoriť skúšobný účet: ' + detail
          : 'Nepodarilo sa vytvoriť skúšobný účet. Skontrolujte internetové pripojenie a skúste znova.';
        setStatus(message, 'error');
        submitBtn.disabled = false;
      });
  });
})();
