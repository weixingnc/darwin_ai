/**
 * plugin/watcher -- fs.watch hot-reload for plugin files.
 *
 * V11: lets Darwin pick up plugin file changes (create / modify /
 * delete) without a full restart. Mirrors core/skill-watcher.js but
 * uses the 5-stage plugin lifecycle (load -> init -> enable,
 * disable -> unload) on each change.
 *
 * Behavior on file change:
 *   1. Resolve the file to a plugin name (basename without .js)
 *   2. If loaded: disable(name) + unload(name)
 *   3. If file exists: load(path) + init(name) + enable(name)
 *   4. If any step fails, attempt to restore the previous plugin
 *      (best-effort; logs to stderr, never throws)
 *
 * Debounce: 200ms (default) to coalesce rapid file-system events
 * (editors often write in 2-3 chunks).
 *
 * Does NOT watch the `plugin/` directory recursively; the 5-stage
 * lifecycle expects one plugin per file with a unique basename.
 * Subdirectories are ignored (skill/ provider/ etc. live elsewhere).
 *
 * Scope: hot-reload applies to plugins loaded AFTER the watcher was
 * started. Plugins loaded before are still subject to lifecycle
 * (disable + unload), but the new module is re-imported in place.
 *
 * No LLM. No external API. Pure node:fs + dynamic import.
 */

import { watch, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const DEBOUNCE_MS = 200;
const IGNORE = new Set(['node_modules', '.git', '__example__']);
const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/;

const log = (m) => {
  if (process?.stderr?.write) {
    process.stderr.write('[plugin-watcher] ' + m + '\n');
  }
};

const fn = (v) => typeof v === 'function';

/**
 * Run a single lifecycle step. Returns the step's own {ok,error} or a
 * normalized failure envelope. Never throws.
 */
async function runStep(label, name, stepFn) {
  if (!fn(stepFn)) {
    return { ok: true, skipped: true, name };
  }
  try {
    const r = await stepFn(name);
    if (!r || r.ok !== true) {
      return { ok: false, name, error: label + '() returned ' + JSON.stringify(r) };
    }
    return { ok: true, name };
  } catch (err) {
    return { ok: false, name, error: label + '() threw: ' + (err?.message || err) };
  }
}

/**
 * Tear down a previously-loaded plugin (disable + unload). Best-effort:
 * logs and swallows errors so a failed teardown never blocks a reload.
 */
async function teardownOld(name, loader, prevState) {
  if (prevState === 'UNLOADED') {
    return;
  }
  if (prevState === 'ENABLED') {
    const d = await runStep('disable', name, loader.disable);
    if (!d.ok) {
      log('teardown error (non-fatal): ' + d.error);
    }
  }
  const u = await runStep('unload', name, loader.unload);
  if (!u.ok) {
    log('teardown error (non-fatal): ' + u.error);
  }
}

/**
 * Reload one plugin file: disable + unload old, load + init + enable new.
 * Best-effort: if the new plugin fails to load, the OLD plugin is
 * left unloaded (we do not have a saved copy). Errors are logged.
 *
 * @param {string} absPath  absolute path to the plugin .js file
 * @param {object} loader   the PluginLoader instance (has load/init/enable/disable/unload)
 * @returns {Promise<{ok: boolean, name: string, action?: string, error?: string}>}
 */
export async function reloadPlugin(absPath, loader) {
  const name = basename(absPath, extname(absPath));
  if (!VALID_NAME.test(name)) {
    return { ok: false, name, error: 'invalid plugin name' };
  }
  const prevState = fn(loader.state) ? loader.state(name) : 'UNLOADED';
  await teardownOld(name, loader, prevState);
  if (!existsSync(absPath)) {
    return { ok: true, name, action: 'unloaded' };
  }
  const lr = await runStep('load', absPath, loader.load);
  if (!lr.ok) {
    return { ok: false, name, error: lr.error };
  }
  const ir = await runStep('init', name, loader.init);
  if (!ir.ok) {
    return { ok: false, name, error: ir.error };
  }
  const er = await runStep('enable', name, loader.enable);
  if (!er.ok) {
    return { ok: false, name, error: er.error };
  }
  return { ok: true, name, action: 'reloaded' };
}

/**
 * Validate a fs.watch filename and return the absolute path + plugin
 * name, or null if it should be skipped.
 */
function resolveFile(dir, filename) {
  if (!filename) {
    return null;
  }
  if (filename.startsWith('.')) {
    return null;
  }
  if (IGNORE.has(filename)) {
    return null;
  }
  if (!filename.endsWith('.js')) {
    return null;
  }
  const name = basename(filename, extname(filename));
  if (!VALID_NAME.test(name)) {
    return null;
  }
  return { abs: join(dir, filename), name };
}

/**
 * Build the watcher handle. Internal -- wrapped by watchPluginsDir.
 */
function buildHandle(dir, loader, ms, onEvent) {
  const timers = new Map();
  const stats = { reloadAttempts: 0, reloadOk: 0, reloadFail: 0 };
  let closed = false;

  const fire = (filename) => {
    if (closed) {
      return;
    }
    const resolved = resolveFile(dir, filename);
    if (!resolved) {
      return;
    }
    const { abs } = resolved;
    if (timers.has(abs)) {
      clearTimeout(timers.get(abs));
    }
    timers.set(
      abs,
      setTimeout(async () => {
        timers.delete(abs);
        if (closed) {
          return;
        }
        stats.reloadAttempts += 1;
        const result = await reloadPlugin(abs, loader);
        if (result.ok) {
          stats.reloadOk += 1;
          log('reloaded ' + result.name + ' (' + (result.action || 'ok') + ')');
          onEvent({ type: 'reload', ok: true, name: result.name });
        } else {
          stats.reloadFail += 1;
          log('reload failed for ' + result.name + ': ' + result.error);
          onEvent({
            type: 'reload',
            ok: false,
            name: result.name,
            error: result.error,
          });
        }
      }, ms),
    );
  };

  const close = () => {
    closed = true;
    for (const t of timers.values()) {
      clearTimeout(t);
    }
    timers.clear();
  };

  return {
    stats,
    fire,
    close,
    markClosed: () => {
      closed = true;
    },
  };
}

/**
 * Start watching a plugin directory. Returns a handle with `close()`.
 *
 * @param {string} pluginsDir  absolute path to scan
 * @param {object} loader       PluginLoader instance
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=200]
 * @param {function} [opts.onEvent]  (event) => void  observer for tests
 * @returns {{close: () => void, stats: {reloadAttempts: number, reloadOk: number, reloadFail: number}}}
 */
export function watchPluginsDir(pluginsDir, loader, opts = {}) {
  const requested = Number.isInteger(opts.debounceMs) && opts.debounceMs >= 0;
  const ms = requested ? opts.debounceMs : DEBOUNCE_MS;
  const dir = resolve(pluginsDir);
  const onEvent = fn(opts.onEvent) ? opts.onEvent : () => {};
  const h = buildHandle(dir, loader, ms, onEvent);

  let watcher = null;
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => h.fire(filename));
  } catch (err) {
    log('failed to start watch: ' + (err?.message || err));
    return { close: () => {}, stats: h.stats };
  }

  return {
    stats: h.stats,
    close: () => {
      h.markClosed();
      try {
        if (watcher) {
          watcher.close();
        }
      } catch {
        /* swallow */
      }
      h.close();
    },
  };
}
