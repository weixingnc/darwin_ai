/**
 * ISkill contract tests — TDD red→green for PR 16a.
 * ISkill = Darwin's "ability" contract (chat / code / search / ...).
 * Plain {name, version, capabilities, init, ...} objects validated via
 * ISkill.validate (duck typing). Style parity with IProvider + IPlugin +
 * IAdapter + IMemory. Key boundary vs IPlugin: IPlugin hooks core lifecycle
 * (mutates self); ISkill is a passive ability called via invoke/stream.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ISkill } from '../skill/interface.js';

describe('ISkill — shape', () => {
  test('has name + version + capabilities fields', () => {
    assert.ok('name' in ISkill);
    assert.ok('version' in ISkill);
    assert.ok('capabilities' in ISkill);
  });

  test('default capabilities is an array of strings', () => {
    assert.ok(Array.isArray(ISkill.capabilities));
    for (const c of ISkill.capabilities) {
      assert.equal(typeof c, 'string');
    }
  });

  test('exposes prototype with init/destroy/invoke/stream/validate', () => {
    for (const m of ['init', 'destroy', 'invoke', 'stream', 'validate']) {
      assert.equal(typeof ISkill.prototype[m], 'function', `prototype.${m} must be function`);
    }
  });

  test('default prototype methods throw "not implemented"', () => {
    assert.throws(() => ISkill.prototype.init({}), /not implemented/);
    assert.throws(() => ISkill.prototype.destroy(), /not implemented/);
    assert.throws(() => ISkill.prototype.invoke({ input: '' }), /not implemented/);
    assert.throws(() => ISkill.prototype.stream({ input: '' }), /not implemented/);
    assert.throws(() => ISkill.prototype.validate('x'), /not implemented/);
  });
});

describe('ISkill.validate', () => {
  const valid = () => ({
    name: 'chat',
    version: '1.0.0',
    capabilities: ['invoke', 'stream'],
    init() {},
    destroy() {},
    invoke() {},
    stream() {},
    validate() {},
  });

  test('throws on non-object / null / undefined / primitives', () => {
    assert.throws(() => ISkill.validate(null), /object/);
    assert.throws(() => ISkill.validate(undefined), /object/);
    assert.throws(() => ISkill.validate('s'), /object/);
    assert.throws(() => ISkill.validate(42), /object/);
  });

  test('throws when name missing / non-string / empty', () => {
    assert.throws(() => ISkill.validate({ version: '1.0.0', capabilities: [] }), /name/);
    assert.throws(() => ISkill.validate({ name: 42, version: '1.0.0', capabilities: [] }), /name/);
    assert.throws(() => ISkill.validate({ name: '', version: '1.0.0', capabilities: [] }), /name/);
  });

  test('throws when version missing / non-string / empty', () => {
    assert.throws(() => ISkill.validate({ name: 'a', capabilities: [] }), /version/);
    assert.throws(() => ISkill.validate({ name: 'a', version: 1, capabilities: [] }), /version/);
    assert.throws(() => ISkill.validate({ name: 'a', version: '', capabilities: [] }), /version/);
  });

  test('throws when capabilities missing / not array / contains non-string', () => {
    assert.throws(() => ISkill.validate({ name: 'a', version: '1.0.0' }), /capabilities/);
    assert.throws(
      () => ISkill.validate({ name: 'a', version: '1.0.0', capabilities: 'invoke' }),
      /capabilities/,
    );
    assert.throws(
      () => ISkill.validate({ name: 'a', version: '1.0.0', capabilities: [1, 2] }),
      /capability/,
    );
  });

  test('returns {ok: true} for valid skill (incl. empty capabilities)', () => {
    assert.equal(ISkill.validate(valid()).ok, true);
    const s = valid();
    s.capabilities = [];
    assert.equal(ISkill.validate(s).ok, true);
  });
});

describe('ISkill — vs IPlugin semantic boundary', () => {
  test('has invoke/stream/validate; NOT enable/disable (plugin lifecycle)', () => {
    // Skills are passive — no enable/disable toggling. Those live on IPlugin.
    const expected = ['init', 'destroy', 'invoke', 'stream', 'validate'];
    assert.deepEqual(Object.keys(ISkill.prototype).sort(), expected.sort());
    assert.equal(typeof ISkill.prototype.enable, 'undefined');
    assert.equal(typeof ISkill.prototype.disable, 'undefined');
  });
});
