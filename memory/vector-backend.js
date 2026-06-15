/**
 * VectorBackend: in-memory vector store with cosine similarity search.
 *
 * Darwin's third memory backend (filesystem / sqlite / vector). PR-S1 stub:
 *   - In-memory Map<id, { vector: number[], metadata: object }>
 *   - No persistence (restart = empty)
 *   - Cosine similarity search (top-k)
 *   - embed() stub: deterministic 8-dim pseudo-vector from text hash
 *   - TODO(p2) wire to provider.embed() — real provider-backed embeddings
 *
 * LLM gate (ADR-009): embed() is deterministic local code; no network call.
 * Hygiene: no hard-coded paths, no real credentials. Tests use in-memory.
 */

import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';

const VECTOR_DIM = 8;

function emitErr(b, evt, ctx, err) {
  b._bus?.emit(evt, { ...err, context: { context: ctx } });
}

function safeId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  if (id.includes('\0')) {
    return null;
  }
  return id;
}

/** Deterministic 8-dim pseudo-embedding. Char-bucket + word-bag features
 *  so semantically overlapping texts (e.g. "dogs" vs "dogs bark loudly")
 *  produce similar vectors. Good enough for unit-test cosine checks. */
function fakeEmbed(text) {
  const s = (typeof text === 'string' ? text : String(text ?? '')).toLowerCase();
  const v = new Array(VECTOR_DIM).fill(0);
  // Char-bucket hash → 4 dims
  for (let i = 0; i < s.length; i++) {
    v[i % 4] += s.charCodeAt(i);
  }
  // Word-bag hash → 4 dims
  for (const w of s.split(/\s+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < w.length; i++) {
      h = (h * 31 + w.charCodeAt(i)) >>> 0;
    }
    v[4 + (h % 4)] += w.length;
  }
  // Unit-length normalize
  let mag = 0;
  for (const x of v) {
    mag += x * x;
  }
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < VECTOR_DIM; i++) {
    v[i] /= mag;
  }
  return v;
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** VectorBackend factory. Returns a fresh IMemory-shaped + vector-extension object. */
export function VectorBackend() {
  const b = {
    name: 'vector',
    version: '1.0.0',
    capabilities: ['key-value', 'vector-search', 'cosine-similarity', 'in-memory'],
    _bus: null,
    _store: new Map(), // id → { vector: number[], metadata: object }

    /** Init: just record the eventBus. No IO. */
    async init(ctx) {
      const r = await ErrorHandler.wrapAsync(
        async () => {
          if (!ctx?.eventBus) {
            throw new TypeError('[VectorBackend] init: ctx.eventBus is required');
          }
          b._bus = ctx.eventBus;
        },
        { context: 'memory.vector.init' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_GET_ERROR_MEMORY, 'memory.vector.init', r.error);
      }
    },

    /** Embed a text into a fixed-dim vector. PR-S1 stub.
     *  TODO(p2): wire to provider.embed() — replace fakeEmbed with a real call. */
    embed(text) {
      return fakeEmbed(text);
    },

    /** Store a vector by id with metadata. Replaces if id exists. */
    async store(id, vector, metadata = {}) {
      const k = safeId(id);
      if (k === null) {
        return { ok: false, error: { message: 'invalid id' } };
      }
      if (!Array.isArray(vector) || vector.length !== VECTOR_DIM) {
        return { ok: false, error: { message: `vector must be length-${VECTOR_DIM} array` } };
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          b._store.set(k, {
            vector: vector.slice(),
            metadata: { ...metadata },
            updated_at: Date.now(),
          });
          return { ok: true, id: k };
        },
        { context: 'memory.vector.store' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_SET_ERROR, 'memory.vector.store', r.error);
        return { ok: false };
      }
      return r.value;
    },

    /** Retrieve a single entry by id. Returns null on miss. */
    async retrieve(id) {
      const k = safeId(id);
      if (k === null) {
        return null;
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const e = b._store.get(k);
          if (!e) {
            return null;
          }
          return { id: k, vector: e.vector.slice(), metadata: { ...e.metadata } };
        },
        { context: 'memory.vector.retrieve' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_GET_ERROR, 'memory.vector.retrieve', r.error);
        return null;
      }
      return r.value;
    },

    /** Cosine-similarity search.
     *  @param {number[]|string} query — vector OR text (auto-embed via stub)
     *  @param {object} [opts]
     *  @param {number} [opts.topK=5] — return at most this many hits
     *  @param {number} [opts.minScore=-1] — drop results below this score
     *  @returns {Promise<Array<{id, score, metadata}>>} sorted by score desc */
    async search(query, opts = {}) {
      const topK = Number.isInteger(opts.topK) ? opts.topK : 5;
      const minScore = typeof opts.minScore === 'number' ? opts.minScore : -1;
      const qVec = typeof query === 'string' ? b.embed(query) : query;
      if (!Array.isArray(qVec) || qVec.length !== VECTOR_DIM) {
        return [];
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const out = [];
          for (const [id, entry] of b._store.entries()) {
            const score = cosineSim(qVec, entry.vector);
            if (score >= minScore) {
              out.push({ id, score, metadata: { ...entry.metadata } });
            }
          }
          out.sort((a, b2) => b2.score - a.score);
          return out.slice(0, Math.max(0, topK));
        },
        { context: 'memory.vector.search' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_GET_ERROR, 'memory.vector.search', r.error);
        return [];
      }
      return r.value;
    },

    /** Forget (delete) a vector by id. Missing key = no-op. */
    async forget(id) {
      const k = safeId(id);
      if (k === null) {
        return { ok: false, error: { message: 'invalid id' } };
      }
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const existed = b._store.delete(k);
          return { ok: true, existed };
        },
        { context: 'memory.vector.forget' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_DELETE_ERROR, 'memory.vector.forget', r.error);
        return { ok: false };
      }
      return r.value;
    },

    /** List all ids (insertion order). Optional prefix filter. */
    async list(prefix) {
      const pref = typeof prefix === 'string' ? prefix : '';
      const r = await ErrorHandler.wrapAsync(
        async () => {
          const ids = [];
          for (const id of b._store.keys()) {
            if (id.startsWith(pref)) {
              ids.push(id);
            }
          }
          return ids;
        },
        { context: 'memory.vector.list' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_LIST_ERROR, 'memory.vector.list', r.error);
        return [];
      }
      return r.value;
    },

    /** Total number of stored vectors. */
    size() {
      return b._store.size;
    },

    /** Wipe all vectors. Idempotent. */
    async clear() {
      const r = await ErrorHandler.wrapAsync(
        async () => {
          b._store.clear();
          return { ok: true };
        },
        { context: 'memory.vector.clear' },
      )();
      if (!r.ok) {
        emitErr(b, EVENTS.MEMORY_CLEAR_ERROR, 'memory.vector.clear', r.error);
        return { ok: false };
      }
      return r.value;
    },

    /** Destroy: wipe + drop bus handle. Idempotent. */
    destroy() {
      this._store.clear();
      this._bus = null;
    },

    /** IMemory self-validate (mirror SqliteBackend pattern). */
    validate() {
      return this.name === 'vector' && Array.isArray(this.capabilities);
    },

    /** Vector dimension constant (exposed for tests + provider wire-up). */
    VECTOR_DIM,
  };
  return b;
}

export const _internal = { fakeEmbed, cosineSim, VECTOR_DIM };
