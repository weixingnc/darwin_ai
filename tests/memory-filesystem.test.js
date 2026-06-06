/**
 * FilesystemBackend tests — TDD red→green for PR 13b.
 * Covers: IMemory contract; init via ConfigResolver (A-4: no process.env);
 * recursive mkdir; get/set/delete/list/query/clear round-trip; TTL expiry;
 * absent-key silent path; destroy cleanup; error isolation (IO throws →
 * emit *_ERROR, NEVER throw); hygiene; multi-tenant registry coexistence.
 * Async: PR 13b's filesystem backend uses fs/promises throughout, so
 * get/set/delete/list/query/clear all return Promises. Tests use await.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { IMemory } from '../memory/interface.js';
import { MemoryRegistry } from '../memory/registry.js';
import { FilesystemBackend } from '../memory/filesystem-backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fresh ConfigResolver pointing at a tmpdir with a memory-default.yaml. */
function makeCfg(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-mem-cfg-'));
  mkdirSync(join(dir, 'code'), { recursive: true });
  const path = opts.path || join(dir, 'mem');
  writeFileSync(
    join(dir, 'code', 'memory-default.yaml'),
    ['backend: filesystem', `path: ${path}`, ''].join('\n'),
  );
  const cfg = new ConfigResolver({
    codePath: join(dir, 'code'),
    userPath: join(dir, 'user'),
    credPath: join(dir, '.env'),
  });
  return { cfg, path, dir };
}

/** Init a fresh backend wired to a tmpdir. */
async function boot() {
  const { cfg } = makeCfg();
  const m = FilesystemBackend();
  await m.init({ eventBus: new EventBus(), config: cfg, container: null });
  return m;
}

describe('FilesystemBackend — IMemory contract', () => {
  test('name=filesystem, version=1.0.0, capabilities include persist/ttl/list/query/delete', () => {
    const m = FilesystemBackend();
    assert.equal(m.name, 'filesystem');
    assert.equal(m.version, '1.0.0');
    for (const cap of ['key-value', 'persist', 'query', 'list', 'delete', 'ttl']) {
      assert.ok(m.capabilities.includes(cap), `missing capability: ${cap}`);
    }
  });
  test('exposes init/destroy/get/set/delete/list/query/clear as functions', () => {
    for (const k of ['init', 'destroy', 'get', 'set', 'delete', 'list', 'query', 'clear']) {
      assert.equal(typeof FilesystemBackend()[k], 'function', `missing fn: ${k}`);
    }
  });
  test('IMemory.validate passes for a fresh factory output', () => {
    assert.equal(IMemory.validate(FilesystemBackend()).ok, true);
  });
});

