/**
 * feishu-notify plugin tests — V6 cycle 1 (2026-06-19).
 *
 * Covers:
 *  - IPlugin manifest shape (P2d contract)
 *  - init() subscribes to evolution:apply:after + evolution:audit
 *  - evolution:apply:after → feishu.send with formatted text
 *  - evolution:audit → feishu.send with audit-formatted text
 *  - destroy() unsubscribes (events after destroy don't fire feishu.send)
 *  - feishu.send throw → plugin logs to stderr, never throws to caller
 *  - feishu.send {ok:false} → plugin logs, never throws
 *  - empty target → graceful no-op (no adapter call)
 *  - enabled=false → graceful no-op
 *  - adapter injection via ctx.adapters.feishu (no real network, ADR-009)
 *
 * Adapter injection contract: tests pass a stub feishu adapter via
 * ctx.adapters.feishu. The stub records calls. Plugin never touches
 * fetch directly (feishu adapter handles it).
 *
 * LLM gate (ADR-009): all paths use stub adapter. No network. No LLM.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { PluginRegistry } from '../plugin/registry.js';
import { IPlugin } from '../plugin/interface.js';
import feishuNotify from '../plugin/feishu-notify.js';

let createPluginLoader;
async function loader() {
  if (!createPluginLoader) {
    ({ createPluginLoader } = await import('../plugin/loader.js'));
  }
  return createPluginLoader;
}

/** Stub feishu adapter — records every send call. Configurable failure mode. */
function stubFeishu({ throwErr = null, returnValue = { ok: true, messageId: 'om_stub' } } = {}) {
  const calls = [];
  const stub = {
    async execute({ action, payload, config }) {
      calls.push({ action, payload, config });
      if (throwErr) {
        throw throwErr;
      }
      return returnValue;
    },
  };
  return { stub, calls };
}

describe('feishu-notify plugin — manifest (P2d contract)', () => {
  test('has name, version, capabilities, permissions in expected shape', () => {
    assert.equal(feishuNotify.name, 'feishu-notify');
    assert.equal(feishuNotify.version, '0.1.0');
    assert.deepEqual(feishuNotify.capabilities, ['tool']);
    assert.deepEqual(feishuNotify.permissions, [
      'bus:on',
      'bus:off',
      'log:info',
      'log:error',
      'config:get',
    ]);
  });

  test('passes IPlugin.validate (P2d whitelist + not in PLUGIN_DENIED)', () => {
    // Throws on violation; reaching the next line means OK.
    IPlugin.validate(feishuNotify);
  });

  test('exposes the IPlugin lifecycle methods', () => {
    for (const m of ['init', 'enable', 'disable', 'destroy']) {
      assert.equal(typeof feishuNotify[m], 'function', `feishuNotify.${m} must be function`);
    }
  });
});

