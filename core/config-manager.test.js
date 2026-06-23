/**
 * core/config-manager.test.js -- V43 tests for ConfigManager.
 *
 * Strategy: use a tmp directory for the user layer and the code
 * layer; the test never touches ~/.darwin. ConfigResolver is given
 * a fresh credPath/userPath/codePath per test.
 *
 * LLM gate (ADR-009): no LLM. We never hit a real provider API.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, VENDOR_SCHEMA, redact, redactObject } from './config-manager.js';

let tmp;
let codeDir;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'darwin-configmgr-'));
  codeDir = mkdtempSync(join(tmpdir(), 'darwin-code-'));
});

after(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (codeDir) {
    rmSync(codeDir, { recursive: true, force: true });
  }
});

function makeManager(extra = {}) {
  return new ConfigManager({
    userDir: tmp,
    envPath: join(tmp, '.env'),
    runtimePath: join(tmp, 'darwin-runtime.yaml'),
    codePath: codeDir,
    ...extra,
  });
}

describe('config-manager (V43) -- redact helper', () => {
  test('redact: short / empty / normal', () => {
    assert.equal(redact(''), '');
    assert.equal(redact('a'), '****');
    assert.equal(redact('abcd'), '****');
    assert.equal(redact('sk-abc123XYZ'), 'sk-a****');
    assert.equal(redact(123), '');
    assert.equal(redact(null), '');
  });

  test('redactObject: redacts known secret keys, leaves others alone', () => {
    const input = {
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-abc123XYZ',
      default_model: 'gpt-4o-mini',
      app_secret: 'secret-value',
      token: 'tok-xyz',
    };
    const out = redactObject(input);
    assert.equal(out.base_url, 'https://api.openai.com/v1');
    assert.equal(out.api_key, 'sk-a****');
    assert.equal(out.default_model, 'gpt-4o-mini');
    assert.equal(out.app_secret, 'secr****');
    assert.equal(out.token, 'tok-****');
    // original untouched
    assert.equal(input.api_key, 'sk-abc123XYZ');
  });

  test('redactObject: returns primitives as-is (defensive)', () => {
    assert.equal(redactObject(null), null);
    assert.equal(redactObject('x'), 'x');
    assert.deepEqual(redactObject([1, 2, 3]), [1, 2, 3]);
  });
});

describe('config-manager (V43) -- VENDOR_SCHEMA', () => {
  test('catalog has 7 vendors, all with required fields', () => {
    assert.equal(VENDOR_SCHEMA.length, 7);
    for (const v of VENDOR_SCHEMA) {
      assert.ok(v.id && v.label && v.kind, `vendor missing basic fields: ${JSON.stringify(v)}`);
      assert.ok(['openai', 'anthropic'].includes(v.kind), `unknown kind: ${v.kind}`);
      assert.ok(Array.isArray(v.fields) && v.fields.length > 0, `${v.id} has no fields`);
      for (const f of v.fields) {
        assert.ok(f.name && f.label && f.type, `field missing basics: ${JSON.stringify(f)}`);
      }
    }
  });

  test('every schema has an api_key field (we always need a key)', () => {
    for (const v of VENDOR_SCHEMA) {
      const hasKey = v.fields.some((f) => f.name === 'api_key');
      assert.ok(hasKey, `vendor ${v.id} missing api_key field`);
    }
  });

  test('only anthropic kind has version field', () => {
    const anthropic = VENDOR_SCHEMA.find((v) => v.kind === 'anthropic');
    assert.ok(anthropic.fields.some((f) => f.name === 'version'));
    for (const v of VENDOR_SCHEMA.filter((x) => x.kind === 'openai')) {
      assert.ok(!v.fields.some((f) => f.name === 'version'), `${v.id} should not have version`);
    }
  });
});

describe('config-manager (V43) -- CRUD', () => {
  test('listProviderIds: empty when no files', () => {
    const m = makeManager();
    assert.deepEqual(m.listProviderIds(), []);
  });

  test('upsertProvider: writes yaml with ${ENV} placeholders, secrets to .env', () => {
    const m = makeManager();
    const r = m.upsertProvider(
      'openai',
      {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-abc123XYZ',
        default_model: 'gpt-4o-mini',
      },
      { reveal: true },
    );
    assert.equal(r.id, 'openai');
    assert.equal(r.written, 3);
    assert.equal(r.envVars.length, 1);
    // yaml file has ${ENV} placeholder
    const yaml = readFileSync(join(tmp, 'provider-openai.yaml'), 'utf8');
    assert.match(yaml, /api_key: \$\{DARWIN_PROVIDER_OPENAI_API_KEY\}/);
    assert.match(yaml, /base_url: https:\/\/api\.openai\.com\/v1/);
    // .env has the real key
    const env = readFileSync(join(tmp, '.env'), 'utf8');
    assert.match(env, /DARWIN_PROVIDER_OPENAI_API_KEY=sk-abc123XYZ/);
  });

  test('getProvider: returns merged+redacted view by default', () => {
    const m = makeManager();
    m.upsertProvider(
      'openai',
      {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-abc123XYZ',
        default_model: 'gpt-4o-mini',
      },
      { reveal: true },
    );
    const cfg = m.getProvider('openai');
    assert.equal(cfg.api_key, 'sk-a****');
    assert.equal(cfg.base_url, 'https://api.openai.com/v1');
    assert.equal(cfg.default_model, 'gpt-4o-mini');
  });

  test('getProvider: reveal=true returns the real key', () => {
    const m = makeManager();
    m.upsertProvider(
      'openai',
      {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-abc123XYZ',
        default_model: 'gpt-4o-mini',
      },
      { reveal: true },
    );
    const cfg = m.getProvider('openai', { reveal: true });
    assert.equal(cfg.api_key, 'sk-abc123XYZ');
  });

  test('getProvider: returns null for missing', () => {
    const m = makeManager();
    assert.equal(m.getProvider('nonexistent'), null);
  });

  test('getProvider: rejects invalid id', () => {
    const m = makeManager();
    assert.throws(() => m.getProvider('../etc'), /invalid provider id/);
    assert.throws(() => m.getProvider('a b'), /invalid provider id/);
  });

  test('listProviders: returns id + kind + label + redacted config', () => {
    const m = makeManager();
    m.upsertProvider(
      'openai',
      {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-abc123XYZ',
        default_model: 'gpt-4o-mini',
      },
      { reveal: true },
    );
    m.upsertProvider(
      'anthropic',
      {
        base_url: 'https://api.anthropic.com',
        api_key: 'sk-ant-XYZ',
        default_model: 'claude-sonnet-4-5',
        version: '2023-06-01',
      },
      { reveal: true },
    );
    const list = m.listProviders();
    assert.equal(list.length, 2);
    const openai = list.find((p) => p.id === 'openai');
    const anthropic = list.find((p) => p.id === 'anthropic');
    assert.equal(openai.kind, 'openai');
    assert.equal(openai.label, 'OpenAI (official)');
    assert.equal(openai.api_key, 'sk-a****');
    assert.equal(anthropic.kind, 'anthropic');
    assert.equal(anthropic.api_key, 'sk-a****');
  });

  test('deleteProvider: removes the yaml file', () => {
    const m = makeManager();
    m.upsertProvider(
      'openai',
      { base_url: 'https://api.openai.com/v1', api_key: 'sk-x', default_model: 'gpt-4o-mini' },
      { reveal: true },
    );
    assert.ok(existsSync(join(tmp, 'provider-openai.yaml')));
    const r = m.deleteProvider('openai');
    assert.equal(r.deleted, true);
    assert.ok(!existsSync(join(tmp, 'provider-openai.yaml')));
  });

  test('deleteProvider: returns {deleted:false,reason} for missing', () => {
    const m = makeManager();
    const r = m.deleteProvider('nope');
    assert.equal(r.deleted, false);
    assert.equal(r.reason, 'not found');
  });

  test('upsertProvider: rejects invalid id', () => {
    const m = makeManager();
    assert.throws(() => m.upsertProvider('../x', {}), /invalid provider id/);
  });

  test('upsertProvider: non-string fields are JSON-serialized', () => {
    const m = makeManager();
    m.upsertProvider(
      'openai',
      { base_url: 'https://x', api_key: 'k', default_model: 'm', capabilities: ['chat', 'stream'] },
      { reveal: true },
    );
    const yaml = readFileSync(join(tmp, 'provider-openai.yaml'), 'utf8');
    assert.match(yaml, /capabilities: \["chat","stream"\]/);
  });
});

describe('config-manager (V43) -- active provider', () => {
  test('getActive: returns null when not set', () => {
    const m = makeManager();
    assert.equal(m.getActive(), null);
  });

  test('setActive: writes darwin-runtime.yaml with provider + model', () => {
    const m = makeManager();
    m.upsertProvider(
      'openai',
      { base_url: 'https://api.openai.com/v1', api_key: 'sk-x', default_model: 'gpt-4o-mini' },
      { reveal: true },
    );
    const r = m.setActive('openai');
    assert.equal(r.provider, 'openai');
    assert.equal(r.model, 'gpt-4o-mini');
    const active = m.getActive();
    assert.equal(active.provider, 'openai');
    assert.equal(active.model, 'gpt-4o-mini');
  });

  test('setActive: explicit model wins over default', () => {
    const m = makeManager();
    m.upsertProvider(
      'openai',
      { base_url: 'https://api.openai.com/v1', api_key: 'sk-x', default_model: 'gpt-4o-mini' },
      { reveal: true },
    );
    m.setActive('openai', 'gpt-4o');
    assert.equal(m.getActive().model, 'gpt-4o');
  });

  test('setActive: rejects unknown provider', () => {
    const m = makeManager();
    assert.throws(() => m.setActive('nope'), /provider not configured/);
  });

  test('setActive: rejects invalid id', () => {
    const m = makeManager();
    assert.throws(() => m.setActive('../x'), /invalid provider id/);
  });
});

describe('config-manager (V43) -- env-var preservation', () => {
  test('upserting an existing key replaces only that line', () => {
    const m = makeManager();
    writeFileSync(join(tmp, '.env'), 'OTHER=keep-me\n');
    m.upsertProvider(
      'openai',
      { base_url: 'https://x', api_key: 'first', default_model: 'm' },
      { reveal: true },
    );
    m.upsertProvider(
      'openai',
      { base_url: 'https://x', api_key: 'second', default_model: 'm' },
      { reveal: true },
    );
    const env = readFileSync(join(tmp, '.env'), 'utf8');
    assert.match(env, /OTHER=keep-me/);
    assert.match(env, /DARWIN_PROVIDER_OPENAI_API_KEY=second/);
    assert.doesNotMatch(env, /first/);
  });
});
