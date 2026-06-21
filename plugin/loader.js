/**
 * plugin/loader.js -- 5-stage plugin lifecycle with state machine + error isolation.
 * V12: adds startWatcher/stopWatcher integration with plugin/watcher.js.
 *
 * Stages: discover -> load -> init -> enable (warm-up), disable -> unload (cool-down).
 * States: UNLOADED -> LOADED -> INITIALIZED -> ENABLED -> DISABLED -> UNLOADED.
 *
 * The discover + load pair is extracted to plugin/loader-{discover,load}.js
 * to keep this factory under the max-lines-per-function=200 cap. The
 * helpers (stage, init/enable/disable/unload) live here because they
 * share the closure state (bus, registry, states, sandbox).
 *
 * Hard rules:
 *   - NEVER throws across module boundary (defensive, ANTI-PATTERNS A-5).
 *   - Illegal state jumps return {ok:false} + emit *_ERROR.
 *   - Per-stage success events emitted on EventBus for cross-module subscribers.
 *   - Plugins can only bus.emit/on + ConfigResolver.get (D-0 self-evolution boundary).
 */

import { createSandbox } from './sandbox.js';
import { watchPluginsDir } from './watcher.js';
import { ErrorHandler } from '../core/error-handler.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { EVENTS } from '../core/events.js';
import { createLoadFn, createTryLoadFileFn } from './loader-load.js';
import { createDiscoverFn } from './loader-discover.js';

const S = Object.freeze({
  UNLOADED: 'UNLOADED',
  LOADED: 'LOADED',
  INITIALIZED: 'INITIALIZED',
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
});

const TRANS = Object.freeze({
  init: [[S.LOADED, S.INITIALIZED], S.INITIALIZED],
  enable: [[S.INITIALIZED], S.ENABLED],
  disable: [[S.ENABLED], S.DISABLED],
  unload: [[S.LOADED, S.INITIALIZED, S.ENABLED, S.DISABLED], S.UNLOADED],
});

const E = Object.freeze({
  load: { ok: EVENTS.PLUGIN_LOAD, err: EVENTS.PLUGIN_LOAD_ERROR },
  init: { ok: EVENTS.PLUGIN_INIT, err: EVENTS.PLUGIN_INIT_ERROR },
  enable: { ok: EVENTS.PLUGIN_ENABLE, err: EVENTS.PLUGIN_ENABLE_ERROR },
  disable: { ok: EVENTS.PLUGIN_DISABLE, err: EVENTS.PLUGIN_DISABLE_ERROR },
  unload: { ok: EVENTS.PLUGIN_UNLOAD, err: EVENTS.PLUGIN_UNLOAD_ERROR },
});

