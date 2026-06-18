/**
 * P2j (2026-06-18) — audit plugin persistence tests.
 *
 * Verifies the upgraded audit plugin (plugin/audit.js v0.2.0):
 *   1. Records events to in-memory log (P2c-2 behavior preserved)
 *   2. Persists each event to <baseDir>/audit.jsonl
 *   3. readPersisted() replays from disk independent of in-memory
 *   4. Permission 'fs:write' passes IPlugin.validate (P2d contract)
 *   5. destroy() doesn't lose persisted data (file survives)
 *   6. disable() stops BOTH in-memory and on-disk recording
 *   7. Permission is in PLUGIN_PERMISSIONS, NOT in PLUGIN_DENIED
 *      (so static check passes; runtime sandbox opt-in decides)
 *   8. readPersisted() handles missing file gracefully (returns [])
 *   9. readPersisted() skips malformed lines without throwing
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import audit from '../plugin/audit.js';
import { IPlugin, PLUGIN_PERMISSIONS, PLUGIN_DENIED } from '../plugin/interface.js';
import { evolutionBus } from '../evolution/_bus.js';

const TMP = mkdtempSync(join(tmpdir(), 'p2j-'));

function makeBus() {
  // Each test gets a fresh bus-like object. evolutionBus is module-scope
  // and shared across tests — we don't depend on a clean bus because
  // audit subscribes to specific topics; we just emit on those topics
  // and assert the audit log.
  return evolutionBus;
}

test('P2j: manifest validates (fs:append is in PLUGIN_PERMISSIONS)', () => {
  // The plugin manifest now declares 'fs:append' (needed for audit.jsonl).
  // P2d's static manifest check should accept it because:
  //   - 'fs:append' is in PLUGIN_PERMISSIONS (append-only, no overwrite)
  //   - 'fs:append' is NOT in PLUGIN_DENIED (which has fs:write)
  assert.ok(PLUGIN_PERMISSIONS.includes('fs:append'));
  assert.ok(!PLUGIN_DENIED.includes('fs:append'));
  // The full manifest still validates cleanly under IPlugin.
  assert.doesNotThrow(() => IPlugin.validate(audit));
});

test('P2j: in-memory getEvents() works (P2c-2 behavior preserved)', () => {
  const bus = makeBus();
  const tmp = join(TMP, 'mem');
  audit._bus = null; // reset from prior tests
  audit.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:propose:after', { count: 1 });
  bus.emit('evolution:apply:after', { tag_sha: 'abc123' });
  const events = audit.getEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].topic, 'evolution:propose:after');
  assert.equal(events[1].topic, 'evolution:apply:after');
  audit.destroy();
});

test('P2j: events persisted to <baseDir>/audit.jsonl (one line per event)', () => {
  const bus = makeBus();
  const tmp = join(TMP, 'persist');
  audit.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:propose:after', { count: 7 });
  bus.emit('evolution:apply:after', { applied: true });
  bus.emit('evolution:apply:after', { applied: false });
  // File should exist and have 3 JSONL lines.
  const logPath = audit.getLogPath();
  assert.ok(existsSync(logPath), `expected ${logPath} to exist`);
  const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 3);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].topic, 'evolution:propose:after');
  assert.equal(parsed[0].payload.count, 7);
  assert.equal(parsed[1].payload.applied, true);
  assert.equal(parsed[2].payload.applied, false);
  audit.destroy();
});

test('P2j: readPersisted() replays from disk independent of in-memory', () => {
  const bus = makeBus();
  const tmp = join(TMP, 'replay');
  audit.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:propose:after', { count: 1 });
  bus.emit('evolution:apply:after', { applied: true });
  // destroy() wipes in-memory but file survives.
  audit.destroy();
  assert.equal(audit.getEvents().length, 0, 'in-memory wiped');
  // Re-init to bind getLogPath / readPersisted (these are instance state).
  audit.init({ eventBus: bus, config: { baseDir: tmp } });
  const persisted = audit.readPersisted();
  assert.equal(persisted.length, 2, 'disk log survives destroy');
  assert.equal(persisted[0].topic, 'evolution:propose:after');
  assert.equal(persisted[1].topic, 'evolution:apply:after');
  audit.destroy();
});

test('P2j: disable() stops BOTH in-memory and on-disk recording', () => {
  const bus = makeBus();
  const tmp = join(TMP, 'disable');
  audit.init({ eventBus: bus, config: { baseDir: tmp } });
  bus.emit('evolution:propose:after', { count: 1 });
  audit.disable();
  bus.emit('evolution:propose:after', { count: 2 });
  audit.enable();
  bus.emit('evolution:propose:after', { count: 3 });
  // In-memory: 2 events (the disabled one is dropped).
  assert.equal(audit.getEvents().length, 2);
  // On-disk: same 2 events.
  const lines = readFileSync(audit.getLogPath(), 'utf8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 2);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].payload.count, 1);
  assert.equal(parsed[1].payload.count, 3);
  audit.destroy();
});

test('P2j: readPersisted() on missing file returns []', () => {
  const bus = makeBus();
  const tmp = join(TMP, 'missing');
  audit.init({ eventBus: bus, config: { baseDir: tmp } });
  // No events emitted → file may or may not exist (mkdirSync only writes
  // on first _record). Either way readPersisted should return [].
  const result = audit.readPersisted();
  assert.deepEqual(result, []);
  audit.destroy();
});

test('P2j: readPersisted() skips malformed lines without throwing', () => {
  const bus = makeBus();
  const tmp = join(TMP, 'malformed');
  audit.init({ eventBus: bus, config: { baseDir: tmp } });
  // Write one valid + one malformed + one valid line directly to disk.
  const logPath = audit.getLogPath();
  mkdirSync(tmp, { recursive: true });
  writeFileSync(
    logPath,
    [
      JSON.stringify({ topic: 'evolution:propose:after', payload: { count: 1 }, recordedAt: 't1' }),
      'this is not json {',
      JSON.stringify({ topic: 'evolution:apply:after', payload: { applied: true }, recordedAt: 't2' }),
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
    result = audit.readPersisted();
  } finally {
    process.stderr.write = original;
  }
  assert.equal(result.length, 2, 'malformed line skipped');
  assert.equal(result[0].topic, 'evolution:propose:after');
  assert.equal(result[1].topic, 'evolution:apply:after');
  assert.ok(
    errs.some((e) => e.includes('[audit] malformed line skipped')),
    'stderr warned about malformed line',
  );
  audit.destroy();
});

test('P2j: audit plugin manifest version bumped to 0.2.0', () => {
  // Sanity check that the version bump is reflected in the manifest
  // (so consumers can detect the P2j upgrade).
  assert.equal(audit.version, '0.2.0');
});

test.afterAll ??= (fn) => test('afterAll', async () => fn());
test.afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});