/**
 * PluginRegistry tests — TDD red→green for PR 11a.
 *
 * PluginRegistry differs from ProviderRegistry: it MUST never throw.
 * All error paths go through ErrorHandler + emit *_ERROR events.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { PluginRegistry } from '../plugin/registry.js';
import { EVENTS } from '../core/events.js';

const make = (name) => ({
  name,
  version: '1.0.0',
  capabilities: ['tool'],
  init() {},
  destroy() {},
  enable() {},
  disable() {},
});

describe('PluginRegistry — construction', () => {
  test('throws without eventBus; starts empty', () => {
    assert.throws(() => new PluginRegistry(), /eventBus/);
    const r = new PluginRegistry({ eventBus: new EventBus() });
    assert.equal(r.size(), 0);
    assert.deepEqual(r.list(), []);
  });
});

describe('PluginRegistry — register', () => {
  let bus, reg;
  beforeEach(() => {
    bus = new EventBus();
    reg = new PluginRegistry({ eventBus: bus });
  });
  test('adds + emits PLUGIN_REGISTER on success', () => {
    const ok = [];
    bus.on(EVENTS.PLUGIN_REGISTER, (p) => ok.push(p));
    reg.register(make('logger'));
    assert.equal(reg.has('logger'), true);
    assert.equal(reg.size(), 1);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].name, 'logger');
    assert.equal(ok[0].version, '1.0.0');
  });
  test('duplicate register NEVER throws — emits PLUGIN_REGISTER_ERROR', () => {
    const ok = [],
      err = [];
    bus.on(EVENTS.PLUGIN_REGISTER, (p) => ok.push(p));
    bus.on(EVENTS.PLUGIN_REGISTER_ERROR, (p) => err.push(p));
    reg.register(make('logger'));
    assert.doesNotThrow(() => reg.register(make('logger')));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /logger|already/i);
    assert.equal(ok.length, 1);
    assert.equal(reg.size(), 1);
  });
  test('invalid plugin NEVER throws — emits PLUGIN_REGISTER_ERROR', () => {
    const err = [];
    bus.on(EVENTS.PLUGIN_REGISTER_ERROR, (p) => err.push(p));
    assert.doesNotThrow(() => reg.register({}));
    assert.equal(err.length, 1);
    assert.match(err[0].message, /name/);
    assert.equal(reg.size(), 0);
  });
});

describe('PluginRegistry — get / has / list', () => {
  let bus, reg;
  beforeEach(() => {
    bus = new EventBus();
    reg = new PluginRegistry({ eventBus: bus });
  });
  test('get returns the plugin; missing → undefined (no throw) + GET_ERROR', () => {
    const p = make('a');
    reg.register(p);
    assert.equal(reg.get('a'), p);
    const err = [];
    bus.on(EVENTS.PLUGIN_GET_ERROR, (payload) => err.push(payload));
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

describe('PluginRegistry — unregister', () => {
  test('removes + emits PLUGIN_UNREGISTER; unknown NEVER throws + emits ERROR', () => {
    const bus = new EventBus();
    const reg = new PluginRegistry({ eventBus: bus });
    const ok = [],
      err = [];
    bus.on(EVENTS.PLUGIN_UNREGISTER, (p) => ok.push(p));
    bus.on(EVENTS.PLUGIN_UNREGISTER_ERROR, (p) => err.push(p));
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

describe('PluginRegistry — error isolation', () => {
  test('async handler throw does not break other handlers (PR 2 contract)', () => {
    const bus = new EventBus();
    const reg = new PluginRegistry({ eventBus: bus });
    const seen = [];
    bus.on(EVENTS.PLUGIN_REGISTER, async () => {
      throw new Error('boom');
    });
    bus.on(EVENTS.PLUGIN_REGISTER, (p) => seen.push(p.name));
    reg.register(make('a'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'a');
  });
});
