/**
 * IMemory: memory backend contract (data interface).
 *
 * Concrete backends are plain {name, version, capabilities, init, ...} objects
 * validated via IMemory.validate (duck typing) at registry time.
 *
 * v2 design (PR 13a, skeleton only): memory is Darwin's "永生" foundation —
 * persistent state that survives process restarts. The same contract will be
 * implemented by filesystem (PR 13b), sqlite, vector backends later (Darwin
 * grows them via self-evolution). This file defines the SHAPE only.
 *
 * Implementation note: IMemory is a plain object (not a class) because classes
 * have read-only `name`/`length` that we can't override cleanly. Mirrors
 * IProvider (PR 6) + IPlugin (PR 11a) + IAdapter (PR 12a).
 */

export const IMemory = {
  name: '', // sentinel: real backend must set its own name (e.g. 'filesystem')
  version: '0.0.0', // sentinel: real backend must set semver string
  // Default capabilities: 'key-value' | 'persist' | 'query' | 'list' | 'delete'
  capabilities: ['key-value', 'persist', 'query', 'list', 'delete'],
  prototype: {
    // init({eventBus, config, container}) — open handles, subscribe, resolve config
    init(_ctx) {
      throw new Error('[IMemory] init() not implemented');
    },
    // destroy() — close handles, unsubscribe. Idempotent.
    destroy() {
      throw new Error('[IMemory] destroy() not implemented');
    },
    // get(key) — read value; backends decide absent semantics (undefined / null)
    get(_key) {
      throw new Error('[IMemory] get() not implemented');
    },
    // set(key, value, ttl?) — ttl is ms; backends w/o TTL may ignore
    set(_key, _value, _ttl) {
      throw new Error('[IMemory] set() not implemented');
    },
    // delete(key) — remove; missing key is a no-op (defensive parity)
    delete(_key) {
      throw new Error('[IMemory] delete() not implemented');
    },
    // list(prefix?) — array of key strings (NOT values)
    list(_prefix) {
      throw new Error('[IMemory] list() not implemented');
    },
    // query(pattern) — regex source string; returns array of key strings
    query(_pattern) {
      throw new Error('[IMemory] query() not implemented');
    },
    // clear() — wipe all keys. Idempotent.
    clear() {
      throw new Error('[IMemory] clear() not implemented');
    },
  },
  validate(memory) {
    if (!memory || typeof memory !== 'object') {
      throw new TypeError('[IMemory] validate: memory must be object');
    }
    if (typeof memory.name !== 'string' || memory.name.length === 0) {
      throw new TypeError('[IMemory] validate: memory.name must be non-empty string');
    }
    if (typeof memory.version !== 'string' || memory.version.length === 0) {
      throw new TypeError('[IMemory] validate: memory.version must be non-empty string');
    }
    if (!Array.isArray(memory.capabilities)) {
      throw new TypeError(
        `[IMemory] validate: memory.capabilities must be array (got ${typeof memory.capabilities})`,
      );
    }
    for (const cap of memory.capabilities) {
      if (typeof cap !== 'string') {
        throw new TypeError('[IMemory] validate: each capability must be string');
      }
    }
    return { ok: true };
  },
};
