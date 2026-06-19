/**
 * Cron scheduler: timed jobs for Darwin v2 lifecycle.
 *
 * v2 design (V7 cycle 2, 2026-06-19):
 * - Factory function `createCron({eventBus, setIntervalImpl?, clearIntervalImpl?})`
 *   mirroring PluginLoader style — same dependency-injection pattern.
 * - Internal state: `started` flag, `handles: Map<name, {intervalMs, handler, enabled}>`.
 * - API:
 *     register(name, intervalMs, handler)  → {name, intervalMs, enabled:false}
 *     unregister(name)                    → boolean
 *     start()                             → {started:N} (idempotent)
 *     stop()                              → {stopped:N} (idempotent)
 *     tick(name?)                         → manual trigger for tests; does
 *                                           NOT use setInterval, emits
 *                                           cron:tick + invokes handler.
 *     list()                              → {names, totalEnabled, totalRegistered}
 * - Emits via eventBus (when supplied):
 *     cron:tick   {name, ts}
 *     cron:start  {started}
 *     cron:stop   {stopped}
 *     cron:error  {name, message, cause?}
 * - A-5 isolation: handler throws → emit cron:error, never throw across boundary.
 * - setInterval/clearInterval are INJECTED via opts (default globalThis.*).
 *   Tests pass fakes so no real timers fire.
 * - No dependency on Darwin core/events.js — uses string literals for cron
 *   events (same pattern as plugin/audit.js).
 *
 * Lifecycle wiring: lifecycle/bootstrap.js creates one instance and registers
 * it in the container under the key 'cron'. lifecycle/shutdown.js calls
 * cron.stop() on teardown. plugin/cron-audit.js subscribes to cron:tick
 * and emits evolution:audit (which plugin/feishu-notify turns into a card).
 *
 * Standalone use (tests, scripts): createCron({eventBus}) without bootstrap.
 */

const TICK = 'cron:tick';
const START = 'cron:start';
const STOP = 'cron:stop';
const ERROR_EVT = 'cron:error';

function isName(s) {
  return typeof s === 'string' && s.length > 0 && s === s.toLowerCase();
}

function isHandler(fn) {
  return typeof fn === 'function';
}

function safeEmit(bus, topic, payload) {
  if (bus && typeof bus.emit === 'function') {
    bus.emit(topic, payload);
  }
}

/**
 * Build a Cron scheduler.
 * @param {object} [opts]
 * @param {object} [opts.eventBus] - EventBus to emit cron:* events on.
 * @param {Function} [opts.setIntervalImpl] - inject setInterval (test fake).
 * @param {Function} [opts.clearIntervalImpl] - inject clearInterval.
 * @returns {object} cron instance with register/unregister/start/stop/tick/list.
 */
