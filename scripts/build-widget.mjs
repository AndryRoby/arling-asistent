#!/usr/bin/env node
/*
 * build-widget.mjs
 *
 * widget/widget.js is the single source of truth for the embeddable chat
 * widget. It needs to reach two other places that cannot simply `import` a
 * .js file as raw text:
 *
 *   - worker/src/widget-src.js: a plain ES module exporting the widget's
 *     source as a string (`export default \`...\`;`), so the Worker (plain
 *     JavaScript ES modules, no bundler, see README) can serve it verbatim
 *     from GET /widget.js without a build step at request time.
 *   - demo/widget.js: the GitHub Pages copy used by the demo/trial page, so
 *     visitors trying the assistant on arling.sk get the exact same widget
 *     an e-shop would embed.
 *
 * Run this after every edit to widget/widget.js:
 *
 *   npm run build:widget
 *
 * Both outputs are committed like any other source file (there is no build
 * step at deploy or request time, per the project's "no build step" rule in
 * README): this script only needs to run locally when widget/widget.js
 * changes, not on every `wrangler deploy`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(rootDir, 'widget', 'widget.js');
const workerOutPath = path.join(rootDir, 'worker', 'src', 'widget-src.js');
const demoOutPath = path.join(rootDir, 'demo', 'widget.js');

const source = readFileSync(sourcePath, 'utf8');

/** Escape backslash, backtick and `${` so `source` can sit inside a template literal without breaking out of it or interpolating anything. */
function escapeForTemplateLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const header =
  '// widget-src.js\n' +
  '// GENERATED FILE: do not edit directly, it will be overwritten.\n' +
  '// Source of truth is ../../widget/widget.js. Regenerate both this file\n' +
  "// and the demo/widget.js copy with `npm run build:widget` (see\n" +
  '// scripts/build-widget.mjs) after any change to widget/widget.js.\n' +
  '//\n' +
  '// Served verbatim by GET /widget.js (see src/index.js) so e-shops can\n' +
  "// load the widget from the worker's own origin instead of needing a\n" +
  '// separate static host.\n\n';

writeFileSync(workerOutPath, header + 'export default `' + escapeForTemplateLiteral(source) + '`;\n', 'utf8');
writeFileSync(demoOutPath, source, 'utf8');

console.log(
  `build:widget: wrote ${path.relative(rootDir, workerOutPath)} and ${path.relative(rootDir, demoOutPath)} ` +
    `from ${path.relative(rootDir, sourcePath)} (${source.length} bytes)`
);
