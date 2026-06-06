/**
 * Container: minimal dependency-injection container.
 *
 * v2 rules (PR 4):
 * - factory is lazy (runs on first get(), not on register())
 * - duplicate name → throw; unknown get → throw with available list
 * - child containers inherit parent registrations; child override is local
 * - zero external deps (no inversify / lodash / reflect-metadata)
 *
 * v1 lesson: v1 used inversify + decorators; build broke when TS configs
 * drifted. v2 stays dependency-free so any Node 20+ host can run it.
 */

export class Container {
  constructor(options = {}) {
    this._parent = options.parent || null;
    this._registry = new Map(); // Map<name, { factory, instance }>
  }

  /** Register a factory under a name. Lazy. Throws on duplicate or invalid input. */
  register(name, factory) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('[Container] register: name must be non-empty string');
    }
    if (typeof factory !== 'function') {
      throw new TypeError(`[Container] register: factory must be function (got ${typeof factory})`);
    }
    if (this._registry.has(name)) {
      throw new Error(`[Container] register: name is already registered (existing: "${name}")`);
    }
    this._registry.set(name, { factory, instance: undefined });
    return this;
  }

  /** Resolve a registration by name. Lazy + cached. */
  get(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('[Container] get: name must be non-empty string');
    }
    const reg = this._findRegistration(name);
    if (!reg) {
      const available = this._availableNames();
      const list = available.length === 0 ? 'none' : available.join(', ');
      throw new Error(`[Container] get: "${name}" not registered (available: ${list})`);
    }
    if (reg.instance === undefined) {
      reg.instance = reg.factory();
    }
    return reg.instance;
  }

  /** Check whether a name is registered (own or inherited). */
  has(name) {
    return this._findRegistration(name) !== null;
  }

  /** Remove all own registrations. Parent untouched. */
  clear() {
    this._registry.clear();
    return this;
  }

  /** Number of visible registrations (own + inherited). */
  size() {
    return this._availableNames().length;
  }

  /** Create a child container that inherits from this one. */
  createChild() {
    return new Container({ parent: this });
  }

  // ─── private ──────────────────────────────────────

  _findRegistration(name) {
    if (this._registry.has(name)) {
      return this._registry.get(name);
    }
    if (this._parent) {
      return this._parent._findRegistration(name);
    }
    return null;
  }

  _availableNames() {
    const seen = new Set();
    const out = [];
    if (this._parent) {
      for (const key of this._parent._availableNames()) {
        if (!seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      }
    }
    for (const key of this._registry.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  }
}
