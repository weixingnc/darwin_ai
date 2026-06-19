/**
 * cron factory unit tests — V7 cycle 2 (2026-06-19).
 *
 * Mirrors lifecycle/bootstrap.test.js style (node --test, no extra deps).
 *
 * Coverage targets:
 * - createCron returns object with register/start/stop/tick/list
 * - register valid → returns handle {name, intervalMs, enabled: false}
 * - register invalid (name, intervalMs, handler) → throws
 * - unregister(name) → removes from registry
 * - start() with no enabled jobs → {started: 0}
 * - start() with jobs → fake setInterval called for each
 * - stop() → fake clearInterval called for each
 * - stop() idempotent (second call returns {stopped: 0})
 * - tick(name) → emit cron:tick + handler called with {ts, name}
 * - tick() (no name) → triggers all registered
 * - handler throws → emit cron:error, no propagation (A-5)
 * - setIntervalImpl / clearIntervalImpl injection (fakes, not real timers)
 * - start() twice → idempotent (second {started: 0})
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { createCron } from './cron.js';

/** Build a fake setInterval that records every call and lets us fire
 *  the callback synchronously. Returns {impl, fire(name)}. */
function fakeSetInterval() {
  const calls = [];
  const callbacks = new Map();
  let nextId = 1;
  const impl = (cb, ms) => {
    const id = nextId++;
    calls.push({ id, ms, callback: cb });
    // We don't have a name here — fake stores the callback keyed by id;
    // tests that need to fire by name use registerByName via the impl
    // returning the id only. We'll use the list() shape to find by intervalMs.
    callbacks.set(id, cb);
    return id;
  };
  impl.calls = calls;
  impl.callbacks = callbacks;
  impl.clearById = (id) => {
    callbacks.delete(id);
  };
  return impl;
}

/** Build a fake clearInterval that records. */
function fakeClearInterval() {
  const calls = [];
  const impl = (id) => {
    calls.push(id);
  };
  impl.calls = calls;
  return impl;
}

describe('createCron — factory shape', () => {
  test('returns object with register/unregister/start/stop/tick/list/events', () => {
    const c = createCron();
    for (const m of ['register', 'unregister', 'start', 'stop', 'tick', 'list']) {
      assert.equal(typeof c[m], 'function', `cron.${m} must be function`);
    }
    assert.equal(c.events.TICK, 'cron:tick');
    assert.equal(c.events.START, 'cron:start');
    assert.equal(c.events.STOP, 'cron:stop');
    assert.equal(c.events.ERROR_EVT, 'cron:error');
  });

  test('list() returns diagnostics: totalRegistered, totalEnabled, started', () => {
    const c = createCron();
    const r = c.list();
    assert.equal(r.totalRegistered, 0);
    assert.equal(r.totalEnabled, 0);
    assert.equal(r.started, false);
    assert.deepEqual(r.names, []);
  });
});

describe('createCron — register', () => {
  test('register(name, intervalMs, handler) → returns {name, intervalMs, enabled: false}', () => {
    const c = createCron();
    const h = c.register('heartbeat', 1000, () => {});
    assert.equal(h.name, 'heartbeat');
    assert.equal(h.intervalMs, 1000);
    assert.equal(h.enabled, false);
    assert.equal(c.list().totalRegistered, 1);
  });

  test('register with non-string name → throws TypeError', () => {
    const c = createCron();
    assert.throws(() => c.register(42, 1000, () => {}), /lowercase string/);
    assert.throws(() => c.register('', 1000, () => {}), /lowercase string/);
    assert.throws(() => c.register('MixedCase', 1000, () => {}), /lowercase string/);
  });

  test('register with non-positive intervalMs → throws TypeError', () => {
    const c = createCron();
    assert.throws(() => c.register('a', 0, () => {}), /> 0/);
    assert.throws(() => c.register('a', -1, () => {}), /> 0/);
    assert.throws(() => c.register('a', NaN, () => {}), /> 0/);
    assert.throws(() => c.register('a', Infinity, () => {}), /> 0/);
  });

  test('register with non-function handler → throws TypeError', () => {
    const c = createCron();
    assert.throws(() => c.register('a', 1000, null), /function/);
    assert.throws(() => c.register('a', 1000, 'string'), /function/);
  });

  test('re-register replaces handle (idempotent on duplicate name)', () => {
    const c = createCron();
    c.register('a', 1000, () => {});
    const r = c.register('a', 2000, () => {});
    assert.equal(r.intervalMs, 2000);
    assert.equal(c.list().totalRegistered, 1);
  });
});

