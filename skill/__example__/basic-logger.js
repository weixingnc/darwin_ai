/**
 * basic-logger — minimal example skill demonstrating the ISkill contract.
 *
 * - Subscribes to 'test.ping' and re-emits as 'log' event when enabled
 * - destroy() unsubscribes to keep EventBus clean
 * - 8-field ISkill contract: name / version / capabilities / init / destroy / enable / disable / validate
 *
 * Skill authors must export a default object with the 8 ISkill fields.
 */

export default {
  name: 'basic-logger',
  version: '0.1.0',
  capabilities: ['logging', 'event-listener'],

  init(ctx) {
    // ctx.eventBus is the framework EventBus (injected by loader)
    this._bus = ctx.eventBus;
    this._enabled = true; // default enabled after init (examples opt-in pattern)
    this._handler = (payload) => {
      if (this._enabled) {
        this._bus.emit('log', {
          level: 'info',
          msg: `received ping: ${payload.value}`,
          from: this.name,
        });
      }
    };
    this._bus.on('test:ping', this._handler);
  },

  enable(ctx) {
    this._enabled = true;
    if (ctx && ctx.eventBus) {
      ctx.eventBus.emit('skill:enable', { name: this.name });
    }
  },

  disable(ctx) {
    this._enabled = false;
    if (ctx && ctx.eventBus) {
      ctx.eventBus.emit('skill:disable', { name: this.name });
    }
  },

  destroy() {
    if (this._bus && this._handler) {
      this._bus.off('test.ping', this._handler);
    }
    this._handler = null;
    this._bus = null;
  },

  validate() {
    return (
      this.name === 'basic-logger' &&
      Array.isArray(this.capabilities) &&
      this.capabilities.length > 0
    );
  },
};
