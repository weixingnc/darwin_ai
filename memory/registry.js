/**
 * MemoryRegistry: central registry of memory backends (Darwin's "永生" layer).
 *
 * v2 rules (PR 13a, skeleton only):
 * - register(memory): validates via IMemory.validate, stores, emits MEMORY_REGISTER
 *   → duplicate name / invalid shape: NEVER throws, emits MEMORY_REGISTER_ERROR
 * - get(name): returns backend or undefined; on miss NEVER throws, emits MEMORY_GET_ERROR_MEMORY
 *   (note: distinct from backend-level MEMORY_GET_ERROR — registry vs backend layers)
 * - has(name): boolean
 * - list(): array of backends (insertion order)
 * - unregister(name): removes + emits MEMORY_UNREGISTER on success;
 *   on unknown name NEVER throws, emits MEMORY_UNREGISTER_ERROR
 * - size(): count
 *
 * v2 startup rule (D-0): we do NOT enforce "only one active memory backend"
 * at the registry level. Multiple backends can coexist (filesystem + sqlite
 * + vector); Darwin's self-evolution decides the single-active policy later.
 * The registry is multi-tenant by default.
 *
 * v1 lesson (ANTI-PATTERNS A-5): v1's memory layer had no contract and
 * swallowed errors silently. v2 keeps the contract: errors are surfaced
 * via EventBus, never thrown across module boundaries. Cross-module
 * communication = EventBus only.
 *
 * Style parity with PluginRegistry (PR 11a) + AdapterRegistry (PR 12a) —
 * defensive, never throws. ProviderRegistry (PR 6) is the opposite because
 * providers are statically registered at bootstrap; memory backends are
 * fed by lifecycle + evolution + external code, where one bad apple must
 * not bring Darwin down.
 */

import { IMemory } from './interface.js';
import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';

export class MemoryRegistry {
  /**
   * @param {object} opts
   * @param {import('../core/event-bus.js').EventBus} opts.eventBus - REQUIRED
   */
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[MemoryRegistry] constructor: opts.eventBus is required');
    }
    this._bus = opts.eventBus;
    this._memories = new Map(); // name → backend
  }

  /** Register a memory backend. Validates shape first. NEVER throws. */
  register(memory) {
    const ctx = { context: 'memory.registry.register', name: memory?.name };
    const result = ErrorHandler.wrap(() => {
      IMemory.validate(memory);
      if (this._memories.has(memory.name)) {
        throw new Error(`[MemoryRegistry] register: name "${memory.name}" is already registered`);
      }
      this._memories.set(memory.name, memory);
      this._bus.emit(EVENTS.MEMORY_REGISTER, {
        name: memory.name,
        version: memory.version,
        capabilities: [...memory.capabilities],
      });
      return { ok: true, name: memory.name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.MEMORY_REGISTER_ERROR, { ...result.error, context: ctx });
    }
    return this;
  }

  /** Get a memory backend by name. Returns undefined on miss. NEVER throws. */
  get(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[MemoryRegistry] get: name must be non-empty string');
      }
      const m = this._memories.get(name);
      if (!m) {
        throw new Error(`[MemoryRegistry] get: "${name}" not registered`);
      }
      return m;
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.MEMORY_GET_ERROR_MEMORY, {
        ...result.error,
        context: { context: 'memory.registry.get', name },
      });
      return undefined;
    }
    return result.value;
  }

  /** Check if a name is registered. */
  has(name) {
    return this._memories.has(name);
  }

  /** List backends in insertion order. */
  list() {
    return Array.from(this._memories.values());
  }

  /** Number of registered backends. */
  size() {
    return this._memories.size;
  }

  /** Remove a backend. NEVER throws. */
  unregister(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[MemoryRegistry] unregister: name must be non-empty string');
      }
      const m = this._memories.get(name);
      if (!m) {
        throw new Error(`[MemoryRegistry] unregister: "${name}" not registered`);
      }
      this._memories.delete(name);
      this._bus.emit(EVENTS.MEMORY_UNREGISTER, {
        name,
        version: m.version,
        capabilities: [...m.capabilities],
      });
      return { ok: true, name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.MEMORY_UNREGISTER_ERROR, {
        ...result.error,
        context: { context: 'memory.registry.unregister', name },
      });
    }
    return this;
  }
}
