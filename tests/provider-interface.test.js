/**
 * IProvider contract tests — TDD red→green for PR 6.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IProvider } from '../provider/interface.js';

describe('IProvider — shape', () => {
  test('has name + capabilities fields; default caps include "chat"', () => {
    assert.ok('name' in IProvider);
    assert.ok('capabilities' in IProvider);
    assert.ok(Array.isArray(IProvider.capabilities));
    assert.ok(IProvider.capabilities.includes('chat'));
  });

  test('exposes prototype with chat/stream/embed/listModels methods', () => {
    for (const m of ['chat', 'stream', 'embed', 'listModels']) {
      assert.equal(typeof IProvider.prototype[m], 'function', `prototype.${m} must be function`);
    }
  });

  test('default listModels() → []; chat/stream/embed throw "not implemented"', async () => {
    assert.deepEqual(await IProvider.prototype.listModels(), []);
    await assert.rejects(() => IProvider.prototype.chat([], {}), /not implemented/);
    await assert.rejects(() => IProvider.prototype.stream([], {}), /not implemented/);
    await assert.rejects(() => IProvider.prototype.embed('x'), /not implemented/);
  });
});

describe('IProvider.validate', () => {
  const ok = () => Promise.resolve({ content: '', usage: {}, raw: null });
  test('throws on non-object, missing/empty name, non-array caps, non-string cap, missing chat', () => {
    assert.throws(() => IProvider.validate(null), /object/);
    assert.throws(() => IProvider.validate({ capabilities: ['chat'], chat: ok }), /name/);
    assert.throws(() => IProvider.validate({ name: '', capabilities: ['chat'], chat: ok }), /name/);
    assert.throws(
      () => IProvider.validate({ name: 'x', capabilities: 'chat', chat: ok }),
      /capabilities/,
    );
    assert.throws(
      () => IProvider.validate({ name: 'x', capabilities: [1, 2], chat: ok }),
      /capability/,
    );
    assert.throws(() => IProvider.validate({ name: 'x', capabilities: ['chat'] }), /chat/);
  });

  test('returns {ok: true} for a minimal valid provider', () => {
    const p = {
      name: 'ok',
      capabilities: ['chat'],
      chat: ok,
      listModels: () => Promise.resolve([]),
    };
    assert.equal(IProvider.validate(p).ok, true);
  });
});