describe('createCron — unregister', () => {
  test('unregister(name) → removes from registry, returns true', () => {
    const c = createCron();
    c.register('a', 1000, () => {});
    assert.equal(c.unregister('a'), true);
    assert.equal(c.list().totalRegistered, 0);
  });

  test('unregister(unknown) → returns false (no throw)', () => {
    const c = createCron();
    assert.equal(c.unregister('not-there'), false);
  });

  test('unregister clears the live interval if started', () => {
    const setI = fakeSetInterval();
    const clearI = fakeClearInterval();
    const c = createCron({ setIntervalImpl: setI, clearIntervalImpl: clearI });
    c.register('a', 100, () => {});
    c.start();
    assert.equal(setI.calls.length, 1);
    c.unregister('a');
    assert.equal(clearI.calls.length, 1);
  });
});

describe('createCron — start/stop', () => {
  test('start() with no jobs → {started: 0}', () => {
    const c = createCron();
    assert.deepEqual(c.start(), { started: 0 });
  });

  test('start() with N jobs → fake setInterval called N times, returns {started: N}', () => {
    const setI = fakeSetInterval();
    const clearI = fakeClearInterval();
    const c = createCron({ setIntervalImpl: setI, clearIntervalImpl: clearI });
    c.register('a', 100, () => {});
    c.register('b', 200, () => {});
    c.register('c', 300, () => {});
    const r = c.start();
    assert.equal(r.started, 3);
    assert.equal(setI.calls.length, 3);
    assert.deepEqual(
      setI.calls.map((x) => x.ms),
      [100, 200, 300],
    );
  });

  test('start() twice → idempotent, second {started: 0}', () => {
    const setI = fakeSetInterval();
    const c = createCron({ setIntervalImpl: setI, clearIntervalImpl: fakeClearInterval() });
    c.register('a', 100, () => {});
    assert.equal(c.start().started, 1);
    assert.equal(c.start().started, 0);
    assert.equal(setI.calls.length, 1);
  });

  test('stop() → fake clearInterval called for each, returns {stopped: N}', () => {
    const setI = fakeSetInterval();
    const clearI = fakeClearInterval();
    const c = createCron({ setIntervalImpl: setI, clearIntervalImpl: clearI });
    c.register('a', 100, () => {});
    c.register('b', 200, () => {});
    c.start();
    const r = c.stop();
    assert.equal(r.stopped, 2);
    assert.equal(clearI.calls.length, 2);
  });

  test('stop() twice → idempotent, second {stopped: 0}', () => {
    const setI = fakeSetInterval();
    const clearI = fakeClearInterval();
    const c = createCron({ setIntervalImpl: setI, clearIntervalImpl: clearI });
    c.register('a', 100, () => {});
    c.start();
    assert.equal(c.stop().stopped, 1);
    assert.equal(c.stop().stopped, 0);
    assert.equal(clearI.calls.length, 1);
  });
});

