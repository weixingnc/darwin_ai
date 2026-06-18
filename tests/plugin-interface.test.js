/**
 * IPlugin contract tests — TDD red→green for PR 11a.
 * Covers: shape, prototype methods, validate() duck-typing errors.
 *
 * P2d (2026-06-18): extended with manifest validation tests
 * (PLUGIN_CAPABILITIES / PLUGIN_PERMISSIONS / PLUGIN_DENIED).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  IPlugin,
  PLUGIN_CAPABILITIES,
  PLUGIN_PERMISSIONS,
  PLUGIN_DENIED,
} from '../plugin/interface.js';

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

describe('IPlugin — P2d manifest enums', () => {
  test('PLUGIN_CAPABILITIES is a frozen array of known categories', () => {
    assert.ok(Array.isArray(PLUGIN_CAPABILITIES));
    assert.ok(Object.isFrozen(PLUGIN_CAPABILITIES));
    for (const cat of ['tool', 'skill', 'memory', 'hook', 'listener']) {
      assert.ok(PLUGIN_CAPABILITIES.includes(cat), `expected ${cat} in PLUGIN_CAPABILITIES`);
    }
  });

  test('PLUGIN_PERMISSIONS is a frozen whitelist of fine-grained actions', () => {
    assert.ok(Array.isArray(PLUGIN_PERMISSIONS));
    assert.ok(Object.isFrozen(PLUGIN_PERMISSIONS));
    for (const p of [
      'bus:on',
      'bus:off',
      'bus:emit',
      'config:get',
      'log:info',
      'log:warn',
      'log:error',
    ]) {
      assert.ok(PLUGIN_PERMISSIONS.includes(p), `expected ${p} in PLUGIN_PERMISSIONS`);
    }
  });

  test('PLUGIN_DENIED is a frozen blocklist of high-risk primitives', () => {
    assert.ok(Array.isArray(PLUGIN_DENIED));
    assert.ok(Object.isFrozen(PLUGIN_DENIED));
    for (const p of [
      'process:exit',
      'fs:delete',
      'fs:write',
      'child_process:exec',
      'network:raw',
    ]) {
      assert.ok(PLUGIN_DENIED.includes(p), `expected ${p} in PLUGIN_DENIED`);
    }
  });
});

describe('IPlugin.validate — P2d manifest enforcement', () => {
  function pluginWith(extra) {
    return {
      name: 'p',
      version: '1.0.0',
      capabilities: ['tool'],
      ...extra,
    };
  }

  test('rejects capability not in PLUGIN_CAPABILITIES (e.g. "weird-cat")', () => {
    assert.throws(
      () => IPlugin.validate(pluginWith({ capabilities: ['weird-cat'] })),
      /not in PLUGIN_CAPABILITIES/,
    );
  });

  test('accepts every category in PLUGIN_CAPABILITIES', () => {
    for (const cat of PLUGIN_CAPABILITIES) {
      const r = IPlugin.validate(pluginWith({ capabilities: [cat] }));
      assert.equal(r.ok, true, `expected ${cat} to be valid`);
    }
  });

  test('rejects permissions field when not an array', () => {
    assert.throws(() => IPlugin.validate(pluginWith({ permissions: 'bus:on' })), /permissions/);
    assert.throws(() => IPlugin.validate(pluginWith({ permissions: 42 })), /permissions/);
  });

  test('rejects unknown permission (not in PLUGIN_PERMISSIONS)', () => {
    assert.throws(
      () => IPlugin.validate(pluginWith({ permissions: ['unknown:perm'] })),
      /not in PLUGIN_PERMISSIONS/,
    );
  });

  test('rejects non-string permission element', () => {
    assert.throws(
      () => IPlugin.validate(pluginWith({ permissions: ['bus:on', 1] })),
      /permission must be string/,
    );
  });

  test('accepts every permission in PLUGIN_PERMISSIONS', () => {
    const r = IPlugin.validate(pluginWith({ permissions: [...PLUGIN_PERMISSIONS] }));
    assert.equal(r.ok, true);
  });

  test('accepts plugin without permissions (backward compat)', () => {
    // Existing tests (PR 11a) construct plugins with no `permissions` field.
    // This MUST stay valid — adding P2d should not break legacy plugins.
    const r = IPlugin.validate(
      pluginWith({
        /* no permissions */
      }),
    );
    assert.equal(r.ok, true);
  });

  test('rejects when permissions ∩ PLUGIN_DENIED is non-empty (process:exit)', () => {
    assert.throws(
      () => IPlugin.validate(pluginWith({ permissions: ['process:exit'] })),
      /denied values/,
    );
  });

  test('rejects every entry in PLUGIN_DENIED', () => {
    for (const denied of PLUGIN_DENIED) {
      assert.throws(
        () => IPlugin.validate(pluginWith({ permissions: [denied] })),
        /denied values/,
        `expected ${denied} to be rejected`,
      );
    }
  });

  test('rejects mixed permissions (one valid + one denied)', () => {
    assert.throws(
      () => IPlugin.validate(pluginWith({ permissions: ['bus:on', 'fs:delete'] })),
      /denied values.*fs:delete/,
    );
  });
});