describe('FilesystemBackend — init (A-4: ConfigResolver, not process.env)', () => {
  test('init reads config via ConfigResolver.get("memory-default")', async () => {
    const { cfg } = makeCfg();
    const origGet = cfg.get.bind(cfg);
    let gotName = null;
    cfg.get = (m) => {
      gotName = m;
      return origGet(m);
    };
    const m = FilesystemBackend();
    await m.init({ eventBus: new EventBus(), config: cfg, container: null });
    assert.equal(gotName, 'memory-default');
    assert.equal(m._resolvedConfig.backend, 'filesystem');
    assert.equal(typeof m._path, 'string');
  });
  test('init does not mutate process.env for memory path', async () => {
    const before = process.env.DARWIN_MEMORY_PATH;
    const { cfg } = makeCfg();
    await FilesystemBackend().init({ eventBus: new EventBus(), config: cfg, container: null });
    assert.equal(process.env.DARWIN_MEMORY_PATH, before);
  });
  test('hygiene: source has no real hard-coded path literals', () => {
    const src = readFileSync(resolve(__dirname, '../memory/filesystem-backend.js'), 'utf8');
    assert.equal(/\/home\/[a-z_]+\//.test(src), false, 'contains /home/<user>/ literal');
    assert.equal(/\/Users\/[a-z_]+\//.test(src), false, 'contains /Users/<user>/ literal');
    assert.equal(
      /\.darwin\/memory/.test(src),
      false,
      'contains hard-coded ~/.darwin/memory literal',
    );
  });
  test('init creates the path directory recursively', async () => {
    const { cfg, path } = makeCfg();
    await FilesystemBackend().init({ eventBus: new EventBus(), config: cfg, container: null });
    assert.equal(existsSync(path), true, `expected ${path} to exist after init`);
    assert.deepEqual(readdirSync(path), []);
  });
});

describe('FilesystemBackend — init failure paths', () => {
  test('unwritable path → emit MEMORY_GET_ERROR_MEMORY, NEVER throws', async () => {
    const bus = new EventBus();
    // Build a "file" that will block mkdir from creating a child dir under it.
    const blocker = join(tmpdir(), `darwin-mem-block-${Date.now()}-${Math.random()}`);
    writeFileSync(blocker, 'x');
    const blockedPath = join(blocker, 'subdir-cannot-exist');
    const fakeConfig = { get: () => ({ backend: 'filesystem', path: blockedPath }) };
    const got = [];
    bus.on(EVENTS.MEMORY_GET_ERROR_MEMORY, (p) => got.push(p));
    const m = FilesystemBackend();
    await assert.doesNotReject(m.init({ eventBus: bus, config: fakeConfig, container: null }));
    assert.ok(got.length >= 1, 'expected MEMORY_GET_ERROR_MEMORY on unwritable path');
    rmSync(blocker, { force: true });
  });
});

describe('FilesystemBackend — get/set round-trip', () => {
  let m;
  beforeEach(async () => {
    m = await boot();
  });
  test('set then get returns the value', async () => {
    await m.set('foo', { hello: 'world' });
    assert.deepEqual(await m.get('foo'), { hello: 'world' });
  });
  test('get on missing key returns null (NEVER throws)', async () => {
    let result;
    await assert.doesNotReject(async () => {
      result = await m.get('nope');
    });
    assert.equal(result, null);
  });
  test('set without TTL writes meta.expiresAt = null', async () => {
    await m.set('a', 1);
    const meta = m._meta.get('a');
    assert.ok(meta, 'meta entry should exist for "a"');
    assert.equal(meta.expiresAt, null);
  });
  test('set with TTL writes meta.expiresAt = createdAt + ttl', async () => {
    await m.set('b', 2, 5000);
    const meta = m._meta.get('b');
    assert.ok(meta);
    assert.equal(typeof meta.expiresAt, 'number');
    assert.equal(meta.expiresAt - meta.createdAt, 5000);
  });
});

describe('FilesystemBackend — TTL expiry', () => {
  test('set with ttl=100ms, sleep 200ms → get returns null + file unlinked', async () => {
    const { cfg, path } = makeCfg();
    const m = FilesystemBackend();
    await m.init({ eventBus: new EventBus(), config: cfg, container: null });
    await m.set('ephemeral', 'gone-soon', 100);
    assert.equal(await m.get('ephemeral'), 'gone-soon');
    // Real sleep so the timestamp crosses the expiry boundary.
    await new Promise((r) => setTimeout(r, 200));
    let result;
    await assert.doesNotReject(async () => {
      result = await m.get('ephemeral');
    });
    assert.equal(result, null);
    assert.throws(() => readFileSync(join(path, 'ephemeral.json')));
  });
});

describe('FilesystemBackend — delete', () => {
  let m;
  beforeEach(async () => {
    m = await boot();
  });
  test('delete existing key removes it', async () => {
    await m.set('a', 1);
    const r = await m.delete('a');
    assert.equal(r?.ok !== false, true);
    assert.equal(await m.get('a'), null);
  });
  test('delete missing key is silent (NEVER throws)', async () => {
    let result;
    await assert.doesNotReject(async () => {
      result = await m.delete('ghost');
    });
    assert.equal(result?.ok !== false, true);
  });
});

describe('FilesystemBackend — list + query', () => {
  let m;
  beforeEach(async () => {
    m = await boot();
  });
  test('list() with no prefix returns all keys sorted', async () => {
    await m.set('banana', 1);
    await m.set('apple', 2);
    await m.set('cherry', 3);
    assert.deepEqual(await m.list(), ['apple', 'banana', 'cherry']);
  });
  test('list("ap") filters by prefix', async () => {
    await m.set('apple', 1);
    await m.set('apricot', 2);
    await m.set('banana', 3);
    assert.deepEqual(await m.list('ap'), ['apple', 'apricot']);
  });
  test('query("^user-") matches filenames with regex', async () => {
    await m.set('user-1', 'a');
    await m.set('user-2', 'b');
    await m.set('item-1', 'c');
    assert.deepEqual(await m.query('^user-'), ['user-1', 'user-2']);
  });
});

describe('FilesystemBackend — clear', () => {
  test('clear() removes all keys and recreates the path', async () => {
    const { cfg, path } = makeCfg();
    const m = FilesystemBackend();
    await m.init({ eventBus: new EventBus(), config: cfg, container: null });
    await m.set('a', 1);
    await m.set('b', 2);
    assert.deepEqual(await m.list(), ['a', 'b']);
    const r = await m.clear();
    assert.equal(r?.ok !== false, true);
    assert.deepEqual(await m.list(), []);
    assert.equal(existsSync(path), true);
  });
});

describe('FilesystemBackend — destroy', () => {
  test('destroy() clears the in-memory map (does not touch disk)', async () => {
    const { cfg } = makeCfg();
    const m = FilesystemBackend();
    await m.init({ eventBus: new EventBus(), config: cfg, container: null });
    await m.set('keep-me', 'persisted');
    m.destroy();
    assert.equal(m._meta.size, 0);
    // Re-init should still see the on-disk value.
    const m2 = FilesystemBackend();
    await m2.init({ eventBus: new EventBus(), config: cfg, container: null });
    assert.equal(await m2.get('keep-me'), 'persisted');
  });
});

describe('FilesystemBackend — error isolation + multi-tenant', () => {
  test('FilesystemBackend is multi-tenant with sqlite + vector in MemoryRegistry', () => {
    const bus = new EventBus();
    const reg = new MemoryRegistry({ eventBus: bus });
    const stub = (name) => ({
      name,
      version: '0.0.0',
      capabilities: ['key-value'],
      init() {},
      destroy() {},
      get() {},
      set() {},
      delete() {},
      list() {},
      query() {},
      clear() {},
    });
    reg.register(FilesystemBackend());
    reg.register(stub('sqlite'));
    reg.register(stub('vector'));
    assert.equal(reg.size(), 3);
    assert.equal(reg.has('filesystem') && reg.has('sqlite') && reg.has('vector'), true);
  });
  test('get() on a missing key after destroy returns null, NEVER throws', async () => {
    const m = await boot();
    m.destroy();
    let result;
    await assert.doesNotReject(async () => {
      result = await m.get('whatever');
    });
    assert.equal(result, null);
  });
});