export function createPluginLoader(opts = {}) {
  if (!opts || !opts.eventBus) {
    throw new TypeError('[PluginLoader] opts.eventBus is required');
  }
  if (!opts.registry) {
    throw new TypeError('[PluginLoader] opts.registry is required');
  }
  const bus = opts.eventBus;
  const registry = opts.registry;
  const config = new ConfigResolver();
  const states = new Map();
  // P2i: optional runtime sandbox -- when enableSandbox=true, activate
  // it for the duration of any loaded plugin's runtime.
  const enableSandbox = opts.enableSandbox === true;
  const sandbox = enableSandbox ? createSandbox({ pluginName: 'loader-active' }) : null;
  const sandboxActiveNames = new Set();
  // V12: watcher handle -- one per loader, opt-in via startWatcher().
  let watcherHandle = null;

  const stateOf = (n) => states.get(n) || S.UNLOADED;
  const setState = (n, s) => states.set(n, s);
  const errEvt = (op, name, err) =>
    bus.emit(E[op].err, {
      name,
      message: `[PluginLoader.${op}] ${err?.message || 'failed'}`,
      op,
      cause: err ? { message: err.message, name: err.name } : null,
      context: { context: `plugin.loader.${op}`, name },
    });
  const run = (op, name, fn) =>
    ErrorHandler.wrapAsync(fn, { context: `plugin.loader.${op}`, name })();

  // Wire load + tryLoadFile + discover via the closure context.
  const load = createLoadFn({
    bus,
    registry,
    states,
    sandbox,
    sandboxActiveNames,
    errEvt,
    run,
    setState,
    EVENTS_LOAD_OK: E.load.ok,
  });
  const tryLoadFile = createTryLoadFileFn({ registry, load });
  const discover = createDiscoverFn({ tryLoadFile });

  // Centralized state-transition stage. All 4 single-step ops go
  // through this so the state machine + event-emission contract
  // lives in exactly one place.
  async function stage(op, name, fn) {
    if (typeof name !== 'string' || !name) {
      errEvt(op, '<unknown>', new TypeError('name required'));
      return { ok: false };
    }
    const cur = stateOf(name);
    const [from, to] = TRANS[op];
    if (!from.includes(cur)) {
      errEvt(
        op,
        name,
        new Error(`illegal transition: ${cur} -> ${op} (allowed: ${from.join(',')})`),
      );
      return { ok: false };
    }
    const r = await run(op, name, async () => {
      const v = await fn();
      setState(name, to);
      bus.emit(E[op].ok, { name, prevState: cur, state: to });
      return v;
    });
    if (!r.ok) {
      errEvt(op, name, r.error);
    }
    return r;
  }

  function init(name) {
    return stage('init', name, async () => {
      const p = registry.get(name);
      if (!p || typeof p.init !== 'function') {
        throw new Error(`plugin "${name}" not registered / no init()`);
      }
      await p.init({ eventBus: bus, config: config.get(`plugin-${name}`) });
      return { name };
    });
  }

  function enable(name) {
    return stage('enable', name, async () => {
      const p = registry.get(name);
      if (p && typeof p.enable === 'function') {
        await p.enable();
      }
      return { name };
    });
  }

  function disable(name) {
    return stage('disable', name, async () => {
      const p = registry.get(name);
      if (p && typeof p.disable === 'function') {
        await p.disable();
      }
      return { name };
    });
  }

  function unload(name) {
    return stage('unload', name, async () => {
      // P2i: deactivate sandbox only after the LAST plugin is unloaded.
      if (sandbox && sandboxActiveNames.has(name)) {
        sandboxActiveNames.delete(name);
        if (sandboxActiveNames.size === 0) {
          sandbox.deactivate();
        }
      }
      const p = registry.get(name);
      if (p && typeof p.destroy === 'function') {
        try {
          await p.destroy();
        } catch (err) {
          errEvt('unload', name, err);
        }
      }
      registry.unregister(name);
      setState(name, S.UNLOADED);
      return { name };
    });
  }

  // V12: start watching a plugin directory. Idempotent.
  function startWatcher(pluginsDir, watcherOpts = {}) {
    if (watcherHandle) {
      return watcherHandle;
    }
    const watcherLoader = {
      state: (n) => stateOf(n),
      load: (p) => load(p),
      init: (n) => init(n),
      enable: (n) => enable(n),
      disable: (n) => disable(n),
      unload: (n) => unload(n),
    };
    watcherHandle = watchPluginsDir(pluginsDir, watcherLoader, watcherOpts);
    return watcherHandle;
  }

  // V12: stop the watcher. Idempotent.
  function stopWatcher() {
    if (!watcherHandle) {
      return;
    }
    try {
      watcherHandle.close();
    } catch {
      /* swallow */
    }
    watcherHandle = null;
  }

  return {
    discover,
    load,
    init,
    enable,
    disable,
    unload,
    state: stateOf,
    // V12: opt-in hot-reload integration with plugin/watcher.js.
    startWatcher,
    stopWatcher,
    _internal: { sandbox, sandboxActiveNames, enableSandbox, watcherHandle: () => watcherHandle },
  };
}
