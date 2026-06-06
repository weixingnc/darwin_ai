/**
 * SkillRegistry tests — TDD red→green for PR 16a.
 * Style parity with PluginRegistry (PR 11a) + AdapterRegistry (PR 12a) +
 * MemoryRegistry (PR 13a): defensive — NEVER throws — emits SKILL_REGISTER /
 * SKILL_UNREGISTER on success, SKILL_*_ERROR on failure. v2 rule: multi-tenant.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { SkillRegistry } from '../skill/registry.js';
import { EVENTS } from '../core/events.js';

const make = (name) => ({
  name,
  version: '1.0.0',
  capabilities: ['invoke'],
  init() {},
  destroy() {},
  invoke() {},
  stream() {},
  validate() {},
});

describe('SkillRegistry', () => {
  let bus, reg;
  beforeEach(() => {
    bus = new EventBus();
    reg = new SkillRegistry({ eventBus: bus });
  });

  test('throws without eventBus; starts empty', () => {
    assert.throws(() => new SkillRegistry(), /eventBus/);
    const r = new SkillRegistry({ eventBus: new EventBus() });
    assert.equal(r.size(), 0);
    assert.deepEqual(r.list(), []);
  });

  test('register adds + emits SKILL_REGISTER on success', () => {
    const ok = [];
    bus.on(EVENTS.SKILL_REGISTER, (p) => ok.push(p));
    reg.register(make('chat'));
    assert.equal(reg.has('chat'), true);
    assert.equal(reg.size(), 1);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].name, 'chat');
    assert.equal(ok[0].version, '1.0.0');
    assert.ok(Array.isArray(ok[0].capabilities));
  });

  test('duplicate register NEVER throws — emits SKILL_REGISTER_ERROR', () => {
    const ok = [],
      err = [];
    bus.on(EVENTS.SKILL_REGISTER, (p) => ok.push(p));
    bus.on(EVENTS.SKILL_REGISTER_ERROR, (p) => err.push(p));
    reg.register(make('chat'));
    assert.doesNotThrow(() => reg.register(make('chat')));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /chat|already/i);
    assert.equal(ok.length, 1);
    assert.equal(reg.size(), 1);
  });

  test('invalid skill NEVER throws — emits SKILL_REGISTER_ERROR', () => {
    const err = [];
    bus.on(EVENTS.SKILL_REGISTER_ERROR, (p) => err.push(p));
    assert.doesNotThrow(() => reg.register({}));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /name/);
    assert.equal(reg.size(), 0);
  });

  test('multi-tenant: chat + code + search coexist', () => {
    reg.register(make('chat'));
    reg.register(make('code'));
    reg.register(make('search'));
    assert.equal(reg.size(), 3);
    assert.ok(reg.has('chat') && reg.has('code') && reg.has('search'));
  });

  test('get returns skill; missing → undefined + SKILL_GET_ERROR', () => {
    const a = make('chat');
    reg.register(a);
    assert.equal(reg.get('chat'), a);
    const err = [];
    bus.on(EVENTS.SKILL_GET_ERROR, (p) => err.push(p));
    let result;
    assert.doesNotThrow(() => {
      result = reg.get('nope');
    });
    assert.equal(result, undefined);
    assert.equal(err.length, 1);
    assert.match(err[0].message, /nope/);
  });

  test('has true/false; list returns insertion-order array', () => {
    reg.register(make('a'));
    reg.register(make('b'));
    assert.equal(reg.has('a'), true);
    assert.equal(reg.has('c'), false);
    const list = reg.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'a');
    assert.equal(list[1].name, 'b');
  });

  test('unregister removes + emits SKILL_UNREGISTER; unknown NEVER throws', () => {
    const ok = [],
      err = [];
    bus.on(EVENTS.SKILL_UNREGISTER, (p) => ok.push(p));
    bus.on(EVENTS.SKILL_UNREGISTER_ERROR, (p) => err.push(p));
    reg.register(make('a'));
    reg.unregister('a');
    assert.equal(reg.has('a'), false);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].name, 'a');
    assert.doesNotThrow(() => reg.unregister('nope'));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /nope/);
  });

  test('async handler throw does not break sibling handlers (PR 2)', () => {
    const seen = [];
    bus.on(EVENTS.SKILL_REGISTER, async () => {
      throw new Error('boom');
    });
    bus.on(EVENTS.SKILL_REGISTER, (p) => seen.push(p.name));
    reg.register(make('a'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'a');
  });
});
