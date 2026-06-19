/**
 * cron-audit e2e — V7 cycle 2 P2-ext 调度面升级 (2026-06-19).
 *
 * Four-part round-trip:
 *   (a) lifecycle/cron + plugin/cron-audit chain — register a cron job,
 *       tick it, verify bus emits 'evolution:audit' with the heartbeat
 *       payload (proposal_id, action='heartbeat', outcome='info',
 *       source='cron-audit').
 *   (b) bootstrap — PHASES_ORDER has 'cron', PHASE_FNS.cron registers a
 *       cron service under container key 'cron'. We verify by building
 *       a fresh container + bus + resolver and calling bootstrap(), then
 *       asserting container.has('cron') and that cron.list() reports
 *       no enabled jobs (start() is owned by consumers).
 *   (c) shutdown — cron.stop() is called before SHUTDOWN_START. We
 *       register a fake cron that records stop(), call shutdown(), and
 *       assert the stop was called and observed BEFORE the SHUTDOWN_START
 *       event.
 *   (d) catalogue closure (T7-W1 sandbox pattern) — addToCatalogue
 *       records cron-audit without polluting production catalogue.json.
 *
 * No real timers anywhere (ADR-009 + V7.2 fake setInterval). No LLM.
 * No process.env. No node:fs in plugin (leaf). Catalogue closure uses
 * isolatedFile + _internal.LOG_FILE (T7-W1 lesson).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Container } from '../../core/container.js';
import { EventBus } from '../../core/event-bus.js';
import { EVENTS } from '../../core/events.js';
import { bootstrap } from '../../lifecycle/bootstrap.js';
import { shutdown } from '../../lifecycle/shutdown.js';
import { PHASES, PHASES_ORDER } from '../../lifecycle/phases.js';
import { createCron } from '../../lifecycle/cron.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';
import cronAudit from '../../plugin/cron-audit.js';

// ─── (a) lifecycle/cron + plugin/cron-audit chain ──────────────
describe('cron-audit e2e (a) — cron tick → plugin → bus evolution:audit', () => {
  let bus;
  let cron;

  beforeEach(() => {
    bus = new EventBus();
    cron = createCron({ eventBus: bus });
  });

  test('cron.tick("cron-audit") → bus emits evolution:audit with heartbeat payload', async () => {
    cronAudit.init({ eventBus: bus, adapters: { cron } });
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));

    const before = Date.now();
    const r = cron.tick('cron-audit');
    const after = Date.now();
    await new Promise((res) => setImmediate(res));

    assert.equal(r.triggered, 1);
    assert.equal(auditEvents.length, 1);
    const e = auditEvents[0];
    assert.equal(e.action, 'heartbeat');
    assert.equal(e.outcome, 'info');
    assert.equal(e.source, 'cron-audit');
    assert.match(e.proposal_id, /^heartbeat-cron-audit-\d+$/);
    assert.ok(e.ts >= before && e.ts <= after, 'ts falls within tick window');

    cronAudit.destroy();
    cron.stop();
  });

  test('two cron ticks → 2 evolution:audit events in order', async () => {
    cronAudit.init({ eventBus: bus, adapters: { cron } });
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));

    cron.tick('cron-audit');
    // Force a small sleep so the two ticks land in distinct ms timestamps.
    // (Date.now() can return the same value for back-to-back calls.)
    await new Promise((res) => setTimeout(res, 5));
    cron.tick('cron-audit');
    await new Promise((res) => setImmediate(res));

    assert.equal(auditEvents.length, 2);
    assert.equal(auditEvents[1].ts >= auditEvents[0].ts, true);
    assert.match(auditEvents[0].proposal_id, /-\d+$/);
    assert.match(auditEvents[1].proposal_id, /-\d+$/);

    cronAudit.destroy();
    cron.stop();
  });

  test('cron-audit enabled=false → tick does NOT emit evolution:audit', async () => {
    cronAudit.init({
      eventBus: bus,
      config: { enabled: false },
      adapters: { cron },
    });
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));
    cron.tick('cron-audit');
    await new Promise((res) => setImmediate(res));
    assert.equal(auditEvents.length, 0);
    cronAudit.destroy();
    cron.stop();
  });

  test('cron handler throws → cron:error emitted, plugin still healthy (A-5)', () => {
    // Don't init cron-audit — we want to test raw cron error path.
    const errors = [];
    bus.on('cron:error', (p) => errors.push(p));
    cron.register('bad', 100, () => {
      throw new Error('boom from raw cron');
    });
    assert.doesNotThrow(() => cron.tick('bad'));
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /boom from raw cron/);
    cron.stop();
  });
});

// ─── (b) bootstrap → cron phase ────────────────────────────────
describe('cron-audit e2e (b) — bootstrap registers cron service', () => {
  test('PHASES_ORDER includes cron between registry and ready', () => {
    const idxRegistry = PHASES_ORDER.indexOf(PHASES.REGISTRY);
    const idxCron = PHASES_ORDER.indexOf(PHASES.CRON);
    const idxReady = PHASES_ORDER.indexOf(PHASES.READY);
    assert.ok(idxRegistry >= 0);
    assert.ok(idxCron >= 0);
    assert.ok(idxReady >= 0);
    assert.equal(idxCron, idxRegistry + 1, 'cron immediately after registry');
    assert.equal(idxReady, idxCron + 1, 'ready immediately after cron');
  });

  test('bootstrap() registers cron service under container key "cron"', () => {
    const c = bootstrap();
    assert.equal(c.has('cron'), true);
    const cron = c.get('cron');
    for (const m of ['register', 'start', 'stop', 'tick', 'list']) {
      assert.equal(typeof cron[m], 'function');
    }
    // bootstrap does NOT start cron (per V7.2 thin design — start is owned by consumers).
    const diag = cron.list();
    assert.equal(diag.started, false);
    assert.equal(diag.totalRegistered, 0);
  });

  test('bootstrap() emits lifecycle:bootstrap:cron phase event', () => {
    const c = new Container();
    const bus = new EventBus();
    c.register('eventBus', () => bus);
    c.register('configResolver', () => ({ get: () => ({}), invalidate: () => undefined }));
    c.register('errorHandler', () => ({ handle: (e) => ({ ok: false, error: String(e) }) }));

    const seen = [];
    bus.on('lifecycle:bootstrap:cron', (p) => seen.push(p));
    bootstrap({ container: c });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].phase, 'cron');
    assert.ok(seen[0].container instanceof Container);
  });
});

// ─── (c) shutdown → cron.stop() ────────────────────────────────
describe('cron-audit e2e (c) — shutdown stops cron first', () => {
  test('shutdown() calls container.get(cron).stop() before SHUTDOWN_START', () => {
    const stopOrder = [];
    const c = new Container();
    const bus = new EventBus();
    c.register('eventBus', () => bus);
    c.register('cron', () => ({
      stop() {
        stopOrder.push('cron-stop');
      },
    }));
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_START, () => stopOrder.push('shutdown-start'));

    shutdown({ container: c });
    assert.deepEqual(stopOrder, ['cron-stop', 'shutdown-start']);
  });

  test('full chain: manual cron service + shutdown stops cron (no real timers)', () => {
    // Use a fake-setInterval cron to keep the test deterministic and not
    // leak real timers into Node's event loop.
    const setI = {
      calls: [],
      impl: (cb, ms) => {
        setI.calls.push({ ms, callback: cb });
        return setI.calls.length;
      },
    };
    const clearI = {
      calls: [],
      impl: (id) => {
        clearI.calls.push(id);
      },
    };

    const c = new Container();
    const bus = new EventBus();
    c.register('eventBus', () => bus);
    c.register('configResolver', () => ({ get: () => ({}), invalidate: () => undefined }));
    c.register('errorHandler', () => ({ handle: (e) => ({ ok: false, error: String(e) }) }));
    const cron = createCron({
      eventBus: bus,
      setIntervalImpl: setI.impl,
      clearIntervalImpl: clearI.impl,
    });
    c.register('cron', () => cron);

    cron.register('test-job', 1000, () => {});
    cron.start();
    assert.equal(setI.calls.length, 1);
    assert.equal(cron.list().started, true);

    shutdown({ container: c });
    assert.equal(clearI.calls.length, 1, 'shutdown must clear the cron interval');
    assert.equal(cron.list().started, false);
  });
});

// ─── (d) catalogue closure ─────────────────────────────────────
describe('cron-audit e2e (d) — catalogue closure (T7-W1 sandbox)', () => {
  test('addToCatalogue(plugins, cron-audit, sandboxed) → true; duplicate → false', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c1-cron-audit-'));
    const isolatedFile = join(tmp, 'catalogue-c1-cron-audit.json');

    const first = addToCatalogue('plugins', 'cron-audit', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
      reason: 'V7 cycle 2 P2-ext: cron scheduler plugin for audit heartbeat',
    });
    assert.equal(first, true);

    const second = addToCatalogue('plugins', 'cron-audit', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
      reason: 'V7 cycle 2 P2-ext: cron scheduler plugin for audit heartbeat (replay)',
    });
    assert.equal(second, false);
  });
});
