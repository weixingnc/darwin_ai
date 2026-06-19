/**
 * Lifecycle phases: 6 canonical bootstrap phases + their event names.
 *
 * v2 design: phases are an ORDERED CONSTANT — the bootstrap orchestrator
 * iterates PHASES_ORDER, emitting a phase event before each step.
 *
 * v1 lesson: bootstrap steps were hidden inside a constructor — impossible
 * to observe from outside. v2 makes every phase observable via event bus
 * (subscribers can hook 'lifecycle:bootstrap:registry' to register a custom
 * provider, for example).
 *
 * V7 cycle 2 (2026-06-19): added PHASES.CRON between REGISTRY and READY.
 *   The cron phase creates a Cron scheduler service and registers it
 *   under container key 'cron'. It does NOT start() the scheduler —
 *   that is owned by plugin/cron-audit.js (the consumer registers its
 *   job on init() and start() the scheduler when ready).
 *
 * Naming convention: <domain>:<resource>:<action>:<state>
 * Phase events use 'lifecycle:bootstrap:<phase>' to be distinct from the
 * umbrella LIFECYCLE_BOOTSTRAP_START / LIFECYCLE_BOOTSTRAP_DONE events.
 */

export const PHASES = Object.freeze({
  INIT: 'init',
  CONFIG: 'config',
  CONTAINER: 'container',
  REGISTRY: 'registry',
  CRON: 'cron',
  READY: 'ready',
});

/** Canonical order — bootstrap walks these in sequence. */
export const PHASES_ORDER = Object.freeze([
  PHASES.INIT,
  PHASES.CONFIG,
  PHASES.CONTAINER,
  PHASES.REGISTRY,
  PHASES.CRON,
  PHASES.READY,
]);

/** Each phase → its dedicated event name. */
export const PHASE_EVENTS = Object.freeze({
  [PHASES.INIT]: 'lifecycle:bootstrap:init',
  [PHASES.CONFIG]: 'lifecycle:bootstrap:config',
  [PHASES.CONTAINER]: 'lifecycle:bootstrap:container',
  [PHASES.REGISTRY]: 'lifecycle:bootstrap:registry',
  [PHASES.CRON]: 'lifecycle:bootstrap:cron',
  [PHASES.READY]: 'lifecycle:bootstrap:ready',
});
