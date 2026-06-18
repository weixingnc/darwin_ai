/**
 * rate-limiter — Darwin outgoing-call rate limiter plugin (W5-1, 2026-06-18).
 *
 * 4th production plugin in plugin/ (after logger, audit, metrics).
 * Darwin's first self-grown plugin — W4-2 ran `evolve --confirm` and
 * wrote a P2c-1 manifest stub with init/destroy methods that threw
 * "not implemented". W5-1 fills in the real implementation.
 *
 * Purpose: limit outgoing LLM calls (or any other Darwin operation)
 * to a configurable rate. Prevents runaway agents from saturating an
 * upstream API, controls cost, and provides backpressure under load.
 *
 * Algorithm: sliding window counter. Each acquire() pushes a
 * timestamp into a ring buffer; before pushing, prune entries older
 * than the window. If size >= max_calls, refuse (tryAcquire) or wait
 * (acquire). O(1) amortized (prune drops the whole prefix at once
 * when the oldest entry is too old).
 *
 * Manifest (P2d contract):
 *   - name         'rate-limiter'
 *   - version      '0.1.0'           (W5-1: real impl — supersedes
 *                                     P2c-1 stub from W4-2)
 *   - capabilities ['tool']          (PLUGIN_CAPABILITIES category)
 *   - permissions  ['bus:on', 'log:info']
 *                                     (in-memory only — no fs:append
 *                                      needed; rate state is ephemeral
 *                                      and not persisted across
 *                                      restarts. Darwin's process
 *                                      restart = new rate budget.)
 *
 * Public API (in addition to IPlugin lifecycle):
 *   tryAcquire()              → boolean (sync, non-blocking)
 *   acquire(opts)             → Promise<void> (async, blocks until
 *                                slot available, then acquires)
 *   getStats()                → { current_rate, max_calls, window_ms,
 *                                last_acquire_at, total_acquired,
 *                                total_rejected, total_waited }
 *   configure({ max, window })  update rate params at runtime
 *
 * Config (from ctx.config or defaults):
 *   max_calls   10   (max acquires per window)
 *   window_ms   1000 (sliding window duration in ms)
 *
 * Design notes:
 *   - acquire() uses busy-wait with setTimeout(0) for the wait.
 *     Simpler than a scheduler; rate windows are ms-scale so the
 *     CPU cost is bounded. For Darwin's LLM use case (sub-second
 *     to multi-second per call) this is fine.
 *   - No LLM-specific knowledge: this plugin is generic. LLM
 *     integration (calling acquire() before each LLM request) is
 *     the host's responsibility (see Darwin core/llm-client.js or
 *     provider/* future integration).
 *   - In-memory only: rate-limit state is not persisted. Process
 *     restart = fresh budget. This is intentional: rate limits
 *     are a property of the current burst, not history.
 */

const DEFAULTS = Object.freeze({
  max_calls: 10,
  window_ms: 1000,
});

export default {
  name: 'rate-limiter',
  version: '0.1.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'log:info'],

  init(ctx) {
    const cfg = ctx.config || {};
    this._maxCalls = Number.isInteger(cfg.max_calls)
      ? cfg.max_calls
      : DEFAULTS.max_calls;
    this._windowMs = Number.isInteger(cfg.window_ms)
      ? cfg.window_ms
      : DEFAULTS.window_ms;
    // Sliding window state.
    this._calls = []; // timestamps (ms since epoch) of recent acquires
    this._recording = true;
    // Stats.
    this._lastAcquireAt = null;
    this._totalAcquired = 0;
    this._totalRejected = 0;
    this._totalWaited = 0;
  },

  enable() {
    this._recording = true;
  },

  disable() {
    this._recording = false;
  },

  destroy() {
    this._calls = [];
    this._recording = false;
  },

  /**
   * Sync, non-blocking. Returns true if a slot is available and the
   * call is recorded; false if the window is full. Does NOT wait.
   */
  tryAcquire() {
    if (!this._recording) {
      // When disabled, behaviour is "let everything through" — the
      // plugin is a guard, not a gate, and disable = stand down.
      return true;
    }
    this._prune();
    if (this._calls.length >= this._maxCalls) {
      this._totalRejected += 1;
      return false;
    }
    this._calls.push(Date.now());
    this._lastAcquireAt = this._calls[this._calls.length - 1];
    this._totalAcquired += 1;
    return true;
  },

  /**
   * Async, blocking. Returns when a slot is available. Resolves to
   * nothing (just side-effects on the rate state). opts.maxWaitMs
   * (default: windowMs) bounds the wait — if the wait would exceed
   * maxWaitMs, throws an Error so the caller can choose to retry,
   * back off differently, or fail.
   */
  async acquire(opts = {}) {
    if (this.tryAcquire()) {
      return;
    }
    const maxWaitMs = Number.isInteger(opts.maxWaitMs)
      ? opts.maxWaitMs
      : this._windowMs;
    const deadline = Date.now() + maxWaitMs;
    while (!this.tryAcquire()) {
      this._totalWaited += 1;
      if (Date.now() >= deadline) {
        throw new Error(
          `[rate-limiter] acquire timed out after ${maxWaitMs}ms ` +
            `(window=${this._windowMs}ms, max=${this._maxCalls})`,
        );
      }
      // Sleep for a small interval. windowMs/10 is a reasonable
      // compromise: short enough to react quickly, long enough
      // not to spin the event loop.
      const sleep = Math.max(1, Math.floor(this._windowMs / 10));
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
  },

  /**
   * Stats snapshot. current_rate = number of acquires in the
   * current window. max_calls / window_ms are the configured
   * limits.
   */
  getStats() {
    this._prune();
    return {
      current_rate: this._calls.length,
      max_calls: this._maxCalls,
      window_ms: this._windowMs,
      last_acquire_at:
        this._lastAcquireAt !== null
          ? new Date(this._lastAcquireAt).toISOString()
          : null,
      total_acquired: this._totalAcquired,
      total_rejected: this._totalRejected,
      total_waited: this._totalWaited,
    };
  },

  /**
   * Update rate params at runtime. Prunes the window to the new
   * window_ms (entries outside the new window drop immediately).
   */
  configure({ max_calls, window_ms } = {}) {
    if (Number.isInteger(max_calls) && max_calls > 0) {
      this._maxCalls = max_calls;
    }
    if (Number.isInteger(window_ms) && window_ms > 0) {
      this._windowMs = window_ms;
    }
    this._prune();
  },

  // Internal: drop entries older than the current window. O(k) where
  // k is the number of stale entries (usually 0 or all).
  _prune() {
    const cutoff = Date.now() - this._windowMs;
    let i = 0;
    while (i < this._calls.length && this._calls[i] <= cutoff) {
      i += 1;
    }
    if (i > 0) {
      this._calls.splice(0, i);
    }
  },
};
