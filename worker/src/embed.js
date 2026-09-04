/*
 * embed.js
 *
 * Turns normalised products (from feed.js) into Vectorize embeddings and
 * upserts them, namespaced per tenant. Uses Cloudflare Workers AI's
 * @cf/baai/bge-m3 model (multilingual, cheapest embedding model on Workers
 * AI, see opportunities/asistent-research.md section 3).
 *
 * A product's title+description is chunked (long descriptions split into
 * ~800 character pieces) so no single embedding call exceeds the model's
 * input window and so a long description does not drown out the title in
 * the embedding.
 *
 * Every function here takes its Workers AI / Vectorize bindings as plain
 * arguments, so tests can pass small mock objects instead of the real
 * Cloudflare runtime (see tests/embed.test.mjs).
 */

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const CHUNK_MAX_CHARS = 800;
export const EMBED_BATCH_SIZE = 50;

/** Split text into chunks of at most maxChars, breaking on the nearest preceding newline/space. */
export function chunkText(text, maxChars = CHUNK_MAX_CHARS) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
      if (breakAt > maxChars * 0.5) end = start + breakAt;
    }
    chunks.push(clean.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

/**
 * Build the embeddable chunks for one product, each carrying the metadata
 * that gets stored alongside the vector in Vectorize (used later by chat.js
 * to answer without a second database lookup).
 */
export function buildProductChunks(product) {
  const base = [product.title, product.description].filter(Boolean).join('\n\n');
  const pieces = chunkText(base);
  if (pieces.length === 0) return [];
  return pieces.map((text, index) => ({
    chunkId: `${product.id}::${index}`,
    text: index === 0 ? text : `${product.title}\n\n${text}`, // keep title context in every chunk
    metadata: {
      productId: product.id,
      title: product.title,
      url: product.url,
      price: product.price,
      currency: product.currency,
      image: product.image,
      availability: product.availability,
      category: product.category,
      chunkIndex: index,
    },
  }));
}

/** Call the embedding model for a batch of texts, returning one vector per input, in order. */
export async function embedTexts(ai, texts) {
  if (texts.length === 0) return [];
  const result = await ai.run(EMBED_MODEL, { text: texts });
  const vectors = result && result.data;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error('embedding_model_unexpected_response');
  }
  return vectors;
}

/**
 * Embed every product for a tenant and upsert into Vectorize, batched so a
 * single AI.run/Vectorize.upsert call never carries too many vectors.
 * Returns a small summary used by onboarding.js/cron.js for status reporting.
 */
export async function embedAndUpsertProducts(env, tenantId, products, { batchSize = EMBED_BATCH_SIZE } = {}) {
  const allChunks = [];
  for (const product of products) {
    for (const chunk of buildProductChunks(product)) {
      chunk.metadata.tenant = tenantId;
      allChunks.push(chunk);
    }
  }

  let upserted = 0;
  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);
    const vectors = await embedTexts(env.AI, batch.map((c) => c.text));
    const toUpsert = batch.map((chunk, idx) => ({
      id: `${tenantId}::${chunk.chunkId}`,
      values: vectors[idx],
      metadata: chunk.metadata,
    }));
    await env.VECTORIZE.upsert(toUpsert);
    upserted += toUpsert.length;
  }

  return { productCount: products.length, chunkCount: allChunks.length, upserted };
}

/** Remove every vector belonging to a tenant (used before re-ingesting on feed refresh, and on tenant deletion). */
export async function deleteTenantVectors(env, tenantId, existingChunkIds) {
  const ids = (existingChunkIds || []).map((chunkId) => `${tenantId}::${chunkId}`);
  if (ids.length === 0) return { deleted: 0 };
  await env.VECTORIZE.deleteByIds(ids);
  return { deleted: ids.length };
}
