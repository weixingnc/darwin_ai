/**
 * Plugin sandbox — runtime enforcement of PLUGIN_DENIED (P2e, 2026-06-18).
 *
 * P2d added the static manifest check (PLUGIN_DENIED ∩ permissions === ∅,
 * plugins declaring denied perms are rejected at load time). P2e adds the
 * runtime half: even if a plugin *doesn't* declare the permission, a
 * monkey-patched sandbox can stop it from actually invoking high-risk
 * primitives. This is the "belt + suspenders" approach to plugin safety:
 * belt = static manifest check (P2d), suspenders = runtime block (P2e).
 *
 * Design:
 *   - createSandbox({ pluginName, deny? }) returns a sandbox object with
 *     activate() / deactivate() / isActive(). Deny defaults to PLUGIN_DENIED
 *     from plugin/interface.js.
 *   - activate() monkey-patches global fs / child_process / process methods
 *     listed in SANDBOX_TARGETS. Each call to a patched method throws
 *     PluginSandboxDeniedError (not the real implementation).
 *   - deactivate() restores the originals and is idempotent — calling it
 *     twice in a row is safe (second call is a no-op).
 *   - The sandbox is process-global: at most one sandbox can be active at
 *     a time. activate() while another sandbox is active throws (so two
 *     concurrent plugin loads can't both think they own the process).
 *
 * Pitfalls (P3+): if a future Darwin internal relies on process.exit /
 * fs.writeFileSync / etc. running while plugins are loaded, the runtime
 * sandbox needs to be scoped per-plugin-call via async context, not
 * global. As of P2e, Darwin's runtime (plugin loader, event bus,
 * evolution pipeline) doesn't touch the sandboxed methods — they live in
 * bin/lib/{chat,repl}.js and scripts/size-check.js which run only at CLI
 * invocation, not while plugins are loaded.
 *
 * Scope: 'network:raw' is intentionally NOT sandboxed in P2e. It's
 * harder to monkey-patch cleanly (fetch / http / net.connect / dns),
 * and the P2d static check already blocks plugins from declaring it.
 * A future P2f can add network sandbox if Darwin ever loads untrusted
 * plugins (today plugins are PM-authored, so static checks suffice).
 */

import fs from 'node:fs';
import childProcess from 'node:child_process';
import { PLUGIN_DENIED } from './interface.js';

/**
 * Thrown when a sandboxed method is invoked while the sandbox is active.
 * Carries the plugin name, the called method, and the DENIED category it
 * violates so callers can distinguish sandbox blocks from real errors.
 */
export class PluginSandboxDeniedError extends Error {
  constructor(pluginName, method, permission) {
    super(
      `PluginSandboxDenied: plugin "${pluginName}" called "${method}" ` +
        `which is in PLUGIN_DENIED category "${permission}"`,
    );
    this.name = 'PluginSandboxDeniedError';
    this.pluginName = pluginName;
    this.method = method;
    this.permission = permission;
  }
}

/**
 * Map of (DENIED permission → list of module methods to monkey-patch).
 * Each entry is the GLOBAL method we patch on `fs` / `child_process` /
 * `process` — the sandbox checks the method name when deciding whether
 * to throw.
 */
const SANDBOX_TARGETS = [
  { perm: 'process:exit', holder: () => process, method: 'exit' },
  { perm: 'fs:delete', holder: () => fs, method: 'rmSync' },
  { perm: 'fs:delete', holder: () => fs, method: 'unlinkSync' },
  { perm: 'fs:delete', holder: () => fsPromises, method: 'rm' },
  { perm: 'fs:write', holder: () => fs, method: 'writeFileSync' },
  { perm: 'fs:write', holder: () => fsPromises, method: 'writeFile' },
  { perm: 'child_process:exec', holder: () => childProcess, method: 'execSync' },
  { perm: 'child_process:exec', holder: () => childProcess, method: 'exec' },
  { perm: 'child_process:exec', holder: () => childProcess, method: 'spawnSync' },
  { perm: 'child_process:exec', holder: () => childProcess, method: 'spawn' },
];

