/**
 * basic-logger skill example tests — TDD red→green for PR 16b.
 * 8-field ISkill contract + event listener + lifecycle hooks.
 * Style parity with tests/plugin-example-logger.test.js (when present).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';

describe('skill/example — basic-logger (8-field ISkill contract)', () => {
  let skill;
  test('shape: 8 fields all present and well-typed', async () => {
    ({ default: skill } = await import('../skill/__example__/basic-logger.js'));
    assert.equal(skill.name, 'basic-logger');
    assert.equal(skill.version, '0.1.0');
    assert.ok(Array.isArray(skill.capabilities));
    assert.ok(skill.capabilities.length > 0);
    assert.equal(typeof skill.init, 'function');
    assert.equal(typeof skill.destroy, 'function');
    assert.equal(typeof skill.enable, 'function');
    assert.equal(typeof skill.disable, 'function');
    assert.equal(typeof skill.validate, 'function');
  });
  test('validate() returns true (self-checks identity + capabilities)', () => {
    assert.equal(skill.validate(), true);
  });
  test('init(ctx) registers a listener and survives a no-op teardown', async () => {
    const bus = new EventBus();
    await skill.init({ eventBus: bus });
    assert.doesNotThrow(async () => await skill.destroy({ eventBus: bus }));
  });
  test('init listens to test.ping and re-emits as log event (event bus hook works)', async () => {
    const bus = new EventBus();
    const seen = [];
    bus.on('log', (p) => seen.push(p));
    await skill.init({ eventBus: bus });
    bus.emit('test:ping', { value: 42 });
    assert.ok(seen.length >= 1);
    assert.equal(seen[0].from, 'basic-logger');
    assert.equal(seen[0].level, 'info');
    assert.match(seen[0].msg, /42/);
  });
  test('destroy() is idempotent and does not throw', async () => {
    const bus = new EventBus();
    await skill.init({ eventBus: bus });
    await assert.doesNotReject(async () => {
      await skill.destroy({ eventBus: bus });
      await skill.destroy({ eventBus: bus });
    });
  });
  test('enable(ctx) emits SKILL_ENABLE with skill name', async () => {
    const bus = new EventBus();
    const ev = [];
    bus.on(EVENTS.SKILL_ENABLE, (p) => ev.push(p));
    await skill.enable({ eventBus: bus });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].name, 'basic-logger');
  });
  test('disable(ctx) emits SKILL_DISABLE with skill name', async () => {
    const bus = new EventBus();
    const ev = [];
    bus.on(EVENTS.SKILL_DISABLE, (p) => ev.push(p));
    await skill.disable({ eventBus: bus });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].name, 'basic-logger');
  });
});
