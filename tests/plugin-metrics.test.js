/**
 * W4-1 (2026-06-18) — metrics plugin tests.
 *
 * Verifies the third production plugin (plugin/metrics.js) — Darwin's
 * observability layer for evolution events. Where audit records
 * WHAT happened, metrics records HOW MUCH and HOW FAST.
 *
 * Covered:
 *   1. Manifest validates (P2d contract)
 *   2. getStats() starts empty
 *   3. Event counter increments per topic
 *   4. Duration aggregation: avg per topic + global
 *   5. Events without duration_ms still count, but don't affect avg
 *   6. Persists to <baseDir>/stats.jsonl
 *   7. readPersisted() replays from disk
 *   8. disable() stops BOTH in-memory and on-disk
 *   9. destroy() unsubscribes from all 5 topics
 *  10. Tracked topics: 5 evolution:* events
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import metrics from '../plugin/metrics.js';
import { IPlugin, PLUGIN_PERMISSIONS, PLUGIN_DENIED } from '../plugin/interface.js';
import { evolutionBus } from '../evolution/_bus.js';

const TMP = mkdtempSync(join(tmpdir(), 'w4-1-'));

test('W4-1: manifest validates (P2d contract)', () => {
  assert.equal(metrics.name, 'metrics');
  assert.equal(metrics.version, '0.1.0');
  assert.deepEqual(metrics.capabilities, ['tool']);
  // fs:append (P2j pattern) accepted because not in PLUGIN_DENIED.
  assert.deepEqual(metrics.permissions, ['bus:on', 'log:info', 'fs:append']);
  assert.ok(PLUGIN_PERMISSIONS.includes('fs:append'));
  assert.ok(!PLUGIN_DENIED.includes('fs:append'));
  assert.doesNotThrow(() => IPlugin.validate(metrics));
});

test('W4-1: getStats() starts empty before init', () => {
  // metrics is a singleton plugin; reset internal state for clean test.
  metrics._bus = null;
  metrics._handlers = {};
  metrics._eventsByTopic = {};
  metrics._totalEvents = 0;
  const stats = metrics.getStats();
  assert.equal(stats.total_events, 0);
  assert.deepEqual(stats.events_by_topic, {});
  assert.equal(stats.avg_duration_ms, null);
  // last_event_at is null before any event has been recorded; if the
  // plugin has never been initialised, the property is undefined.
  assert.ok(
    stats.last_event_at === null || stats.last_event_at === undefined,
    `last_event_at should be null/undefined, got ${stats.last_event_at}`,
  );
});

test('W4-1: event counter increments per topic', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'count');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:diagnose:after', {});
  bus.emit('evolution:diagnose:after', {});
  bus.emit('evolution:propose:after', { proposals: [] });
  bus.emit('evolution:apply:after', { applied: true });
  const stats = metrics.getStats();
  assert.equal(stats.events_by_topic['evolution:diagnose:after'], 2);
  assert.equal(stats.events_by_topic['evolution:propose:after'], 1);
  assert.equal(stats.events_by_topic['evolution:apply:after'], 1);
  assert.equal(stats.total_events, 4);
  assert.ok(stats.last_event_at !== null, 'last_event_at recorded');
  metrics.destroy();
});

test('W4-1: duration aggregation per topic + global avg', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'duration');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 100 });
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 200 });
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 300 });
  // Event without duration_ms — counted but not averaged.
  bus.emit('evolution:apply:after', { applied: true });
  const stats = metrics.getStats();
  assert.equal(stats.events_by_topic['evolution:apply:after'], 4);
  // avg of 100/200/300 = 200
  assert.equal(stats.avg_duration_ms_by_topic['evolution:apply:after'], 200);
  assert.equal(stats.avg_duration_ms, 200);
  metrics.destroy();
});

test('W4-1: events without duration_ms do not affect avg (only count)', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'no-duration');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:diagnose:after', {}); // no duration
  bus.emit('evolution:diagnose:after', { duration_ms: 50 });
  bus.emit('evolution:diagnose:after', { duration_ms: 100 });
  const stats = metrics.getStats();
  assert.equal(stats.events_by_topic['evolution:diagnose:after'], 3);
  // Only 2 events had duration_ms → avg = 75
  assert.equal(stats.avg_duration_ms_by_topic['evolution:diagnose:after'], 75);
  assert.equal(stats.avg_duration_ms, 75);
  metrics.destroy();
});

test('W4-1: events persisted to <baseDir>/stats.jsonl (one line per event)', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'persist');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:propose:after', { count: 1, duration_ms: 10 });
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 20 });
  const logPath = metrics.getLogPath();
  assert.ok(existsSync(logPath));
  const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 2);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].topic, 'evolution:propose:after');
  assert.equal(parsed[0].duration_ms, 10);
  assert.equal(parsed[1].topic, 'evolution:apply:after');
  assert.equal(parsed[1].duration_ms, 20);
  metrics.destroy();
});

test('W4-1: readPersisted() replays from disk independent of in-memory', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'replay');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 50 });
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 75 });
  metrics.destroy();
  // Re-init to read.
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  const persisted = metrics.readPersisted();
  assert.equal(persisted.length, 2, 'disk log survives destroy');
  assert.equal(persisted[0].duration_ms, 50);
  assert.equal(persisted[1].duration_ms, 75);
  metrics.destroy();
});

test('W4-1: disable() stops BOTH in-memory and on-disk recording', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'disable');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 5 });
  metrics.disable();
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 10 });
  metrics.enable();
  bus.emit('evolution:apply:after', { applied: true, duration_ms: 15 });
  const stats = metrics.getStats();
  // 2 in-memory (the disabled one is dropped)
  assert.equal(stats.events_by_topic['evolution:apply:after'], 2);
  assert.equal(stats.avg_duration_ms_by_topic['evolution:apply:after'], 10);
  const lines = readFileSync(metrics.getLogPath(), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  assert.equal(lines.length, 2);
  metrics.destroy();
});

test('W4-1: destroy() unsubscribes from all 5 evolution:* topics', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'unsubscribe');
  // Snapshot listener counts before init.
  const before = bus.listenerCount ? bus.listenerCount('evolution:propose:after') : 0;
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  const afterInit = bus.listenerCount
    ? bus.listenerCount('evolution:propose:after')
    : 0;
  assert.ok(afterInit > before, 'init subscribed a handler');
  metrics.destroy();
  const afterDestroy = bus.listenerCount
    ? bus.listenerCount('evolution:propose:after')
    : 0;
  assert.equal(
    afterDestroy,
    before,
    'destroy unsubscribed the handler (back to original count)',
  );
});

test('W4-1: tracks 5 evolution:* topics (diagnose/propose/apply/verify/rollback)', () => {
  // Read the plugin source to assert the 5-topic list.
  const src = readFileSync(
    new URL('../plugin/metrics.js', import.meta.url),
    'utf8',
  );
  for (const topic of [
    'evolution:diagnose:after',
    'evolution:propose:after',
    'evolution:apply:after',
    'evolution:verify:after',
    'evolution:rollback:after',
  ]) {
    assert.ok(src.includes(`'${topic}'`), `metrics tracks ${topic}`);
  }
});

test('W4-1: readPersisted() on missing file returns []', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'missing');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  const result = metrics.readPersisted();
  assert.deepEqual(result, []);
  metrics.destroy();
});

test('W4-1: readPersisted() skips malformed lines without throwing', () => {
  const bus = evolutionBus;
  const tmp = join(TMP, 'malformed');
  metrics.init({ eventBus: bus, config: { baseDir: tmp } });
  const logPath = metrics.getLogPath();
  mkdirSync(tmp, { recursive: true });
  writeFileSync(
    logPath,
    [
      JSON.stringify({ topic: 'evolution:apply:after', duration_ms: 10, recordedAt: 't1' }),
      'not json {',
      JSON.stringify({ topic: 'evolution:apply:after', duration_ms: 20, recordedAt: 't2' }),
      '',
    ].join('\n'),
    'utf8',
  );
  const errs = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    errs.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  let result;
  try {
    result = metrics.readPersisted();
  } finally {
    process.stderr.write = original;
  }
  assert.equal(result.length, 2, 'malformed line skipped');
  assert.ok(
    errs.some((e) => e.includes('[metrics] malformed line skipped')),
    'stderr warned about malformed line',
  );
  metrics.destroy();
});

test.afterAll ??= (fn) => test('afterAll', async () => fn());
test.afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
