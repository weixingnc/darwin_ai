/**
 * darwin plugin — load + list plugin via PluginLoader / PluginRegistry.
 *
 * `darwin plugin add <path>` — load + init + enable a single plugin file.
 *   Path can be absolute or relative; must be a .js file exporting
 *   a default object with `name` field (IPlugin contract).
 * `darwin plugin list` — list all currently loaded plugins.
 *
 * MVP: 1 plugin per command (no batch add). User chains commands for > 1.
 */

import { createPluginLoader } from '../../plugin/loader.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { sharedBootstrap } from './_shared.js';

export async function pluginAdd(path) {
  if (!path) {
    throw new Error(
      'plugin add: missing path. Usage: darwin plugin add ./plugin/__example__/logger.js',
    );
  }
  if (!path.endsWith('.js')) {
    throw new Error(`plugin add: path must be a .js file. Got: ${path}`);
  }

  const { bus } = await sharedBootstrap();
  const registry = new PluginRegistry({ eventBus: bus });
  const loader = createPluginLoader({ eventBus: bus, registry });

  // Stage 1: load (parse + import) — loader.load() returns { ok, name? } (ErrorHandler shape)
  const loadResult = await loader.load(path);
  const name = loadResult?.name || _nameFromPath(path);
  console.log(`✓ Loaded: ${path} → ${name}`);

  // Stage 2: init (call plugin.init({ eventBus }))
  await loader.init(name);
  console.log(`✓ Initialized: ${name}`);

  // Stage 3: enable (call plugin.enable())
  await loader.enable(name);
  console.log(`✓ Enabled: ${name} (ready)`);
}

export async function pluginList() {
  const { bus } = await sharedBootstrap();
  const registry = new PluginRegistry({ eventBus: bus });
  // Note: list is a snapshot — plugins added via `plugin add` don't survive
  // across CLI invocations (each spawn gets a fresh process).
  // This command is useful when called from a script that loads multiple plugins
  // in-process (e.g. via REPL or future script runner).
  const plugins = registry.list();
  if (plugins.length === 0) {
    console.log('(no plugins loaded)');
    return;
  }
  for (const p of plugins) {
    const caps = Array.isArray(p.capabilities) ? p.capabilities.join(', ') : 'no caps';
    const ver = p.version || '?';
    console.log(`- ${p.name} v${ver} [${caps}]`);
  }
}

function _nameFromPath(p) {
  // ./plugin/__example__/logger.js → 'logger'
  const base = p.split('/').pop() || p;
  return base.replace(/\.js$/, '');
}
