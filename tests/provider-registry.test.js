/**
 * ProviderRegistry tests — TDD red→green for PR 6.
 * Covers: register/get/has/list/unregister + events + error cases.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { ProviderRegistry } from '../provider/registry.js';
import { EVENTS } from '../core/events.js';

function fakeProvider(name) {
  return {
    name,
    capabilities: ['chat'],
    chat: () => Promise.resolve({ content: '', usage: {}, raw: null }),
    listModels: () => Promise.resolve([]),
  };
}

describe('ProviderRegistry — construction', () => {
  test('throws without eventBus', () => {
    assert.throws(() => new ProviderRegistry(), /eventBus/);
  });

  test('starts empty', () => {
    const r = new ProviderRegistry({ eventBus: new EventBus() });
    assert.equal(r.size(), 0);
    assert.deepEqual(r.list(), []);
  });
});

describe('ProviderRegistry — register / get / has', () => {
  let bus;
  let reg;
  beforeEach(() => {
    bus = new EventBus();
    reg = new ProviderRegistry({ eventBus: bus });
  });

  test('register adds and emits PROVIDER_REGISTER', () => {
    const fired = [];
    bus.on(EVENTS.PROVIDER_REGISTER, (p) => fired.push(p));
    reg.register(fakeProvider('a'));
    assert.equal(reg.has('a'), true);
    assert.equal(reg.size(), 1);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].name, 'a');
  });

  test('register throws on duplicate name and on invalid shape', () => {
    reg.register(fakeProvider('a'));
    assert.throws(() => reg.register(fakeProvider('a')), /already/);
    assert.throws(() => reg.register({ capabilities: ['chat'] }), /name/);
  });

  test('get returns the registered provider; throws with available list when not found', () => {
    const p = fakeProvider('a');
    reg.register(p);
    reg.register(fakeProvider('b'));
    assert.equal(reg.get('a'), p);
    assert.throws(() => reg.get('c'), /c/);
    assert.throws(() => reg.get('c'), /a/);
    assert.equal(reg.has('nope'), false);
  });

  test('list returns providers in insertion order', () => {
    reg.register(fakeProvider('a'));
    reg.register(fakeProvider('b'));
    const list = reg.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'a');
    assert.equal(list[1].name, 'b');
  });
});

describe('ProviderRegistry — unregister', () => {
  test('removes provider + emits UNREGISTER; throws on unknown name', () => {
    const bus = new EventBus();
    const reg = new ProviderRegistry({ eventBus: bus });
    reg.register(fakeProvider('a'));
    const fired = [];
    bus.on(EVENTS.PROVIDER_UNREGISTER, (p) => fired.push(p));
    reg.unregister('a');
    assert.equal(reg.has('a'), false);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].name, 'a');
    assert.throws(() => reg.unregister('nope'), /nope/);
  });
});
