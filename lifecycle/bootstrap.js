/**
 * Bootstrap: Darwin v2 startup orchestration.
 *
 * v2 design (PR 5):
 * - SYNC orchestration — returns the container once events have been emitted.
 *   Async subscribers run in the background (EventBus isolates handler errors).
 * - 5 phases walked in order: init → config → container → registry → ready.
 *   Each phase does ONE meaningful piece of wiring so failures are observable
 *   and the phase names carry semantic weight (not just labels):
 *     - init:      no-op sentinel (start-of-life marker)
 *     - config:    resolve a 'core' config via ConfigResolver (exercises the resolver)
 *     - container: verify core services are wired (eventBus, configResolver, errorHandler)
 *     - registry:  no-op sentinel (registry is filled by Darwin self-evolution later)
 *     - ready:     no-op sentinel (core:ready follows immediately after)
 * - Each phase emits a 'lifecycle:bootstrap:<phase>' event with { phase, container }.
 * - Top-level emits: LIFECYCLE_BOOTSTRAP_START → ... → LIFECYCLE_BOOTSTRAP_DONE → CORE_READY.
 * - Failures are caught, normalized via ErrorHandler.handle, emitted as CORE_ERROR,
 *   and NEVER thrown to the caller. The container is always returned.
 * - Test seam: bootstrap({ container }) accepts a caller-built container so tests
 *   can inject a tracked EventBus. Without one, bootstrap builds its own.
 *
 * v1 lesson: v1 bootstrap threw on partial config load — a missing optional
 * provider broke the whole framework. v2 rule: bootstrap is best-effort;
 * each phase is independent and the orchestrator always returns.
 */

import { Container } from '../core/container.js';
import { EventBus } from '../core/event-bus.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';
import { PHASES_ORDER } from './phases.js';

/** Build the default container with core services wired. */
function buildDefaultContainer() {
  const c = new Container();
  c.register('eventBus', () => new EventBus());
  c.register('configResolver', () => new ConfigResolver());
  c.register('errorHandler', () => ErrorHandler);
  return c;
}

/** Verify a service is resolvable; throw with context if not. */
function requireService(container, name) {
  if (!container.has(name)) {
    throw new Error(`core service missing: ${name}`);
  }
  return container.get(name);
}

/**
 * Phase executor: each phase returns void. Throws are caught by bootstrap
 * and surfaced as CORE_ERROR events.
 */
const PHASE_FNS = {
  init: () => {
    // no-op: marker for start-of-life
  },
  config: (container) => {
    // exercise ConfigResolver — load the 'core' module config
    const cfg = requireService(container, 'configResolver');
    cfg.get('core');
  },
  container: (container) => {
    // verify core services are present + resolvable
    requireService(container, 'eventBus');
    requireService(container, 'configResolver');
    requireService(container, 'errorHandler');
  },
  registry: () => {
    // no-op: registry is filled by Darwin self-evolution (v3+)
  },
  ready: () => {
    // no-op: CORE_READY event follows immediately after
  },
};

/**
 * Run the Darwin v2 bootstrap.
 * @param {object} [options]
 * @param {Container} [options.container] - caller-provided container (test seam)
 * @returns {Container} the container (always — never throws)
 */
export function bootstrap(options = {}) {
  const container = options.container || buildDefaultContainer();
  let bus;
  try {
    bus = container.get('eventBus');
  } catch (err) {
    // Catastrophic: even the bus could not be built. Return the container
    // so the caller still has a handle; do not throw.
    return container;
  }

  bus.emit(EVENTS.LIFECYCLE_BOOTSTRAP_START, { container });

  for (const phase of PHASES_ORDER) {
    // Emit phase event FIRST so subscribers can observe entry (success path)
    bus.emit(`lifecycle:bootstrap:${phase}`, { phase, container });
    // Then do the phase work; failures emit CORE_ERROR but never throw
    try {
      PHASE_FNS[phase](container);
    } catch (err) {
      const entry = ErrorHandler.handle(err, { phase, container });
      bus.emit(EVENTS.CORE_ERROR, entry);
      // continue — bootstrap is best-effort, never aborts mid-phase
    }
  }

  bus.emit(EVENTS.LIFECYCLE_BOOTSTRAP_DONE, { container });
  bus.emit(EVENTS.CORE_READY, { container });

  return container;
}
