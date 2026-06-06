/**
 * IMemory contract tests — TDD red→green for PR 13a.
 *
 * IMemory = Darwin's "永生" foundation (persistent state across runs).
 * Backends (filesystem / sqlite / vector / ...) are plain {name, version,
 * capabilities, init, ...} objects validated via IMemory.validate (duck
 * typing) at registry time. Style parity with IProvider + IPlugin + IAdapter.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IMemory } from '../memory/interface.js';

describe('IMemory — shape', () => {
  test('has name + version + capabilities fields', () => {
    assert.ok('name' in IMemory);
    assert.ok('version' in IMemory);
    assert.ok('capabilities' in IMemory);
  });

  test('default capabilities is an array of strings', () => {
    assert.ok(Array.isArray(IMemory.capabilities));
    for (const c of IMemory.capabilities) {
      assert.equal(typeof c, 'string');
    }
  });

  test('exposes prototype with init/destroy/get/set/delete/list/query/clear', () => {
    for (const m of ['init', 'destroy', 'get', 'set', 'delete', 'list', 'query', 'clear']) {
      assert.equal(typeof IMemory.prototype[m], 'function', `prototype.${m} must be function`);
    }
  });

  test('default prototype methods throw "not implemented"', () => {
    assert.throws(() => IMemory.prototype.init({}), /not implemented/);
    assert.throws(() => IMemory.prototype.destroy(), /not implemented/);
    assert.throws(() => IMemory.prototype.get('k'), /not implemented/);
    assert.throws(() => IMemory.prototype.set('k', 'v'), /not implemented/);
    assert.throws(() => IMemory.prototype.delete('k'), /not implemented/);
    assert.throws(() => IMemory.prototype.list(), /not implemented/);
    assert.throws(() => IMemory.prototype.query('.*'), /not implemented/);
    assert.throws(() => IMemory.prototype.clear(), /not implemented/);
  });
});

describe('IMemory.validate', () => {
  const valid = () => ({
    name: 'filesystem',
    version: '1.0.0',
    capabilities: ['key-value', 'persist'],
    init() {},
    destroy() {},
    get() {},
    set() {},
    delete() {},
    list() {},
    query() {},
    clear() {},
  });

  test('throws on non-object / null / undefined / primitives', () => {
    assert.throws(() => IMemory.validate(null), /object/);
    assert.throws(() => IMemory.validate(undefined), /object/);
    assert.throws(() => IMemory.validate('m'), /object/);
    assert.throws(() => IMemory.validate(42), /object/);
  });

  test('throws when name missing / non-string / empty', () => {
    assert.throws(() => IMemory.validate({ version: '1.0.0', capabilities: [] }), /name/);
    assert.throws(() => IMemory.validate({ name: 42, version: '1.0.0', capabilities: [] }), /name/);
    assert.throws(() => IMemory.validate({ name: '', version: '1.0.0', capabilities: [] }), /name/);
  });

  test('throws when version missing / non-string / empty', () => {
    assert.throws(() => IMemory.validate({ name: 'a', capabilities: [] }), /version/);
    assert.throws(() => IMemory.validate({ name: 'a', version: 1, capabilities: [] }), /version/);
    assert.throws(() => IMemory.validate({ name: 'a', version: '', capabilities: [] }), /version/);
  });

  test('throws when capabilities missing / not array / contains non-string', () => {
    assert.throws(() => IMemory.validate({ name: 'a', version: '1.0.0' }), /capabilities/);
    assert.throws(
      () => IMemory.validate({ name: 'a', version: '1.0.0', capabilities: 'k' }),
      /capabilities/,
    );
    assert.throws(
      () => IMemory.validate({ name: 'a', version: '1.0.0', capabilities: [1, 2] }),
      /capability/,
    );
  });

  test('returns {ok: true} for valid backend (incl. empty capabilities)', () => {
    assert.equal(IMemory.validate(valid()).ok, true);
    const m = valid();
    m.capabilities = [];
    assert.equal(IMemory.validate(m).ok, true);
  });
});