describe('feishu-notify plugin — direct init (no loader, fast)', () => {
  let bus;
  let stderrChunks;
  const origWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    bus = new EventBus();
    stderrChunks = [];
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    // Best-effort cleanup: destroy in case test forgot.
    if (feishuNotify._handlers) {
      feishuNotify.destroy();
    }
  });

  test('evolution:apply:after → feishu.send called with formatted text + configured target', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_user_test_1' },
      adapters: { feishu: stub },
    });

    bus.emit('evolution:apply:after', { subject: 'V6.1 cycle 收口', tag: 'tag-x' });

    // Allow microtasks (dispatch is async).
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'send');
    assert.equal(calls[0].payload.receive_id, 'ou_user_test_1');
    assert.match(calls[0].payload.text, /✅ Darwin cycle 收口: V6\.1 cycle 收口/);
    feishuNotify.destroy();
  });

  test('evolution:apply:after with no subject → text uses tag fallback', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_user_test_2' },
      adapters: { feishu: stub },
    });

    bus.emit('evolution:apply:after', { tag: 'fallback-tag-42' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.text, /✅ Darwin cycle 收口: fallback-tag-42/);
    feishuNotify.destroy();
  });

  test('evolution:audit event → feishu.send called with audit-formatted text', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_user_test_3' },
      adapters: { feishu: stub },
    });

    bus.emit('evolution:audit', {
      proposal_id: 'prop-001',
      action: 'apply',
      outcome: 'success',
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'send');
    assert.equal(calls[0].payload.receive_id, 'ou_user_test_3');
    assert.match(calls[0].payload.text, /📒 Darwin audit: prop-001 \(apply\/success\)/);
    feishuNotify.destroy();
  });

  test('destroy() unsubscribes both topics — events after destroy do not call feishu', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_user_test_4' },
      adapters: { feishu: stub },
    });

    feishuNotify.destroy();

    bus.emit('evolution:apply:after', { subject: 'should be ignored' });
    bus.emit('evolution:audit', { proposal_id: 'p', action: 'a', outcome: 'o' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0, 'no feishu.send after destroy()');
  });

  test('feishu.send throws → plugin logs to stderr, NEVER throws to caller (A-5)', async () => {
    const { stub, calls } = stubFeishu({
      throwErr: new Error('network is on fire'),
    });
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_user_test_5' },
      adapters: { feishu: stub },
    });

    // Must not throw.
    bus.emit('evolution:apply:after', { subject: 'boom' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(
      stderrChunks.join(''),
      /\[feishu-notify\] evolution:apply:after push failed: network is on fire/,
    );
  });

  test('feishu.send returns {ok:false,error} → plugin logs, NEVER throws (A-5)', async () => {
    const { stub, calls } = stubFeishu({
      returnValue: { ok: false, error: 'tenant_access_token refused: code=99999' },
    });
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_user_test_6' },
      adapters: { feishu: stub },
    });

    bus.emit('evolution:apply:after', { subject: 'failure path' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(
      stderrChunks.join(''),
      /\[feishu-notify\] evolution:apply:after push failed: tenant_access_token refused/,
    );
  });

  test('empty target → graceful no-op (no adapter call, warning logged)', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({
      eventBus: bus,
      config: {}, // no target
      adapters: { feishu: stub },
    });

    bus.emit('evolution:apply:after', { subject: 'no target' });
    bus.emit('evolution:audit', { proposal_id: 'p', action: 'a', outcome: 'o' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0, 'no adapter call when target empty');
    assert.match(
      stderrChunks.join(''),
      /\[feishu-notify\] .* push failed: no feishuNotifyTarget configured/,
      'empty target logs a config warning so the user knows to set one',
    );
  });

  test('enabled=false → graceful no-op (no adapter call)', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_user_test_8', enabled: false },
      adapters: { feishu: stub },
    });

    bus.emit('evolution:apply:after', { subject: 'disabled' });
    bus.emit('evolution:audit', { proposal_id: 'p', action: 'a', outcome: 'o' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0, 'no adapter call when disabled');
    feishuNotify.destroy();
  });

  test('init() with no ctx.config → defaults to enabled=true, target=empty (graceful)', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({ eventBus: bus, adapters: { feishu: stub } });

    bus.emit('evolution:apply:after', { subject: 'no config at all' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
    assert.deepEqual(feishuNotify._getNotifyConfig(), { target: '', enabled: true });
  });

  test('init() with no ctx.eventBus → no subscribe attempted, no crash', () => {
    // Defensive: real loader always passes eventBus, but plugin should
    // not crash if ctx.eventBus is missing.
    feishuNotify.init({ adapters: { feishu: stubFeishu().stub } });
    // If we got here without throwing, OK. Cleanup.
    feishuNotify.destroy();
  });

  test('_getNotifyConfig returns defensive copy (mutating result does not affect state)', () => {
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_orig', enabled: true },
      adapters: { feishu: stubFeishu().stub },
    });
    const snap = feishuNotify._getNotifyConfig();
    snap.target = 'ou_mutated';
    assert.equal(feishuNotify._getNotifyConfig().target, 'ou_orig', 'mutation must not leak');
    feishuNotify.destroy();
  });
});

describe('feishu-notify plugin — end-to-end via PluginLoader', () => {
  let bus, registry, l;
  beforeEach(async () => {
    bus = new EventBus();
    registry = new PluginRegistry({ eventBus: bus });
    const f = await loader();
    l = f({ eventBus: bus, registry });
  });
  afterEach(async () => {
    if (l.state('feishu-notify') !== 'UNLOADED') {
      await l.unload('feishu-notify');
    }
  });

  test('load + init + enable → plugin registered, state ENABLED', async () => {
    // Loader uses ConfigResolver by default for `config`, which returns
    // empty when no ~/.darwin/.env exists. Plugin should still init.
    const r = await l.load('./plugin/feishu-notify.js');
    assert.equal(r.ok, true);
    assert.equal(r.value.name, 'feishu-notify');
    assert.equal(l.state('feishu-notify'), 'LOADED');

    const i = await l.init('feishu-notify');
    assert.equal(i.ok, true);
    assert.equal(l.state('feishu-notify'), 'INITIALIZED');

    const e = await l.enable('feishu-notify');
    assert.equal(e.ok, true);
    assert.equal(l.state('feishu-notify'), 'ENABLED');
  });

  test('plugin emits no feishu.send without configured target (loader default config)', async () => {
    // Loader calls plugin.init() with config = ConfigResolver.get(...)
    // which returns {} when ~/.darwin/.env is absent. Plugin should
    // no-op gracefully (target empty).
    await l.load('./plugin/feishu-notify.js');
    await l.init('feishu-notify');
    await l.enable('feishu-notify');

    // Real feishu adapter would try to fetch — we must not let it.
    // Since target is empty, plugin no-ops BEFORE calling adapter.
    // Just verify no throw and no state change.
    const before = registry.get('feishu-notify')._getNotifyConfig();
    assert.equal(before.target, '');
    bus.emit('evolution:apply:after', { subject: 'no target via loader' });
    await new Promise((r) => setImmediate(r));
    // Plugin still alive after event.
    assert.equal(l.state('feishu-notify'), 'ENABLED');
  });
});
