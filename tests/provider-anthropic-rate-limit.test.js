/** W6-1 (2026-06-18) — rate-limiter integration with AnthropicProvider.
 *
 * Verifies that:
 *  - rate-limiter falls open when not initialised (existing tests safe)
 *  - when initialised + configured for 'anthropic' scope, _doChat
 *    throws structured RATE_LIMITED on the 4th call within window
 *  - stream() also gates on the 'anthropic' scope
 *  - per-scope isolation: 'anthropic' rate-limit does NOT affect
 *    the default bucket or any other scope
 *  - error carries stats, code, scope, op for host inspection
 *
 * rate-limiter is a module-scope singleton; each test calls
 * destroy() + init() + configureScope() to set up isolated state.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { AnthropicProvider } from '../provider/anthropic.js';
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
    return ok({
      content: [{ type: 'text', text: 'ok' }],
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
};

const mkProvider = () => {
  const bus = new EventBus();
  const p = new AnthropicProvider({
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-ant-test',
    defaultModel: 'claude-3-5-sonnet-20241022',
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

describe('W6-1: AnthropicProvider — rate-limiter integration', () => {
  before(() => {
    origFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = origFetch;
  });

  test('falls open when rate-limiter is not initialised', async () => {
    rateLimiter.destroy(); // _recording = false → fall open
    installFetch();
    const p = mkProvider();
    // 20 calls in a row — should all succeed because limiter is down.
    for (let i = 0; i < 20; i++) {
      const r = await p.chat([{ role: 'user', content: `m${i}` }]);
      assert.equal(r.ok, true, `call #${i + 1} should succeed`);
    }
    assert.equal(calls.length, 20);
  });

  test('falls open when rate-limiter is disabled (init then disable)', async () => {
    rateLimiter.destroy();
    rateLimiter.init({});
    rateLimiter.disable(); // _recording = false
    installFetch();
    const p = mkProvider();
    for (let i = 0; i < 20; i++) {
      const r = await p.chat([{ role: 'user', content: `d${i}` }]);
      assert.equal(r.ok, true);
    }
    assert.equal(calls.length, 20);
  });

  test('4th chat() within window throws RATE_LIMITED (anthropic scope)', async () => {
    resetLimiter({ anthropic: { max_calls: 3, window_ms: 60_000 } });
    installFetch();
    const p = mkProvider();
    // First 3 should succeed.
    for (let i = 0; i < 3; i++) {
      const r = await p.chat([{ role: 'user', content: `a${i}` }]);
      assert.equal(r.ok, true, `call #${i + 1} should succeed`);
    }
    // 4th should return {ok:false, error} (ProviderBase._wrap never throws).
    const r4 = await p.chat([{ role: 'user', content: 'a4' }]);
    assert.equal(r4.ok, false, '4th call should be rejected');
    assert.equal(r4.error.code, 'RATE_LIMITED');
    assert.equal(r4.error.scope, 'anthropic');
    assert.equal(r4.error.op, '_doChat');
    assert.ok(r4.error.stats, 'error should carry stats');
    assert.equal(r4.error.stats.scope, 'anthropic');
    assert.equal(r4.error.stats.max_calls, 3);
    assert.equal(r4.error.stats.current_rate, 3);
    assert.match(r4.error.message, /rate-limited/);
    // Fetch was called exactly 3 times, not 4.
    assert.equal(calls.length, 3);
  });

  test('stream() also gates on anthropic scope', async () => {
    resetLimiter({ anthropic: { max_calls: 2, window_ms: 60_000 } });
    installFetch();
    const p = mkProvider();
    // First 2 streams OK.
    for (let i = 0; i < 2; i++) {
      const it = p.stream([{ role: 'user', content: `s${i}` }]);
      // drain one item to ensure the gate ran
      await it.next();
    }
    // 3rd stream: base class wraps in {ok,value/error} for the async-iterable.
    // Our _enforceRateLimit is called inside stream() (an async generator);
    // the throw propagates as a rejected iterator when the consumer calls
    // .next() for the first time.
    const it3 = p.stream([{ role: 'user', content: 's3' }]);
    await assert.rejects(it3.next(), (err) => {
      assert.equal(err.code, 'RATE_LIMITED');
      assert.equal(err.op, 'stream');
      return true;
    });
  });

  test('per-scope isolation: anthropic limit does NOT block default or other scopes', async () => {
    resetLimiter({ anthropic: { max_calls: 2, window_ms: 60_000 } });
    installFetch();
    const p = mkProvider();
    // Exhaust anthropic.
    const r1 = await p.chat([{ role: 'user', content: 'x' }]);
    assert.equal(r1.ok, true);
    const r2 = await p.chat([{ role: 'user', content: 'y' }]);
    assert.equal(r2.ok, true);
    const r3 = await p.chat([{ role: 'user', content: 'z' }]);
    assert.equal(r3.ok, false);
    assert.equal(r3.error.code, 'RATE_LIMITED');
    // Default bucket is still empty.
    const defaultStats = rateLimiter.getStats();
    assert.equal(defaultStats.current_rate, 0);
    assert.equal(defaultStats.max_calls, 10); // plugin default
    // OpenAI scope (different provider, different bucket) should pass.
    assert.equal(rateLimiter.tryAcquireFor('openai'), true);
    assert.equal(rateLimiter.getStatsFor('openai').current_rate, 1);
  });

  test('error carries actionable stats for backoff', async () => {
    resetLimiter({ anthropic: { max_calls: 1, window_ms: 60_000 } });
    installFetch();
    const p = mkProvider();
    const r1 = await p.chat([{ role: 'user', content: 'q' }]);
    assert.equal(r1.ok, true);
    const r2 = await p.chat([{ role: 'user', content: 'q2' }]);
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'RATE_LIMITED');
    assert.ok(r2.error.stats, 'has stats');
    assert.equal(r2.error.stats.scope, 'anthropic');
    assert.equal(r2.error.stats.max_calls, 1);
    assert.equal(r2.error.stats.current_rate, 1);
    assert.equal(typeof r2.error.stats.window_ms, 'number');
    assert.equal(r2.error.stats.total_rejected, 1);
  });

  test('configureScope lower than default shrinks bucket immediately', async () => {
    resetLimiter();
    // Default: 10 calls/window. Configure anthropic to 1.
    rateLimiter.configureScope('anthropic', { max_calls: 1, window_ms: 60_000 });
    installFetch();
    const p = mkProvider();
    const r1 = await p.chat([{ role: 'user', content: 'm' }]);
    assert.equal(r1.ok, true);
    const r2 = await p.chat([{ role: 'user', content: 'm2' }]);
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'RATE_LIMITED');
  });
});
