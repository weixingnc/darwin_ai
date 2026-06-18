/** W7-1 (2026-06-18) — rate-limiter integration with OpenAICompatibleProvider.
 *
 * Mirrors tests/provider-anthropic-rate-limit.test.js (W6-1). The
 * 'openai-compatible' scope is independent of 'anthropic' (W6-1
 * per-scope buckets guarantee no cross-provider starvation).
 *
 * Coverage:
 *   - Falls open when rate-limiter is not initialised
 *   - 4th chat() within window returns {ok:false, error.code=RATE_LIMITED}
 *   - stream() also gates on the 'openai-compatible' scope
 *   - per-scope isolation: 'openai-compatible' limit does NOT block
 *     'anthropic' or the default bucket
 *   - error carries actionable stats (current_rate, max_calls, etc.)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { OpenAICompatibleProvider } from '../provider/openai-compatible.js';
import rateLimiter from '../plugin/rate-limiter.js';

const ok = (b) => ({
  ok: true,
  status: 200,
  json: async () => b,
  text: async () => JSON.stringify(b),
});

let origFetch;
let calls;
const installFetch = () => {
  calls = [];
  globalThis.fetch = async () => {
    calls.push(Date.now());
    // OpenAI-compatible protocol expects:
    //   rawResponse.choices[0].message.{content,tool_calls}
    //   rawResponse.usage.{prompt_tokens,completion_tokens}
    return ok({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'ok',
            tool_calls: [],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
};

const mkProvider = () => {
  const bus = new EventBus();
  const p = new OpenAICompatibleProvider({
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    defaultModel: 'gpt-4o-mini',
    eventBus: bus,
  });
  return p;
};

const resetLimiter = (scopeConfig = {}) => {
  rateLimiter.destroy();
  rateLimiter.init({});
  for (const [scope, cfg] of Object.entries(scopeConfig)) {
    rateLimiter.configureScope(scope, cfg);
  }
};

describe('W7-1: OpenAICompatibleProvider — rate-limiter integration', () => {
  before(() => {
    origFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = origFetch;
  });

  test('falls open when rate-limiter is not initialised', async () => {
    rateLimiter.destroy();
    installFetch();
    const p = mkProvider();
    for (let i = 0; i < 20; i += 1) {
      const r = await p.chat([{ role: 'user', content: `m${i}` }]);
      assert.equal(r.ok, true, `call #${i + 1} should succeed`);
    }
    assert.equal(calls.length, 20);
  });

  test('4th chat() within window returns RATE_LIMITED (openai-compatible scope)', async () => {
    resetLimiter({ 'openai-compatible': { max_calls: 3, window_ms: 60_000 } });
    installFetch();
    const p = mkProvider();
    for (let i = 0; i < 3; i += 1) {
      const r = await p.chat([{ role: 'user', content: `o${i}` }]);
      assert.equal(r.ok, true);
    }
    const r4 = await p.chat([{ role: 'user', content: 'o4' }]);
    assert.equal(r4.ok, false);
    assert.equal(r4.error.code, 'RATE_LIMITED');
    assert.equal(r4.error.scope, 'openai-compatible');
    assert.equal(r4.error.op, '_doChat');
    assert.ok(r4.error.stats);
    assert.equal(r4.error.stats.scope, 'openai-compatible');
    assert.equal(r4.error.stats.max_calls, 3);
    assert.equal(r4.error.stats.current_rate, 3);
    assert.match(r4.error.message, /openai-compatible/);
    assert.match(r4.error.message, /rate-limited/);
    assert.equal(calls.length, 3);
  });

  test('per-scope isolation: openai-compatible limit does NOT block anthropic', async () => {
    resetLimiter({ 'openai-compatible': { max_calls: 1, window_ms: 60_000 } });
    installFetch();
    const p = mkProvider();
    const r1 = await p.chat([{ role: 'user', content: 'x' }]);
    assert.equal(r1.ok, true);
    const r2 = await p.chat([{ role: 'user', content: 'y' }]);
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'RATE_LIMITED');
    // Anthropic scope is independent.
    assert.equal(rateLimiter.tryAcquireFor('anthropic'), true);
    assert.equal(rateLimiter.getStatsFor('anthropic').current_rate, 1);
    // Default bucket still empty.
    const defaultStats = rateLimiter.getStats();
    assert.equal(defaultStats.current_rate, 0);
  });

  test('stream() also gates on openai-compatible scope', async () => {
    resetLimiter({ 'openai-compatible': { max_calls: 2, window_ms: 60_000 } });
    installFetch();
    const p = mkProvider();
    for (let i = 0; i < 2; i += 1) {
      const it = p.stream([{ role: 'user', content: `s${i}` }]);
      await it.next();
    }
    const it3 = p.stream([{ role: 'user', content: 's3' }]);
    await assert.rejects(it3.next(), (err) => {
      assert.equal(err.code, 'RATE_LIMITED');
      assert.equal(err.op, 'stream');
      assert.equal(err.scope, 'openai-compatible');
      return true;
    });
  });
});
