/**
 * Phases unit tests — TDD red→green for PR 5.
 *
 * Coverage targets:
 * - PHASES constant exports 5 named phases in correct order
 * - PHASES is frozen (immutable contract)
 * - PHASE_EVENTS maps each phase to a LIFECYCLE_BOOTSTRAP:* event name
 * - PHASES_ORDER contains exactly the same phases as PHASES, in order
 * - Boundary: phase is string, order is array, every phase has a matching event
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, PHASE_EVENTS, PHASES_ORDER } from '../lifecycle/phases.js';
import { EVENTS } from '../core/events.js';

describe('PHASES constant', () => {
  test('exports exactly 6 phases', () => {
    assert.equal(PHASES_ORDER.length, 6);
  });

  test('phase names are INIT / CONFIG / CONTAINER / REGISTRY / CRON / READY in order', () => {
    assert.equal(PHASES.INIT, 'init');
    assert.equal(PHASES.CONFIG, 'config');
    assert.equal(PHASES.CONTAINER, 'container');
    assert.equal(PHASES.REGISTRY, 'registry');
    assert.equal(PHASES.CRON, 'cron');
    assert.equal(PHASES.READY, 'ready');
  });

  test('PHASES_ORDER matches PHASES values in canonical order', () => {
    assert.deepEqual(PHASES_ORDER, [
      PHASES.INIT,
      PHASES.CONFIG,
      PHASES.CONTAINER,
      PHASES.REGISTRY,
      PHASES.CRON,
      PHASES.READY,
    ]);
  });

  test('PHASES is frozen (immutable contract)', () => {
    assert.equal(Object.isFrozen(PHASES), true);
  });
});

describe('PHASE_EVENTS mapping', () => {
  test('every phase has a corresponding LIFECYCLE_BOOTSTRAP:* event', () => {
    for (const phase of PHASES_ORDER) {
      const evt = PHASE_EVENTS[phase];
      assert.equal(typeof evt, 'string', `phase "${phase}" must have event name`);
      assert.ok(
        evt.startsWith('lifecycle:bootstrap:'),
        `event "${evt}" must be lifecycle:bootstrap:*`,
      );
    }
  });

  test('PHASE_EVENTS points at the right EVENTS.* constants', () => {
    // INIT/CONFIG/CONTAINER/REGISTRY/CRON share one bootstrap:start contract; READY → bootstrap:done
    assert.equal(PHASE_EVENTS[PHASES.INIT], 'lifecycle:bootstrap:init');
    assert.equal(PHASE_EVENTS[PHASES.CONFIG], 'lifecycle:bootstrap:config');
    assert.equal(PHASE_EVENTS[PHASES.CONTAINER], 'lifecycle:bootstrap:container');
    assert.equal(PHASE_EVENTS[PHASES.REGISTRY], 'lifecycle:bootstrap:registry');
    assert.equal(PHASE_EVENTS[PHASES.CRON], 'lifecycle:bootstrap:cron');
    assert.equal(PHASE_EVENTS[PHASES.READY], 'lifecycle:bootstrap:ready');
  });

  test('start/done events exist on EVENTS constants', () => {
    // Sanity: the umbrella start/done events must be the EVENTS.* values
    assert.equal(EVENTS.LIFECYCLE_BOOTSTRAP_START, 'lifecycle:bootstrap:start');
    assert.equal(EVENTS.LIFECYCLE_BOOTSTRAP_DONE, 'lifecycle:bootstrap:done');
  });
});
