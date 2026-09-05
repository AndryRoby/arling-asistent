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

  var form = document.getElementById('trial-form');
  if (!form) return;

  var feedInput = document.getElementById('trial-feed-url');
  var emailInput = document.getElementById('trial-email');
  var langSelect = document.getElementById('trial-lang');
  var submitBtn = document.getElementById('trial-submit');
  var statusEl = document.getElementById('trial-status');
  var widgetMount = document.getElementById('trial-widget-note');

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
