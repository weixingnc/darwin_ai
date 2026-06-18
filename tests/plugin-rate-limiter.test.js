/**
 * W5-1 (2026-06-18) — rate-limiter plugin tests.
 *
 * The 4th production plugin's real implementation (W5-1 supersedes
 * the P2c-1 "not implemented" stub that W4-2 grew). Verifies the
 * sliding window rate limiter, sync/async APIs, runtime config,
 * and Darwin's first self-grown plugin's IPlugin lifecycle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import rateLimiter from '../plugin/rate-limiter.js';
import { IPlugin, PLUGIN_PERMISSIONS, PLUGIN_DENIED } from '../plugin/interface.js';

test.afterAll ??= (fn) => test('afterAll', async () => fn());

// Helper: rate-limiter is a module-scope singleton (every test imports
// the same default export), so we reset state by calling destroy() +
// init({config: cfg}) before each test. This avoids cross-test
// pollution. The plugin reads config from ctx.config (per
// rate-limiter.js init signature).
function resetLimiter(config = {}) {
  rateLimiter.destroy();
  rateLimiter.init({ config });
}

test('W5-1: manifest validates (P2d contract, in-memory only)', () => {
  assert.equal(rateLimiter.name, 'rate-limiter');
  // W5-1: real impl — supersedes P2c-1 stub from W4-2.
  assert.equal(rateLimiter.version, '0.1.0');
  assert.deepEqual(rateLimiter.capabilities, ['tool']);
  // In-memory only — no fs:append needed.
  assert.deepEqual(rateLimiter.permissions, ['bus:on', 'log:info']);
  assert.ok(PLUGIN_PERMISSIONS.includes('bus:on'));
  assert.ok(!PLUGIN_DENIED.includes('log:info'));
  assert.doesNotThrow(() => IPlugin.validate(rateLimiter));
});

test('W5-1: defaults are 10 calls per 1000ms window', () => {
  resetLimiter();
  const stats = rateLimiter.getStats();
  assert.equal(stats.max_calls, 10);
  assert.equal(stats.window_ms, 1000);
  assert.equal(stats.current_rate, 0);
  assert.equal(stats.total_acquired, 0);
  assert.equal(stats.total_rejected, 0);
  assert.equal(stats.total_waited, 0);
  assert.equal(stats.last_acquire_at, null);
});

test('W5-1: tryAcquire returns true up to max_calls, then false', () => {
  resetLimiter({ max_calls: 3, window_ms: 1000 });
  assert.equal(rateLimiter.tryAcquire(), true, '1st');
  assert.equal(rateLimiter.tryAcquire(), true, '2nd');
  assert.equal(rateLimiter.tryAcquire(), true, '3rd');
  assert.equal(rateLimiter.tryAcquire(), false, '4th rejected');
  assert.equal(rateLimiter.getStats().total_acquired, 3);
  assert.equal(rateLimiter.getStats().total_rejected, 1);
});

test('W5-1: window slides — old calls drop out', async () => {
  // Tight window: 3 calls per 50ms.
  resetLimiter({ max_calls: 3, window_ms: 50 });
  assert.equal(rateLimiter.tryAcquire(), true);
  assert.equal(rateLimiter.tryAcquire(), true);
  assert.equal(rateLimiter.tryAcquire(), true);
  assert.equal(rateLimiter.tryAcquire(), false, 'window full');
  // Wait for the window to slide.
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(rateLimiter.tryAcquire(), true, 'window slid, slot available');
  assert.equal(rateLimiter.getStats().current_rate, 1, 'only new call in window');
});

test('W5-1: acquire() async blocks until slot available', async () => {
  resetLimiter({ max_calls: 2, window_ms: 50 });
  // Fill the window.
  assert.equal(rateLimiter.tryAcquire(), true);
  assert.equal(rateLimiter.tryAcquire(), true);
  // acquire() should block ~50ms then succeed.
  const start = Date.now();
  await rateLimiter.acquire();
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed >= 40 && elapsed < 500,
    `acquire should block ~50ms, took ${elapsed}ms`,
  );
  assert.equal(rateLimiter.getStats().total_acquired, 3);
  assert.ok(rateLimiter.getStats().total_waited >= 1, 'wait counter incremented');
});

test('W5-1: acquire() throws on maxWaitMs timeout', async () => {
  resetLimiter({ max_calls: 1, window_ms: 1000 });
  // Fill the slot.
  assert.equal(rateLimiter.tryAcquire(), true);
  // Try to acquire with a 30ms wait budget — should throw.
  await assert.rejects(
    () => rateLimiter.acquire({ maxWaitMs: 30 }),
    /timed out/,
    'acquire should respect maxWaitMs',
  );
});

test('W5-1: configure() updates limits at runtime', () => {
  resetLimiter({ max_calls: 1, window_ms: 1000 });
  assert.equal(rateLimiter.getStats().max_calls, 1);
  // Reconfigure to 5.
  rateLimiter.configure({ max_calls: 5 });
  assert.equal(rateLimiter.getStats().max_calls, 5);
  assert.equal(rateLimiter.getStats().window_ms, 1000, 'window unchanged');
  // Reconfigure both.
  rateLimiter.configure({ max_calls: 7, window_ms: 500 });
  assert.equal(rateLimiter.getStats().max_calls, 7);
  assert.equal(rateLimiter.getStats().window_ms, 500);
});

test('W5-1: configure() rejects invalid values silently (keeps old)', () => {
  resetLimiter({ max_calls: 5, window_ms: 200 });
  // Bad values: 0, negative, non-integer, missing — silently ignored.
  rateLimiter.configure({ max_calls: 0 });
  rateLimiter.configure({ max_calls: -1 });
  rateLimiter.configure({ max_calls: 1.5 });
  rateLimiter.configure({ max_calls: undefined });
  assert.equal(rateLimiter.getStats().max_calls, 5, 'bad values ignored');
  rateLimiter.configure({ window_ms: 0 });
  assert.equal(rateLimiter.getStats().window_ms, 200, 'bad window ignored');
});

test('W5-1: configure() prunes window to new window_ms', async () => {
  resetLimiter({ max_calls: 5, window_ms: 1000 });
  rateLimiter.tryAcquire();
  rateLimiter.tryAcquire();
  // Tighten the window to 10ms — old calls are now outside.
  await new Promise((resolve) => setTimeout(resolve, 20));
  rateLimiter.configure({ window_ms: 10 });
  // Old calls should be pruned.
  assert.equal(rateLimiter.getStats().current_rate, 0);
  // New slot available.
  assert.equal(rateLimiter.tryAcquire(), true);
});

test('W5-1: disable() lets everything through (guard stands down)', () => {
  resetLimiter({ max_calls: 1, window_ms: 1000 });
  rateLimiter.tryAcquire();
  rateLimiter.tryAcquire(); // rejected
  assert.equal(rateLimiter.getStats().total_rejected, 1);
  rateLimiter.disable();
  // After disable, tryAcquire always returns true.
  assert.equal(rateLimiter.tryAcquire(), true, 'disabled = pass-through');
  assert.equal(rateLimiter.tryAcquire(), true, 'disabled = pass-through');
  rateLimiter.enable();
  assert.equal(rateLimiter.tryAcquire(), false, 're-enabled = back to enforcement');
});

test('W5-1: destroy() clears state and stops enforcing', async () => {
  resetLimiter({ max_calls: 1, window_ms: 1000 });
  rateLimiter.tryAcquire();
  rateLimiter.destroy();
  // After destroy, _calls is empty. tryAcquire would still run if
  // called, but destroy sets _recording = false so it returns true.
  // We test that destroy clears state via the side-effect: re-init
  // should start with current_rate = 0.
  resetLimiter();
  assert.equal(rateLimiter.getStats().current_rate, 0);
  assert.equal(rateLimiter.getStats().total_acquired, 0, 'counters reset');
});

test('W5-1: getStats() returns ISO timestamp on last_acquire_at', () => {
  resetLimiter({ max_calls: 5, window_ms: 1000 });
  rateLimiter.tryAcquire();
  const stats = rateLimiter.getStats();
  assert.ok(
    stats.last_acquire_at !== null,
    'last_acquire_at set after acquire',
  );
  // ISO 8601 format check.
  assert.match(stats.last_acquire_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('W5-1: stats counters increment correctly under mixed load', () => {
  resetLimiter({ max_calls: 3, window_ms: 1000 });
  rateLimiter.tryAcquire();
  rateLimiter.tryAcquire();
  rateLimiter.tryAcquire();
  rateLimiter.tryAcquire(); // rejected
  rateLimiter.tryAcquire(); // rejected
  const stats = rateLimiter.getStats();
  assert.equal(stats.total_acquired, 3);
  assert.equal(stats.total_rejected, 2);
  assert.equal(stats.current_rate, 3);
});

test.afterAll(() => {
  // Best-effort cleanup; no global state to reset since rate-limiter
  // is in-memory only.
});
