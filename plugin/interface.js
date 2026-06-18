/**
 * IPlugin: plugin contract (data interface).
 *
 * Concrete plugins are plain {name, version, capabilities, permissions, ...} objects.
 * They are validated via IPlugin.validate (duck typing) at registry time.
 *
 * v2 design (PR 11a, skeleton only): plugins are dynamic evolution units
 * Darwin grows over time (tools, skills, memory backends, ...). This file
 * defines the SHAPE only — no loader, no sandbox, no remote hub here
 * (those come later via self-evolution).
 *
 * P2d (2026-06-18) plugin security manifest:
 * - `capabilities` = category (what KIND of plugin, e.g. 'tool', 'skill', 'memory').
 *   Darwin uses this for classification / introspection (mirrors IProvider pattern).
 *   Whitelist enforced: must be a subset of PLUGIN_CAPABILITIES.
 * - `permissions` = fine-grained actions the plugin will take at runtime
 *   (e.g. 'bus:on', 'bus:emit', 'config:get', 'log:info'). Loader validates
 *   permissions ∈ PLUGIN_PERMISSIONS, rejects anything ∩ PLUGIN_DENIED.
 *   Optional for backward compat; if present, must be non-empty and valid.
 * - PLUGIN_DENIED is the explicit blocklist: a plugin declaring 'process:exit',
 *   'fs:delete', 'fs:write', 'child_process:exec', or 'network:raw' is rejected
 *   at load time (loader wraps via ErrorHandler → PLUGIN_LOAD_ERROR event).
 *   These are the high-risk primitives a Darwin self-evolution unit should
 *   never hold by default.
 *
 * Implementation note: IPlugin is a plain object (not a class) because
 * classes have read-only `name`/`length` that we can't override cleanly.
 * Mirrors the IProvider pattern from PR 6.
 */

// P2d (2026-06-18): whitelist of category capabilities a plugin can self-declare.
// Mirrors IProvider.capabilities pattern (e.g. 'chat', 'embed'). Used by Darwin
// for introspection (diagnose) and plugin classification, NOT for runtime gating.
export const PLUGIN_CAPABILITIES = Object.freeze(['tool', 'skill', 'memory', 'hook', 'listener']);

// P2d (2026-06-18): whitelist of fine-grained runtime permissions.
// A plugin's `permissions` field must be a subset of this list.
// Runtime enforcement: P2d-2 (sandbox + monkey-patch) — not in this PR.
export const PLUGIN_PERMISSIONS = Object.freeze([
  'bus:on', // EventBus.on — subscribe to events
  'bus:off', // EventBus.off — unsubscribe
  'bus:emit', // EventBus.emit — publish events
  'config:get', // ConfigResolver.get — read config
  'log:info', // console.log
  'log:warn', // console.warn
  'log:error', // console.error
  // P2j (2026-06-18): append-only file write. Distinct from fs:write
  // (which is in PLUGIN_DENIED) because `fs:append` cannot overwrite,
  // truncate, or delete — only fs.appendFileSync. Audit-style plugins
  // (e.g. plugin/audit.js) use it to persist evolution events to
  // <baseDir>/audit.jsonl. Granted narrowly so the static manifest
  // check accepts audit; runtime sandbox (P2e) still gates any actual
  // fs.writeFile / fs.appendFile call if enableSandbox=true.
  'fs:append',
]);

// P2d (2026-06-18): explicit blocklist. If a plugin's permissions intersect
// this set, loader.load() rejects the plugin outright (ErrorHandler wrap →
// PLUGIN_LOAD_ERROR event). These are the high-risk primitives a Darwin
// self-evolution unit should never hold by default.
export const PLUGIN_DENIED = Object.freeze([
  'process:exit', // process.exit — would kill Darwin
  'fs:delete', // fs.rm / unlink — would destroy audit log etc.
  'fs:write', // fs.writeFile — would mutate Darwin state outside plugin scope
  'child_process:exec', // child_process — arbitrary shell
  'network:raw', // raw fetch — bypass Darwin's provider abstraction
]);

export const IPlugin = {
  name: '', // sentinel: real plugin must set its own name
  version: '0.0.0', // sentinel: real plugin must set semver string
  capabilities: ['tool', 'skill', 'memory'],
  permissions: ['bus:on', 'log:info'], // sentinel: minimal demo set
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
  /**
   * Validate a plugin's manifest. Throws on the first violation.
   * - Required: name, version, capabilities (array of known category strings)
   * - Optional: permissions (array of fine-grained actions, checked against
   *   PLUGIN_PERMISSIONS whitelist; PLUGIN_DENIED is hard blocklist)
   *
   * Deny-by-default ordering: PLUGIN_DENIED is checked first so high-risk
   * primitives always surface the "denied values" error, even if a future
   * version accidentally adds a denied value to PLUGIN_PERMISSIONS.
   */
  validate(plugin) {
    IPlugin._requirePluginObject(plugin);
    IPlugin._requireNonEmptyString(plugin, 'name');
    IPlugin._requireNonEmptyString(plugin, 'version');
    IPlugin._validateCapabilities(plugin);
    IPlugin._validatePermissions(plugin);
    return { ok: true };
  },
  _requirePluginObject(plugin) {
    if (!plugin || typeof plugin !== 'object') {
      throw new TypeError('[IPlugin] validate: plugin must be object');
    }
  },
  _requireNonEmptyString(plugin, key) {
    if (typeof plugin[key] !== 'string' || plugin[key].length === 0) {
      throw new TypeError(`[IPlugin] validate: plugin.${key} must be non-empty string`);
    }
  },
  _validateCapabilities(plugin) {
    if (!Array.isArray(plugin.capabilities)) {
      throw new TypeError(
        `[IPlugin] validate: plugin.capabilities must be array (got ${typeof plugin.capabilities})`,
      );
    }
    for (const cap of plugin.capabilities) {
      if (typeof cap !== 'string') {
        throw new TypeError('[IPlugin] validate: each capability must be string');
      }
      if (!PLUGIN_CAPABILITIES.includes(cap)) {
        throw new TypeError(
          `[IPlugin] validate: capability "${cap}" not in PLUGIN_CAPABILITIES ` +
            `(allowed: ${PLUGIN_CAPABILITIES.join(', ')})`,
        );
      }
    }
  },
  _validatePermissions(plugin) {
    if (plugin.permissions === undefined) {
      return;
    }
    if (!Array.isArray(plugin.permissions)) {
      throw new TypeError(
        `[IPlugin] validate: plugin.permissions must be array (got ${typeof plugin.permissions})`,
      );
    }
    // P2d: PLUGIN_DENIED is hard blocklist (deny-by-default). Check first so
    // high-risk primitives always surface the "denied values" error message.
    const blocked = plugin.permissions.filter((p) => PLUGIN_DENIED.includes(p));
    if (blocked.length > 0) {
      throw new Error(
        `[IPlugin] validate: permissions contain denied values: ${blocked.join(', ')}. ` +
          `PLUGIN_DENIED is hard blocklist for Darwin self-evolution units.`,
      );
    }
    // Then PLUGIN_PERMISSIONS whitelist
    for (const perm of plugin.permissions) {
      if (typeof perm !== 'string') {
        throw new TypeError('[IPlugin] validate: each permission must be string');
      }
      if (!PLUGIN_PERMISSIONS.includes(perm)) {
        throw new TypeError(
          `[IPlugin] validate: permission "${perm}" not in PLUGIN_PERMISSIONS ` +
            `(allowed: ${PLUGIN_PERMISSIONS.join(', ')})`,
        );
      }
    }
  },
};
