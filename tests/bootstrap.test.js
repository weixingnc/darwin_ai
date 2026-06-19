/**
 * Bootstrap unit + integration tests — TDD red→green for PR 5.
 *
 * Coverage targets:
 * - happy path: bootstrap() returns a Container
 * - happy path: bootstrap({ container }) uses a caller-provided container (test seam)
 * - happy path: bootstrap emits LIFECYCLE_BOOTSTRAP_START, every phase event,
 *               LIFECYCLE_BOOTSTRAP_DONE, CORE_READY — in that order
 * - core services wired: eventBus / configResolver / errorHandler resolvable
 * - error path: a wired service that throws → CORE_ERROR fired, ErrorHandler.handle runs,
 *               bootstrap does NOT throw to caller
 * - boundary: bootstrap is sync (returns synchronously)
 *
 * Test seam: bootstrap({ container }) lets tests inject a pre-built container with
 * a tracked EventBus so we can assert emit order. Without an injected container,
 * bootstrap builds its own.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../lifecycle/bootstrap.js';
import { EVENTS } from '../core/events.js';
import { EventBus } from '../core/event-bus.js';
import { Container } from '../core/container.js';
import { ErrorHandler } from '../core/error-handler.js';

/** Build a container with a tracked bus + a real configResolver + ErrorHandler. */
function makeTrackedContainer() {
  const c = new Container();
  const bus = new EventBus();
  c.register('eventBus', () => bus);
  c.register('configResolver', () => ({ get: () => ({}), invalidate: () => undefined }));
  c.register('errorHandler', () => ErrorHandler);
  return { container: c, bus };
}

const PHASE_EVENTS = [
  'lifecycle:bootstrap:init',
  'lifecycle:bootstrap:config',
  'lifecycle:bootstrap:container',
  'lifecycle:bootstrap:registry',
  'lifecycle:bootstrap:cron',
  'lifecycle:bootstrap:ready',
];
const FULL_EVENT_ORDER = [
  EVENTS.LIFECYCLE_BOOTSTRAP_START,
  ...PHASE_EVENTS,
  EVENTS.LIFECYCLE_BOOTSTRAP_DONE,
  EVENTS.CORE_READY,
];

describe('bootstrap happy path', () => {
  test('returns a Container instance', () => {
    const c = bootstrap();
    assert.ok(c instanceof Container);
  });

  test('core services are wired and resolvable', () => {
    const c = bootstrap();
    assert.ok(c.get('eventBus') instanceof EventBus);
    assert.equal(typeof c.get('configResolver').get, 'function');
    assert.equal(typeof c.get('errorHandler').handle, 'function');
  });

  test('cron service is registered after bootstrap (V7 cycle 2)', () => {
    const c = bootstrap();
    const cron = c.get('cron');
    assert.ok(cron, 'cron service must be registered under key "cron"');
    assert.equal(typeof cron.register, 'function');
    assert.equal(typeof cron.start, 'function');
    assert.equal(typeof cron.stop, 'function');
    assert.equal(typeof cron.tick, 'function');
    // list() returns diagnostics — bootstrap hasn't started any jobs.
    const diag = cron.list();
    assert.equal(diag.totalRegistered, 0);
    assert.equal(diag.started, false);
  });

  test('emits START → *phases → DONE → CORE_READY in order on the framework bus', () => {
    const { container, bus } = makeTrackedContainer();
    const seen = [];
    for (const evt of FULL_EVENT_ORDER) {
      bus.on(evt, () => seen.push(evt));
    }
    bootstrap({ container });
    assert.deepEqual(seen, FULL_EVENT_ORDER);
  });

  test('passes a phase payload on each phase event', () => {
    const { container, bus } = makeTrackedContainer();
    const payloads = [];
    for (const phase of ['init', 'config', 'container', 'registry', 'cron', 'ready']) {
      bus.on(`lifecycle:bootstrap:${phase}`, (p) => payloads.push({ phase, p }));
    }
    bootstrap({ container });
    assert.equal(payloads.length, 6);
    for (const { phase, p } of payloads) {
      assert.equal(p.phase, phase);
      assert.ok(p.container instanceof Container);
    }
  });
});

describe('bootstrap error path', () => {
  test('factory throw on a wired service → CORE_ERROR fired, no throw to caller', () => {
    const c = new Container();
    const bus = new EventBus();
    const captured = [];
    bus.on(EVENTS.CORE_ERROR, (entry) => captured.push(entry));
    c.register('eventBus', () => bus);
    c.register('configResolver', () => ({
      get: () => {
        throw new Error('config exploded');
      },
      invalidate: () => undefined,
    }));
    c.register('errorHandler', () => ErrorHandler);

    let result;
    assert.doesNotThrow(() => {
      result = bootstrap({ container: c });
    }, 'bootstrap must not throw to caller on internal failure');
    assert.ok(result instanceof Container, 'bootstrap must return a Container even on failure');
    assert.ok(captured.length >= 1, 'CORE_ERROR must fire at least once');
    const entry = captured[0];
    assert.equal(entry.ok, false);
    assert.ok(entry.error);
  });
});

describe('bootstrap sync contract', () => {
  test('bootstrap returns synchronously (no Promise)', () => {
    const r = bootstrap();
    assert.ok(!(r instanceof Promise), 'bootstrap must be sync — no Promise returned');
    assert.ok(r instanceof Container);
  });
});
