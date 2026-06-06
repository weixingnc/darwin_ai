/**
 * ProviderRegistry: central registry of LLM providers.
 *
 * v2 rules (PR 6):
 * - register(provider): validates via IProvider.validate, stores, emits PROVIDER_REGISTER
 * - get(name): returns provider or throws with available list
 * - has(name): boolean
 * - list(): array of providers (insertion order)
 * - unregister(name): removes + emits PROVIDER_UNREGISTER (throws on unknown)
 * - duplicate register → throw
 *
 * v1 lesson: v1's plugin registry swallowed errors silently and let
 * duplicate names coexist. v2 is strict + event-driven.
 */

import { IProvider } from './interface.js';
import { EVENTS } from '../core/events.js';

export class ProviderRegistry {
  /**
   * @param {object} opts
   * @param {import('../core/event-bus.js').EventBus} opts.eventBus - REQUIRED
   */
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[ProviderRegistry] constructor: opts.eventBus is required');
    }
    this._bus = opts.eventBus;
    this._providers = new Map(); // name → provider
  }

  /** Register a provider. Validates shape first. Throws on duplicate. */
  register(provider) {
    IProvider.validate(provider);
    if (this._providers.has(provider.name)) {
      throw new Error(`[ProviderRegistry] register: name "${provider.name}" is already registered`);
    }
    this._providers.set(provider.name, provider);
    this._bus.emit(EVENTS.PROVIDER_REGISTER, { name: provider.name, provider });
    return this;
  }

  /** Get a provider by name. Throws with available list when not found. */
  get(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('[ProviderRegistry] get: name must be non-empty string');
    }
    const p = this._providers.get(name);
    if (!p) {
      const available = this.list().map((x) => x.name);
      const list = available.length === 0 ? 'none' : available.join(', ');
      throw new Error(`[ProviderRegistry] get: "${name}" not registered (available: ${list})`);
    }
    return p;
  }

  /** Check if a name is registered. */
  has(name) {
    return this._providers.has(name);
  }

  /** List providers in insertion order. */
  list() {
    return Array.from(this._providers.values());
  }

  /** Number of registered providers. */
  size() {
    return this._providers.size;
  }

  /** Remove a provider. Throws on unknown name. Emits PROVIDER_UNREGISTER. */
  unregister(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('[ProviderRegistry] unregister: name must be non-empty string');
    }
    const p = this._providers.get(name);
    if (!p) {
      throw new Error(`[ProviderRegistry] unregister: "${name}" not registered`);
    }
    this._providers.delete(name);
    this._bus.emit(EVENTS.PROVIDER_UNREGISTER, { name, provider: p });
    return this;
  }
}
