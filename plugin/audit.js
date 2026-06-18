/**
 * audit — Darwin self-evolution audit plugin (P2c-2, 2026-06-18).
 *
 * Production plugin (NOT the P2c-1 manifest stub): subscribes to Darwin's
 * evolution events and records them in an in-memory log. P2c-2 is the
 * first non-example production plugin in `plugin/` — the "装新器官" half
 * of Darwin's self-evolution closed loop. The flow:
 *
 *   Darwin (diagnose → propose → apply) → emits evolution:* events
 *                                          ↓
 *                                  audit plugin records them
 *                                          ↓
 *                            host calls audit.getEvents() to inspect
 *
 * Manifest (P2d contract, validated by IPlugin.validate at load time):
 *   - name         'audit'             (lowercase, non-empty)
 *   - version      '0.1.0'             (semver-ish)
 *   - capabilities ['tool']            (PLUGIN_CAPABILITIES category)
 *   - permissions  ['bus:on', 'log:info']  (PLUGIN_PERMISSIONS whitelist,
 *                                           ∩ PLUGIN_DENIED = ∅)
 *
 * Lifecycle:
 *   init(ctx)   subscribe to evolution:propose:after + evolution:apply:after
 *               via ctx.eventBus; reset in-memory log; recording = true
 *   enable()    recording = true (default after init)
 *   disable()   recording = false (events keep firing but are dropped)
 *   destroy()   unsubscribe both topics, clear in-memory log
 *
 * Public API (in addition to IPlugin lifecycle):
 *   getEvents()  → Array<{topic, payload, recordedAt}> in insertion order
 */

export default {
  name: 'audit',
  version: '0.1.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'log:info'],

  init(ctx) {
    this._bus = ctx.eventBus;
    this._events = [];
    this._recording = true;
    this._handlers = {
      'evolution:propose:after': (payload) => this._record('evolution:propose:after', payload),
      'evolution:apply:after': (payload) => this._record('evolution:apply:after', payload),
    };
    for (const [topic, fn] of Object.entries(this._handlers)) {
      this._bus.on(topic, fn);
    }
  },

  enable() {
    this._recording = true;
  },

  disable() {
    this._recording = false;
  },

  destroy() {
    if (this._bus && this._handlers) {
      for (const [topic, fn] of Object.entries(this._handlers)) {
        this._bus.off(topic, fn);
      }
    }
    this._handlers = null;
    this._events = [];
    this._bus = null;
  },

  /**
   * P2c-2 (2026-06-18): return the in-memory log of evolution events
   * recorded since init(). Each entry is {topic, payload, recordedAt}:
   *   - topic       original event topic (e.g. 'evolution:propose:after')
   *   - payload     event payload as emitted on EventBus
   *   - recordedAt  ISO timestamp of when audit recorded it
   *
   * Returns a shallow copy so callers can't mutate internal state.
   * Returns [] before init() or after destroy().
   */
  getEvents() {
    return Array.isArray(this._events) ? [...this._events] : [];
  },

  // Internal: append a recorded event when _recording is true. Arrow
  // function in init() captures plugin as `this`, so this stays bound
  // even when the event handler runs after a disable()/enable() cycle.
  _record(topic, payload) {
    if (!this._recording) {
      return;
    }
    this._events.push({
      topic,
      payload,
      recordedAt: new Date().toISOString(),
    });
  },
};
