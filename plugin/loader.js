/**
 * PluginLoader — 5-stage plugin lifecycle with state machine + error isolation.
 *
 * Stages: discover → load → init → enable (warm-up), disable → unload (cool-down).
 * States: UNLOADED → LOADED → INITIALIZED → ENABLED → DISABLED → UNLOADED.
 *
 * Hard rules:
 *   - NEVER throws across module boundary (defensive, ANTI-PATTERNS A-5).
 *   - Illegal state jumps return {ok:false} + emit *_ERROR.
 *   - Per-stage success events emitted on EventBus for cross-module subscribers.
 *   - Plugins can only bus.emit/on + ConfigResolver.get (D-0 self-evolution boundary).
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPlugin } from './interface.js';
import { createSandbox } from './sandbox.js';
import { ErrorHandler } from '../core/error-handler.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { EVENTS } from '../core/events.js';

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
  // P2i (2026-06-18): optional runtime sandbox — when enableSandbox=true,
  // activate the sandbox for the duration of any loaded plugin's runtime
  // (between load() and unload()). Darwin's own runtime (self-evolve,
  // apply.js, propose.js) doesn't load plugins, so this is safe — but
  // bin/lib/plugin.js does NOT pass enableSandbox because it's CLI scope
  // and a plugin add is a one-shot process where sandbox overhead is wasted.
  const enableSandbox = opts.enableSandbox === true;
  const sandbox = enableSandbox ? createSandbox({ pluginName: 'loader-active' }) : null;
  const sandboxActiveNames = new Set();

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

  async function discover(dirPath) {
    const root = resolve(dirPath);
    let entries;
    try {
      if (!(await stat(root)).isDirectory()) {
        return [];
      }
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      const full = join(root, e.name);
      if (e.isDirectory()) {
        // Recurse one level (skip node_modules / dotfiles).
        if (e.name === 'node_modules' || e.name.startsWith('.')) {
          continue;
        }
        const sub = await discover(full);
        for (const item of sub) {
          out.push(item);
        }
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.js')) {
        continue;
      }
      try {
        const mod = await import(pathToFileURL(full).href);
        const p = mod.default || mod.plugin;
        if (!p || typeof p !== 'object' || typeof p.name !== 'string') {
          continue;
        }
        out.push({ name: p.name, path: full, plugin: p });
      } catch {
        /* skip unloadable file */
      }
    }
    return out;
  }

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
      // P2i: sandbox is process-global; activate once on first plugin load.
      // Subsequent plugin loads while a sandbox is active are fine — the
      // sandbox only protects the DENIED-method calls, not the plugin code
      // path. (Darwin runtime itself doesn't run inside a sandbox because
      // bin/lib/plugin.js doesn't pass enableSandbox; tests that DO pass
      // enableSandbox must not run Darwin code that touches DENIED methods.)
      if (sandbox && sandboxActiveNames.size === 0) {
        sandbox.activate();
      }
      sandboxActiveNames.add(p.name);
      bus.emit(E.load.ok, { name: p.name, path: resolve(pluginPath) });
      return { name: p.name };
    });
    if (!r.ok) {
      errEvt('load', '<loading>', r.error);
    }
    return r;
  }

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
        new Error(`illegal transition: ${cur} → ${op} (allowed: ${from.join(',')})`),
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
      // P2i: deactivate sandbox only after the LAST plugin is unloaded,
      // so multiple plugins coexist safely. deactivate() restores the
      // original methods so Darwin's own code (e.g. test teardown writing
      // to /tmp) can run normally.
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

  return {
    discover,
    load,
    init,
    enable,
    disable,
    unload,
    state: stateOf,
    // P2i: exposed for tests + future "list sandbox-active plugins" tooling.
    _internal: { sandbox, sandboxActiveNames, enableSandbox },
  };
}
