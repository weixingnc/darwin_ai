/**
 * memory/sqlite — SqliteBackend IMemory contract tests.
 *
 * 12 tests mirroring tests/memory-filesystem.test.js style:
 * shape, validate, init, set/get round-trip, JSON serialization,
 * overwrite, delete, has, list prefix/sorted, clear, TTL expiry, errors.
 *
 * Uses node:sqlite with :memory: database for hermetic tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { SqliteBackend } from '../memory/sqlite-backend.js';

function ctx() {
  return {
    eventBus: new EventBus(),
    // ConfigResolver stand-in: SqliteBackend reads ctx.config.get('memory-default')
    // and falls back to ':memory:' if path is missing. We pass a stub config.
    config: { get: (k) => (k === 'memory-default' ? { path: ':memory:' } : {}) },
  };
}

describe('memory/sqlite — SqliteBackend (IMemory contract)', () => {
  test('1. shape: 9 fields all present and well-typed', () => {
    const m = SqliteBackend();
    assert.equal(m.name, 'sqlite');
    assert.equal(typeof m.init, 'function');
    assert.equal(typeof m.get, 'function');
    assert.equal(typeof m.set, 'function');
    assert.equal(typeof m.delete, 'function');
    assert.equal(typeof m.has, 'function');
    assert.equal(typeof m.list, 'function');
    assert.equal(typeof m.clear, 'function');
    assert.equal(typeof m.destroy, 'function');
  });

  test('2. validate() returns true (self-checks identity + capabilities)', () => {
    const m = SqliteBackend();
    assert.equal(m.validate(), true);
  });

  test('3. set + get round-trip (string value)', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    const r = await m.set('foo', 'bar');
    assert.equal(r.ok, true);
    assert.equal(await m.get('foo'), 'bar');
  });

  test('4. set + get: object/array auto JSON.stringify / parse', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    const obj = { a: 1, b: [1, 2, 3], c: { d: 'deep' } };
    await m.set('o', obj);
    const got = await m.get('o');
    assert.deepEqual(got, obj);
    const arr = [1, 'two', { three: 3 }];
    await m.set('arr', arr);
    assert.deepEqual(await m.get('arr'), arr);
  });

  test('5. set overwrites same key (REPLACE semantics)', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    await m.set('k', 'v1');
    await m.set('k', 'v2');
    assert.equal(await m.get('k'), 'v2');
  });

  test('6. delete: returns ok + true if existed, false if not', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    await m.set('d', 1);
    const r1 = await m.delete('d');
    assert.equal(r1.ok, true);
    assert.equal(r1.count, 1);
    const r2 = await m.delete('never-existed');
    assert.equal(r2.ok, true);
    assert.equal(r2.count, 0);
  });

  test('7. has: true / false', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    await m.set('h', 1);
    assert.equal(await m.has('h'), true);
    assert.equal(await m.has('missing'), false);
  });

  test('8. list: returns sorted keys matching prefix', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    await m.set('user:1', 'a');
    await m.set('user:2', 'b');
    await m.set('item:1', 'c');
    const users = await m.list('user:');
    assert.deepEqual(users, ['user:1', 'user:2']);
  });

  test('9. list: empty prefix returns all keys sorted', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    await m.set('b', 1);
    await m.set('a', 2);
    await m.set('c', 3);
    assert.deepEqual(await m.list(''), ['a', 'b', 'c']);
  });

  test('10. clear: deletes all keys + returns count', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    await m.set('a', 1);
    await m.set('b', 2);
    await m.set('c', 3);
    const r = await m.clear();
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
    assert.deepEqual(await m.list(''), []);
  });

  test('11. TTL: expired key auto-deletes on get (no error)', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    await m.set('ephemeral', 'soon-gone', 50); // 50ms ttl
    assert.equal(await m.get('ephemeral'), 'soon-gone');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await m.get('ephemeral'), null);
    assert.equal(await m.has('ephemeral'), false);
  });

  test('12. errors: invalid key (null/empty) returns {ok:false} — NEVER throws', async () => {
    const m = SqliteBackend();
    await m.init(ctx());
    const r1 = await m.set(null, 'v');
    assert.equal(r1.ok, false);
    const r2 = await m.set('', 'v');
    assert.equal(r2.ok, false);
    assert.equal(await m.get(null), null);
    assert.equal(await m.has(''), false);
  });
});
