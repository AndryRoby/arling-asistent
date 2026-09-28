// Asistent krok 1, pokus 2 (28. 9. 2026, druhý Claude): nálezy posudku ops/ai/kontrola/2026-09-28-asistent-krok1.md.
//   1 (W2) cenový validátor ops/oslovenia/predohrej-ukazky.py: tabulátor, nový riadok, U+2007 a celá trieda iných
//     oddeľovačov medzi číselnými časťami zastaví dávku v skutočnom main() (kód 1, nula PUT). Tabuľka je v Pythone
//     (predohrej_ceny_test.py), tu sa spúšťa len jej časť W2, aby nález mal vlastný test.
//   2 (W4) dôkazový skript ops/druhy-ucet/dokazy-34/snimky.mjs: samotest so surovými udalosťami Chrome aj Firefoxu,
//     očakávané sieťové hlásenie prejde, TypeError, odmietnutie a console.error s „widget.js“ nie.
//   3 podmienka nasadenia widgetu je v pláne aj v odovzdaní pre Fabla rovnaká a krok 1 ju nevydáva za schválenie
//     plávajúceho režimu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOREN = path.resolve(__dirname, '../../..');
const PLAN = path.join(KOREN, 'ops/asistent/PLAN-KRASA.md');
const SPRAVY = path.join(KOREN, 'ops/druhy-ucet/SPRAVY-PRE-FABLE.md');
const SNIMKY = path.join(KOREN, 'ops/druhy-ucet/dokazy-34/snimky.mjs');

test('nalez 1 (W2): sonda Astry a trieda oddelovacov cez main() zastavi celu davku, kod 1 a nula PUT (Python)', (t) => {
  if (!fs.existsSync(path.join(KOREN, 'ops/oslovenia/predohrej-ukazky.py'))) return t.skip('ops/oslovenia nie je vedľa produktu');
  const r = spawnSync('python', ['-X', 'utf8', '-B', '-m', 'unittest', '-v',
    'predohrej_ceny_test.NahratieZastavi.test_w2_pokus2_trieda_oddelovacov_v_texte',
    'predohrej_ceny_test.NahratieZastavi.test_w2_pokus2_sonda_astry_cez_main_zastavi_celu_davku',
    'predohrej_ceny_test.NahratieZastavi.test_skutocny_doplnok_prejde_a_posle_dva_put'], { cwd: __dirname, encoding: 'utf8' });
  if (r.error) return t.skip(`python sa nedá spustiť: ${r.error.code}`);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /Ran 3 tests[\s\S]*OK/);
});

test('nalez 2 (W4): samotest dokazoveho skriptu odlisi siet od vynimky, odmietnutia a console.error (Chrome aj Firefox)', (t) => {
  if (!fs.existsSync(SNIMKY)) return t.skip('ops/druhy-ucet nie je vedľa produktu');
  const r = spawnSync(process.execPath, [SNIMKY, '--samotest'], { cwd: KOREN, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /13 prípadov konzoly W4/);
  // Povolenie konzoly je štruktúra (druh, zdroj, URL, text), nie regulárny výraz nad skráteným JSON.
  const zdroj = fs.readFileSync(SNIMKY, 'utf8');
  assert.doesNotMatch(zdroj, /konzola: \[\/widget\\\.js\//, 'široké povolenie z pokusu 1 sa vrátilo');
  assert.doesNotMatch(zdroj, /JSON\.stringify\(u\.params\)\.slice\(0, 300\)/, 'klasifikácia nad skráteným textom sa vrátila');
});

const podmienka = (text) => {
  // SPRAVY-PRE-FABLE.md má CRLF, plán LF: porovnáva sa text riadku bez konca riadku.
  const m = text.match(/\*\*Podmienka nasadenia widgetu:\*\*[^\r\n]+/);
  return m && m[0];
};
const sekciaPokus2 = (text) => {
  const i = text.indexOf('## Asistent krok 1 pokus 2 na bránu');
  if (i < 0) return null;
  const j = text.indexOf('\n## ', i + 5);
  return text.slice(i, j < 0 ? undefined : j);
};

test('nalez 3: podmienka nasadenia widgetu je v plane aj v odovzdani pre Fabla doslova rovnaka', (t) => {
  if (!fs.existsSync(PLAN) || !fs.existsSync(SPRAVY)) return t.skip('ops/ nie je vedľa produktu');
  const plan = podmienka(fs.readFileSync(PLAN, 'utf8'));
  const sekcia = sekciaPokus2(fs.readFileSync(SPRAVY, 'utf8'));
  assert.ok(plan, 'v PLAN-KRASA.md chýba podmienka nasadenia');
  assert.ok(sekcia, 'v SPRAVY-PRE-FABLE.md chýba sekcia pokusu 2');
  assert.equal(podmienka(sekcia), plan);
  // Krok 1 sa nevydáva za schválenie plávajúceho režimu a nasadenie čaká na jeho kontrolu.
  assert.match(plan, /nie vizuálnu kvalitu plávajúceho widgetu na cudzích e-shopoch/);
  assert.match(plan, /po kroku 1 nenasadzujú/);
  assert.match(plan, /až po zelenej bráne kontroly plávajúceho režimu/);
  // Pokyny pre Fabla v sekcii pokusu 2 neprikazujú nasadenie po bráne kroku 1.
  const pokyny = sekcia.slice(sekcia.indexOf('### Pre Fabla'));
  assert.doesNotMatch(pokyny, /^\d+\.\s[^\n]*`wrangler deploy`(?![^\n]*(až po|NEPLATÍ))/m);
});
