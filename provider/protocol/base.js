/**
 * ProtocolBase: concrete base class for IProtocol implementations.
 *
 * v2 rules (PR 7):
 * - buildRequest / parseResponse / parseStreamChunk / buildToolCallMessage /
 *   parseToolCallDelta are public entry points.
 *   Each: emit PROVIDER_CALL_BEFORE → run override via ErrorHandler.wrapAsync
 *         → emit AFTER (ok) or ERROR (fail) → return ErrorHandler entry.
 *   NEVER throws to caller.
 * - Subclass overrides: _doBuildRequest, _doParseResponse, _doParseStreamChunk,
 *   _doBuildToolCallMessage, _doParseToolCallDelta.
 * - Concrete wire-format bodies (OpenAI / Anthropic) come in PR 8+ via
 *   self-evolution. ProtocolBase stays protocol-agnostic.
 *
 * v1 lesson: v0.25 飞书 tool-call errors were silently swallowed. v2
 * surfaces them as structured events + entries.
 *
 * Note: we don't `class ProtocolBase extends IProtocol` because IProtocol
 * is a contract object (data), not a class. ProtocolBase instances satisfy
 * the IProtocol shape via duck typing.
 */

import { randomUUID } from 'node:crypto';
import { IProtocol } from './interface.js';
import { ErrorHandler } from '../../core/error-handler.js';
import { EVENTS } from '../../core/events.js';

export class ProtocolBase {
  /** @param {{name:string, kind?:string, eventBus:import('../../core/event-bus.js').EventBus}} opts */
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[ProtocolBase] constructor: opts.eventBus is required');
    }
    this.name = opts.name;
    this.kind = typeof opts.kind === 'string' ? opts.kind : 'wire-format';
    this._bus = opts.eventBus;
  }

  buildRequest(messages, options = {}, model = '') {
    return this._wrap('buildRequest', () => this._doBuildRequest(messages, options, model));
  }
  parseResponse(rawResponse) {
    return this._wrap('parseResponse', () => this._doParseResponse(rawResponse));
  }
  parseStreamChunk(chunk) {
    return this._wrap('parseStreamChunk', () => this._doParseStreamChunk(chunk));
  }
  buildToolCallMessage(toolCall, result) {
    return this._wrap('buildToolCallMessage', () => this._doBuildToolCallMessage(toolCall, result));
  }
  parseToolCallDelta(delta) {
    return this._wrap('parseToolCallDelta', () => this._doParseToolCallDelta(delta));
  }

  /**
   * Shared event + error-handler wrapper. Never rejects.
   * @param {string} phase
   * @param {Function} fn
   */
  async _wrap(phase, fn) {
    const ctx = { protocol: this.name, kind: this.kind, traceId: randomUUID(), phase };
    this._bus.emit(EVENTS.PROVIDER_CALL_BEFORE, ctx);
    const entry = await ErrorHandler.wrapAsync(fn, ctx)();
    if (entry.ok) {
      this._bus.emit(EVENTS.PROVIDER_CALL_AFTER, {
        ...ctx,
        size: Array.isArray(entry.value) ? entry.value.length : undefined,
      });
    } else {
      this._bus.emit(EVENTS.PROVIDER_CALL_ERROR, { ...ctx, error: entry.error });
    }
    return entry;
  }

  async _doBuildRequest(_m, _o, _model) {
    throw new Error(`[ProtocolBase] ${this.name}: _doBuildRequest() not implemented`);
  }
  async _doParseResponse(_raw) {
    throw new Error(`[ProtocolBase] ${this.name}: _doParseResponse() not implemented`);
  }
  async _doParseStreamChunk(_chunk) {
    throw new Error(`[ProtocolBase] ${this.name}: _doParseStreamChunk() not implemented`);
  }
  async _doBuildToolCallMessage(_tc, _result) {
    throw new Error(`[ProtocolBase] ${this.name}: _doBuildToolCallMessage() not implemented`);
  }
  async _doParseToolCallDelta(_delta) {
    throw new Error(`[ProtocolBase] ${this.name}: _doParseToolCallDelta() not implemented`);
  }
}

// Marker: instances of ProtocolBase satisfy the IProtocol contract.
ProtocolBase.prototype[IProtocol] = true;
