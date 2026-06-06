/**
 * AdapterRegistry tests — TDD red→green for PR 12a.
 *
 * Style parity with PluginRegistry (PR 11a):
 *   - register/get/has/list/unregister
 *   - NEVER throws (defensive)
 *   - emits ADAPTER_REGISTER / ADAPTER_UNREGISTER on success
 *   - emits ADAPTER_*_ERROR on failure
 *
 * Difference from ProviderRegistry (PR 6): ProviderRegistry throws on
 * duplicate. AdapterRegistry is defensive because adapters are fed by
 * lifecycle bootstrap, evolution, and external channel code; one bad
 * apple must not bring Darwin down.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { AdapterRegistry } from '../adapter/registry.js';
import { EVENTS } from '../core/events.js';

const make = (name, capabilities = ['message:in']) => ({
  name,
  version: '1.0.0',
  capabilities,
  init(_ctx) {},
  destroy() {},
  start() {},
  stop() {},
  handleEvent(_evt) {},
});

describe('AdapterRegistry — construction', () => {
  test('throws without eventBus; starts empty', () => {
    assert.throws(() => new AdapterRegistry(), /eventBus/);
    const r = new AdapterRegistry({ eventBus: new EventBus() });
    assert.equal(r.size(), 0);
    assert.deepEqual(r.list(), []);
  });
});

describe('AdapterRegistry — register', () => {
  let bus, reg;
  beforeEach(() => {
    bus = new EventBus();
    reg = new AdapterRegistry({ eventBus: bus });
  });
  test('adds + emits ADAPTER_REGISTER on success', () => {
    const ok = [];
    bus.on(EVENTS.ADAPTER_REGISTER, (p) => ok.push(p));
    reg.register(make('feishu'));
    assert.equal(reg.has('feishu'), true);
    assert.equal(reg.size(), 1);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].name, 'feishu');
    assert.equal(ok[0].version, '1.0.0');
    assert.ok(Array.isArray(ok[0].capabilities));
  });
  test('duplicate register NEVER throws — emits ADAPTER_REGISTER_ERROR', () => {
    const ok = [],
      err = [];
    bus.on(EVENTS.ADAPTER_REGISTER, (p) => ok.push(p));
    bus.on(EVENTS.ADAPTER_REGISTER_ERROR, (p) => err.push(p));
    reg.register(make('feishu'));
    assert.doesNotThrow(() => reg.register(make('feishu')));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /feishu|already/i);
    assert.equal(ok.length, 1);
    assert.equal(reg.size(), 1);
  });
  test('invalid adapter NEVER throws — emits ADAPTER_REGISTER_ERROR', () => {
    const err = [];
    bus.on(EVENTS.ADAPTER_REGISTER_ERROR, (p) => err.push(p));
    assert.doesNotThrow(() => reg.register({}));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /name/);
    assert.equal(reg.size(), 0);
  });
});

describe('AdapterRegistry — get / has / list', () => {
  let bus, reg;
  beforeEach(() => {
    bus = new EventBus();
    reg = new AdapterRegistry({ eventBus: bus });
  });
  test('get returns the adapter; missing → undefined (no throw) + GET_ERROR', () => {
    const a = make('feishu');
    reg.register(a);
    assert.equal(reg.get('feishu'), a);
    const err = [];
    bus.on(EVENTS.ADAPTER_GET_ERROR, (payload) => err.push(payload));
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
});

describe('AdapterRegistry — unregister', () => {
  test('removes + emits ADAPTER_UNREGISTER; unknown NEVER throws + emits ERROR', () => {
    const bus = new EventBus();
    const reg = new AdapterRegistry({ eventBus: bus });
    const ok = [],
      err = [];
    bus.on(EVENTS.ADAPTER_UNREGISTER, (p) => ok.push(p));
    bus.on(EVENTS.ADAPTER_UNREGISTER_ERROR, (p) => err.push(p));
    reg.register(make('a'));
    reg.unregister('a');
    assert.equal(reg.has('a'), false);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].name, 'a');
    assert.doesNotThrow(() => reg.unregister('nope'));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /nope/);
  });
});

describe('AdapterRegistry — error isolation', () => {
  test('async handler throw does not break other handlers (PR 2 contract)', () => {
    const bus = new EventBus();
    const reg = new AdapterRegistry({ eventBus: bus });
    const seen = [];
    bus.on(EVENTS.ADAPTER_REGISTER, async () => {
      throw new Error('boom');
    });
    bus.on(EVENTS.ADAPTER_REGISTER, (p) => seen.push(p.name));
    reg.register(make('a'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'a');
  });
});
