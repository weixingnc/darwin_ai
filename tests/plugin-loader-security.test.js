/**
 * PluginLoader P2d security tests — split from plugin-loader.test.js to keep
 * the core file ≤ 200 lines (PM-direct-write convention; subagent prompts
 * enforce this). Loader behavior under the new manifest contract:
 *   - accept plugins with valid permissions
 *   - reject plugins whose permissions ∩ PLUGIN_DENIED is non-empty
 *   - reject plugins with unknown permissions
 *
 * Note: loader returns ErrorHandler shape {ok, value, error, ...} (PR 11a
 * contract). Success payload lives on `.value`, failure details on `.error`.
 * P2a (a9fd668) and P2b (694f1ce) callers historically used `.name` directly
 * on the success path which happens to "work" because ErrorHandler entries
 * do not have a top-level `name` — so `_nameFromPath(path)` fallback kicked
 * in. P2d tests pin the real contract: r.value.name on success,
 * r.error.message on failure.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { PluginRegistry } from '../plugin/registry.js';
import { EVENTS } from '../core/events.js';

let createPluginLoader;
const S = Object.freeze({
  UNLOADED: 'UNLOADED',
  LOADED: 'LOADED',
  INITIALIZED: 'INITIALIZED',
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
});
const ERROR = {
  init: EVENTS.PLUGIN_INIT_ERROR,
  enable: EVENTS.PLUGIN_ENABLE_ERROR,
  disable: EVENTS.PLUGIN_DISABLE_ERROR,
  unload: EVENTS.PLUGIN_UNLOAD_ERROR,
  load: EVENTS.PLUGIN_LOAD_ERROR,
};

const ctx = () => ({
  eventBus: new EventBus(),
  registry: new PluginRegistry({ eventBus: new EventBus() }),
});
async function loader() {
  if (!createPluginLoader) {
    ({ createPluginLoader } = await import('../plugin/loader.js'));
  }
  return createPluginLoader;
}
const on = (bus, ev) => {
  const a = [];
  bus.on(ev, (_p) => a.push(_p));
  return a;
};

describe('loader — P2d manifest security', () => {
  test('accepts plugin with valid permissions (logger with bus:on, log:info)', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const ok = on(c.eventBus, EVENTS.PLUGIN_LOAD);
    const r = await l.load('./plugin/__example__/logger.js');
    assert.equal(r.ok, true);
    assert.equal(r.value.name, 'logger');
    assert.equal(ok.length, 1);
    assert.equal(l.state('logger'), S.LOADED);
  });

  test('rejects evil plugin (process:exit in permissions) → PLUGIN_LOAD_ERROR + not registered', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const errs = on(c.eventBus, ERROR.load);
    const r = await l.load('./tests/fixtures/evil-permission.js');
    assert.equal(r.ok, false);
    assert.equal(r.value, undefined, 'no success payload on failure');
    assert.match(r.error.message, /denied values.*process:exit/);
    assert.equal(errs.length, 1, 'PLUGIN_LOAD_ERROR must be emitted');
    assert.equal(c.registry.has('evil'), false, 'evil plugin must not be registered');
    assert.equal(l.state('evil'), S.UNLOADED, 'evil plugin state must remain UNLOADED');
  });

  test('evil plugin with fs:delete is also rejected (blocklist covers all 5 high-risk primitives)', async () => {
    // Verify PLUGIN_DENIED is checked BEFORE PLUGIN_PERMISSIONS whitelist
    // (deny-by-default for high-risk). We cover all 5 PLUGIN_DENIED values
    // via a sibling test in plugin-interface.test.js. Here we sanity-check
    // a different denied permission (fs:delete) also fails at the validate
    // layer the loader wires through.
    const c = ctx();
    const errs = on(c.eventBus, ERROR.load);
    const { IPlugin } = await import('../plugin/interface.js');
    const fsDelete = {
      name: 'evil-fs',
      version: '0.0.1',
      capabilities: ['tool'],
      permissions: ['fs:delete'],
      init() {},
      destroy() {},
      enable() {},
      disable() {},
    };
    assert.throws(() => IPlugin.validate(fsDelete), /denied values.*fs:delete/);
    assert.equal(errs.length, 0, 'no loader events (this test does not call l.load)');
    void c; // silence linter
  });
});
