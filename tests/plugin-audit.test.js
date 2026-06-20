/**
 * audit plugin tests — P2c-2 (2026-06-18).
 *
 * End-to-end via PluginLoader: load + init + enable + emit evolution
 * events + assert getEvents() returns the recorded entries. The plugin
 * lives at plugin/audit.js (production, not __example__) and is the
 * first non-example plugin in v2's plugin/ root — Darwin's first
 * real "装新器官" after the P2a/P2b/P2c-1/P2d plumbing cycle.
 *
 * P2d contract: capabilities ['tool'] + permissions ['bus:on', 'log:info']
 * are both inside their respective whitelists. We re-validate via
 * IPlugin.validate so a typo here fails loudly at test time.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { PluginRegistry } from '../plugin/registry.js';
import { EVENTS } from '../core/events.js';
import { IPlugin } from '../plugin/interface.js';
import audit from '../plugin/audit.js';

let createPluginLoader;
async function loader() {
  if (!createPluginLoader) {
    ({ createPluginLoader } = await import('../plugin/loader.js'));
  }
  return createPluginLoader;
}

const PROPOSE = EVENTS.EVOLUTION_PROPOSE_AFTER;
const APPLY = EVENTS.EVOLUTION_APPLY_AFTER;

describe('audit plugin — manifest (P2d contract)', () => {
  test('has name, version, capabilities, permissions in expected shape', () => {
    assert.equal(audit.name, 'audit');
    // V10.1 (2026-06-20): version bumped 0.2.0 -> 0.3.0 to reflect
    // all-12-events subscription (was 2/12). The P2d contract test
    // still asserts the manifest shape, just the new version string.
    assert.equal(audit.version, '0.3.0');
    assert.deepEqual(audit.capabilities, ['tool']);
    assert.deepEqual(audit.permissions, ['bus:on', 'log:info', 'fs:append']);
  });

  test('passes IPlugin.validate (P2d whitelist + not in PLUGIN_DENIED)', () => {
    // Throws on violation; reaching the next line means OK.
    IPlugin.validate(audit);
  });

  test('exposes the IPlugin lifecycle methods', () => {
    for (const m of ['init', 'enable', 'disable', 'destroy']) {
      assert.equal(typeof audit[m], 'function', `audit.${m} must be function`);
    }
  });
});

describe('audit plugin — end-to-end via PluginLoader', () => {
  let bus, registry, l;
  beforeEach(async () => {
    bus = new EventBus();
    registry = new PluginRegistry({ eventBus: bus });
    const f = await loader();
    l = f({ eventBus: bus, registry });
  });
  afterEach(async () => {
    // Always unload between tests to keep registry fresh.
    if (l.state('audit') !== 'UNLOADED') {
      await l.unload('audit');
    }
  });

  test('load + init + enable puts plugin in ENABLED state', async () => {
    const r = await l.load('./plugin/audit.js');
    assert.equal(r.ok, true);
    assert.equal(r.value.name, 'audit');
    assert.equal(l.state('audit'), 'LOADED');
    assert.ok(registry.has('audit'));

    const i = await l.init('audit');
    assert.equal(i.ok, true);
    assert.equal(l.state('audit'), 'INITIALIZED');

    const e = await l.enable('audit');
    assert.equal(e.ok, true);
    assert.equal(l.state('audit'), 'ENABLED');
  });

  test('getEvents() returns [] before any evolution event fires', async () => {
    await l.load('./plugin/audit.js');
    await l.init('audit');
    await l.enable('audit');
    assert.deepEqual(registry.get('audit').getEvents(), []);
  });

  test('records evolution:propose:after event with topic + payload + timestamp', async () => {
    await l.load('./plugin/audit.js');
    await l.init('audit');
    await l.enable('audit');

    const payload = { count: 2, written_paths: ['/p1.json', '/p2.json'] };
    bus.emit(PROPOSE, payload);

    const events = registry.get('audit').getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].topic, PROPOSE);
    assert.deepEqual(events[0].payload, payload);
    assert.match(events[0].recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('records evolution:apply:after event independently of propose events', async () => {
    await l.load('./plugin/audit.js');
    await l.init('audit');
    await l.enable('audit');

    bus.emit(APPLY, { applied: true, tag: 'evolution-pre-x-123' });

    const events = registry.get('audit').getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].topic, APPLY);
    assert.equal(events[0].payload.applied, true);
  });

  test('records multiple events in insertion order (FIFO)', async () => {
    await l.load('./plugin/audit.js');
    await l.init('audit');
    await l.enable('audit');

    bus.emit(PROPOSE, { count: 1 });
    bus.emit(APPLY, { applied: true });
    bus.emit(PROPOSE, { count: 2 });
    bus.emit(APPLY, { applied: false, reason: 'must_approve' });

    const events = registry.get('audit').getEvents();
    assert.equal(events.length, 4);
    assert.equal(events[0].topic, PROPOSE);
    assert.equal(events[0].payload.count, 1);
    assert.equal(events[1].topic, APPLY);
    assert.equal(events[1].payload.applied, true);
    assert.equal(events[2].topic, PROPOSE);
    assert.equal(events[2].payload.count, 2);
    assert.equal(events[3].topic, APPLY);
    assert.equal(events[3].payload.reason, 'must_approve');
  });

  test('plugin-level disable()/enable() drops/restores event recording', async () => {
    // Darwin's loader state machine only allows enable() from INITIALIZED
    // (not from DISABLED) — disable must be followed by unload+load+init
    // to re-enable via loader. But the PLUGIN's own disable()/enable()
    // methods can be called directly on the registry-held instance to
    // toggle _recording without leaving ENABLED state. This is the
    // useful semantic for the audit plugin: a host that wants to pause
    // recording mid-run (e.g. while running a noisy bulk operation)
    // does it via plugin-level toggle, not via loader stage.
    await l.load('./plugin/audit.js');
    await l.init('audit');
    await l.enable('audit');
    bus.emit(PROPOSE, { count: 1 });
    assert.equal(registry.get('audit').getEvents().length, 1);

    const p = registry.get('audit');
    p.disable();
    bus.emit(PROPOSE, { count: 2 });
    bus.emit(APPLY, { applied: true });
    assert.equal(
      registry.get('audit').getEvents().length,
      1,
      'no events recorded while plugin disabled',
    );

    p.enable();
    bus.emit(PROPOSE, { count: 3 });
    assert.equal(registry.get('audit').getEvents().length, 2);
  });

  test('destroy() unsubscribes + clears in-memory log', async () => {
    await l.load('./plugin/audit.js');
    await l.init('audit');
    await l.enable('audit');
    bus.emit(PROPOSE, { count: 1 });
    assert.equal(registry.get('audit').getEvents().length, 1);

    await l.unload('audit'); // calls destroy internally
    assert.equal(l.state('audit'), 'UNLOADED');
    assert.equal(registry.has('audit'), false);

    // After unload, the plugin object is no longer in the registry — but
    // we still hold a reference. Verify its state was cleared: getEvents
    // must return [] (in-memory log was wiped in destroy()).
    assert.deepEqual(audit.getEvents(), []);
  });

  test('getEvents() returns a defensive copy (mutating result does not affect state)', async () => {
    await l.load('./plugin/audit.js');
    await l.init('audit');
    await l.enable('audit');
    bus.emit(PROPOSE, { count: 1 });

    const events = registry.get('audit').getEvents();
    events.push({ topic: 'tampered', payload: null, recordedAt: 'x' });
    // Subsequent getEvents() must NOT include the tampered entry.
    const events2 = registry.get('audit').getEvents();
    assert.equal(events2.length, 1, 'tampered push must not leak into plugin state');
  });
});
