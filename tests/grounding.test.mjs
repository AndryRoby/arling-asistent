// grounding.test.mjs
// Grounding on product descriptions, canonical "I do not know" replies,
// price formatting and the Slovak/Czech slip table in chat.js.
//
// Live regression, 2026-09-05, Slovak demo shop: "Ktorý hrniec je na
// indukciu?" was answered with "do not know" although the feed said
// "vhodný na indukciu", because embed.js never stored the description in
// the Vectorize metadata and chat.js could only show the model an empty
// "description:" line. The same session produced refusals in
// Czech-flavoured Slovak ("Neznám počasie") and prose prices with one
// decimal ("89.9 EUR") next to cards saying 89.90 EUR.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSystemPrompt,
  buildUserPrompt,
  formatPriceForPrompt,
  polishAnswer,
  noMatchFallback,
  runChat,
  CHAT_MODEL_OPTIONS,
} from '../worker/src/chat.js';
import { embedAndUpsertProducts } from '../worker/src/embed.js';
import { createMockAI, createMockVectorize } from './helpers/mock-cf.mjs';

test('formatPriceForPrompt prints two decimals like the product cards, n/a when there is no price', () => {
  assert.equal(formatPriceForPrompt(89.9, 'EUR'), '89.90 EUR');
  assert.equal(formatPriceForPrompt(1299, 'CZK'), '1299.00 CZK');
  assert.equal(formatPriceForPrompt(null, 'EUR'), 'n/a');
  assert.equal(formatPriceForPrompt(12, ''), '12.00');
});

test('buildUserPrompt shows each candidate price with two decimals and its description', () => {
  const prompt = buildUserPrompt({
    question: 'Ktorý hrniec je na indukciu?',
    candidates: [{ id: 'KUC-001', title: 'Hrniec 20 cm', price: 34.9, currency: 'EUR', availability: 'in_stock', category: 'Kuchyňa', url: 'https://x/1', description: 'Sendvičové dno vhodné na indukciu.' }],
    contactEmail: 'shop@example.sk',
    lang: 'sk',
  });
  assert.match(prompt, /price: 34\.90 EUR/);
  assert.match(prompt, /description: Sendvičové dno vhodné na indukciu\./);
});

test("buildSystemPrompt: fixed languages carry the empty-answer protocol and the price rule, auto keeps the model's own refusal wording", () => {
  assert.match(buildSystemPrompt('sk'), /"neviem", nie "neznám"/);
  assert.match(buildSystemPrompt('sk'), /prázdny reťazec/);
  assert.match(buildSystemPrompt('cs'), /prázdný řetězec/);
  assert.match(buildSystemPrompt('en'), /empty string in "answer"/);
  assert.match(buildSystemPrompt('de'), /leeren String/);
  for (const lang of ['sk', 'cs', 'en', 'de', 'auto']) assert.match(buildSystemPrompt(lang), /89\.90 EUR/);
  assert.doesNotMatch(buildSystemPrompt('auto'), /empty string in "answer"/);
});

test('polishAnswer fixes known Slovak/Czech slips as whole words and gives prose prices two decimals, nothing else', () => {
  assert.equal(polishAnswer('Neznám počasie, kontaktujte nás.', 'sk'), 'Neviem počasie, kontaktujte nás.');
  assert.equal(polishAnswer('Máme niekoľko hrnecov, konkrétné dva.', 'sk'), 'Máme niekoľko hrncov, konkrétne dva.');
  assert.equal(polishAnswer('Kávovar stojí 89.9 EUR, hrniec 44,9 € a fľaša 1.5 l, 3,5 l, 20 cm.', 'sk'), 'Kávovar stojí 89.90 EUR, hrniec 44,90 € a fľaša 1.5 l, 3,5 l, 20 cm.');
  assert.equal(polishAnswer('Cena 89.90 EUR ostáva.', 'sk'), 'Cena 89.90 EUR ostáva.');
  assert.equal(polishAnswer('Neznámy výrobca.', 'sk'), 'Neznámy výrobca.'); // whole word only: "neznámy" is correct Slovak
  assert.equal(polishAnswer('Neviem, stojí 12.5 Kč.', 'cs'), 'Nevím, stojí 12.50 Kč.');
  assert.equal(polishAnswer('Neznám it, 9.5 EUR.', 'en'), 'Neznám it, 9.50 EUR.'); // no slip table for en
  assert.equal(polishAnswer('', 'sk'), '');
});

// Live regression, 2026-09-05: under lang "auto" the reply's own language
// mirrors the customer's (see SYSTEM_PROMPT_AUTO), so a fixed slip table
// cannot be chosen from the request's "auto" lang up front the way it can
// for sk/cs. polishAnswer instead runs the same detectLangFromText
// heuristic on the ANSWER text itself and applies that language's table,
// including a new slip: "спросiť" (Cyrillic "спрос" + Latin "iť", observed
// live when the model offers example questions under the meta-question
// instructions) in place of "spýtať"/"zeptat".
test('polishAnswer under lang "auto" detects the slip table from the answer\'s own language, not the (unknown) requested one', () => {
  // The answer itself carries Slovak diacritics, so its own slips are still
  // caught even though the caller only knows lang: "auto" up front.
  assert.equal(polishAnswer('Neznám, 9.5 EUR.', 'auto'), 'Neviem, 9.50 EUR.');
  assert.equal(polishAnswer('Nevím, stojí 12.5 Kč.', 'auto'), 'Nevím, stojí 12.50 Kč.'); // already correct Czech, untouched
  // An answer with no sk/cs/de-detectable diacritics (plain English) has no
  // slip table at all (same as a fixed "en"/"de" request): price formatting
  // still applies, nothing else changes.
  assert.equal(polishAnswer('We do not know, 9.5 EUR.', 'auto'), 'We do not know, 9.50 EUR.');
});

