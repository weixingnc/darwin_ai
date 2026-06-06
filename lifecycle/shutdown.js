/**
 * Shutdown: Darwin v2 teardown orchestration.
 *
 * v2 design (PR 5):
 * - Emits LIFECYCLE_SHUTDOWN_START, then LIFECYCLE_SHUTDOWN_DONE, then clears
 *   the container + EventBus. Order: emit → clear (so subscribers can react
 *   to DONE before their listeners are removed).
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
 * Run the Darwin v2 shutdown.
 * @param {object} [options]
 * @param {Container} [options.container] - container to tear down
 * @returns {void}
 */
export function shutdown(options = {}) {
  const container = options.container;
  const bus = getBus(container);

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
