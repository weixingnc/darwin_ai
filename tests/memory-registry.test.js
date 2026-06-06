/**
 * MemoryRegistry tests — TDD red→green for PR 13a.
 * Style parity with PluginRegistry (PR 11a) + AdapterRegistry (PR 12a):
 * defensive — NEVER throws — emits MEMORY_REGISTER/_UNREGISTER on
 * success, MEMORY_*_ERROR on failure. v2 startup rule: multi-tenant.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { MemoryRegistry } from '../memory/registry.js';
import { EVENTS } from '../core/events.js';

const make = (name, capabilities = ['key-value']) => ({
  name,
  version: '1.0.0',
  capabilities,
  init() {},
  destroy() {},
  get() {},
  set() {},
  delete() {},
  list() {},
  query() {},
  clear() {},
});

describe('MemoryRegistry', () => {
  let bus, reg;
  beforeEach(() => {
    bus = new EventBus();
    reg = new MemoryRegistry({ eventBus: bus });
  });

  test('throws without eventBus; starts empty', () => {
    assert.throws(() => new MemoryRegistry(), /eventBus/);
    const r = new MemoryRegistry({ eventBus: new EventBus() });
    assert.equal(r.size(), 0);
    assert.deepEqual(r.list(), []);
  });

  test('register adds + emits MEMORY_REGISTER on success', () => {
    const ok = [];
    bus.on(EVENTS.MEMORY_REGISTER, (p) => ok.push(p));
    reg.register(make('filesystem'));
    assert.equal(reg.has('filesystem'), true);
    assert.equal(reg.size(), 1);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].name, 'filesystem');
    assert.equal(ok[0].version, '1.0.0');
    assert.ok(Array.isArray(ok[0].capabilities));
  });

  test('duplicate register NEVER throws — emits MEMORY_REGISTER_ERROR', () => {
    const ok = [],
      err = [];
    bus.on(EVENTS.MEMORY_REGISTER, (p) => ok.push(p));
    bus.on(EVENTS.MEMORY_REGISTER_ERROR, (p) => err.push(p));
    reg.register(make('filesystem'));
    assert.doesNotThrow(() => reg.register(make('filesystem')));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /filesystem|already/i);
    assert.equal(ok.length, 1);
    assert.equal(reg.size(), 1);
  });

  test('invalid backend NEVER throws — emits MEMORY_REGISTER_ERROR', () => {
    const err = [];
    bus.on(EVENTS.MEMORY_REGISTER_ERROR, (p) => err.push(p));
    assert.doesNotThrow(() => reg.register({}));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /name/);
    assert.equal(reg.size(), 0);
  });

  test('multi-tenant: filesystem + sqlite + vector coexist (no single-active)', () => {
    reg.register(make('filesystem'));
    reg.register(make('sqlite'));
    reg.register(make('vector'));
    assert.equal(reg.size(), 3);
    assert.ok(reg.has('filesystem') && reg.has('sqlite') && reg.has('vector'));
  });

  test('get returns backend; missing → undefined + MEMORY_GET_ERROR_MEMORY', () => {
    const a = make('filesystem');
    reg.register(a);
    assert.equal(reg.get('filesystem'), a);
    const err = [];
    bus.on(EVENTS.MEMORY_GET_ERROR_MEMORY, (p) => err.push(p));
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

  test('unregister removes + emits MEMORY_UNREGISTER; unknown NEVER throws + emits ERROR', () => {
    const ok = [],
      err = [];
    bus.on(EVENTS.MEMORY_UNREGISTER, (p) => ok.push(p));
    bus.on(EVENTS.MEMORY_UNREGISTER_ERROR, (p) => err.push(p));
    reg.register(make('a'));
    reg.unregister('a');
    assert.equal(reg.has('a'), false);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].name, 'a');
    assert.doesNotThrow(() => reg.unregister('nope'));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /nope/);
  });

  test('async handler throw does not break sibling handlers (PR 2 contract)', () => {
    const seen = [];
    bus.on(EVENTS.MEMORY_REGISTER, async () => {
      throw new Error('boom');
    });
    bus.on(EVENTS.MEMORY_REGISTER, (p) => seen.push(p.name));
    reg.register(make('a'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'a');
  });
});
