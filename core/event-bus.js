/**
 * EventBus: framework-wide event bus.
 *
 * v2 design goals:
 * 1. Inter-module communication ONLY via EventBus (v1 ANTI-PATTERNS A-2)
 * 2. Event name stability — never rename existing events (v1 evolution:propose:before
 *    is a stable contract; changing it breaks all subscribers)
 * 3. Async handler error isolation — one handler's error must not break others
 * 4. Optional schema validation per event (v1 had no validation)
 * 5. waitFor() pattern for orchestration (v1 had no built-in)
 *
 * v1 lesson: SelfEvolution.js directly imported PluginManager.loadPlugin().
 * v2 rule: modules MUST communicate via events, NEVER via direct method calls.
 */

import { EventEmitter } from 'node:events';

export class EventBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(options.maxListeners || 100);
    this._schemas = new Map();
  }

  /**
   * Register an event schema. Throws on emit if payload doesn't match.
   * @param {string} event - event name (use EVENTS.* constants)
   * @param {Function} [validator] - optional (payload) => void that throws on invalid
   */
  registerSchema(event, validator) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('[EventBus] registerSchema: event must be non-empty string');
    }
    if (validator !== undefined && typeof validator !== 'function') {
      throw new TypeError('[EventBus] registerSchema: validator must be function');
    }
    this._schemas.set(event, validator || null);
  }

  /**
   * Emit an event with optional payload validation.
   * @param {string} event - event name (use EVENTS.* constants)
   * @param {*} [payload] - event payload (must satisfy registered schema)
   * @returns {boolean} true if event had listeners, false otherwise
   */
  emit(event, payload) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('[EventBus] emit: event must be non-empty string');
    }
    const validator = this._schemas.get(event);
    if (validator) {
      validator(payload);
    }
    return super.emit(event, payload);
  }

  /**
   * Subscribe to an event. Async handlers are wrapped for error isolation
   * (one handler's rejection must not break sibling handlers).
   * @param {string} event - event name
   * @param {Function} handler - sync or async function
   * @returns {this}
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('[EventBus] on: handler must be function');
    }
    if (handler.constructor.name === 'AsyncFunction') {
      const wrapped = async (payload) => {
        try {
          await handler(payload);
        } catch (err) {
          // v1 lesson: handler errors must not break the event chain
          // (v1 had a tool-throw-broke-entire-round bug; v0.25 fix)
          console.error(`[EventBus] async handler error on "${event}":`, err.message);
        }
      };
      return super.on(event, wrapped);
    }
    return super.on(event, handler);
  }

  /**
   * Wait for an event with timeout. Resolves with payload, rejects on timeout.
   * @param {string} event - event name
   * @param {number} [timeout=5000] - timeout in ms (0 = no timeout)
   * @returns {Promise<*>} payload
   */
  waitFor(event, timeout = 5000) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this.off(event, handler);
      };
      const handler = (payload) => {
        cleanup();
        resolve(payload);
      };
      this.once(event, handler);
      if (timeout > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`[EventBus] waitFor("${event}") timeout after ${timeout}ms`));
        }, timeout);
      }
    });
  }

  /**
   * Remove all listeners. Useful for tests.
   */
  clear() {
    this.removeAllListeners();
    this._schemas.clear();
  }
}
