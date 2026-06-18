/**
 * logger — minimal example plugin demonstrating the IPlugin contract.
 *
 * - Subscribes to PLUGIN_REGISTER and logs "plugin registered: <name>"
 *   when enabled; stops logging when disabled.
 * - destroy() unsubscribes to keep EventBus clean.
 *
 * Plugin authors must export a default object with {name, version, capabilities, permissions, ...}.
 *
 * P2d (2026-06-18): explicit `permissions` manifest declares which Darwin
 * primitives this plugin needs. Loader validates the array ∩ PLUGIN_DENIED = ∅
 * and ⊆ PLUGIN_PERMISSIONS. logger is the minimal case: subscribe + log.
 */

export default {
  name: 'logger',
  version: '1.0.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'log:info'],

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
