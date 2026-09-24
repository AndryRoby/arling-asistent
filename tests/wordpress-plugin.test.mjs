// wordpress-plugin.test.mjs
//
// Statické kontroly WordPress pluginu (v repozitári nie je PHP, takže sa
// kontroluje text zdrojov). Strážia veci, na ktorých wordpress.org alebo
// používateľ reálne narazí:
//   - verzia v hlavičke, v konštante a Stable tag v readme.txt sa zhodujú
//     (inak wordpress.org aktualizáciu neponúkne, ops/launch/wp-release.mjs
//     to kontroluje tiež),
//   - readme: krátky popis do 150 znakov, najviac 5 značiek (ďalšie adresár
//     ignoruje), záznam v changelogu aj upgrade notice pre aktuálnu verziu,
//   - žiadna dlhá ani stredná pomlčka v texte pre ľudí,
//   - každé volanie prekladu má text domain arling-asistent,
//   - adresa produktov sa skladá cez get_rest_url() (plain permalinks),
//   - uninstall.php maže každú voľbu, ktorú plugin zapisuje,
//   - plugin volá len domény, ktoré readme priznáva v "External services".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../wordpress-plugin/arling-asistent/', import.meta.url));

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const ALL = files(ROOT).filter((p) => /\.(php|js|txt)$/.test(p));
const PHP = ALL.filter((p) => p.endsWith('.php'));
const read = (p) => readFileSync(p, 'utf8');
const main = read(join(ROOT, 'arling-asistent.php'));
const readme = read(join(ROOT, 'readme.txt'));

test('version: plugin header, ARLING_ASISTENT_VERSION and readme Stable tag agree', () => {
  const header = (main.match(/^\s*\*\s*Version:\s*(\S+)/m) || [])[1];
  const constant = (main.match(/define\(\s*'ARLING_ASISTENT_VERSION',\s*'([^']+)'/) || [])[1];
  const stable = (readme.match(/^Stable tag:\s*(\S+)/m) || [])[1];
  assert.ok(header, 'Version header missing');
  assert.equal(constant, header);
  assert.equal(stable, header);
});

test('readme: changelog and upgrade notice exist for the current version', () => {
  const stable = (readme.match(/^Stable tag:\s*(\S+)/m) || [])[1];
  const changelog = readme.slice(readme.indexOf('== Changelog =='), readme.indexOf('== Upgrade Notice =='));
  const notice = readme.slice(readme.indexOf('== Upgrade Notice =='));
  assert.ok(changelog.includes(`= ${stable} =`), 'changelog entry missing');
  assert.ok(notice.includes(`= ${stable} =`), 'upgrade notice missing');
});

test('readme: short description is at most 150 characters and there are at most 5 tags', () => {
  const lines = readme.split(/\r?\n/);
  const headerEnd = lines.findIndex((l, i) => i > 0 && l.trim() === '');
  const short = lines.slice(headerEnd + 1).find((l) => l.trim() !== '');
  assert.ok(short.length <= 150, `short description is ${short.length} characters`);
  const tags = (readme.match(/^Tags:\s*(.+)$/m) || [])[1].split(',').map((t) => t.trim()).filter(Boolean);
  assert.ok(tags.length <= 5, `${tags.length} tags`);
});

test('readme: the first two sentences say chatbot, WooCommerce, free and no account', () => {
  const desc = readme.slice(readme.indexOf('== Description ==') + '== Description =='.length).trim();
  const firstTwo = desc.split(/(?<=\.)\s+/).slice(0, 2).join(' ');
  for (const word of ['AI chatbot', 'WooCommerce', 'no account', 'free']) {
    assert.ok(firstTwo.includes(word), `first two sentences lack "${word}": ${firstTwo}`);
  }
});

test('no em dash or en dash anywhere in the plugin', () => {
  for (const p of ALL) {
    const text = read(p);
    assert.ok(!/[–—]/.test(text), `dash in ${relative(ROOT, p)}`);
  }
});

/** Every gettext call's full argument text, found with a small quote-aware paren scanner. */
function gettextCalls(src) {
  const calls = [];
  const re = /\b(__|_e|_n|_x|esc_html__|esc_html_e|esc_attr__|esc_attr_e|esc_html_x|esc_attr_x)\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    calls.push({ fn: m[1], args: src.slice(m.index + m[0].length, i - 1) });
  }
  return calls;
}

