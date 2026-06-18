/**
 * PluginRegistry: central registry of plugins (Darwin self-evolution units).
 *
 * v2 rules (PR 11a, skeleton only):
 * - register(plugin): validates via IPlugin.validate, stores, emits PLUGIN_REGISTER
 *   → duplicate name / invalid shape: NEVER throws, emits PLUGIN_REGISTER_ERROR
 * - get(name): returns plugin or undefined; on miss NEVER throws, emits PLUGIN_GET_ERROR
 * - has(name): boolean
 * - list(): array of plugins (insertion order)
 * - unregister(name): removes + emits PLUGIN_UNREGISTER on success;
 *   on unknown name NEVER throws, emits PLUGIN_UNREGISTER_ERROR
 * - size(): count
 *
 * v1 lesson (ANTI-PATTERNS A-5): v1's plugin registry silently swallowed
 * errors. v2 keeps the contract: errors are surfaced via EventBus, never
 * thrown across module boundaries. Cross-module communication = EventBus only.
 *
 * Note: this differs from ProviderRegistry (PR 6), which throws on
 * duplicate. Plugin is defensive: loaders, evolution, and external code
 * feed plugins in; a single bad apple must not bring down Darwin.
 */

import { IPlugin } from './interface.js';
import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';

export class PluginRegistry {
  /**
   * @param {object} opts
   * @param {import('../core/event-bus.js').EventBus} opts.eventBus - REQUIRED
   */
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[PluginRegistry] constructor: opts.eventBus is required');
    }
    this._bus = opts.eventBus;
    this._plugins = new Map(); // name → plugin
  }

  /** Register a plugin. Validates shape first. NEVER throws. */
  register(plugin) {
    const ctx = { context: 'plugin.registry.register', name: plugin?.name };
    const result = ErrorHandler.wrap(() => {
      IPlugin.validate(plugin);
      if (this._plugins.has(plugin.name)) {
        throw new Error(`[PluginRegistry] register: name "${plugin.name}" is already registered`);
      }
      this._plugins.set(plugin.name, plugin);
      this._bus.emit(EVENTS.PLUGIN_REGISTER, {
        name: plugin.name,
        version: plugin.version,
        capabilities: [...plugin.capabilities],
      });
      return { ok: true, name: plugin.name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.PLUGIN_REGISTER_ERROR, { ...result.error, context: ctx });
    }
    return this;
  }

  /** Get a plugin by name. Returns undefined on miss. NEVER throws. */
  get(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[PluginRegistry] get: name must be non-empty string');
      }
      const p = this._plugins.get(name);
      if (!p) {
        throw new Error(`[PluginRegistry] get: "${name}" not registered`);
      }
      return p;
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.PLUGIN_GET_ERROR, {
        ...result.error,
        context: { context: 'plugin.registry.get', name },
      });
      return undefined;
    }
    return result.value;
  }

  /** Check if a name is registered. */
  has(name) {
    return this._plugins.has(name);
  }

  /** List plugins in insertion order. */
  list() {
    return Array.from(this._plugins.values());
  }

  /** Number of registered plugins. */
  size() {
    return this._plugins.size;
  }

  /**
   * P2d (2026-06-18): check if a registered plugin holds a given permission.
   * Used by introspective callers (e.g. diagnose, audit) and by P2d-2
   * sandbox to verify a plugin's declared permissions before any runtime
   * primitive is actually invoked. Returns false on unknown plugin.
   * @param {string} name
   * @param {string} perm
   * @returns {boolean}
   */
  hasPermission(name, perm) {
    const p = this._plugins.get(name);
    if (!p) {
      return false;
    }
    const perms = Array.isArray(p.permissions) ? p.permissions : [];
    return perms.includes(perm);
  }

  /** Remove a plugin. NEVER throws. */
  unregister(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[PluginRegistry] unregister: name must be non-empty string');
      }
      const p = this._plugins.get(name);
      if (!p) {
        throw new Error(`[PluginRegistry] unregister: "${name}" not registered`);
      }
      this._plugins.delete(name);
      this._bus.emit(EVENTS.PLUGIN_UNREGISTER, {
        name,
        version: p.version,
        capabilities: [...p.capabilities],
      });
      return { ok: true, name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.PLUGIN_UNREGISTER_ERROR, {
        ...result.error,
        context: { context: 'plugin.registry.unregister', name },
      });
    }
    return this;
  }
}
