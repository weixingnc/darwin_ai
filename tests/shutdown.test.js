/**
 * Shutdown unit + integration tests — TDD red→green for PR 5.
 *
 * Coverage:
 * - happy path: emits SHUTDOWN_START then SHUTDOWN_DONE
 * - clears container + EventBus (in that order: emit → clear)
 * - idempotent: 2nd call does not throw; first call fires start+done once
 * - defensive: no container / null container does not throw
 * - integration: bootstrap → shutdown full chain
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shutdown } from '../lifecycle/shutdown.js';
import { bootstrap } from '../lifecycle/bootstrap.js';
import { EVENTS } from '../core/events.js';
import { EventBus } from '../core/event-bus.js';
import { Container } from '../core/container.js';

function makeContainer() {
  const c = new Container();
  c.register('eventBus', () => new EventBus());
  c.register('configResolver', () => ({ get: () => ({}), invalidate: () => undefined }));
  c.register('errorHandler', () => ({ handle: () => ({ ok: true }) }));
  return c;
}

describe('shutdown happy path', () => {
  test('emits SHUTDOWN_START then SHUTDOWN_DONE on the framework bus', () => {
    const c = makeContainer();
    const bus = c.get('eventBus');
    const seen = [];
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_START, () => seen.push('start'));
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_DONE, () => seen.push('done'));
    shutdown({ container: c });
    assert.deepEqual(seen, ['start', 'done']);
  });

  test('clears the container (size = 0 after shutdown)', () => {
    const c = makeContainer();
    c.register('extra', () => 42);
    assert.ok(c.size() >= 1);
    shutdown({ container: c });
    assert.equal(c.size(), 0);
  });

  test('clears the EventBus listeners', () => {
    const c = makeContainer();
    const bus = c.get('eventBus');
    bus.on(EVENTS.LIFECYCLE_BOOTSTRAP_START, () => {});
    bus.on('custom:event', () => {});
    assert.ok(bus.listenerCount(EVENTS.LIFECYCLE_BOOTSTRAP_START) >= 1);
    shutdown({ container: c });
    assert.equal(bus.eventNames().length, 0);
  });
});

describe('shutdown cron stop (V7 cycle 2)', () => {
  test('calls container.get(cron).stop() before SHUTDOWN_START if cron service registered', () => {
    let stopCount = 0;
    const c = makeContainer();
    c.register('cron', () => ({
      stop() {
        stopCount += 1;
        return { stopped: 1 };
      },
    }));
    shutdown({ container: c });
    assert.equal(stopCount, 1, 'cron.stop() must be called exactly once');
  });

  test('cron.stop is called BEFORE SHUTDOWN_START (chronological)', () => {
    const seen = [];
    const c = makeContainer();
    c.register('cron', () => ({
      stop() {
        seen.push('cron-stop');
      },
    }));
    const bus = c.get('eventBus');
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_START, () => seen.push('shutdown-start'));
    shutdown({ container: c });
    assert.deepEqual(seen, ['cron-stop', 'shutdown-start']);
  });

  test('shutdown with no cron service registered does not throw (graceful)', () => {
    const c = makeContainer();
    assert.doesNotThrow(() => shutdown({ container: c }));
  });

  test('cron.stop() throwing is swallowed — shutdown still emits START/DONE', () => {
    let doneCount = 0;
    const c = makeContainer();
    c.register('cron', () => ({
      stop() {
        throw new Error('cron blew up');
      },
    }));
    const bus = c.get('eventBus');
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_DONE, () => {
      doneCount += 1;
    });
    assert.doesNotThrow(() => shutdown({ container: c }));
    assert.equal(doneCount, 1);
  });
});

describe('shutdown idempotency', () => {
  test('calling shutdown twice does not throw; first call fires start+done once', () => {
    const c = makeContainer();
    const bus = c.get('eventBus');
    let startCount = 0;
    let doneCount = 0;
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_START, () => startCount++);
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_DONE, () => doneCount++);
    assert.doesNotThrow(() => {
      shutdown({ container: c });
      shutdown({ container: c });
    });
    // 1st call: listeners fire (count=1), then bus cleared.
    // 2nd call: bus empty, listeners gone, emit reaches nobody (count stays 1).
    assert.equal(startCount, 1);
    assert.equal(doneCount, 1);
  });

  test('shutdown with no container does not throw', () => {
    assert.doesNotThrow(() => shutdown());
    assert.doesNotThrow(() => shutdown({ container: null }));
  });
});

describe('bootstrap → shutdown integration', () => {
  test('full lifecycle: bootstrap emits DONE, then shutdown emits DONE', () => {
    const seen = [];
    const c = makeContainer();
    const bus = c.get('eventBus');
    bus.on(EVENTS.LIFECYCLE_BOOTSTRAP_DONE, () => seen.push('bootstrap-done'));
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_DONE, () => seen.push('shutdown-done'));
    bootstrap({ container: c });
    shutdown({ container: c });
    assert.deepEqual(seen, ['bootstrap-done', 'shutdown-done']);
  });
});