test('every translation call uses the arling-asistent text domain', () => {
  let count = 0;
  for (const p of PHP) {
    for (const call of gettextCalls(read(p))) {
      count++;
      assert.match(call.args, /,\s*'arling-asistent'\s*$/, `${relative(ROOT, p)}: ${call.fn}(${call.args.slice(0, 80)}...)`);
    }
  }
  assert.ok(count > 50, `only ${count} translation calls found, scanner broken?`);
});

test('the product list URL is built with get_rest_url(), not a fixed /wp-json/ path', () => {
  const admin = read(join(ROOT, 'includes/class-arling-asistent-admin.php'));
  assert.match(admin, /get_rest_url\(\s*null,\s*'wc\/store\/v1\/products'\s*\)/);
  const code = PHP.map(read).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*|#).*$/gm, '');
  assert.ok(!code.includes("'/wp-json/"), 'a hard-coded /wp-json/ path is back in code');
});

test('uninstall.php deletes every arling_asistent_* option the plugin writes', () => {
  const uninstall = read(join(ROOT, 'uninstall.php'));
  const written = new Set();
  for (const p of PHP) {
    for (const m of read(p).matchAll(/update_option\(\s*'(arling_asistent_[a-z_]+)'/g)) written.add(m[1]);
  }
  assert.ok(written.size >= 8);
  for (const option of written) assert.ok(uninstall.includes(`'${option}'`), `uninstall.php does not delete ${option}`);
  assert.ok(uninstall.includes("wp_clear_scheduled_hook( 'arling_asistent_status_check' )"));
});

test('the plugin only links or calls hosts that the readme discloses', () => {
  const allowed = new Set(['arling.sk', 'arling-asistent.arling.workers.dev', 'buy.stripe.com', 'billing.stripe.com', 'www.gnu.org', 'example.com']);
  for (const p of ALL.filter((f) => !f.endsWith('readme.txt'))) {
    for (const m of read(p).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      assert.ok(allowed.has(m[1].toLowerCase()), `${relative(ROOT, p)} uses ${m[1]}`);
    }
  }
  for (const host of ['arling-asistent.arling.workers.dev', 'stripe.com']) assert.ok(readme.includes(host));
  assert.match(readme, /WP-Cron at most twice a day/);
});

test('the status check is scheduled on connect and removed on deactivate, disconnect and uninstall', () => {
  const admin = read(join(ROOT, 'includes/class-arling-asistent-admin.php'));
  assert.match(admin, /wp_schedule_event\([^;]*'twicedaily',\s*ARLING_ASISTENT_CRON_HOOK\s*\)/);
  assert.match(main, /register_deactivation_hook[\s\S]*?/);
  assert.match(main, /function arling_asistent_deactivate\(\)\s*\{\s*wp_clear_scheduled_hook\(\s*ARLING_ASISTENT_CRON_HOOK\s*\)/);
  assert.match(admin, /function handle_disconnect\(\)[\s\S]*?wp_clear_scheduled_hook\(\s*ARLING_ASISTENT_CRON_HOOK\s*\)/);
});

test('state-changing admin actions check a nonce and the manage_woocommerce capability', () => {
  const admin = read(join(ROOT, 'includes/class-arling-asistent-admin.php'));
  for (const action of ['connect', 'retry', 'disconnect', 'save_settings', 'refresh_status']) {
    const body = admin.slice(admin.indexOf(`function handle_${action}()`));
    assert.match(body.slice(0, 300), new RegExp(`require_capability_and_nonce\\(\\s*'arling_asistent_${action}'`), `handle_${action}`);
  }
  const dismiss = admin.slice(admin.indexOf('function handle_dismiss()'), admin.indexOf('function handle_dismiss()') + 400);
  assert.match(dismiss, /current_user_can\(\s*'manage_woocommerce'\s*\)/);
  assert.match(dismiss, /check_admin_referer\(\s*'arling_asistent_dismiss'\s*\)/);
});
