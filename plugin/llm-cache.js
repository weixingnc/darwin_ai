/**
 * llm-cache — Darwin LLM response cache plugin (W6-2, 2026-06-18).
 *
 * 5th production plugin in plugin/ (after logger, audit, metrics,
 * rate-limiter). Caches LLM responses by a deterministic key
 * (messages + model hash). Avoids redundant API calls, controls
 * cost, and reduces latency for repeated prompts.
 *
 * Why a separate plugin: caching is a *cross-cutting* concern that
 * touches every provider. Putting it in one place keeps the
 * providers thin and the cache logic testable in isolation.
 *
 * Algorithm: bounded LRU (Least-Recently-Used) map with optional
 * TTL (time-to-live). When max_entries is reached, the oldest
 * entry is evicted. TTL is checked on get(): expired entries
 * return null (cache miss) and are dropped. Set always inserts
 * at the head. Get moves the entry to the head (LRU touch).
 *
 * Key construction lives in plugin/llm-cache-key.js (split at
 * W6-2 to keep this file under the 200-line convention).
 *
 * Manifest (P2d contract):
 *   - name         'llm-cache'
 *   - version      '0.1.0'           (W6-2: first real impl)
 *   - capabilities ['tool']          (PLUGIN_CAPABILITIES category)
 *   - permissions  ['bus:on', 'log:info'] (in-memory only, no
 *                                      fs:append — cache is
 *                                      ephemeral; not persisted
 *                                      across restarts. Different
 *                                      from audit's persistent
 *                                      JSONL — cache is a property
 *                                      of the current session, not
 *                                      history.)
 *
 * Public API (in addition to IPlugin lifecycle):
 *   get(key)                      → cached value | null
 *   set(key, value, { ttl_ms })   → boolean (true if inserted,
 *                                   false if rejected — e.g. size
 *                                   > max_value_bytes)
 *   delete(key)                   → boolean
 *   clear()                       → void
 *   size()                        → number (current entries)
 *   stats()                       → { size, max_entries, hits,
 *                                   misses, evictions, expirations,
 *                                   total_set, total_get }
 *   makeKey(messages, model)      → string (deterministic SHA-256
 *                                   hash of normalised messages +
 *                                   model name — delegates to
 *                                   plugin/llm-cache-key.js)
 *
 * Config (from ctx.config or defaults):
 *   max_entries       1000   (LRU cap; 0 = unlimited)
 *   default_ttl_ms    300000 (5 minutes; 0 = no expiry)
 *   max_value_bytes   1048576 (1 MiB; cache.set rejects values
 *                              larger than this to prevent
 *                              memory blow-up)
 */

import { makeKey } from './llm-cache-key.js';

const DEFAULTS = Object.freeze({
  max_entries: 1000,
  default_ttl_ms: 300_000, // 5 min
  max_value_bytes: 1_048_576, // 1 MiB
});

export default {
  name: 'llm-cache',
  version: '0.1.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'log:info'],

  init(ctx) {
    const cfg = ctx.config || {};
    this._maxEntries = Number.isInteger(cfg.max_entries) ? cfg.max_entries : DEFAULTS.max_entries;
    this._defaultTtlMs = Number.isInteger(cfg.default_ttl_ms)
      ? cfg.default_ttl_ms
      : DEFAULTS.default_ttl_ms;
    this._maxValueBytes = Number.isInteger(cfg.max_value_bytes)
      ? cfg.max_value_bytes
      : DEFAULTS.max_value_bytes;
    // LRU map (insertion-ordered). Entry shape: { value, expires_at }
    this._entries = new Map();
    this._recording = true;
    // Stats.
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
    this._expirations = 0;
    this._totalSet = 0;
    this._totalGet = 0;
  },

  enable() {
    this._recording = true;
  },

  disable() {
    this._recording = false;
  },

  destroy() {
    if (this._entries) {
      this._entries.clear();
    }
    this._recording = false;
  },

  /** Delegated to llm-cache-key.js (see that file for the algo). */
  makeKey(messages, model) {
    return makeKey(messages, model);
  },

  /**
   * Get a cached value. Returns null on miss or expiry. On hit,
   * LRU-touch (move to head). Increments hit/miss counters.
   */
  get(key) {
    if (!this._recording) {
      return null;
    }
    this._totalGet += 1;
    if (typeof key !== 'string' || key.length === 0) {
      this._misses += 1;
      return null;
    }
    const entry = this._entries.get(key);
    if (!entry) {
      this._misses += 1;
      return null;
    }
    if (entry.expires_at !== null && entry.expires_at < Date.now()) {
      this._entries.delete(key);
      this._expirations += 1;
      this._misses += 1;
      return null;
    }
    // LRU touch: delete + re-insert to move to head.
    this._entries.delete(key);
    this._entries.set(key, entry);
    this._hits += 1;
    return entry.value;
  },

  /**
   * Set a cached value. Returns true if inserted, false if rejected
   * (e.g. value too large or invalid key). ttl_ms overrides the
   * plugin default; pass 0 (or omit) to use default; pass null
   * explicitly for "no expiry".
   */
  set(key, value, opts = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      return false;
    }
    if (!this._recording) {
      return false;
    }
    let serialised;
    try {
      serialised = JSON.stringify(value);
    } catch {
      return false;
    }
    if (serialised.length > this._maxValueBytes) {
      return false;
    }
    const ttlMs = opts.ttl_ms === undefined ? this._defaultTtlMs : opts.ttl_ms;
    const expires_at = ttlMs > 0 ? Date.now() + ttlMs : null;
    if (this._entries.has(key)) {
      this._entries.delete(key);
    } else if (this._maxEntries > 0 && this._entries.size >= this._maxEntries) {
      const oldest = this._entries.keys().next().value;
      if (oldest !== undefined) {
        this._entries.delete(oldest);
        this._evictions += 1;
      }
    }
    this._entries.set(key, { value, expires_at });
    this._totalSet += 1;
    return true;
  },

  delete(key) {
    return this._entries.delete(key);
  },

  clear() {
    this._entries.clear();
  },

  size() {
    return this._entries.size;
  },

  stats() {
    return {
      size: this._entries.size,
      max_entries: this._maxEntries,
      default_ttl_ms: this._defaultTtlMs,
      max_value_bytes: this._maxValueBytes,
      hits: this._hits,
      misses: this._misses,
      hit_rate: this._hits + this._misses > 0 ? this._hits / (this._hits + this._misses) : 0,
      evictions: this._evictions,
      expirations: this._expirations,
      total_set: this._totalSet,
      total_get: this._totalGet,
    };
  },
};