describe('createCron — tick (manual trigger for tests)', () => {
  test('tick(name) → emits cron:tick with {name, ts} + handler called', () => {
    const bus = new EventBus();
    const seen = [];
    bus.on('cron:tick', (p) => seen.push(p));
    const c = createCron({ eventBus: bus });
    const handlerCalls = [];
    c.register('heartbeat', 1000, (p) => handlerCalls.push(p));
    const r = c.tick('heartbeat');
    assert.equal(r.triggered, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, 'heartbeat');
    assert.equal(typeof seen[0].ts, 'number');
    assert.equal(handlerCalls.length, 1);
    assert.equal(handlerCalls[0].name, 'heartbeat');
    assert.equal(handlerCalls[0].ts, seen[0].ts);
  });

  test('tick() with no name → triggers all registered', () => {
    const bus = new EventBus();
    const tickEvents = [];
    bus.on('cron:tick', (p) => tickEvents.push(p.name));
    const c = createCron({ eventBus: bus });
    const handlerCalls = [];
    c.register('a', 100, () => handlerCalls.push('a'));
    c.register('b', 200, () => handlerCalls.push('b'));
    const r = c.tick();
    assert.equal(r.triggered, 2);
    assert.deepEqual(tickEvents.sort(), ['a', 'b']);
    assert.deepEqual(handlerCalls.sort(), ['a', 'b']);
  });

  test('tick(unknown name) → {triggered: 0}, no emit', () => {
    const bus = new EventBus();
    const tickEvents = [];
    bus.on('cron:tick', (p) => tickEvents.push(p));
    const c = createCron({ eventBus: bus });
    const r = c.tick('nope');
    assert.equal(r.triggered, 0);
    assert.equal(tickEvents.length, 0);
  });
});

describe('createCron — error isolation (A-5)', () => {
  test('handler throws → cron:error emitted, no propagation', () => {
    const bus = new EventBus();
    const errors = [];
    bus.on('cron:error', (p) => errors.push(p));
    const c = createCron({ eventBus: bus });
    c.register('bad', 100, () => {
      throw new Error('boom');
    });
    // tick() should not throw, even though handler does.
    assert.doesNotThrow(() => c.tick('bad'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'bad');
    assert.match(errors[0].message, /boom/);
  });

  test('handler returns rejected promise → cron:error emitted asynchronously', async () => {
    const bus = new EventBus();
    const errors = [];
    bus.on('cron:error', (p) => errors.push(p));
    const c = createCron({ eventBus: bus });
    c.register('async-bad', 100, () => Promise.reject(new Error('async boom')));
    c.tick('async-bad');
    // Wait a microtask for the rejection to land.
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'async-bad');
    assert.match(errors[0].message, /async boom/);
  });

  test('start() handler throws → cron:error on next tick (via fake interval)', async () => {
    const bus = new EventBus();
    const errors = [];
    bus.on('cron:error', (p) => errors.push(p));
    const setI = fakeSetInterval();
    const c = createCron({
      eventBus: bus,
      setIntervalImpl: setI,
      clearIntervalImpl: fakeClearInterval(),
    });
    c.register('bad', 100, () => {
      throw new Error('started boom');
    });
    c.start();
    // Simulate the interval firing once.
    const cb = setI.calls[0].callback;
    assert.doesNotThrow(() => cb(Date.now()));
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /started boom/);
  });
});

describe('createCron — interval injection (no real timers)', () => {
  test('uses opts.setIntervalImpl instead of globalThis.setInterval', () => {
    const setI = fakeSetInterval();
    const c = createCron({ setIntervalImpl: setI, clearIntervalImpl: fakeClearInterval() });
    c.register('a', 100, () => {});
    c.register('b', 200, () => {});
    c.start();
    assert.equal(setI.calls.length, 2);
  });

  test('uses opts.clearIntervalImpl instead of globalThis.clearInterval', () => {
    const setI = fakeSetInterval();
    const clearI = fakeClearInterval();
    const c = createCron({ setIntervalImpl: setI, clearIntervalImpl: clearI });
    c.register('a', 100, () => {});
    c.start();
    c.stop();
    assert.equal(clearI.calls.length, 1);
  });
});

describe('createCron — eventBus-less mode', () => {
  test('works without eventBus (no emit, no crash)', () => {
    const c = createCron();
    c.register('a', 100, () => {});
    assert.doesNotThrow(() => c.start());
    assert.doesNotThrow(() => c.tick('a'));
    assert.doesNotThrow(() => c.stop());
  });
});
