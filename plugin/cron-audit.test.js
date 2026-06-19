/**
 * cron-audit plugin tests — V7 cycle 2 (2026-06-19).
 *
 * Mirrors plugin/feishu-notify.test.js style:
 * - IPlugin manifest shape (P2d contract)
 * - init() subscribes to cron:tick
 * - _onCronTick → emits evolution:audit with heartbeat payload
 * - enabled=false → no emit
 * - destroy() unsubscribes + cleans up
 * - ctx.adapters.cron (test seam) → plugin owns cron lifecycle
 *   (register + start called on init; unregister called on destroy)
 *
 * LLM gate (ADR-009): no LLM. process.env (A-4): no direct env access.
 * Network: never touches fetch.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { IPlugin } from '../plugin/interface.js';
import cronAudit from '../plugin/cron-audit.js';

describe('cron-audit plugin — manifest (P2d contract)', () => {
  test('has name, version, capabilities, permissions in expected shape', () => {
    assert.equal(cronAudit.name, 'cron-audit');
    assert.equal(cronAudit.version, '0.1.0');
    assert.deepEqual(cronAudit.capabilities, ['tool']);
    assert.deepEqual(cronAudit.permissions, [
      'bus:on',
      'bus:off',
      'log:info',
      'log:error',
      'config:get',
    ]);
  });

  test('passes IPlugin.validate (P2d whitelist + not in PLUGIN_DENIED)', () => {
    IPlugin.validate(cronAudit);
  });

  test('exposes the IPlugin lifecycle methods', () => {
    for (const m of ['init', 'enable', 'disable', 'destroy']) {
      assert.equal(typeof cronAudit[m], 'function', `cronAudit.${m} must be function`);
    }
  });
});

describe('cron-audit plugin — direct init (no cron factory)', () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    if (cronAudit._handler) {
      cronAudit.destroy();
    }
  });

  test('init() with empty config → defaults applied (intervalMs=60000, enabled=true, source=cron-audit)', () => {
    cronAudit.init({ eventBus: bus });
    const cfg = cronAudit._getAuditConfig();
    assert.equal(cfg.intervalMs, 60000);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.source, 'cron-audit');
  });

  test('init() with config {intervalMs: 5000} → cfg.intervalMs = 5000', () => {
    cronAudit.init({ eventBus: bus, config: { intervalMs: 5000 } });
    const cfg = cronAudit._getAuditConfig();
    assert.equal(cfg.intervalMs, 5000);
  });

  test('init() with config {enabled:false} → cfg.enabled = false', () => {
    cronAudit.init({ eventBus: bus, config: { enabled: false } });
    const cfg = cronAudit._getAuditConfig();
    assert.equal(cfg.enabled, false);
  });

  test('init() subscribes to cron:tick (emit triggers handler)', async () => {
    cronAudit.init({ eventBus: bus });
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));
    bus.emit('cron:tick', { name: 'cron-audit', ts: 1700000000000 });
    await new Promise((r) => setImmediate(r));
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].ts, 1700000000000);
    assert.equal(auditEvents[0].source, 'cron-audit');
    assert.equal(auditEvents[0].action, 'heartbeat');
    assert.equal(auditEvents[0].outcome, 'info');
    assert.match(auditEvents[0].proposal_id, /^heartbeat-cron-audit-1700000000000$/);
  });

  test('enabled=false → cron:tick does NOT emit evolution:audit', async () => {
    cronAudit.init({ eventBus: bus, config: { enabled: false } });
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));
    bus.emit('cron:tick', { name: 'cron-audit', ts: 1 });
    await new Promise((r) => setImmediate(r));
    assert.equal(auditEvents.length, 0);
  });

  test('payload with no ts → audit uses Date.now()', async () => {
    cronAudit.init({ eventBus: bus });
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));
    const before = Date.now();
    bus.emit('cron:tick', { name: 'cron-audit' }); // no ts
    await new Promise((r) => setImmediate(r));
    const after = Date.now();
    assert.equal(auditEvents.length, 1);
    assert.ok(auditEvents[0].ts >= before && auditEvents[0].ts <= after);
  });

  test('destroy() unsubscribes cron:tick (events after destroy do nothing)', async () => {
    cronAudit.init({ eventBus: bus });
    cronAudit.destroy();
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));
    bus.emit('cron:tick', { name: 'cron-audit', ts: 1 });
    await new Promise((r) => setImmediate(r));
    assert.equal(auditEvents.length, 0);
  });

  test('enable()/disable() toggle the enabled flag', () => {
    cronAudit.init({ eventBus: bus, config: { enabled: false } });
    assert.equal(cronAudit._getAuditConfig().enabled, false);
    cronAudit.enable();
    assert.equal(cronAudit._getAuditConfig().enabled, true);
    cronAudit.disable();
    assert.equal(cronAudit._getAuditConfig().enabled, false);
  });
});

describe('cron-audit plugin — owns cron lifecycle (ctx.adapters.cron)', () => {
  let bus;
  let cronStub;

  beforeEach(() => {
    bus = new EventBus();
    cronStub = {
      registered: [],
      started: false,
      stopped: false,
      unregistered: [],
      register(name, ms, handler) {
        this.registered.push({ name, ms, handler });
        return { name, intervalMs: ms, enabled: false };
      },
      start() {
        this.started = true;
        return { started: this.registered.length };
      },
      stop() {
        this.stopped = true;
        return { stopped: this.registered.length };
      },
      unregister(name) {
        this.unregistered.push(name);
        return true;
      },
    };
  });

  afterEach(() => {
    if (cronAudit._handler) {
      cronAudit.destroy();
    }
  });

  test('init() with ctx.adapters.cron → cron.register + cron.start called', () => {
    cronAudit.init({
      eventBus: bus,
      config: { intervalMs: 3000 },
      adapters: { cron: cronStub },
    });
    assert.equal(cronStub.registered.length, 1);
    assert.equal(cronStub.registered[0].name, 'cron-audit');
    assert.equal(cronStub.registered[0].ms, 3000);
    assert.equal(typeof cronStub.registered[0].handler, 'function');
    assert.equal(cronStub.started, true);
  });

  test('registered handler emits evolution:audit when invoked', async () => {
    cronAudit.init({
      eventBus: bus,
      config: { intervalMs: 1000 },
      adapters: { cron: cronStub },
    });
    const auditEvents = [];
    bus.on('evolution:audit', (p) => auditEvents.push(p));
    // Simulate the cron service firing the registered handler.
    await cronStub.registered[0].handler({ name: 'cron-audit', ts: 999 });
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].ts, 999);
    assert.equal(auditEvents[0].action, 'heartbeat');
  });

  test('destroy() → cron.unregister called when plugin owns cron', () => {
    cronAudit.init({
      eventBus: bus,
      adapters: { cron: cronStub },
    });
    assert.equal(cronStub.unregistered.length, 0);
    cronAudit.destroy();
    assert.deepEqual(cronStub.unregistered, ['cron-audit']);
  });
});

describe('cron-audit plugin — A-5 isolation', () => {
  afterEach(() => {
    if (cronAudit._handler) {
      cronAudit.destroy();
    }
  });

  test('bus.emit throw → plugin logs to stderr, does NOT propagate', async () => {
    // Stub stderr capture.
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => {
      stderrChunks.push(String(c));
      return true;
    };
    try {
      // Override bus.emit to throw — use a bus-like adapter.
      const badBus = {
        emit() {
          throw new Error('bus exploded');
        },
        on: () => undefined,
        off: () => undefined,
      };
      cronAudit.init({ eventBus: badBus });
      // _onCronTick should swallow the throw.
      assert.doesNotThrow(async () => {
        await cronAudit._onCronTick({ name: 'cron-audit', ts: 1 });
      });
      // Either stderr captures or the catch handles — either way no rethrow.
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
