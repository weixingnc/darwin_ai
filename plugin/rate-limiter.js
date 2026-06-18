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
 *   - version      '0.2.0'           (W6-1: per-scope buckets so
 *                                     multiple providers share the
 *                                     plugin but get independent
 *                                     rate budgets. W5-1: real
 *                                     impl, single bucket, supersedes
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
 *   tryAcquire()                 → boolean (sync, non-blocking,
 *                                   uses default / single bucket)
 *   tryAcquireFor(scope)         → boolean (sync, non-blocking,
 *                                   per-scope independent bucket)
 *   acquire(opts)                → Promise<void> (async, blocks
 *                                   until slot available)
 *   acquireFor(scope, opts)      → Promise<void> (async, blocks,
 *                                   per-scope)
 *   getStats()                   → { current_rate, max_calls,
 *                                   window_ms, last_acquire_at,
 *                                   total_acquired, total_rejected,
 *                                   total_waited }
 *   getStatsFor(scope)           → same shape, but for a specific
 *                                   scope (creates the bucket if
 *                                   missing — read-only)
 *   configure({ max, window })   → update default-bucket params
 *   configureScope(scope, { max, window })  → update per-scope params
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

const DEFAULT_SCOPE = '__default__';

const DEFAULTS = Object.freeze({
  max_calls: 10,
  window_ms: 1000,
});

export default {
  name: 'rate-limiter',
  version: '0.2.0',
  capabilities: ['tool'],
  permissions: ['bus:on', 'log:info'],

  init(ctx) {
    const cfg = ctx.config || {};
    this._maxCalls = Number.isInteger(cfg.max_calls) ? cfg.max_calls : DEFAULTS.max_calls;
    this._windowMs = Number.isInteger(cfg.window_ms) ? cfg.window_ms : DEFAULTS.window_ms;
    // Sliding window state. Per-scope buckets so multiple callers
    // (e.g. multiple providers) share the plugin but get independent
    // rate budgets.
    this._buckets = new Map();
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
    if (this._buckets) {
      this._buckets.clear();
    }
    this._recording = false;
  },

  /**
   * Sync, non-blocking. Returns true if a slot is available and the
   * call is recorded; false if the window is full. Does NOT wait.
   * Uses the default / single bucket (legacy / shared budget).
   */
  tryAcquire() {
    return this._tryAcquireScope(DEFAULT_SCOPE);
  },

  /**
   * Per-scope variant. Each scope (e.g. 'anthropic', 'openai') has
   * its own bucket. W6-1 motivation: multiple LLM providers share
   * the rate-limiter plugin but each gets its own budget. Without
   * this, one provider's burst would starve all others.
   */
  tryAcquireFor(scope) {
    return this._tryAcquireScope(scope);
  },

  /**
   * Async, blocking. Returns when a slot is available. Resolves to
   * nothing (just side-effects on the rate state). opts.maxWaitMs
   * (default: windowMs) bounds the wait — if the wait would exceed
   * maxWaitMs, throws an Error so the caller can choose to retry,
   * back off differently, or fail.
   */
  async acquire(opts = {}) {
    return this.acquireFor(DEFAULT_SCOPE, opts);
  },

  /**
   * Per-scope async variant. See acquire().
   */
  async acquireFor(scope, opts = {}) {
    if (this._tryAcquireScope(scope)) {
      return;
    }
    const bucket = this._getOrCreateBucket(scope);
    const maxWaitMs = Number.isInteger(opts.maxWaitMs) ? opts.maxWaitMs : bucket.windowMs;
    const deadline = Date.now() + maxWaitMs;
    while (!this._tryAcquireScope(scope)) {
      this._totalWaited += 1;
      if (Date.now() >= deadline) {
        throw new Error(
          `[rate-limiter] acquireFor(${scope}) timed out after ${maxWaitMs}ms ` +
            `(window=${bucket.windowMs}ms, max=${bucket.maxCalls})`,
        );
      }
      // Sleep for a small interval. windowMs/10 is a reasonable
      // compromise: short enough to react quickly, long enough
      // not to spin the event loop.
      const sleep = Math.max(1, Math.floor(bucket.windowMs / 10));
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
  },

  /**
   * Stats snapshot for the default bucket. See _statsFor() for
   * the per-scope shape.
   */
  getStats() {
    return this._statsFor(DEFAULT_SCOPE);
  },

  /**
   * Per-scope stats. Creates the bucket if missing (read-only —
   * does not record an acquire).
   */
  getStatsFor(scope) {
    return this._statsFor(scope);
  },

  /**
   * Update default-bucket params at runtime. Prunes the window
   * to the new window_ms (entries outside the new window drop
   * immediately).
   */
  configure({ max_calls, window_ms } = {}) {
    this.configureScope(DEFAULT_SCOPE, { max_calls, window_ms });
  },

  /**
   * Per-scope configure. Creates the bucket if missing. Per-scope
   * limits override the default — if a scope was never configured
   * the default applies.
   */
  configureScope(scope, { max_calls, window_ms } = {}) {
    const bucket = this._getOrCreateBucket(scope);
    if (Number.isInteger(max_calls) && max_calls > 0) {
      bucket.maxCalls = max_calls;
    }
    if (Number.isInteger(window_ms) && window_ms > 0) {
      bucket.windowMs = window_ms;
    }
    this._pruneBucket(bucket);
  },

  // Internal: get-or-create a per-scope bucket. Defaults inherit
  // from the plugin-level _maxCalls / _windowMs at creation time.
  _getOrCreateBucket(scope) {
    let b = this._buckets.get(scope);
    if (!b) {
      b = {
        maxCalls: this._maxCalls,
        windowMs: this._windowMs,
        calls: [],
      };
      this._buckets.set(scope, b);
    }
    return b;
  },

  // Internal: try-acquire on a specific scope.
  _tryAcquireScope(scope) {
    if (!this._recording) {
      return true;
    }
    const bucket = this._getOrCreateBucket(scope);
    this._pruneBucket(bucket);
    if (bucket.calls.length >= bucket.maxCalls) {
      this._totalRejected += 1;
      return false;
    }
    bucket.calls.push(Date.now());
    this._lastAcquireAt = bucket.calls[bucket.calls.length - 1];
    this._totalAcquired += 1;
    return true;
  },

  // Internal: stats snapshot for a scope. Creates the bucket if
  // missing (read-only).
  _statsFor(scope) {
    const bucket = this._getOrCreateBucket(scope);
    this._pruneBucket(bucket);
    return {
      scope,
      current_rate: bucket.calls.length,
      max_calls: bucket.maxCalls,
      window_ms: bucket.windowMs,
      last_acquire_at:
        this._lastAcquireAt !== null ? new Date(this._lastAcquireAt).toISOString() : null,
      total_acquired: this._totalAcquired,
      total_rejected: this._totalRejected,
      total_waited: this._totalWaited,
    };
  },

  // Internal: drop entries older than the bucket's window. O(k) where
  // k is the number of stale entries (usually 0 or all).
  _pruneBucket(bucket) {
    const cutoff = Date.now() - bucket.windowMs;
    let i = 0;
    while (i < bucket.calls.length && bucket.calls[i] <= cutoff) {
      i += 1;
    }
    if (i > 0) {
      bucket.calls.splice(0, i);
    }
  },
};
