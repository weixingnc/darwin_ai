/**
 * IAdapter: adapter contract (data interface).
 *
 * Concrete adapters are plain {name, version, capabilities, init, ...} objects.
 * They are validated via IAdapter.validate (duck typing) at registry time.
 *
 * v2 design (PR 12a, skeleton only): adapters are Darwin's "continuous-run"
 * carrier — they connect Darwin to external channels (feishu / slack / discord
 * / webhook) so the system can keep running and exchanging messages. This
 * file defines the SHAPE only — concrete implementations (e.g. feishu.js) come
 * in PR 12b and beyond, grown by Darwin itself via self-evolution.
 *
 * Implementation note: IAdapter is a plain object (not a class) because
 * classes have read-only `name`/`length` that we can't override cleanly.
 * Mirrors IProvider (PR 6) and IPlugin (PR 11a).
 */

export const IAdapter = {
  name: '', // sentinel: real adapter must set its own name (e.g. 'feishu')
  version: '0.0.0', // sentinel: real adapter must set semver string
  // Default capability examples; real adapters advertise e.g. 'message:in' / 'message:out' / 'webhook' / 'event'.
  capabilities: ['message:in', 'message:out', 'webhook', 'event'],
  prototype: {
    /**
     * One-time init. Subscribe to EventBus, resolve config via ConfigResolver,
     * open long-lived handles (DB, queues). Idempotent at the adapter's discretion.
     * @param {object} ctx
     * @param {import('../core/event-bus.js').EventBus} ctx.eventBus
     * @param {import('../core/config-resolver.js').ConfigResolver} ctx.config
     * @param {import('../core/container.js').Container} ctx.container
     */
    init(_ctx) {
      throw new Error('[IAdapter] init() not implemented');
    },
    /** Tear down: close handles, unsubscribe. Idempotent. */
    destroy() {
      throw new Error('[IAdapter] destroy() not implemented');
    },
    /** Begin accepting work (e.g. open webhook server, start polling). Idempotent. */
    start() {
      throw new Error('[IAdapter] start() not implemented');
    },
    /** Stop accepting work. Idempotent. */
    stop() {
      throw new Error('[IAdapter] stop() not implemented');
    },
    /**
     * Handle an inbound event from the EventBus (e.g. a message coming back
     * from the provider layer that needs to be forwarded to the channel).
     * @param {object} event
     */
    handleEvent(_event) {
      throw new Error('[IAdapter] handleEvent() not implemented');
    },
  },
  validate(adapter) {
    if (!adapter || typeof adapter !== 'object') {
      throw new TypeError('[IAdapter] validate: adapter must be object');
    }
    if (typeof adapter.name !== 'string' || adapter.name.length === 0) {
      throw new TypeError('[IAdapter] validate: adapter.name must be non-empty string');
    }
    if (typeof adapter.version !== 'string' || adapter.version.length === 0) {
      throw new TypeError('[IAdapter] validate: adapter.version must be non-empty string');
    }
    if (!Array.isArray(adapter.capabilities)) {
      throw new TypeError(
        `[IAdapter] validate: adapter.capabilities must be array (got ${typeof adapter.capabilities})`,
      );
    }
    for (const cap of adapter.capabilities) {
      if (typeof cap !== 'string') {
        throw new TypeError('[IAdapter] validate: each capability must be string');
      }
    }
    return { ok: true };
  },
};
