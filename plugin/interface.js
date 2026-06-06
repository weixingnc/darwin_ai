/**
 * IPlugin: plugin contract (data interface).
 *
 * Concrete plugins are plain {name, version, capabilities, init, ...} objects.
 * They are validated via IPlugin.validate (duck typing) at registry time.
 *
 * v2 design (PR 11a, skeleton only): plugins are dynamic evolution units
 * Darwin grows over time (tools, skills, memory backends, ...). This file
 * defines the SHAPE only — no loader, no sandbox, no remote hub here
 * (those come later via self-evolution).
 *
 * Implementation note: IPlugin is a plain object (not a class) because
 * classes have read-only `name`/`length` that we can't override cleanly.
 * Mirrors the IProvider pattern from PR 6.
 */

export const IPlugin = {
  name: '', // sentinel: real plugin must set its own name
  version: '0.0.0', // sentinel: real plugin must set semver string
  capabilities: ['tool', 'skill', 'memory'],
  prototype: {
    init(_ctx) {
      throw new Error('[IPlugin] init() not implemented');
    },
    destroy() {
      throw new Error('[IPlugin] destroy() not implemented');
    },
    enable() {
      throw new Error('[IPlugin] enable() not implemented');
    },
    disable() {
      throw new Error('[IPlugin] disable() not implemented');
    },
  },
  validate(plugin) {
    if (!plugin || typeof plugin !== 'object') {
      throw new TypeError('[IPlugin] validate: plugin must be object');
    }
    if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
      throw new TypeError('[IPlugin] validate: plugin.name must be non-empty string');
    }
    if (typeof plugin.version !== 'string' || plugin.version.length === 0) {
      throw new TypeError('[IPlugin] validate: plugin.version must be non-empty string');
    }
    if (!Array.isArray(plugin.capabilities)) {
      throw new TypeError(
        `[IPlugin] validate: plugin.capabilities must be array (got ${typeof plugin.capabilities})`,
      );
    }
    for (const cap of plugin.capabilities) {
      if (typeof cap !== 'string') {
        throw new TypeError('[IPlugin] validate: each capability must be string');
      }
    }
    return { ok: true };
  },
};
