/**
 * Tests for provider/protocol/_shared.js (V10.2, 2026-06-20).
 * V45.1: splitThinkBlocks lifted out of openai-compatible-stream.js
 * so the chat path can reuse it. Added test cases for the shared
 * helper below.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBaseUrl,
  bearerAuthHeader,
  extractErrorMessage,
  wrapHttpError,
  makeExtractReasoning,
  joinChatUrl,
  splitThinkBlocks,
} from '../provider/protocol/_shared.js';

describe('normalizeBaseUrl', () => {
  test('returns empty for non-string / empty / null', () => {
    assert.equal(normalizeBaseUrl(''), '');
    assert.equal(normalizeBaseUrl(null), '');
    assert.equal(normalizeBaseUrl(undefined), '');
    assert.equal(normalizeBaseUrl(42), '');
  });
  test('strips trailing slash', () => {
    assert.equal(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com');
  });
  test('strips /v1 by default', () => {
    assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com');
  });
  test('strips /compatible-mode/v1 when stripCompatibleMode: true (qwen)', () => {
    assert.equal(
      normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', {
        stripCompatibleMode: true,
      }),
      'https://dashscope.aliyuncs.com',
    );
  });
  test('keeps non-v1 path components', () => {
    assert.equal(
      normalizeBaseUrl('https://api.example.com/api/v2/chat'),
      'https://api.example.com/api/v2/chat',
    );
  });
});

describe('bearerAuthHeader', () => {
  test('produces Content-Type + Authorization: Bearer <key>', () => {
    const h = bearerAuthHeader('sk-abc');
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(h.Authorization, 'Bearer sk-abc');
  });
  test('handles empty key (no throw, produces Bearer )', () => {
    const h = bearerAuthHeader('');
    assert.equal(h.Authorization, 'Bearer ');
  });
});

describe('extractErrorMessage', () => {
  test('parses { error: { message } }', () => {
    assert.equal(extractErrorMessage({ error: { message: 'rate limit' } }, 429), 'rate limit');
  });
  test('parses { error: "string" }', () => {
    assert.equal(extractErrorMessage({ error: 'rate_limit' }, 429), 'rate_limit');
  });
  test('parses { message: "..." }', () => {
    assert.equal(extractErrorMessage({ message: 'timeout' }, 504), 'timeout');
  });
  test('falls back to HTTP <status> on weird / missing body', () => {
    assert.equal(extractErrorMessage(null, 500), 'HTTP 500');
    assert.equal(extractErrorMessage({}, 500), 'HTTP 500');
  });
  test('never throws on weird inputs', () => {
    assert.doesNotThrow(() => extractErrorMessage('not-an-object', 500));
  });
});

describe('wrapHttpError', () => {
  test('builds Error with [label] HTTP <status>: <msg> + .status + .raw', () => {
    const err = wrapHttpError('qwen', { error: { message: 'quota' } }, 429);
    assert.ok(err instanceof Error);
    assert.equal(err.status, 429);
    assert.deepEqual(err.raw, { error: { message: 'quota' } });
    assert.match(err.message, /^\[qwen\] HTTP 429: quota$/);
  });
});

describe('makeExtractReasoning', () => {
  test('returns onAbsent "" when field absent (deepseek style)', () => {
    const ext = makeExtractReasoning({ onAbsent: '' });
    assert.equal(ext({ choices: [{ message: {} }] }), '');
    assert.equal(ext(null), '');
  });
  test('returns onAbsent null when field absent (qwen V3 style)', () => {
    const ext = makeExtractReasoning({ onAbsent: null });
    assert.equal(ext({ choices: [{ message: {} }] }), null);
    assert.equal(ext(null), null);
  });
  test('returns onAbsent when field present but wrong type (defensive)', () => {
    const extNull = makeExtractReasoning({ onAbsent: null });
    assert.equal(extNull({ choices: [{ message: { reasoning_content: 123 } }] }), null);
  });
  test('returns the string when field is non-empty string', () => {
    const ext = makeExtractReasoning({ onAbsent: '' });
    assert.equal(
      ext({ choices: [{ message: { reasoning_content: 'thinking...' } }] }),
      'thinking...',
    );
  });
  test('returns empty string as-is (vendor signal: reasoning was empty, not absent)', () => {
    // An empty string is a valid reasoning_content value. The vendor
    // explicitly said "reasoning was empty", which is different from
    // "field absent" (V3 null) or "field wrong type" (defensive onAbsent).
    // We preserve the empty string so callers can distinguish.
    const ext = makeExtractReasoning({ onAbsent: null });
    assert.equal(ext({ choices: [{ message: { reasoning_content: '' } }] }), '');
    // Same for '' absent (deepseek) -- an explicit '' means "no
    // reasoning", which '' faithfully represents.
    const extDeep = makeExtractReasoning({ onAbsent: '' });
    assert.equal(extDeep({ choices: [{ message: { reasoning_content: '' } }] }), '');
  });
});

describe('joinChatUrl', () => {
  test('joins base + path with single slash', () => {
    assert.equal(
      joinChatUrl('https://api.example.com', '/v1/chat/completions'),
      'https://api.example.com/v1/chat/completions',
    );
  });
  test('returns base alone if path missing leading slash', () => {
    assert.equal(
      joinChatUrl('https://api.example.com', 'no-leading-slash'),
      'https://api.example.com',
    );
  });
  test('returns empty for empty base', () => {
    assert.equal(joinChatUrl('', '/v1/chat/completions'), '');
  });
});

// V45.1: splitThinkBlocks was lifted out of openai-compatible-stream.js
// into _shared.js so the chat path (openai-compatible.js#parseResponseBody)
// can reuse it. These cases mirror the V45 stream suite (8 cases there
// already) but exercise the helper in isolation; the stream suite keeps
// its own end-to-end coverage.
describe('splitThinkBlocks (V45.1, shared helper)', () => {
  test('returns empty defaults for non-string / empty / null', () => {
    for (const v of [null, undefined, '', 0, false, {}]) {
      const out = splitThinkBlocks(v);
      assert.equal(out.visible, '');
      assert.equal(out.reasoning, '');
    }
  });
  test('passes through plain text with no think blocks', () => {
    const out = splitThinkBlocks('Hello world');
    assert.equal(out.visible, 'Hello world');
    assert.equal(out.reasoning, '');
  });
  test('strips a single complete <think>...</think> pair', () => {
    const out = splitThinkBlocks('<think>reasoning here</think>visible answer');
    assert.equal(out.visible, 'visible answer');
    assert.equal(out.reasoning, 'reasoning here');
  });
  test('strips a think block split across the middle of the reply', () => {
    const out = splitThinkBlocks('before<think>hidden</think>after');
    assert.equal(out.visible, 'beforeafter');
    assert.equal(out.reasoning, 'hidden');
  });
  test('treats an unclosed <think> as reasoning (never leaks partial thinking)', () => {
    const out = splitThinkBlocks('before<think>still thinking');
    assert.equal(out.visible, 'before');
    assert.equal(out.reasoning, 'still thinking');
  });
  test('handles multiple think blocks in one reply', () => {
    const out = splitThinkBlocks('A<think>x</think>B<think>y</think>C');
    assert.equal(out.visible, 'ABC');
    assert.equal(out.reasoning, 'xy');
  });
  test('preserves leading/trailing newlines outside the think block', () => {
    const out = splitThinkBlocks('\n<think>h\n</think>\nv\n');
    assert.equal(out.visible, '\n\nv\n');
    assert.equal(out.reasoning, 'h\n');
  });
});
