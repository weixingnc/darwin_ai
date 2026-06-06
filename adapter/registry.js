/**
 * AdapterRegistry: central registry of adapters (Darwin's channel layer).
 *
 * v2 rules (PR 12a, skeleton only):
 * - register(adapter): validates via IAdapter.validate, stores, emits ADAPTER_REGISTER
 *   → duplicate name / invalid shape: NEVER throws, emits ADAPTER_REGISTER_ERROR
 * - get(name): returns adapter or undefined; on miss NEVER throws, emits ADAPTER_GET_ERROR
 * - has(name): boolean
 * - list(): array of adapters (insertion order)
 * - unregister(name): removes + emits ADAPTER_UNREGISTER on success;
 *   on unknown name NEVER throws, emits ADAPTER_UNREGISTER_ERROR
 * - size(): count
 *
 * v1 lesson (ANTI-PATTERNS A-5): v1's adapter layer (FeishuClient etc.) had no
 * contract, and bootstrap wired channels via direct method calls. v2 keeps the
 * contract: errors are surfaced via EventBus, never thrown across module
 * boundaries. Cross-module communication = EventBus only.
 *
 * Note: this matches PluginRegistry (PR 11a) — defensive, never throws.
 * ProviderRegistry (PR 6) is the opposite (throws on duplicate) because
 * providers are statically registered at bootstrap; adapters are fed by
 * lifecycle + evolution + external code, where one bad apple must not
 * bring Darwin down.
 */

import { IAdapter } from './interface.js';
import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';

export class AdapterRegistry {
  /**
   * @param {object} opts
   * @param {import('../core/event-bus.js').EventBus} opts.eventBus - REQUIRED
   */
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[AdapterRegistry] constructor: opts.eventBus is required');
    }
    this._bus = opts.eventBus;
    this._adapters = new Map(); // name → adapter
  }

  /** Register an adapter. Validates shape first. NEVER throws. */
  register(adapter) {
    const ctx = { context: 'adapter.registry.register', name: adapter?.name };
    const result = ErrorHandler.wrap(() => {
      IAdapter.validate(adapter);
      if (this._adapters.has(adapter.name)) {
        throw new Error(`[AdapterRegistry] register: name "${adapter.name}" is already registered`);
      }
      this._adapters.set(adapter.name, adapter);
      this._bus.emit(EVENTS.ADAPTER_REGISTER, {
        name: adapter.name,
        version: adapter.version,
        capabilities: [...adapter.capabilities],
      });
      return { ok: true, name: adapter.name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.ADAPTER_REGISTER_ERROR, { ...result.error, context: ctx });
    }
    return this;
  }

  /** Get an adapter by name. Returns undefined on miss. NEVER throws. */
  get(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[AdapterRegistry] get: name must be non-empty string');
      }
      const a = this._adapters.get(name);
      if (!a) {
        throw new Error(`[AdapterRegistry] get: "${name}" not registered`);
      }
      return a;
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.ADAPTER_GET_ERROR, {
        ...result.error,
        context: { context: 'adapter.registry.get', name },
      });
      return undefined;
    }
    return result.value;
  }

  /** Check if a name is registered. */
  has(name) {
    return this._adapters.has(name);
  }

  /** List adapters in insertion order. */
  list() {
    return Array.from(this._adapters.values());
  }

  /** Number of registered adapters. */
  size() {
    return this._adapters.size;
  }

  /** Remove an adapter. NEVER throws. */
  unregister(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[AdapterRegistry] unregister: name must be non-empty string');
      }
      const a = this._adapters.get(name);
      if (!a) {
        throw new Error(`[AdapterRegistry] unregister: "${name}" not registered`);
      }
      this._adapters.delete(name);
      this._bus.emit(EVENTS.ADAPTER_UNREGISTER, {
        name,
        version: a.version,
        capabilities: [...a.capabilities],
      });
      return { ok: true, name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.ADAPTER_UNREGISTER_ERROR, {
        ...result.error,
        context: { context: 'adapter.registry.unregister', name },
      });
    }
    return this;
  }
}
