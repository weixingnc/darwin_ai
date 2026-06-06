/**
 * IPlugin contract tests — TDD red→green for PR 11a.
 * Covers: shape, prototype methods, validate() duck-typing errors.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IPlugin } from '../plugin/interface.js';

describe('IPlugin — shape', () => {
  test('has name + version + capabilities fields', () => {
    assert.ok('name' in IPlugin, 'IPlugin.name must exist');
    assert.ok('version' in IPlugin, 'IPlugin.version must exist');
    assert.ok('capabilities' in IPlugin, 'IPlugin.capabilities must exist');
  });

  test('default capabilities is an array of strings (e.g. tool/skill/memory)', () => {
    assert.ok(Array.isArray(IPlugin.capabilities));
    for (const cap of IPlugin.capabilities) {
      assert.equal(typeof cap, 'string', 'capability must be string');
    }
  });

  test('exposes prototype with init/destroy/enable/disable methods', () => {
    for (const m of ['init', 'destroy', 'enable', 'disable']) {
      assert.equal(typeof IPlugin.prototype[m], 'function', `prototype.${m} must be function`);
    }
  });

  test('default prototype methods throw "not implemented"', () => {
    assert.throws(() => IPlugin.prototype.init({}), /not implemented/);
    assert.throws(() => IPlugin.prototype.destroy(), /not implemented/);
    assert.throws(() => IPlugin.prototype.enable(), /not implemented/);
    assert.throws(() => IPlugin.prototype.disable(), /not implemented/);
  });
});

describe('IPlugin.validate', () => {
  function validPlugin() {
    return {
      name: 'logger',
      version: '1.0.0',
      capabilities: ['tool'],
      init() {},
      destroy() {},
      enable() {},
      disable() {},
    };
  }

  test('throws on non-object / null / undefined', () => {
    assert.throws(() => IPlugin.validate(null), /object/);
    assert.throws(() => IPlugin.validate(undefined), /object/);
    assert.throws(() => IPlugin.validate('plugin'), /object/);
    assert.throws(() => IPlugin.validate(42), /object/);
  });

  test('throws when name missing or non-string or empty', () => {
    assert.throws(() => IPlugin.validate({ version: '1.0.0', capabilities: [] }), /name/);
    assert.throws(() => IPlugin.validate({ name: 42, version: '1.0.0', capabilities: [] }), /name/);
    assert.throws(() => IPlugin.validate({ name: '', version: '1.0.0', capabilities: [] }), /name/);
  });

  test('throws when version missing or non-string', () => {
    assert.throws(() => IPlugin.validate({ name: 'p', capabilities: [] }), /version/);
    assert.throws(() => IPlugin.validate({ name: 'p', version: 1, capabilities: [] }), /version/);
  });

  test('throws when capabilities missing or not array or contains non-string', () => {
    assert.throws(() => IPlugin.validate({ name: 'p', version: '1.0.0' }), /capabilities/);
    assert.throws(
      () => IPlugin.validate({ name: 'p', version: '1.0.0', capabilities: 'tool' }),
      /capabilities/,
    );
    assert.throws(
      () => IPlugin.validate({ name: 'p', version: '1.0.0', capabilities: [1, 2] }),
      /capability/,
    );
  });

  test('returns {ok: true} for a minimal valid plugin', () => {
    const r = IPlugin.validate(validPlugin());
    assert.equal(r.ok, true);
  });
});