export function createCron(opts = {}) {
  const eventBus = opts.eventBus || null;
  const setIntervalImpl = opts.setIntervalImpl || globalThis.setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl || globalThis.clearInterval;

  const handles = new Map();
  const intervals = new Map();
  let started = false;

  function register(name, intervalMs, handler) {
    if (!isName(name)) {
      throw new TypeError(
        `createCron.register: name must be a lowercase string (got ${typeof name})`,
      );
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError(`createCron.register: intervalMs must be > 0 (got ${intervalMs})`);
    }
    if (!isHandler(handler)) {
      throw new TypeError(
        `createCron.register: handler must be a function (got ${typeof handler})`,
      );
    }
    if (handles.has(name)) {
      // Re-register replaces the handle; if started, the new handler
      // takes effect on the next tick (we don't restart intervals for
      // existing jobs to avoid timer churn).
      handles.set(name, { intervalMs, handler, enabled: false });
    } else {
      handles.set(name, { intervalMs, handler, enabled: false });
    }
    return { name, intervalMs, enabled: false };
  }

  function unregister(name) {
    if (!handles.has(name)) {
      return false;
    }
    const intervalId = intervals.get(name);
    if (intervalId !== undefined) {
      try {
        clearIntervalImpl(intervalId);
      } catch {
        /* swallow — A-5 */
      }
      intervals.delete(name);
    }
    handles.delete(name);
    return true;
  }

  function start() {
    if (started) {
      return { started: 0 };
    }
    started = true;
    let n = 0;
    for (const [name, h] of handles.entries()) {
      h.enabled = true;
      // Wrap handler in A-5 isolation: handler throws → cron:error, no rethrow.
      const safeHandler = (ts) => {
        const payload = { name, ts };
        safeEmit(eventBus, TICK, payload);
        try {
          const r = h.handler(payload);
          // If handler returns a promise, observe it asynchronously.
          if (r && typeof r.then === 'function') {
            r.catch((err) => {
              const msg = err && err.message ? err.message : 'handler rejected';
              safeEmit(eventBus, ERROR_EVT, { name, message: msg, cause: err });
              try {
                process.stderr.write(`[cron] ${name} handler rejected: ${msg}\n`);
              } catch {
                /* swallow */
              }
            });
          }
        } catch (err) {
          const msg = err && err.message ? err.message : 'handler threw';
          safeEmit(eventBus, ERROR_EVT, { name, message: msg, cause: err });
          try {
            process.stderr.write(`[cron] ${name} handler threw: ${msg}\n`);
          } catch {
            /* swallow */
          }
        }
      };
      const intervalId = setIntervalImpl(safeHandler, h.intervalMs);
      intervals.set(name, intervalId);
      n += 1;
    }
    safeEmit(eventBus, START, { started: n });
    return { started: n };
  }

  function stop() {
    if (!started && intervals.size === 0) {
      return { stopped: 0 };
    }
    let n = 0;
    for (const [name, intervalId] of intervals.entries()) {
      try {
        clearIntervalImpl(intervalId);
      } catch {
        /* swallow */
      }
      intervals.delete(name);
      const h = handles.get(name);
      if (h) {
        h.enabled = false;
      }
      n += 1;
    }
    started = false;
    safeEmit(eventBus, STOP, { stopped: n });
    return { stopped: n };
  }

  function tick(name) {
    if (name === undefined || name === null) {
      // Trigger all registered handlers once.
      let n = 0;
      for (const [jobName, h] of handles.entries()) {
        const ts = Date.now();
        safeEmit(eventBus, TICK, { name: jobName, ts });
        try {
          const r = h.handler({ name: jobName, ts });
          if (r && typeof r.then === 'function') {
            r.catch((err) => {
              const msg = err && err.message ? err.message : 'handler rejected';
              safeEmit(eventBus, ERROR_EVT, { name: jobName, message: msg, cause: err });
            });
          }
        } catch (err) {
          const msg = err && err.message ? err.message : 'handler threw';
          safeEmit(eventBus, ERROR_EVT, { name: jobName, message: msg, cause: err });
        }
        n += 1;
      }
      return { triggered: n };
    }
    if (!handles.has(name)) {
      return { triggered: 0 };
    }
    const h = handles.get(name);
    const ts = Date.now();
    safeEmit(eventBus, TICK, { name, ts });
    try {
      const r = h.handler({ name, ts });
      if (r && typeof r.then === 'function') {
        r.catch((err) => {
          const msg = err && err.message ? err.message : 'handler rejected';
          safeEmit(eventBus, ERROR_EVT, { name, message: msg, cause: err });
        });
      }
    } catch (err) {
      const msg = err && err.message ? err.message : 'handler threw';
      safeEmit(eventBus, ERROR_EVT, { name, message: msg, cause: err });
    }
    return { triggered: 1 };
  }

  function list() {
    const names = [];
    let totalEnabled = 0;
    for (const [name, h] of handles.entries()) {
      names.push(name);
      if (h.enabled) {
        totalEnabled += 1;
      }
    }
    return {
      names,
      totalEnabled,
      totalRegistered: handles.size,
      started,
    };
  }

  return {
    register,
    unregister,
    start,
    stop,
    tick,
    list,
    // Test seam: expose internals for assertions.
    _internals: { handles, intervals, started },
    // Export event names for downstream consumers.
    events: { TICK, START, STOP, ERROR_EVT },
  };
}
