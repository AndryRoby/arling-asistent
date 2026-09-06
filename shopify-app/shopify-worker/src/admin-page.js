/*
 * admin-page.js
 *
 * GET /app - the embedded admin page rendered inside Shopify admin's
 * iframe. Plain HTML/CSS/JS (no build step, no framework), loading App
 * Bridge from Shopify's own CDN as required for embedded apps (see
 * shopify.dev "Build an embedded app" / app requirements checklist: "apps
 * must use App Bridge"). App Bridge issues short-lived session tokens
 * (`shopify.idToken()`); every call this page makes to its own backend
 * (/app/api/status, /app/api/settings, /app/api/billing) carries one as
 * `Authorization: Bearer <token>`, verified server-side by
 * session-token.js - never a cookie, per the "no third-party cookies"
 * review requirement.
 *
 * This function only builds the HTML string; index.js is what actually
 * serves it on GET /app.
 */

export function renderAdminPage({ apiKey, shop, host }) {
  const safeApiKey = String(apiKey || '').replace(/"/g, '&quot;');
  const safeShop = String(shop || '').replace(/</g, '&lt;');
  const safeHost = String(host || '').replace(/"/g, '&quot;');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${safeApiKey}">
<title>ARLing Asistent</title>
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background: #f6f6f7; color: #1a1a1a; }
  .card { background: #fff; border: 1px solid #e3e3e3; border-radius: 8px; padding: 20px; max-width: 640px; margin: 0 auto 16px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
  .row:last-child { border-bottom: none; }
  .plans { display: flex; gap: 10px; flex-wrap: wrap; }
  .plan { border: 1px solid #d0d0d0; border-radius: 6px; padding: 12px; flex: 1; min-width: 140px; }
  .plan.current { border-color: #008060; background: #f1f8f5; }
  .plan button { width: 100%; margin-top: 8px; padding: 8px; border-radius: 4px; border: 1px solid #008060; background: #008060; color: #fff; cursor: pointer; font-size: 13px; }
  .plan button:disabled { opacity: .5; cursor: default; }
  label { display: block; font-size: 13px; margin: 10px 0 4px; }
  select { width: 100%; padding: 6px; font-size: 13px; }
  #save-settings { margin-top: 14px; padding: 8px 14px; border-radius: 4px; border: 1px solid #008060; background: #008060; color: #fff; cursor: pointer; font-size: 13px; }
  #status-message { font-size: 13px; color: #616161; margin-top: 8px; }
  .error { color: #b40000; }
</style>
</head>
<body>
  <div class="card">
    <h1>ARLing Asistent</h1>
    <div id="status-rows"></div>
    <div id="status-message">Loading status...</div>
  </div>

  <div class="card">
    <h2>Plan</h2>
    <div class="plans" id="plans"></div>
  </div>

  <div class="card">
    <h2>Widget settings</h2>
    <label for="language">Language</label>
    <select id="language">
      <option value="auto">Automatic (follows visitor's browser)</option>
      <option value="sk">Slovak</option>
      <option value="cs">Czech</option>
      <option value="en">English</option>
      <option value="de">German</option>
    </select>
    <label for="color">Colour</label>
    <select id="color">
      <option value="auto">Automatic (follows visitor's system)</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
    <label for="position">Position</label>
    <select id="position">
      <option value="right">Bottom right</option>
      <option value="left">Bottom left</option>
    </select>
    <button id="save-settings" type="button">Save settings</button>
    <div id="save-message" style="font-size:13px;margin-top:8px;color:#616161;"></div>
  </div>

<script>
(function () {
  'use strict';

  var shopDomain = ${JSON.stringify(safeShop)};
  var host = ${JSON.stringify(safeHost)};

  function apiFetch(path, options) {
    options = options || {};
    return shopify.idToken().then(function (token) {
      return fetch(path, Object.assign({}, options, {
        headers: Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, options.headers || {}),
      }));
    });
  }

  var PLAN_LABELS = {
    free: { name: 'Free', price: '0 USD', desc: 'Up to 100 conversations/month' },
    starter: { name: 'Starter', price: '19 USD/month', desc: 'Up to 1,000 conversations/month' },
    pro: { name: 'Pro', price: '39 USD/month', desc: 'Up to 3,000 conversations/month' },
  };

  function renderStatus(data) {
    var rows = document.getElementById('status-rows');
    rows.innerHTML =
      row('Shop', data.shop) +
      row('Tenant status', data.tenant ? data.tenant.status : 'not created yet') +
      row('Products indexed', data.tenant ? String(data.tenant.product_count || 0) : '-') +
      row('Conversations used this month', data.tenant ? (data.tenant.used_this_month + ' / ' + data.tenant.monthly_quota) : '-') +
      row('Current plan', PLAN_LABELS[data.plan] ? PLAN_LABELS[data.plan].name : data.plan);
    document.getElementById('status-message').textContent = data.tenant && data.tenant.status === 'ready'
      ? 'Widget is ready. Add the app embed block from the theme editor to show it on your storefront.'
      : (data.tenant ? 'Building your assistant from your product catalogue, this can take a few minutes.' : 'Setting up...');

    document.getElementById('language').value = data.language || 'auto';
    document.getElementById('color').value = data.color || 'auto';
    document.getElementById('position').value = data.position || 'right';

    renderPlans(data.plan);
  }

  function row(label, value) {
    return '<div class="row"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderPlans(currentPlan) {
    var container = document.getElementById('plans');
    container.innerHTML = '';
    ['free', 'starter', 'pro'].forEach(function (key) {
      var info = PLAN_LABELS[key];
      var div = document.createElement('div');
      div.className = 'plan' + (key === currentPlan ? ' current' : '');
      var isCurrent = key === currentPlan;
      div.innerHTML =
        '<strong>' + info.name + '</strong><br>' +
        '<span>' + info.price + '</span><br>' +
        '<small>' + info.desc + '</small>' +
        '<button type="button" ' + (isCurrent ? 'disabled' : '') + '>' + (isCurrent ? 'Current plan' : 'Choose ' + info.name) + '</button>';
      if (!isCurrent) {
        div.querySelector('button').addEventListener('click', function () { choosePlan(key); });
      }
      container.appendChild(div);
    });
  }

  function choosePlan(planKey) {
    if (planKey === 'free') {
      apiFetch('/app/api/billing', { method: 'POST', body: JSON.stringify({ plan: 'free' }) })
        .then(function (r) { return r.json(); })
        .then(function () { loadStatus(); });
      return;
    }
    apiFetch('/app/api/billing', { method: 'POST', body: JSON.stringify({ plan: planKey }) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.confirmationUrl) {
          window.top.location.href = data.confirmationUrl;
        } else {
          document.getElementById('status-message').textContent = 'Could not start billing: ' + (data.error || 'unknown error');
        }
      });
  }

  function loadStatus() {
    apiFetch('/app/api/status')
      .then(function (r) { return r.json(); })
      .then(renderStatus)
      .catch(function () {
        document.getElementById('status-message').textContent = 'Could not load status.';
        document.getElementById('status-message').className = 'error';
      });
  }

  document.getElementById('save-settings').addEventListener('click', function () {
    var body = {
      language: document.getElementById('language').value,
      color: document.getElementById('color').value,
      position: document.getElementById('position').value,
    };
    apiFetch('/app/api/settings', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function () {
        document.getElementById('save-message').textContent = 'Saved.';
      })
      .catch(function () {
        document.getElementById('save-message').textContent = 'Could not save settings.';
      });
  });

  loadStatus();
})();
</script>
</body>
</html>`;
}
