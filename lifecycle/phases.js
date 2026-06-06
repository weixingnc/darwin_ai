/**
 * Lifecycle phases: 5 canonical bootstrap phases + their event names.
 *
 * v2 design: phases are an ORDERED CONSTANT — the bootstrap orchestrator
 * iterates PHASES_ORDER, emitting a phase event before each step.
 *
 * v1 lesson: bootstrap steps were hidden inside a constructor — impossible
 * to observe from outside. v2 makes every phase observable via event bus
 * (subscribers can hook 'lifecycle:bootstrap:registry' to register a custom
 * provider, for example).
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
  READY: 'ready',
});

/** Canonical order — bootstrap walks these in sequence. */
export const PHASES_ORDER = Object.freeze([
  PHASES.INIT,
  PHASES.CONFIG,
  PHASES.CONTAINER,
  PHASES.REGISTRY,
  PHASES.READY,
]);

/** Each phase → its dedicated event name. */
export const PHASE_EVENTS = Object.freeze({
  [PHASES.INIT]: 'lifecycle:bootstrap:init',
  [PHASES.CONFIG]: 'lifecycle:bootstrap:config',
  [PHASES.CONTAINER]: 'lifecycle:bootstrap:container',
  [PHASES.REGISTRY]: 'lifecycle:bootstrap:registry',
  [PHASES.READY]: 'lifecycle:bootstrap:ready',
});
