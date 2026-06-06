/**
 * ConfigResolver unit tests — PR 3.
 *
 * Coverage targets:
 * - 3-layer merge order (cred > user > code)
 * - layer absence → graceful fallback (no throw)
 * - ${VAR} expansion: process.env + cred env
 * - ${VAR} missing → '' + warn (v1 lesson: never throw)
 * - deep merge on nested objects
 * - cache hit + invalidate
 * - file read failures → warn + continue (no throw)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigResolver } from '../core/config-resolver.js';

function makeResolver({ code = '', user = '', env = '', codeModule = 'demo' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-cfg-'));
  const codePath = join(dir, 'code');
  const userPath = join(dir, 'user');
  mkdirSync(codePath, { recursive: true });
  mkdirSync(userPath, { recursive: true });
  if (code) {
    writeFileSync(join(codePath, `${codeModule}.yaml`), code);
  }
  if (user) {
    writeFileSync(join(userPath, `${codeModule}.yaml`), user);
  }
  const credPath = join(dir, '.env');
  if (env) {
    writeFileSync(credPath, env);
  }
  return { resolver: new ConfigResolver({ codePath, userPath, credPath }), dir };
}

describe('ConfigResolver 3-layer merge', () => {
  test('code layer only', () => {
    const { resolver } = makeResolver({ code: 'name: from-code\nport: 7777' });
    const cfg = resolver.get('demo');
    assert.equal(cfg.name, 'from-code');
    assert.equal(cfg.port, 7777);
  });

  test('user overrides code', () => {
    const { resolver } = makeResolver({
      code: 'name: from-code\nport: 7777',
      user: 'name: from-user',
    });
    const cfg = resolver.get('demo');
    assert.equal(cfg.name, 'from-user');
    assert.equal(cfg.port, 7777);
  });

  test('cred env fills ${VAR} placeholder (overriding code + user)', () => {
    process.env.APP_ID = 'process-value';
    const { resolver } = makeResolver({
      code: 'app_id: ${APP_ID}',
      user: 'app_id: ${APP_ID}',
      env: 'APP_ID=cred-value',
    });
    const cfg = resolver.get('demo');
    assert.equal(cfg.app_id, 'cred-value');
    delete process.env.APP_ID;
  });

  test('all layers absent → empty object (no throw)', () => {
    const { resolver } = makeResolver({});
    const cfg = resolver.get('demo');
    assert.deepEqual(cfg, {});
  });
});

describe('ConfigResolver ${VAR} expansion', () => {
  test('process.env placeholder', () => {
    process.env.DARWIN_TEST_VAR = 'process-value';
    const { resolver } = makeResolver({ code: 'app_id: ${DARWIN_TEST_VAR}' });
    const cfg = resolver.get('demo');
    assert.equal(cfg.app_id, 'process-value');
    delete process.env.DARWIN_TEST_VAR;
  });

  test('cred env placeholder', () => {
    const { resolver } = makeResolver({
      code: 'app_secret: ${FEISHU_APP_SECRET}',
      env: 'FEISHU_APP_SECRET=cred-value',
    });
    const cfg = resolver.get('demo');
    assert.equal(cfg.app_secret, 'cred-value');
  });

  test('cred env takes priority over process.env', () => {
    process.env.SHARED = 'from-process';
    const { resolver } = makeResolver({
      code: 'val: ${SHARED}',
      env: 'SHARED=from-cred',
    });
    const cfg = resolver.get('demo');
    assert.equal(cfg.val, 'from-cred');
    delete process.env.SHARED;
  });

  test('missing placeholder returns "" + warns (no throw)', () => {
    const { resolver } = makeResolver({ code: 'val: ${NEVER_SET_XYZ_123}' });
    const origWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    const cfg = resolver.get('demo');
    console.warn = origWarn;
    assert.equal(cfg.val, '');
    assert.equal(warned, true, 'should warn on missing placeholder');
  });

  test('placeholder in nested object', () => {
    process.env.NESTED_VAL = 'deep-value';
    const { resolver } = makeResolver({
      code: 'feishu:\n  app_id: ${NESTED_VAL}\n  port: 7777',
    });
    const cfg = resolver.get('demo');
    assert.equal(cfg.feishu.app_id, 'deep-value');
    assert.equal(cfg.feishu.port, 7777);
    delete process.env.NESTED_VAL;
  });
});

describe('ConfigResolver deep merge', () => {
  test('user deep overrides code', () => {
    const { resolver } = makeResolver({
      code: 'feishu:\n  app_id: code-id\n  app_secret: code-secret',
      user: 'feishu:\n  app_id: user-id',
    });
    const cfg = resolver.get('demo');
    assert.equal(cfg.feishu.app_id, 'user-id');
    assert.equal(cfg.feishu.app_secret, 'code-secret');
  });
});

describe('ConfigResolver cache + invalidate', () => {
  test('second get returns cached', () => {
    const { resolver, dir } = makeResolver({ code: 'name: first' });
    const cfg1 = resolver.get('demo');
    // Mutate file — cache should still serve old value
    writeFileSync(join(dir, 'code', 'demo.yaml'), 'name: second');
    const cfg2 = resolver.get('demo');
    assert.equal(cfg1.name, 'first');
    assert.equal(cfg2.name, 'first');
  });

  test('invalidate clears cache', () => {
    const { resolver, dir } = makeResolver({ code: 'name: first' });
    resolver.get('demo');
    writeFileSync(join(dir, 'code', 'demo.yaml'), 'name: second');
    resolver.invalidate('demo');
    const cfg = resolver.get('demo');
    assert.equal(cfg.name, 'second');
  });

  test('invalidate() with no arg clears all', () => {
    const { resolver, dir } = makeResolver({ code: 'name: first' });
    resolver.get('demo');
    writeFileSync(join(dir, 'code', 'demo.yaml'), 'name: second');
    resolver.invalidate();
    const cfg = resolver.get('demo');
    assert.equal(cfg.name, 'second');
  });
});

describe('ConfigResolver error handling', () => {
  test('get with empty moduleName throws TypeError', () => {
    const { resolver } = makeResolver({});
    assert.throws(() => resolver.get(''), /non-empty string/);
    assert.throws(() => resolver.get(null), /non-empty string/);
  });

  test('malformed yaml file → warn + continue (no throw)', () => {
    const { resolver } = makeResolver({ code: '{not yaml: but' });
    const origWarn = console.warn;
    console.warn = () => {};
    const cfg = resolver.get('demo');
    console.warn = origWarn;
    assert.ok(cfg, 'should return empty config instead of throwing');
  });
});
