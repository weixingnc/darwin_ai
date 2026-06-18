/** W6-2 (2026-06-18) — llm-cache plugin tests.
 *
 * Coverage:
 *   - Manifest (P2d contract, in-memory only, no fs:append)
 *   - makeKey determinism: same logical prompt → same key
 *   - makeKey normalisation: whitespace/tool_call order ignored
 *   - get/set basic + LRU touch on hit
 *   - TTL expiry (lazy drop on get)
 *   - TTL=0 means "no expiry"
 *   - LRU eviction when max_entries reached
 *   - max_value_bytes guard rejects oversized values
 *   - Invalid keys (non-string, empty) → false / null
 *   - Disable → null on get, false on set
 *   - Stats (hits, misses, hit_rate, evictions, expirations)
 *   - clear() empties entries without resetting stats
 *   - destroy() resets _recording to false
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import llmCache from '../plugin/llm-cache.js';
import { makeKey, stableStringify, normaliseMessage } from '../plugin/llm-cache-key.js';
import { IPlugin } from '../plugin/interface.js';

const resetCache = (config = {}) => {
  llmCache.destroy();
  llmCache.init({ config });
};

describe('W6-2: llm-cache — manifest (P2d contract)', () => {
  beforeEach(() => resetCache());

  test('name / version / capabilities / permissions', () => {
    assert.equal(llmCache.name, 'llm-cache');
    assert.equal(llmCache.version, '0.1.0');
    assert.deepEqual(llmCache.capabilities, ['tool']);
    // In-memory only — no fs:append (cache is ephemeral).
    assert.deepEqual(llmCache.permissions, ['bus:on', 'log:info']);
  });

  test('validates against IPlugin contract', () => {
    assert.doesNotThrow(() => IPlugin.validate(llmCache));
  });
});

describe('W6-2: llm-cache — makeKey determinism', () => {
  test('same messages + model → same key', () => {
    const messages = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ];
    const k1 = makeKey(messages, 'claude-3-5-sonnet');
    const k2 = makeKey(messages, 'claude-3-5-sonnet');
    assert.equal(k1, k2);
    assert.equal(k1.length, 64); // SHA-256 hex
    assert.match(k1, /^[0-9a-f]{64}$/);
  });

  test('different model → different key', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const k1 = makeKey(messages, 'claude-3-5-sonnet');
    const k2 = makeKey(messages, 'gpt-4o');
    assert.notEqual(k1, k2);
  });

  test('whitespace in content is ignored', () => {
    const a = makeKey([{ role: 'user', content: '  hello  ' }], 'm');
    const b = makeKey([{ role: 'user', content: 'hello' }], 'm');
    assert.equal(a, b);
  });

  test('tool_call order is normalised (sorted by id)', () => {
    const a = makeKey(
      [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'B', type: 'function', function: { name: 'b', arguments: '{}' } },
            { id: 'A', type: 'function', function: { name: 'a', arguments: '{}' } },
          ],
        },
      ],
      'm',
    );
    const b = makeKey(
      [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'A', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'B', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
      ],
      'm',
    );
    assert.equal(a, b);
  });

  test('volatile fields (timestamp, run_id) are dropped', () => {
    const a = makeKey([{ role: 'user', content: 'x', timestamp: 1, run_id: 'r1' }], 'm');
    const b = makeKey([{ role: 'user', content: 'x', timestamp: 999, run_id: 'r2' }], 'm');
    assert.equal(a, b);
  });

  test('non-string content is preserved verbatim', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'img desc' }] }];
    const k = makeKey(messages, 'm');
    assert.equal(k.length, 64);
  });
});

describe('W6-2: llm-cache — get/set basics', () => {
  beforeEach(() => resetCache());

  test('set then get returns the value', () => {
    assert.equal(llmCache.set('k1', { v: 1 }), true);
    assert.deepEqual(llmCache.get('k1'), { v: 1 });
  });

  test('get on missing key returns null', () => {
    assert.equal(llmCache.get('nope'), null);
  });

  test('set on invalid key returns false', () => {
    assert.equal(llmCache.set('', { v: 1 }), false);
    assert.equal(llmCache.set(null, { v: 1 }), false);
    assert.equal(llmCache.set(123, { v: 1 }), false);
  });

  test('get on invalid key returns null + counts miss', () => {
    llmCache.get('');
    llmCache.get(null);
    assert.equal(llmCache.stats().misses, 2);
  });

  test('non-serialisable value rejected', () => {
    const circular = {};
    circular.self = circular;
    assert.equal(llmCache.set('k', circular), false);
  });

  test('size reflects live entries', () => {
    assert.equal(llmCache.size(), 0);
    llmCache.set('a', 1);
    llmCache.set('b', 2);
    assert.equal(llmCache.size(), 2);
  });
});

describe('W6-2: llm-cache — TTL', () => {
  test('TTL expiry: get drops entry and counts as miss', async () => {
    resetCache({ default_ttl_ms: 10 });
    llmCache.set('k', 'v');
    assert.equal(llmCache.get('k'), 'v');
    // Wait for expiry.
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(llmCache.get('k'), null);
    const s = llmCache.stats();
    assert.equal(s.expirations, 1);
    assert.equal(s.misses, 1);
    assert.equal(llmCache.size(), 0);
  });

  test('ttl_ms: 0 = no expiry (plugin default overridden)', async () => {
    resetCache({ default_ttl_ms: 10 });
    llmCache.set('k', 'v', { ttl_ms: 0 });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(llmCache.get('k'), 'v');
  });

  test('ttl_ms: 50 overrides default', async () => {
    resetCache({ default_ttl_ms: 1000 });
    llmCache.set('k', 'v', { ttl_ms: 30 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(llmCache.get('k'), null);
  });
});

describe('W6-2: llm-cache — LRU eviction', () => {
  test('eviction: max_entries=3 → 4th set evicts the oldest', () => {
    resetCache({ max_entries: 3, default_ttl_ms: 0 });
    llmCache.set('a', 1);
    llmCache.set('b', 2);
    llmCache.set('c', 3);
    llmCache.set('d', 4); // evicts 'a'
    assert.equal(llmCache.size(), 3);
    assert.equal(llmCache.get('a'), null);
    assert.equal(llmCache.get('d'), 4);
    assert.equal(llmCache.stats().evictions, 1);
  });

  test('LRU touch on hit: recently-read entry survives eviction', () => {
    resetCache({ max_entries: 3, default_ttl_ms: 0 });
    llmCache.set('a', 1);
    llmCache.set('b', 2);
    llmCache.set('c', 3);
    // Touch 'a' (move to head).
    assert.equal(llmCache.get('a'), 1);
    // Insert 'd' → evicts oldest non-touched = 'b' (not 'a').
    llmCache.set('d', 4);
    assert.equal(llmCache.get('a'), 1, 'a was touched, survives');
    assert.equal(llmCache.get('b'), null, 'b is oldest, evicted');
    assert.equal(llmCache.get('c'), 3);
    assert.equal(llmCache.get('d'), 4);
  });

  test('re-set of existing key moves to head (no eviction)', () => {
    resetCache({ max_entries: 3, default_ttl_ms: 0 });
    llmCache.set('a', 1);
    llmCache.set('b', 2);
    llmCache.set('c', 3);
    llmCache.set('a', 11); // update value, move to head
    llmCache.set('d', 4); // evicts 'b' (oldest non-touched)
    assert.equal(llmCache.get('a'), 11);
    assert.equal(llmCache.get('b'), null);
  });

  test('max_entries=0 = unlimited (no eviction)', () => {
    resetCache({ max_entries: 0, default_ttl_ms: 0 });
    for (let i = 0; i < 50; i += 1) {
      llmCache.set(`k${i}`, i);
    }
    assert.equal(llmCache.size(), 50);
    assert.equal(llmCache.stats().evictions, 0);
  });
});

describe('W6-2: llm-cache — value size guard', () => {
  test('rejects values larger than max_value_bytes', () => {
    resetCache({ max_value_bytes: 100, default_ttl_ms: 0 });
    const big = 'x'.repeat(200);
    assert.equal(llmCache.set('k', big), false);
    assert.equal(llmCache.size(), 0);
  });
});

describe('W6-2: llm-cache — disable / destroy', () => {
  test('disable → get returns null, set returns false (no false cache hits)', () => {
    resetCache();
    llmCache.set('k', 'v');
    llmCache.disable();
    assert.equal(llmCache.get('k'), null);
    assert.equal(llmCache.set('k', 'v2'), false);
    // Stats not counted while disabled.
    const before = llmCache.stats().hits;
    llmCache.get('k');
    assert.equal(llmCache.stats().hits, before);
  });

  test('destroy() clears entries and disables', () => {
    resetCache();
    llmCache.set('k', 'v');
    assert.equal(llmCache.size(), 1);
    llmCache.destroy();
    // After destroy, _recording is false → get returns null.
    assert.equal(llmCache.get('k'), null);
  });

  test('destroy on uninitialised state is safe', () => {
    llmCache.destroy();
    llmCache.destroy(); // idempotent
    assert.equal(llmCache.get('k'), null);
  });
});

describe('W6-2: llm-cache — stats', () => {
  test('hit_rate calculation', () => {
    resetCache({ default_ttl_ms: 0 });
    llmCache.set('a', 1);
    llmCache.set('b', 2);
    llmCache.get('a'); // hit
    llmCache.get('a'); // hit
    llmCache.get('c'); // miss
    const s = llmCache.stats();
    assert.equal(s.hits, 2);
    assert.equal(s.misses, 1);
    assert.equal(s.total_set, 2);
    assert.equal(s.total_get, 3);
    assert.ok(Math.abs(s.hit_rate - 2 / 3) < 1e-9);
  });

  test('clear() empties entries but does not reset stats', () => {
    resetCache();
    llmCache.set('a', 1);
    llmCache.get('a');
    const before = llmCache.stats();
    llmCache.clear();
    assert.equal(llmCache.size(), 0);
    const after = llmCache.stats();
    assert.equal(after.hits, before.hits);
    assert.equal(after.misses, before.misses);
  });

  test('delete() returns true on existing key, false on missing', () => {
    resetCache();
    llmCache.set('a', 1);
    assert.equal(llmCache.delete('a'), true);
    assert.equal(llmCache.delete('a'), false);
    assert.equal(llmCache.size(), 0);
  });
});

describe('W6-2: llm-cache-key — internals', () => {
  test('stableStringify: key order independent', () => {
    const a = stableStringify({ a: 1, b: 2 });
    const b = stableStringify({ b: 2, a: 1 });
    assert.equal(a, b);
  });

  test('stableStringify: nested object key order independent', () => {
    const a = stableStringify({ outer: { a: 1, b: 2 } });
    const b = stableStringify({ outer: { b: 2, a: 1 } });
    assert.equal(a, b);
  });

  test('stableStringify: array order matters (intentional)', () => {
    const a = stableStringify([1, 2, 3]);
    const b = stableStringify([3, 2, 1]);
    assert.notEqual(a, b);
  });

  test('normaliseMessage: drops volatile fields', () => {
    const m = normaliseMessage({
      role: 'user',
      content: '  hi  ',
      timestamp: 12345,
      run_id: 'r1',
      session_id: 's1',
    });
    assert.deepEqual(m, { role: 'user', content: 'hi' });
  });

  test('normaliseMessage: handles non-string content', () => {
    const m = normaliseMessage({
      role: 'user',
      content: [{ type: 'text', text: 'img' }],
    });
    assert.equal(m.role, 'user');
    assert.deepEqual(m.content, [{ type: 'text', text: 'img' }]);
  });

  test('normaliseMessage: null/undefined safe', () => {
    assert.equal(normaliseMessage(null), null);
    assert.equal(normaliseMessage(undefined), undefined);
  });
});
