/**
 * Shutdown: Darwin v2 teardown orchestration.
 *
 * v2 design (PR 5):
 * - Emits LIFECYCLE_SHUTDOWN_START, then LIFECYCLE_SHUTDOWN_DONE, then clears
 *   the container + EventBus. Order: emit → clear (so subscribers can react
 *   to DONE before their listeners are removed).
 * - V7 cycle 2 (2026-06-19): before emitting SHUTDOWN_START, calls
 *   container.get('cron').stop() if a cron service is registered. The
 *   stop() halts all setInterval timers and emits cron:stop. Wrapped in
 *   try/catch — shutdown never throws.
 * - Idempotent: calling shutdown twice is safe. Listeners attached before the
 *   first call fire once. Listeners attached between calls do NOT receive a
 *   second DONE — the second call clears an already-empty bus.
 * - Defensive: shutdown with no container / null container does not throw.
 * - Does NOT throw — even on internal failure. (Same contract as bootstrap.)
 */

import { EVENTS } from '../core/events.js';

function getBus(container) {
  if (!container) {
    return null;
  }
  try {
    if (typeof container.has === 'function' && container.has('eventBus')) {
      return container.get('eventBus');
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Stop the cron scheduler if one is registered. Wrapped in try/catch so a
 * misbehaving cron (or a partial container) cannot break shutdown.
 */
function stopCronIfPresent(container) {
  if (!container || typeof container.has !== 'function' || typeof container.get !== 'function') {
    return;
  }
  try {
    if (container.has('cron')) {
      const cron = container.get('cron');
      if (cron && typeof cron.stop === 'function') {
        cron.stop();
      }
    }
  } catch {
    /* swallow — shutdown never throws */
  }
}

/**
 * Run the Darwin v2 shutdown.
 * @param {object} [options]
 * @param {Container} [options.container] - container to tear down
 * @returns {void}
 */
export function shutdown(options = {}) {
  const container = options.container;
  const bus = getBus(container);

  // V7 cycle 2: stop cron scheduler BEFORE emitting SHUTDOWN_START so any
  // listeners on cron:stop fire in time, and so a hanging interval doesn't
  // keep the process alive past shutdown.
  stopCronIfPresent(container);

  if (bus) {
    bus.emit(EVENTS.LIFECYCLE_SHUTDOWN_START, { container });
    bus.emit(EVENTS.LIFECYCLE_SHUTDOWN_DONE, { container });
  }

  if (container && typeof container.clear === 'function') {
    try {
      container.clear();
    } catch {
      /* swallow — shutdown never throws */
    }
  }

  if (bus) {
    try {
      bus.clear();
    } catch {
      /* swallow */
    }
  }
}