// Imported lazily so we don't pull fs.promises into the synchronous loader
// path before activate() is called. Storing in a lazy binding means the
// holder() callback above always sees the live fs.promises object.
let fsPromises;
function ensureFsPromises() {
  if (!fsPromises) {
    fsPromises = fs.promises;
  }
  return fsPromises;
}

// Per-method SENTINEL — installed on `holder[method]` rather than on the
// whole holder, so multiple methods on the same holder (e.g. fs.rmSync
// and fs.unlinkSync both live on the `fs` object) can be patched
// independently. We only throw "already patched" if THIS specific method
// has been patched by a previous sandbox.
function sentinelKey(method) {
  return `${method}__darwinSandboxPatched`;
}

let activeSandbox = null;

/**
 * Construct a sandbox. The sandbox is INACTIVE until activate() is called.
 * Multiple sandboxes can be constructed; only one can be active at a time
 * (process-global). activate() while another sandbox is active throws.
 */
export function createSandbox(opts = {}) {
  const pluginName = opts.pluginName || 'anonymous';
  const deny = Array.isArray(opts.deny) ? opts.deny : PLUGIN_DENIED;
  const denySet = new Set(deny);
  const patches = [];

  return {
    pluginName,

    /**
     * Install monkey-patches for every SANDBOX_TARGETS entry whose perm
     * is in deny. Throws if another sandbox is already active. Records
     * every patch so deactivate() can restore them in reverse order.
     */
    activate() {
      if (activeSandbox && activeSandbox !== this) {
        throw new Error(
          `PluginSandbox: cannot activate sandbox for "${pluginName}" — ` +
            `sandbox for "${activeSandbox.pluginName}" is already active`,
        );
      }
      if (activeSandbox === this) {
        return; // idempotent
      }

      for (const t of SANDBOX_TARGETS) {
        if (!denySet.has(t.perm)) {
          continue;
        }
        // Make sure lazy holder is bound (relevant for fs.promises entries).
        ensureFsPromises();
        const holder = t.holder();
        const key = sentinelKey(t.method);
        if (holder[key]) {
          // Some other code outside our sandbox already patched this
          // specific method. Don't stomp — restore-on-deactivate would
          // clobber the foreign patch.
          throw new Error(
            `PluginSandbox: method "${t.method}" already patched. ` +
              `Cannot activate sandbox for "${pluginName}".`,
          );
        }
        const original = holder[t.method];
        holder[key] = { original, method: t.method, perm: t.perm };
        holder[t.method] = function patched() {
          throw new PluginSandboxDeniedError(pluginName, t.method, t.perm);
        };
        patches.push({ holder, method: t.method, key });
      }
      activeSandbox = this;
    },

    /**
     * Restore every patched method to its original. Idempotent: calling
     * deactivate() twice is a no-op. Safe to call from a finally block
     * even if activate() threw halfway.
     */
    deactivate() {
      // Walk in reverse so partial restores don't get clobbered by
      // an earlier patch's restoration of a shared holder (not currently
      // a problem since each method has its own SENTINEL key, but the
      // reverse-order habit keeps things robust).
      while (patches.length > 0) {
        const { holder, method, key } = patches.pop();
        const meta = holder[key];
        if (meta && meta.method === method) {
          holder[method] = meta.original;
          delete holder[key];
        }
      }
      if (activeSandbox === this) {
        activeSandbox = null;
      }
    },

    /** True if this sandbox is currently the active one. */
    isActive() {
      return activeSandbox === this;
    },

    /** Test-only: the list of (holder, method) pairs currently patched. */
    _patches() {
      return patches.map((p) => ({ method: p.method }));
    },
  };
}

/** Test-only: returns the currently active sandbox (or null). */
export function _activeSandbox() {
  return activeSandbox;
}
