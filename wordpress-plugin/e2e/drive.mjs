// E2E test pluginu v skutočnom WordPresse a WooCommerce (WordPress
// Playground v Node, bez prehliadača). Prejde celú prvú cestu: nastavenie,
// lokálna adresa, pripojenie, čítanie produktov, každá chyba s dôvodom,
// Try again, hotový asistent s ukážkou, upozornenia na limit, jazyk,
// nastavenia, odpojenie a presmerovanie po aktivácii. 59 kontrol.
//
// Každé volanie na worker ARLing zachytí arltest-mu.php (pre_http_request)
// a odpovie makety, takže sa NIKDY nič nepošle na produkciu. Ten súbor tiež
// prihlasuje curl ako admina: je to len testovací mu-plugin, nikdy ho
// nedávať na skutočný web a nikdy nekopírovať do arling-asistent/.
//
// Spustenie (Git Bash na Windows; MSYS_NO_PATHCONV bráni prepisu /wordpress
// na C:/Program Files/Git/wordpress, TMP/USERPROFILE drží dočasné súbory
// Playgroundu v jednom priečinku $T):
//
//   T=D:/Temp/wp-e2e; mkdir -p $T/home $T/tmp $T/cli $T/mu
//   cp products/arling-asistent/wordpress-plugin/e2e/arltest-mu.php $T/mu/
//   cd $T/cli && npm init -y && npm i @wp-playground/cli     (len raz, mimo repozitára)
//   MSYS_NO_PATHCONV=1 TMP=$T/tmp TEMP=$T/tmp USERPROFILE=$T/home HOME=$T/home \
//     $T/cli/node_modules/.bin/wp-playground-cli server --php 7.4 --wp latest --port 9477 --workers 2 \
//     --mount-dir "<repo>/products/arling-asistent/wordpress-plugin/arling-asistent" "/wordpress/wp-content/plugins/arling-asistent" \
//     --mount-dir "$T/mu" "/wordpress/wp-content/mu-plugins" \
//     --blueprint "<repo>/products/arling-asistent/wordpress-plugin/e2e/blueprint.json" \
//     --define-bool WP_DEBUG true --define-bool WP_DEBUG_DISPLAY true --define-bool DISABLE_WP_CRON true
//   (počkať na „Ready! WordPress is running on http://127.0.0.1:9477“, prvé spustenie sťahuje WooCommerce)
//   node products/arling-asistent/wordpress-plugin/e2e/drive.mjs      -> „ALL OK“
//
// Server potom zastaviť (taskkill na PID z netstat -ano | grep 9477). Na PHP
// 8.3 to isté s --php 8.3. Naposledy prešlo 24. 9. 2026: PHP 7.4 aj 8.3,
// WordPress 7.1.2, WooCommerce 11.1.2. Stránky na pozretie uloží premenná
// ARLTEST_PAGES=<priečinok>.
import { writeFileSync, mkdirSync } from 'node:fs';

