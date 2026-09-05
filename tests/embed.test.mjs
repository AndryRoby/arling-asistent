// embed.test.mjs
// Chunking and the embed + Vectorize upsert pipeline, against the mock
// Workers AI / Vectorize bindings in tests/helpers/mock-cf.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkText, buildProductChunks, embedTexts, embedAndUpsertProducts, EMBED_MODEL, CHUNK_MAX_CHARS } from '../worker/src/embed.js';
import { createMockAI, createMockVectorize } from './helpers/mock-cf.mjs';

test('chunkText returns a single chunk for short text', () => {
  assert.deepEqual(chunkText('hello world'), ['hello world']);
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   '), []);
});

test('chunkText splits long text into pieces at or under the max size', () => {
  const long = 'word '.repeat(400); // ~2000 chars
  const chunks = chunkText(long, CHUNK_MAX_CHARS);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= CHUNK_MAX_CHARS);
  // Every original word survives across the chunks, none silently dropped.
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim().split(' ').length, 400);
});

test('buildProductChunks combines title and description and attaches metadata', () => {
  const product = { id: 'p1', title: 'Modre tenisky', description: 'Pohodlne behanie na kazdy den.', url: 'https://x/p1', price: 59.9, currency: 'EUR', image: 'https://x/p1.jpg', availability: 'in_stock', category: 'Obuv' };
  const chunks = buildProductChunks(product);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Modre tenisky/);
  assert.match(chunks[0].text, /Pohodlne behanie/);
  assert.equal(chunks[0].metadata.productId, 'p1');
  assert.equal(chunks[0].metadata.url, 'https://x/p1');
  assert.equal(chunks[0].metadata.price, 59.9);
  // The description is metadata too: chat.js can only show the model what
  // Vectorize returns, and that is never the embedded text itself.
  assert.equal(chunks[0].metadata.description, 'Pohodlne behanie na kazdy den.');
  assert.equal(buildProductChunks({ id: 'p3', title: 'Bez popisu', url: 'https://x/p3' })[0].metadata.description, '');
});

test('buildProductChunks keeps the title present in every chunk for a long description', () => {
  const product = { id: 'p2', title: 'Kabat Zimny', description: 'x '.repeat(500), url: 'https://x/p2' };
  const chunks = buildProductChunks(product);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.match(c.text, /Kabat Zimny/);
});

test('buildProductChunks returns nothing for an empty product', () => {
  assert.deepEqual(buildProductChunks({ id: 'e', title: '', description: '' }), []);
});

test('embedTexts calls the AI binding with the bge-m3 model and returns one vector per text', async () => {
  const ai = createMockAI({ embedDim: 4 });
  const vectors = await embedTexts(ai, ['a', 'b', 'c']);
  assert.equal(vectors.length, 3);
  assert.equal(vectors[0].length, 4);
  assert.equal(ai.calls[0].model, EMBED_MODEL);
  assert.deepEqual(ai.calls[0].input.text, ['a', 'b', 'c']);
});

test('embedTexts returns [] without calling the model for an empty batch', async () => {
  const ai = createMockAI();
  const vectors = await embedTexts(ai, []);
  assert.deepEqual(vectors, []);
  assert.equal(ai.calls.length, 0);
});

test('embedTexts throws if the model response does not match the input length', async () => {
  const badAi = { async run() { return { data: [[1, 2]] }; } };
  await assert.rejects(() => embedTexts(badAi, ['a', 'b']), /embedding_model_unexpected_response/);
});

test('embedAndUpsertProducts embeds every chunk, tags it with the tenant, and upserts to Vectorize', async () => {
  const env = { AI: createMockAI({ embedDim: 4 }), VECTORIZE: createMockVectorize() };
  const products = [
    { id: 'p1', title: 'Tenisky', description: 'Bezecke tenisky.', url: 'https://x/p1', price: 10, currency: 'EUR', availability: 'in_stock', category: 'Obuv', image: '' },
    { id: 'p2', title: 'Sandale', description: 'Letne sandale.', url: 'https://x/p2', price: 20, currency: 'EUR', availability: 'in_stock', category: 'Obuv', image: '' },
  ];
  const summary = await embedAndUpsertProducts(env, 'tenant-a', products, { batchSize: 1 });
  assert.equal(summary.productCount, 2);
  assert.equal(summary.chunkCount, 2);
  assert.equal(summary.upserted, 2);
  assert.equal(env.VECTORIZE._store.size, 2);

  const stored = env.VECTORIZE._store.get('tenant-a::p1::0');
  assert.ok(stored);
  assert.equal(stored.metadata.tenant, 'tenant-a');
  assert.equal(stored.metadata.productId, 'p1');
  assert.equal(stored.metadata.description, 'Bezecke tenisky.');
});

test('embedAndUpsertProducts keeps tenants isolated in Vectorize metadata', async () => {
  const vectorize = createMockVectorize();
  const envA = { AI: createMockAI({ embedDim: 4 }), VECTORIZE: vectorize };
  const envB = { AI: createMockAI({ embedDim: 4 }), VECTORIZE: vectorize };
  await embedAndUpsertProducts(envA, 'tenant-a', [{ id: 'x', title: 'A product', description: 'desc' }]);
  await embedAndUpsertProducts(envB, 'tenant-b', [{ id: 'x', title: 'B product', description: 'desc' }]);
  assert.equal(vectorize._store.get('tenant-a::x::0').metadata.tenant, 'tenant-a');
  assert.equal(vectorize._store.get('tenant-b::x::0').metadata.tenant, 'tenant-b');
  assert.equal(vectorize._store.size, 2);
});
