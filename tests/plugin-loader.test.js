/**
 * PluginLoader tests — TDD red→green for PR 11b.
 * 5-stage lifecycle, state machine, error isolation, event emission, example integration.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { PluginRegistry } from '../plugin/registry.js';
import { EVENTS } from '../core/events.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let createPluginLoader;
const S = Object.freeze({
  UNLOADED: 'UNLOADED',
  LOADED: 'LOADED',
  INITIALIZED: 'INITIALIZED',
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
});
const SUCCESS = [
  EVENTS.PLUGIN_LOAD,
  EVENTS.PLUGIN_INIT,
  EVENTS.PLUGIN_ENABLE,
  EVENTS.PLUGIN_DISABLE,
  EVENTS.PLUGIN_UNLOAD,
];
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

describe('loader — shape & discover', () => {
  test('factory + 7 methods + requires {eventBus,registry}; discover+missing', async () => {
    const f = await loader();
    const l = f(ctx());
    for (const m of ['discover', 'load', 'init', 'enable', 'disable', 'unload', 'state']) {
      assert.equal(typeof l[m], 'function');
    }
    assert.throws(() => f(), /eventBus/);
    assert.throws(() => f({ eventBus: new EventBus() }), /registry/);
    const ok = await l.discover('./plugin');
    assert.ok(Array.isArray(ok) && ok.length >= 1);
    for (const e of ok) {
      assert.ok(e.name && e.path.endsWith('.js') && e.plugin?.name);
    }
    assert.deepEqual(await l.discover('./no-such-dir-xyz'), []);
  });
});

describe('loader — load (UNLOADED→LOADED)', () => {
  test('load example logger: registers + emits PLUGIN_LOAD + state=LOADED', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const ev = on(c.eventBus, EVENTS.PLUGIN_LOAD);
    await l.load('./plugin/__example__/logger.js');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].name, 'logger');
    assert.ok(c.registry.has('logger'));
    assert.equal(l.state('logger'), S.LOADED);
  });
  test('duplicate load + missing path both → PLUGIN_LOAD_ERROR (no throw)', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const errs = on(c.eventBus, ERROR.load);
    await l.load('./plugin/__example__/logger.js');
    await l.load('./plugin/__example__/logger.js');
    await l.load('./no/such.js');
    assert.equal(errs.length, 2);
  });
});

describe('loader — state machine', () => {
  test('happy path 5 stages', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    await l.load('./plugin/__example__/logger.js');
    assert.equal(l.state('logger'), S.LOADED);
    assert.equal((await l.init('logger')).ok, true);
    assert.equal(l.state('logger'), S.INITIALIZED);
    assert.equal((await l.enable('logger')).ok, true);
    assert.equal(l.state('logger'), S.ENABLED);
    assert.equal((await l.disable('logger')).ok, true);
    assert.equal(l.state('logger'), S.DISABLED);
    assert.equal((await l.unload('logger')).ok, true);
    assert.equal(l.state('logger'), S.UNLOADED);
  });
  test('illegal jumps from UNLOADED: init/enable/disable/unload all return ok:false + emit *_ERROR', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const seen = [];
    for (const k of ['init', 'enable', 'disable', 'unload']) {
      c.eventBus.on(ERROR[k], (_p) => seen.push(k));
    }
    for (const k of ['init', 'enable', 'disable', 'unload']) {
      assert.equal((await l[k]('x')).ok, false);
    }
    assert.deepEqual(seen, ['init', 'enable', 'disable', 'unload']);
  });
  test('skipping init (LOADED→ENABLE) emits PLUGIN_ENABLE_ERROR; state stays LOADED', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const errs = on(c.eventBus, ERROR.enable);
    await l.load('./plugin/__example__/logger.js');
    assert.equal((await l.enable('logger')).ok, false);
    assert.equal(errs.length, 1);
    assert.equal(l.state('logger'), S.LOADED);
  });
});

describe('loader — error isolation', () => {
  test('sync init throw → PLUGIN_INIT_ERROR + state stays LOADED; sibling OK', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const errs = on(c.eventBus, ERROR.init);
    await l.load('./tests/fixtures/bad-init-sync.js');
    await l.load('./plugin/__example__/logger.js');
    assert.equal((await l.init('bad-init-sync')).ok, false);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /boom/);
    assert.equal(l.state('bad-init-sync'), S.LOADED);
    assert.equal((await l.init('logger')).ok, true);
  });
  test('async init reject → PLUGIN_INIT_ERROR + state stays LOADED', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const errs = on(c.eventBus, ERROR.init);
    await l.load('./tests/fixtures/bad-init-async.js');
    assert.equal((await l.init('bad-init-async')).ok, false);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /aboom/);
    assert.equal(l.state('bad-init-async'), S.LOADED);
  });
});

describe('loader — event order', () => {
  test('emits LOAD/INIT/ENABLE/DISABLE/UNLOAD in order on happy path', async () => {
    const f = await loader();
    const c = ctx();
    const l = f(c);
    const order = [];
    for (const ev of SUCCESS) {
      c.eventBus.on(ev, (p) => order.push(`${ev.split(':')[1]}:${p.name}`));
    }
    await l.load('./plugin/__example__/logger.js');
    await l.init('logger');
    await l.enable('logger');
    await l.disable('logger');
    await l.unload('logger');
    assert.deepEqual(order, [
      'load:logger',
      'init:logger',
      'enable:logger',
      'disable:logger',
      'unload:logger',
    ]);
  });
});

describe('loader — example logger integration', () => {
  let log, restore;
  beforeEach(async () => {
    await loader();
    log = [];
    const o = console.log;
    console.log = (...a) => log.push(a.join(' '));
    restore = () => {
      console.log = o;
    };
  });
  afterEach(() => restore());
  test('enabled logger logs on PLUGIN_REGISTER; disabled logger stops', async () => {
    const c = ctx();
    const l = createPluginLoader(c);
    await l.load('./plugin/__example__/logger.js');
    await l.init('logger');
    await l.enable('logger');
    c.eventBus.emit(EVENTS.PLUGIN_REGISTER, { name: 'tool-x' });
    assert.ok(log.find((x) => x.includes('plugin registered: tool-x')));
    await l.disable('logger');
    const before = log.filter((x) => x.includes('plugin registered:')).length;
    c.eventBus.emit(EVENTS.PLUGIN_REGISTER, { name: 'tool-y' });
    assert.equal(log.filter((x) => x.includes('plugin registered:')).length, before);
  });
});

describe('loader -- startWatcher / stopWatcher (V12)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'darwin-v12-'));
  });
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('startWatcher returns a handle; stopWatcher is idempotent', async () => {
    const f = await loader();
    const l = f(ctx());
    const h = l.startWatcher(dir, { debounceMs: 30 });
    assert.equal(typeof h.close, 'function');
    assert.equal(h.stats.reloadAttempts, 0);
    // Idempotent: a second call returns the same handle.
    const h2 = l.startWatcher(dir, { debounceMs: 30 });
    assert.equal(h2, h);
    l.stopWatcher();
    // Idempotent: stopping again is a no-op.
    l.stopWatcher();
    l.stopWatcher();
  });
});
