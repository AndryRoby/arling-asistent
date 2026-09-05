// The ?feed= handoff from Product Feed Doctor (arling.sk/feed-doctor/) into
// the demo trial form. demo/app.js is a browser IIFE that touches the DOM at
// load, so this is a static guard on its source: the parameter is read, only
// http(s) URLs are accepted, the form is brought into view, and nothing ever
// submits the form on the visitor's behalf. The behaviour itself is checked
// in headless Chrome (see ops/log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'demo', 'app.js'), 'utf8');

test('demo app.js: reads ?feed= into the trial feed URL field and scrolls to it', () => {
  assert.ok(src.includes(".get('feed')"), 'reads the feed query parameter');
  assert.ok(src.includes("getElementById('trial-feed-url')"), 'targets the trial feed URL field');
  assert.ok(src.includes('feedInput.value = prefillFeedUrl'), 'prefills the field');
  assert.ok(src.includes('scrollIntoView'), 'scrolls the field into view');
  assert.ok(/parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/.test(src), 'accepts only http(s) URLs');
});

test('demo app.js: never submits the trial form on its own', () => {
  assert.ok(!/requestSubmit\(/.test(src));
  assert.ok(!/form\.submit\(/.test(src));
  assert.ok(!/dispatchEvent\(new (Submit)?Event\('submit'/.test(src));
  assert.ok(!/submitBtn\.click\(/.test(src));
});

test('demo app.js: no em-dashes, no emoji', () => {
  assert.ok(!src.includes('\u2014'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(src));
});
