// mock-cf.mjs
// In-memory stand-ins for the Cloudflare bindings used outside D1
// (env.AI, env.VECTORIZE, env.ASISTENT_CACHE / KV), small enough to audit
// and just faithful enough to the real Workers APIs for chat.js/embed.js/
// security.js to run against unmodified.

/** Deterministic fake embedding: same text always gives the same vector, similar text gives a similar one. */
function fakeEmbedding(text, dim) {
  const vec = new Array(dim).fill(0);
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) vec[i % dim] += s.charCodeAt(i);
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * Mock Workers AI binding. `chatResponse` can be a string (used verbatim as
 * the raw model output) or a function (input, callIndex) => string|object,
 * for tests that need different answers on repeated calls.
 */
export function createMockAI({ embedDim = 8, chatResponse = '{"answer":"ok","products":[]}' } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (model === '@cf/baai/bge-m3') {
        const texts = input.text || [];
        return { data: texts.map((text) => fakeEmbedding(text, embedDim)) };
      }
      const out = typeof chatResponse === 'function' ? chatResponse(input, calls.length) : chatResponse;
      return typeof out === 'string' ? { response: out } : out;
    },
  };
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/** Mock Vectorize index: upsert/query/deleteByIds against an in-memory Map, cosine-ranked. */
export function createMockVectorize() {
  const store = new Map();
  return {
    async upsert(vectors) {
      for (const v of vectors) store.set(v.id, v);
      return { count: vectors.length };
    },
    async deleteByIds(ids) {
      ids.forEach((id) => store.delete(id));
      return { count: ids.length };
    },
    async query(vector, { topK = 8, filter = {}, returnMetadata = true } = {}) {
      const matches = Array.from(store.values())
        .filter((v) => !filter || !filter.tenant || (v.metadata && v.metadata.tenant === filter.tenant))
        .map((v) => ({ id: v.id, score: cosineSimilarity(vector, v.values), metadata: returnMetadata ? v.metadata : undefined }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches };
    },
    _store: store,
  };
}

/** Mock Workers KV namespace: get/put with expirationTtl accepted but not enforced (tests control time explicitly instead). */
export function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    _store: store,
  };
}