test('polishAnswer fixes the mixed-script "спросiť" slip (Cyrillic stem + Latin Slovak ending) for both a fixed sk/cs lang and "auto"', () => {
  assert.equal(polishAnswer('Môžete ma спросiť, napríklad ako vybrať kávovar.', 'sk'), 'Môžete ma spýtať, napríklad ako vybrať kávovar.');
  assert.equal(polishAnswer('Môžete ma спросiť, napríklad ako vybrať kávovar.', 'auto'), 'Môžete ma spýtať, napríklad ako vybrať kávovar.');
  assert.equal(polishAnswer('Спросiť můžete i na cenu, jsme tu denně.', 'cs'), 'Zeptat můžete i na cenu, jsme tu denně.');
});

test("runChat: an empty model answer becomes the worker's own contact message in the requested language, with no product cards", async () => {
  const vectorize = createMockVectorize();
  await vectorize.upsert([{ id: 't::p::0', values: [1, 0], metadata: { tenant: 't', productId: 'p', title: 'Hrniec', url: 'https://x/1', price: 34.9, currency: 'EUR', availability: 'in_stock', description: 'Vhodný na indukciu.' } }]);
  const ai = createMockAI({ embedDim: 2, chatResponse: JSON.stringify({ answer: '  ', products: [{ title: 'Hrniec', url: 'https://x/1' }] }) });
  const result = await runChat({ AI: ai, VECTORIZE: vectorize }, { tenant: { id: 't', contact_email: 'obchod@shop.sk' }, messages: [{ role: 'user', content: 'Aké je počasie?' }], lang: 'sk' });
  assert.equal(result.answer, noMatchFallback('sk', 'obchod@shop.sk').answer);
  assert.match(result.answer, /neviem odpovedať/);
  assert.deepEqual(result.products, []);
  assert.equal(result.meta.noAnswer, true);
  assert.equal(result.meta.candidateCount, 1);
});

test('runChat sends the low-temperature sampling options to the chat model and polishes the parsed answer', async () => {
  const vectorize = createMockVectorize();
  await vectorize.upsert([{ id: 't::p::0', values: [1, 0], metadata: { tenant: 't', productId: 'p', title: 'Hrniec', url: 'https://x/1', price: 34.9, currency: 'EUR', availability: 'in_stock' } }]);
  const ai = createMockAI({ embedDim: 2, chatResponse: JSON.stringify({ answer: 'Neznám presne, ale hrniec stojí 34.9 EUR.', products: [{ title: 'Hrniec', url: 'https://x/1' }] }) });
  const result = await runChat({ AI: ai, VECTORIZE: vectorize }, { tenant: { id: 't', contact_email: 'obchod@shop.sk' }, messages: [{ role: 'user', content: 'Koľko stojí hrniec?' }], lang: 'sk' });
  assert.equal(result.answer, 'Neviem presne, ale hrniec stojí 34.90 EUR.');
  assert.equal(result.products.length, 1);
  assert.equal(ai.calls[1].input.temperature, CHAT_MODEL_OPTIONS.temperature);
  assert.equal(ai.calls[1].input.max_tokens, CHAT_MODEL_OPTIONS.max_tokens);
  assert.equal(result.meta.noAnswer, undefined);
});

test('runChat end to end: a description ingested through embedAndUpsertProducts reaches the model prompt (induction pot regression)', async () => {
  const vectorize = createMockVectorize();
  let seenUserPrompt = '';
  const ai = createMockAI({
    embedDim: 8,
    chatResponse: (input) => {
      seenUserPrompt = input.messages[1].content;
      return JSON.stringify({ answer: 'Na indukciu je vhodný Hrniec 20 cm za 34.90 EUR.', products: [{ title: 'Hrniec 20 cm', url: 'https://x/KUC-001' }] });
    },
  });
  const env = { AI: ai, VECTORIZE: vectorize };
  await embedAndUpsertProducts(env, 't', [
    { id: 'KUC-001', title: 'Hrniec 20 cm', description: 'Sendvičové dno vhodné na indukciu, sklokeramiku aj plyn.', url: 'https://x/KUC-001', price: 34.9, currency: 'EUR', availability: 'in_stock', category: 'Kuchyňa', image: '' },
    { id: 'ZAH-001', title: 'Záhradné nožnice', description: 'Kované, na konáre do 25 mm.', url: 'https://x/ZAH-001', price: 19.9, currency: 'EUR', availability: 'in_stock', category: 'Záhrada', image: '' },
  ]);
  const result = await runChat(env, { tenant: { id: 't', contact_email: 'obchod@shop.sk' }, messages: [{ role: 'user', content: 'Ktorý hrniec je na indukciu?' }], lang: 'sk' });
  assert.match(seenUserPrompt, /description: Sendvičové dno vhodné na indukciu, sklokeramiku aj plyn\./);
  assert.match(seenUserPrompt, /price: 34\.90 EUR/);
  assert.equal(result.products[0].url, 'https://x/KUC-001');
  assert.equal(result.products[0].price, 34.9); // card data still comes from our metadata, not the model
});
