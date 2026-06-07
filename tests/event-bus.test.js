/**
 * EventBus unit tests — TDD red→green for PR 2.
 *
 * Coverage targets:
 * - basic emit/on
 * - once auto-unbinds
 * - off manual unbind
 * - waitFor + timeout
 * - schema validation (throw on invalid payload)
 * - async handler error isolation
 * - setMaxListeners config
 * - event constants import + emit
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { EVENTS, EVENT_DOMAINS } from '../core/events.js';

describe('EventBus basics', () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();
  });

  test('emit + on: handler receives payload', () => {
    let received = null;
    bus.on('test:event', (payload) => {
      received = payload;
    });
    bus.emit('test:event', { foo: 'bar' });
    assert.deepEqual(received, { foo: 'bar' });
  });

  test('emit returns true when listeners exist, false otherwise', () => {
    assert.equal(bus.emit('test:no-listeners'), false);
    bus.on('test:with-listener', () => {});
    assert.equal(bus.emit('test:with-listener'), true);
  });

  test('once auto-unbinds after first fire', () => {
    let count = 0;
    bus.once('test:once', () => {
      count++;
    });
    bus.emit('test:once');
    bus.emit('test:once');
    bus.emit('test:once');
    assert.equal(count, 1);
  });

  test('off manually unbinds handler', () => {
    let count = 0;
    const handler = () => {
      count++;
    };
    bus.on('test:off', handler);
    bus.emit('test:off');
    bus.off('test:off', handler);
    bus.emit('test:off');
    assert.equal(count, 1);
  });
});

describe('EventBus waitFor', () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();
  });

  test('waitFor resolves when event fires', async () => {
    const promise = bus.waitFor('test:ready', 1000);
    setTimeout(() => bus.emit('test:ready', { ok: true }), 10);
    const result = await promise;
    assert.deepEqual(result, { ok: true });
  });

  test('waitFor rejects on timeout', async () => {
    await assert.rejects(() => bus.waitFor('test:never', 50), /timeout after 50ms/);
  });

  test('waitFor with timeout=0 waits forever', async () => {
    const promise = bus.waitFor('test:forever', 0);
    setTimeout(() => bus.emit('test:forever', 42), 10);
    const result = await promise;
    assert.equal(result, 42);
  });
});

describe('EventBus schema validation', () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();
  });

  test('schema-less events accept any payload', () => {
    assert.doesNotThrow(() => bus.emit('test:no-schema', { anything: true }));
    assert.doesNotThrow(() => bus.emit('test:no-schema', 'string'));
    assert.doesNotThrow(() => bus.emit('test:no-schema', null));
  });

  test('schema validator runs on emit', () => {
    bus.registerSchema('test:typed', (payload) => {
      if (typeof payload?.name !== 'string') {
        throw new TypeError('payload.name must be string');
      }
    });
    assert.doesNotThrow(() => bus.emit('test:typed', { name: 'ok' }));
    assert.throws(() => bus.emit('test:typed', { name: 42 }), /payload.name must be string/);
  });

  test('registerSchema validates event name', () => {
    assert.throws(() => bus.registerSchema('', () => {}), /non-empty string/);
    assert.throws(() => bus.registerSchema(null, () => {}), /non-empty string/);
  });

  test('registerSchema validates validator is function', () => {
    assert.throws(() => bus.registerSchema('test:bad', 'not-a-fn'), /validator must be function/);
  });
});

describe('EventBus async error isolation', () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();
  });

  test('async handler error does not break sibling handlers', async () => {
    let siblingRan = false;
    bus.on('test:async-fail', async () => {
      throw new Error('intentional');
    });
    bus.on('test:async-fail', async () => {
      siblingRan = true;
    });
    // Suppress console.error for this test
    const origError = console.error;
    console.error = () => {};
    bus.emit('test:async-fail', {});
    // Give microtasks a chance to settle
    await new Promise((r) => setImmediate(r));
    console.error = origError;
    assert.equal(siblingRan, true);
  });
});

describe('EventBus configuration', () => {
  test('setMaxListeners default = 100', () => {
    const bus = new EventBus();
    assert.equal(bus.getMaxListeners(), 100);
  });

  test('setMaxListeners configurable', () => {
    const bus = new EventBus({ maxListeners: 50 });
    assert.equal(bus.getMaxListeners(), 50);
  });
});

describe('EventBus + EVENTS constants', () => {
  test('emitting by EVENTS constant works', () => {
    const bus = new EventBus();
    let received = null;
    bus.on(EVENTS.CORE_READY, (payload) => {
      received = payload;
    });
    bus.emit(EVENTS.CORE_READY, { status: 'ok' });
    assert.deepEqual(received, { status: 'ok' });
  });

  test('EVENTS object is frozen', () => {
    assert.throws(() => {
      EVENTS.CORE_READY = 'mutated';
    }, /Cannot assign to read only property/);
  });

  test('EVENT_DOMAINS is frozen', () => {
    assert.throws(() => {
      EVENT_DOMAINS.CORE = 'mutated';
    }, /Cannot assign to read only property/);
  });

  test('EVENTS has all required domains (core only — adapter/skill/tool removed at v2 launch cleanup 2026-06-07)', () => {
    const required = [
      'CORE_READY',
      'LIFECYCLE_BOOTSTRAP_START',
      'PROVIDER_CALL_BEFORE',
      'MEMORY_STORE',
      'EVOLUTION_APPLY_AFTER',
      'PLUGIN_LOAD_REQUEST',
    ];
    for (const key of required) {
      assert.ok(EVENTS[key], `EVENTS.${key} must exist`);
      assert.ok(EVENTS[key].includes(':'), `EVENTS.${key} must use ':' separator`);
    }
  });
});