const B = 'http://127.0.0.1:9477';
const ADMIN = { 'X-Arltest-User': '1' };
const OUT = process.env.ARLTEST_PAGES ? new URL(`file:///${process.env.ARLTEST_PAGES.replace(/\\/g, '/').replace(/^\//, '')}/`) : null;
if (OUT) mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
}
const PHP_PROBLEM = /(Fatal error|Warning:|Notice:|Deprecated:|Parse error|Uncaught)[^<]{0,300}/g;
function phpProblems(html) {
  return (html.match(PHP_PROBLEM) || []).filter((m) => /arling/i.test(m));
}
async function fetch(url, opts) {
  for (let i = 1; ; i++) {
    try {
      return await globalThis.fetch(url, opts);
    } catch (e) {
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
async function get(path, { admin = true, redirect = 'manual' } = {}) {
  const res = await fetch(B + path, { headers: admin ? ADMIN : {}, redirect });
  return { status: res.status, location: res.headers.get('location'), html: await res.text() };
}
async function post(path, fields) {
  const res = await fetch(B + path, {
    method: 'POST',
    headers: { ...ADMIN, 'Content-Type': 'application/x-www-form-urlencoded', Referer: B + '/wp-admin/admin.php?page=arling-asistent' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), html: await res.text() };
}
function nonce(html, field) {
  const m = html.match(new RegExp(`name="${field}" value="([a-f0-9]+)"`));
  return m ? m[1] : '';
}
async function mode(m) { await get('/?arltest_set=' + encodeURIComponent(m), { admin: false }); }
async function dump() { return JSON.parse((await get('/?arltest_dump=1', { admin: false })).html); }
const SETTINGS = '/wp-admin/admin.php?page=arling-asistent';
function save(name, html) { if (OUT) writeFileSync(new URL(name + '.html', OUT), html); }

// 0. Clean state.
await get('/?arltest_reset=1', { admin: false });

// 1. Not connected: setup screen.
let p = await get(SETTINGS);
save('01-setup', p.html);
check('setup screen renders', p.status === 200 && p.html.includes('Switch on your AI shopping assistant'), 'status ' + p.status);
check('setup screen states the free plan', p.html.includes('Free for 100 conversations a month'));
check('setup screen: no account wording', p.html.includes('no account on another website'));
check('feed URL comes from get_rest_url', /wc\/store\/v1\/products(&#038;|&amp;|&|\?)per_page=100/.test(p.html), (p.html.match(/<code>[^<]*store[^<]*<\/code>/) || [''])[0]);
check('connect button enabled on a reachable site', !/id="submit"[^>]*disabled/.test(p.html));
check('no PHP warnings on setup screen', phpProblems(p.html).length === 0, phpProblems(p.html).join(' | '));

// 1b. Local site detection (real check, 127.0.0.1).
await get('/?arltest_reach=real', { admin: false });
p = await get(SETTINGS);
save('01b-setup-local', p.html);
check('local site warning shown', p.html.includes('local, staging or private address'));
check('connect button disabled on a local site', /<input[^>]*disabled[^>]*>/.test(p.html.slice(p.html.indexOf('arling_asistent_connect'))));
await get('/?arltest_reach=off', { admin: false });

// 2. Connect.
await mode('pending');
p = await get(SETTINGS);
let r = await post('/wp-admin/admin-post.php', {
  action: 'arling_asistent_connect',
  arling_asistent_connect_nonce: nonce(p.html, 'arling_asistent_connect_nonce'),
  _wp_http_referer: SETTINGS,
  arling_asistent_email: 'owner@example.com',
  arling_asistent_consent: '1',
});
check('connect redirects back to settings', r.status === 302 && String(r.location).includes('page=arling-asistent'), `${r.status} ${r.location}`);
let d = await dump();
check('tenant saved', d.tenant === 't-test-1', JSON.stringify(d.tenant));
check('default scope for new connections is all pages', d.scope === 'all', d.scope);
check('status cron scheduled', !!d.cron);
const create = d.calls.find((c) => c.method === 'POST');
check('POST /v1/tenants sends exactly feed_url, domain, email', create && JSON.stringify(Object.keys(JSON.parse(create.body)).sort()) === '["domain","email","feed_url"]', create && create.body);

// 3. Pending.
p = await get(SETTINGS);
save('03-pending', p.html);
check('pending screen', p.html.includes('Reading your products') && p.html.includes('http-equiv="refresh" content="5'));
check('success notice after connect', p.html.includes('Connected. Your products are being read now'));
check('no PHP warnings on pending', phpProblems(p.html).length === 0, phpProblems(p.html).join(' | '));

// 4. Errors with reasons, and the storefront hides the bubble.
for (const [code, needle] of [
  ['error:feed_http_403', 'HTTP 403'],
  ['error:feed_http_404', 'HTTP 404'],
  ['error:no_products', 'We found no products'],
  ['error:feed_not_readable', 'coming soon page'],
  ['error:ai_budget_exhausted', 'on our side, not yours'],
  ['error', 'We could not read your product list'],
]) {
  await mode(code);
  p = await get(SETTINGS);
  check(`error screen ${code}`, p.html.includes(needle) && p.html.includes('value="arling_asistent_retry"'));
  check(`no PHP warnings on ${code}`, phpProblems(p.html).length === 0, phpProblems(p.html).join(' | '));
}
save('04-error', p.html);
check('no plans or upgrade buttons while setup has failed', !p.html.includes('Plan and usage') && !p.html.includes('buy.stripe.com'));
let front = await get('/', { admin: false, redirect: 'follow' });
check('storefront hides the bubble while the setup is in error', !front.html.includes('arling-asistent.arling.workers.dev/widget.js'));

// 4b. Retry.
await mode('pending');
p = await get(SETTINGS);
await mode('error:feed_http_403');
p = await get(SETTINGS);
r = await post('/wp-admin/admin-post.php', {
  action: 'arling_asistent_retry',
  arling_asistent_retry_nonce: nonce(p.html, 'arling_asistent_retry_nonce'),
  _wp_http_referer: SETTINGS,
});
d = await dump();
check('retry posts to /v1/tenants again with the stored e-mail', r.status === 302 && d.calls.filter((c) => c.method === 'POST').length === 2 && d.calls.at(-1).body.includes('owner@example.com'));

// 4c. Dashboard notice for an error (the settings page or the cron stores the status).
await mode('error:feed_http_403');
await get('/?arltest_cron=1', { admin: false });
p = await get('/wp-admin/index.php');
check('dashboard error notice', p.html.includes('could not read your products'));

// 5. Ready.
await mode('ready3');
p = await get(SETTINGS);
save('05-ready', p.html);
check('ready screen', p.html.includes('Your assistant is ready.') && p.html.includes('Try it now'));
check('example question from own category', p.html.includes('What do you have in Kitchen?'));
check('example question from own product', /Tell me more about (Knife set|Frying pan 28 cm|Cast iron pot 4 l)\./.test(p.html));
check('widget loaded in admin for the preview, with tenant', /<script[^>]*data-tenant="t-test-1"[^>]*src="https:\/\/arling-asistent\.arling\.workers\.dev\/widget\.js/.test(p.html));
check('admin.js loaded', p.html.includes('arling-asistent/js/admin.js'));
check('usage line', p.html.includes('<strong>3</strong> of <strong>100</strong> conversations used this month'));
check('upgrade buttons not primary at 3 %', !/class="button button-primary" href="https:\/\/buy\.stripe\.com/.test(p.html));
check('upgrade link carries tenant id', p.html.includes('client_reference_id=t-test-1'));
check('no PHP warnings on ready', phpProblems(p.html).length === 0, phpProblems(p.html).join(' | '));
front = await get('/', { admin: false, redirect: 'follow' });
save('05-front', front.html);
check('storefront home page has the bubble (scope all)', /data-tenant="t-test-1"/.test(front.html));
check('English site: no data-answer-lang', !front.html.includes('data-answer-lang'));

// 6. Usage 85 %: primary buttons, dashboard notice, hide it.
await mode('ready85');
p = await get(SETTINGS);
check('upgrade buttons primary at 85 %', /class="button button-primary" href="https:\/\/buy\.stripe\.com/.test(p.html));
p = await get('/wp-admin/index.php');
save('06-dashboard-85', p.html);
check('dashboard usage notice at 85 %', p.html.includes('has used 85 of 100 conversations'));
const hide = (p.html.match(/href="([^"]*action=arling_asistent_dismiss[^"]*usage[^"]*)"/) || [])[1];
check('usage notice has a hide link', !!hide);
if (hide) {
  const url = hide.replace(/&#038;|&amp;/g, '&');
  r = await fetch(url.startsWith('http') ? url : B + url, { headers: { ...ADMIN, Referer: B + '/wp-admin/index.php' }, redirect: 'manual' });
  p = await get('/wp-admin/index.php');
  check('usage notice hidden after dismiss', !p.html.includes('has used 85 of 100 conversations'));
}
await mode('ready100');
await get('/?arltest_cron=1', { admin: false });
p = await get('/wp-admin/index.php');
check('100 % notice is new and shows again', p.html.includes('has used all 100 of 100 conversations'));

// 7. Starter plan: manage link, only Pro offered.
await mode('starter');
p = await get(SETTINGS);
check('starter: portal link and only Pro offered', p.html.includes('billing.stripe.com') && !p.html.includes('Upgrade to Starter') && p.html.includes('Upgrade to Pro'));

// 8. Service down and tenant gone.
await mode('down');
p = await get(SETTINGS);
check('service down: calm message', p.html.includes('Could not reach ARLing Shopping Assistant right now'));
await mode('notfound');
p = await get(SETTINGS);
check('tenant gone: reconnect hint', p.html.includes('no longer knows this connection'));
check('no PHP warnings when down/gone', phpProblems(p.html).length === 0, phpProblems(p.html).join(' | '));

// 9. Language: a French site gets data-answer-lang="auto".
await mode('ready3');
await get(SETTINGS);
await get('/?arltest_locale=fr_FR', { admin: false });
front = await get('/', { admin: false, redirect: 'follow' });
check('French site: data-lang fr and data-answer-lang auto', /data-lang="fr"[^>]*data-answer-lang="auto"|data-answer-lang="auto"[^>]*data-lang="fr"/.test(front.html), (front.html.match(/<script[^>]*data-tenant[^>]*>/) || ['no tag'])[0]);
await get('/?arltest_locale=', { admin: false });
await get('/?arltest_cron=1', { admin: false });
d = await dump();
check('cron status check stores status', d.status && d.status.status === 'ready');

// 10. Save settings, then disconnect.
p = await get(SETTINGS);
r = await post('/wp-admin/admin-post.php', {
  action: 'arling_asistent_save_settings',
  arling_asistent_save_settings_nonce: nonce(p.html, 'arling_asistent_save_settings_nonce'),
  _wp_http_referer: SETTINGS,
  arling_asistent_display_scope: 'shop',
  arling_asistent_lang: 'auto',
  arling_asistent_color: 'auto',
  arling_asistent_position: 'bottom-left',
});
d = await dump();
check('settings saved', d.scope === 'shop');
front = await get('/', { admin: false, redirect: 'follow' });
check('scope shop: no bubble on the home page', !/data-tenant="t-test-1"/.test(front.html));

p = await get(SETTINGS);
r = await post('/wp-admin/admin-post.php', {
  action: 'arling_asistent_disconnect',
  arling_asistent_disconnect_nonce: nonce(p.html, 'arling_asistent_disconnect_nonce'),
  _wp_http_referer: SETTINGS,
});
d = await dump();
check('disconnect clears tenant, status and cron', !d.tenant && !d.status && !d.cron);

// 11. Activation redirect: once, then never again.
await get('/?arltest_redirect=1', { admin: false });
r = await get('/wp-admin/index.php');
check('activation redirect goes to setup', r.status === 302 && String(r.location).includes('page=arling-asistent'), `${r.status} ${r.location}`);
r = await get('/wp-admin/index.php');
check('activation redirect happens only once', r.status === 200);

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
