/**
 * ProviderBase: concrete base class for IProvider implementations.
 *
 * v2 rules (PR 6):
 * - chat() / stream() / embed() / listModels() are the public entry points.
 *   Each: emit PROVIDER_CALL_BEFORE → run override via ErrorHandler.wrapAsync
 *         → emit AFTER (ok) or ERROR (fail) → return ErrorHandler entry.
 *   NEVER throws to caller.
 * - Subclass overrides: _doChat, _doStream, _doEmbed, _doListModels.
 *
 * v1 lesson: tool throws used to break the entire event round. v2 isolates
 * every error at the provider boundary.
 *
 * Note: we don't `class ProviderBase extends IProvider` because IProvider
 * is a contract object (data), not a class. ProviderBase instances satisfy
 * the IProvider shape via duck typing.
 */

import { randomUUID } from 'node:crypto';
import { IProvider } from './interface.js';
import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';

export class ProviderBase {
  /** @param {{name:string, capabilities?:string[], eventBus:import('../core/event-bus.js').EventBus}} opts */
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[ProviderBase] constructor: opts.eventBus is required');
    }
    this.name = opts.name;
    this.capabilities = Array.isArray(opts.capabilities) ? opts.capabilities : ['chat'];
    this._bus = opts.eventBus;
  }

  chat(messages, options = {}) {
    return this._wrap('chat', () => this._doChat(messages, options));
  }
  stream(messages, options = {}) {
    return this._wrap('stream', () => this._doStream(messages, options));
  }
  embed(text) {
    return this._wrap('embed', () => this._doEmbed(text));
  }
  listModels() {
    return this._wrap('listModels', () => this._doListModels());
  }

  /**
   * Shared event + error-handler wrapper. Never rejects.
   * @param {string} phase
   * @param {Function} fn
   */
  async _wrap(phase, fn) {
    const ctx = { provider: this.name, traceId: randomUUID(), phase };
    this._bus.emit(EVENTS.PROVIDER_CALL_BEFORE, ctx);
    const entry = await ErrorHandler.wrapAsync(fn, ctx)();
    if (entry.ok) {
      this._bus.emit(EVENTS.PROVIDER_CALL_AFTER, {
        ...ctx,
        usage: entry.value?.usage,
        count: entry.value?.length,
      });
    } else {
      this._bus.emit(EVENTS.PROVIDER_CALL_ERROR, { ...ctx, error: entry.error });
    }
    return entry;
  }

  async _doChat(_m, _o) {
    throw new Error(`[ProviderBase] ${this.name}: _doChat() not implemented`);
  }
  async _doStream(_m, _o) {
    throw new Error(`[ProviderBase] ${this.name}: _doStream() not implemented`);
  }
  async _doEmbed(_t) {
    throw new Error(`[ProviderBase] ${this.name}: _doEmbed() not implemented`);
  }
  async _doListModels() {
    return [];
  }
}

// Marker: instances of ProviderBase satisfy the IProvider contract.
ProviderBase.prototype[IProvider] = true;
