/**
 * audit plugin - V10.1 all-events coverage (2026-06-20).
 *
 * Before V10.1 the audit plugin only subscribed to 2/12 evolution
 * events (propose:after + apply:after). This test pins the V10.1
 * contract: ALL 12 evolution:* events are recorded.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { IPlugin } from '../plugin/interface.js';
import audit from '../plugin/audit.js';

describe('audit plugin - V10.1: all 12 evolution events captured', () => {
  let bus;
  let plugin;

  beforeEach(() => {
    bus = new EventBus();
    plugin = { ...audit };
    plugin.init({ eventBus: bus, config: { baseDir: '/tmp/darwin-v101-test' } });
  });

  test('manifest version bumped to 0.3.0 (V10.1 marker)', () => {
    assert.equal(audit.version, '0.3.0');
  });

  test('IPlugin.validate passes (P2d contract unchanged)', () => {
    IPlugin.validate(audit);
  });

  test('captures all 12 evolution events emitted on the bus', () => {
    const evoKeys = Object.keys(EVENTS).filter((k) => k.startsWith('EVOLUTION_'));
    assert.equal(evoKeys.length, 12, 'EVENTS must define 12 evolution events');

    for (const key of evoKeys) {
      const topic = EVENTS[key];
      bus.emit(topic, { which: key, ts: Date.now() });
    }
    const recorded = plugin.getEvents();
    assert.equal(recorded.length, 12, 'all 12 events must be recorded');

    const recordedTopics = new Set(recorded.map((e) => e.topic));
    for (const key of evoKeys) {
      const topic = EVENTS[key];
      assert.ok(
        recordedTopics.has(topic),
        `plugin.getEvents() should contain ${topic} (key=${key})`,
      );
    }
  });

  test('captures evolution:propose:after (V8.2 baseline, still works)', () => {
    bus.emit(EVENTS.EVOLUTION_PROPOSE_AFTER, { count: 3 });
    const ev = plugin.getEvents();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].topic, 'evolution:propose:after');
    assert.equal(ev[0].payload.count, 3);
  });

  test('captures evolution:apply:after (V8.2 baseline, still works)', () => {
    bus.emit(EVENTS.EVOLUTION_APPLY_AFTER, { tag: 'evolution-pre-1' });
    const ev = plugin.getEvents();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].topic, 'evolution:apply:after');
  });

  test('captures the missing-10: diagnose/verify/rollback/learn/approve/reject', () => {
    const newTopics = [
      EVENTS.EVOLUTION_DIAGNOSE_BEFORE,
      EVENTS.EVOLUTION_DIAGNOSE_AFTER,
      EVENTS.EVOLUTION_PROPOSE_BEFORE,
      EVENTS.EVOLUTION_APPROVE,
      EVENTS.EVOLUTION_REJECT,
      EVENTS.EVOLUTION_APPLY_BEFORE,
      EVENTS.EVOLUTION_VERIFY,
      EVENTS.EVOLUTION_ROLLBACK,
      EVENTS.EVOLUTION_AUDIT,
      EVENTS.EVOLUTION_LEARN,
    ];
    for (const t of newTopics) {
      bus.emit(t, { source: 'v10.1-test', topic: t });
    }
    const recorded = plugin.getEvents();
    assert.equal(recorded.length, 10);
    const recordedTopics = new Set(recorded.map((e) => e.topic));
    for (const t of newTopics) {
      assert.ok(recordedTopics.has(t), `must record ${t}`);
    }
  });

  test('does NOT capture non-evolution events (provider:*, plugin:*, etc.)', () => {
    bus.emit(EVENTS.PROVIDER_CALL_BEFORE, { provider: 'openai' });
    bus.emit(EVENTS.PLUGIN_LOAD, { name: 'test' });
    bus.emit(EVENTS.MEMORY_STORE, { key: 'k' });
    assert.equal(plugin.getEvents().length, 0, 'non-evolution events must be ignored');
  });

  test('destroy() unsubscribes all 12 topics (no leak)', () => {
    plugin.destroy();
    for (const key of Object.keys(EVENTS)) {
      if (key.startsWith('EVOLUTION_')) {
        bus.emit(EVENTS[key], { after: 'destroy' });
      }
    }
    assert.equal(plugin.getEvents().length, 0);
  });
});
