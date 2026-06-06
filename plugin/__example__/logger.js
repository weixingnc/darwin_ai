/**
 * logger — minimal example plugin demonstrating the IPlugin contract.
 *
 * - Subscribes to PLUGIN_REGISTER and logs "plugin registered: <name>"
 *   when enabled; stops logging when disabled.
 * - destroy() unsubscribes to keep EventBus clean.
 *
 * Plugin authors must export a default object with {name, version, capabilities, ...}.
 */

export default {
  name: 'logger',
  version: '1.0.0',
  capabilities: ['tool'],

  init(ctx) {
    // ctx.eventBus is the framework EventBus (injected by loader).
    this._bus = ctx.eventBus;
    this._enabled = false;
    this._handler = (payload) => {
      if (this._enabled) {
        console.log(`plugin registered: ${payload.name}`);
      }
    };
    this._bus.on('plugin:register', this._handler);
  },

  enable() {
    this._enabled = true;
  },

  disable() {
    this._enabled = false;
  },

  destroy() {
    if (this._bus && this._handler) {
      this._bus.off('plugin:register', this._handler);
    }
    this._handler = null;
    this._bus = null;
  },
};
