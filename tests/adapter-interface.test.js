/**
 * IAdapter contract tests — TDD red→green for PR 12a.
 *
 * IAdapter is the adapter entry point (Darwin's "continuous-run" carrier).
 * Adapters connect Darwin to external channels (feishu / slack / discord / webhook).
 *
 * Style parity with IProvider (PR 6) + IPlugin (PR 11a):
 *   - plain object (NOT a class) — classes have read-only name/length
 *   - duck-typed via IAdapter.validate(adapter)
 *   - prototype methods throw "not implemented" by default
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IAdapter } from '../adapter/interface.js';

describe('IAdapter — shape', () => {
  test('has name + version + capabilities fields', () => {
    assert.ok('name' in IAdapter, 'IAdapter.name must exist');
    assert.ok('version' in IAdapter, 'IAdapter.version must exist');
    assert.ok('capabilities' in IAdapter, 'IAdapter.capabilities must exist');
  });

  test('default capabilities is an array of strings (e.g. message:in/webhook)', () => {
    assert.ok(Array.isArray(IAdapter.capabilities));
    for (const cap of IAdapter.capabilities) {
      assert.equal(typeof cap, 'string', 'capability must be string');
    }
  });

  test('exposes prototype with init/destroy/start/stop/handleEvent methods', () => {
    for (const m of ['init', 'destroy', 'start', 'stop', 'handleEvent']) {
      assert.equal(typeof IAdapter.prototype[m], 'function', `prototype.${m} must be function`);
    }
  });

  test('default prototype methods throw "not implemented"', () => {
    assert.throws(() => IAdapter.prototype.init({}), /not implemented/);
    assert.throws(() => IAdapter.prototype.destroy(), /not implemented/);
    assert.throws(() => IAdapter.prototype.start(), /not implemented/);
    assert.throws(() => IAdapter.prototype.stop(), /not implemented/);
    assert.throws(() => IAdapter.prototype.handleEvent({}), /not implemented/);
  });
});

describe('IAdapter.validate', () => {
  function validAdapter() {
    return {
      name: 'feishu',
      version: '1.0.0',
      capabilities: ['message:in', 'message:out', 'webhook'],
      init(_ctx) {},
      destroy() {},
      start() {},
      stop() {},
      handleEvent(_evt) {},
    };
  }

  test('throws on non-object / null / undefined / non-object primitives', () => {
    assert.throws(() => IAdapter.validate(null), /object/);
    assert.throws(() => IAdapter.validate(undefined), /object/);
    assert.throws(() => IAdapter.validate('adapter'), /object/);
    assert.throws(() => IAdapter.validate(42), /object/);
  });

  test('throws when name missing or non-string or empty', () => {
    assert.throws(() => IAdapter.validate({ version: '1.0.0', capabilities: [] }), /name/);
    assert.throws(
      () => IAdapter.validate({ name: 42, version: '1.0.0', capabilities: [] }),
      /name/,
    );
    assert.throws(
      () => IAdapter.validate({ name: '', version: '1.0.0', capabilities: [] }),
      /name/,
    );
  });

  test('throws when version missing or non-string or empty', () => {
    assert.throws(() => IAdapter.validate({ name: 'a', capabilities: [] }), /version/);
    assert.throws(() => IAdapter.validate({ name: 'a', version: 1, capabilities: [] }), /version/);
    assert.throws(() => IAdapter.validate({ name: 'a', version: '', capabilities: [] }), /version/);
  });

  test('throws when capabilities missing or not array or contains non-string', () => {
    assert.throws(() => IAdapter.validate({ name: 'a', version: '1.0.0' }), /capabilities/);
    assert.throws(
      () => IAdapter.validate({ name: 'a', version: '1.0.0', capabilities: 'message:in' }),
      /capabilities/,
    );
    assert.throws(
      () => IAdapter.validate({ name: 'a', version: '1.0.0', capabilities: [1, 2] }),
      /capability/,
    );
  });

  test('returns {ok: true} for a minimal valid adapter', () => {
    const r = IAdapter.validate(validAdapter());
    assert.equal(r.ok, true);
  });
});
