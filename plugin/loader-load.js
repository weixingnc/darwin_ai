/**
 * plugin/loader-load.js -- the `load` + `tryLoadFile` pair, extracted
 * from createPluginLoader() so the factory itself stays under the
 * max-lines-per-function=200 cap.
 *
 * V12: this module is the single source of truth for how a single
 * plugin file becomes a registered, in-state PLUGIN_LOAD event.
 * tryLoadFile wraps it for discovery (best-effort, swallows import
 * errors). load() is the public surface called by both the user
 * (loader.load) and the watcher (via the watcherLoader adapter).
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { IPlugin } from './interface.js';

const S = Object.freeze({
  UNLOADED: 'UNLOADED',
  LOADED: 'LOADED',
});

const isValidPluginShape = (p) => p && typeof p === 'object' && typeof p.name === 'string';

/**
 * Create a `load(pluginPath)` bound to a specific loader context.
 *
 * @param {object} ctx - { bus, registry, states, sandbox, sandboxActiveNames,
 *                        errEvt, run, setState, EVENTS_LOAD_OK }
 * @returns {function(string): Promise<{ok, name?, error?}>}
 */
export function createLoadFn(ctx) {
  const {
    bus,
    registry,
    states,
    sandbox,
    sandboxActiveNames,
    errEvt,
    run,
    setState,
    EVENTS_LOAD_OK,
  } = ctx;

  async function load(pluginPath) {
    if (typeof pluginPath !== 'string' || pluginPath.length === 0) {
      errEvt('load', '<unknown>', new TypeError('pluginPath required'));
      return { ok: false };
    }
    const r = await run('load', '<loading>', async () => {
      const mod = await import(pathToFileURL(resolve(pluginPath)).href);
      const p = mod.default || mod.plugin;
      if (!p || typeof p !== 'object') {
        throw new Error(`no default/plugin export: ${pluginPath}`);
      }
      IPlugin.validate(p);
      if (states.has(p.name) && states.get(p.name) !== S.UNLOADED) {
        throw new Error(`plugin "${p.name}" is already loaded`);
      }
      registry.register(p);
      setState(p.name, S.LOADED);
      // P2i: activate sandbox on first plugin load; subsequent loads are
      // safe because the sandbox only gates DENIED method calls, not
      // plugin code paths.
      if (sandbox && sandboxActiveNames.size === 0) {
        sandbox.activate();
      }
      sandboxActiveNames.add(p.name);
      bus.emit(EVENTS_LOAD_OK, { name: p.name, path: resolve(pluginPath) });
      return { name: p.name, plugin: p };
    });
    if (!r.ok) {
      errEvt('load', '<loading>', r.error);
    }
    return r;
  }

  return load;
}

/**
 * Create a `tryLoadFile(full)` for use by discover(). Wraps load()
 * with a "swallow import errors" contract and a "skip already-registered"
 * guard.
 *
 * @param {object} ctx - { registry, load }
 * @returns {function(string): Promise<{ok, name?, skipped?, error?}>}
 */
export function createTryLoadFileFn(ctx) {
  const { registry, load } = ctx;
  return async function tryLoadFile(full) {
    const mod = await import(pathToFileURL(full).href);
    const p = mod.default || mod.plugin;
    if (!isValidPluginShape(p)) {
      return { ok: false };
    }
    if (registry.has(p.name)) {
      return { ok: false, skipped: true, name: p.name };
    }
    return load(full);
  };
}
