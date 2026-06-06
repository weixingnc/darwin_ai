/**
 * Event name constants for Darwin v2.
 *
 * Naming convention: `<domain>:<resource>:<action>[:<state>]`
 * - core: framework core
 * - lifecycle: bootstrap / shutdown
 * - provider: LLM providers (Darwin self-evolves these later)
 * - tool: tools (Darwin self-evolves these later)
 * - skill: skills (Darwin self-evolves these later)
 * - memory: memory backends (Darwin self-evolves these later)
 * - evolution: self-evolution (v3 implements handlers)
 * - plugin: plugin loader (v3 implements)
 *
 * v2 design: only event names are defined. NO subscribers are implemented
 * (Darwin self-evolves them later via self-evolution).
 *
 * v1 lesson: event names are STABLE — changing them breaks all subscribers.
 * Adding new ones is fine; renaming/removing is a breaking change (requires ADR).
 */

export const EVENTS = Object.freeze({
  // ─── core: framework core ─────────────────────────
  CORE_READY: 'core:ready',
  CORE_ERROR: 'core:error',

  // ─── lifecycle: bootstrap / shutdown ──────────────
  LIFECYCLE_BOOTSTRAP_START: 'lifecycle:bootstrap:start',
  LIFECYCLE_BOOTSTRAP_DONE: 'lifecycle:bootstrap:done',
  LIFECYCLE_SHUTDOWN_START: 'lifecycle:shutdown:start',
  LIFECYCLE_SHUTDOWN_DONE: 'lifecycle:shutdown:done',

  // ─── provider: LLM providers ──────────────────────
  PROVIDER_REGISTER: 'provider:register',
  PROVIDER_UNREGISTER: 'provider:unregister',
  PROVIDER_CALL_BEFORE: 'provider:call:before',
  PROVIDER_CALL_AFTER: 'provider:call:after',
  PROVIDER_CALL_ERROR: 'provider:call:error',

  // ─── tool: tools ──────────────────────────────────
  TOOL_REGISTER: 'tool:register',
  TOOL_EXECUTE_BEFORE: 'tool:execute:before',
  TOOL_EXECUTE_AFTER: 'tool:execute:after',
  TOOL_EXECUTE_ERROR: 'tool:execute:error',

  // ─── skill: skills ────────────────────────────────
  SKILL_REGISTER: 'skill:register',
  SKILL_EXECUTE_BEFORE: 'skill:execute:before',
  SKILL_EXECUTE_AFTER: 'skill:execute:after',

  // ─── memory: memory backends ──────────────────────
  MEMORY_STORE: 'memory:store',
  MEMORY_RETRIEVE: 'memory:retrieve',
  MEMORY_FORGET: 'memory:forget',

  // ─── evolution: self-evolution (v3 implements) ─────
  EVOLUTION_DIAGNOSE_BEFORE: 'evolution:diagnose:before',
  EVOLUTION_DIAGNOSE_AFTER: 'evolution:diagnose:after',
  EVOLUTION_PROPOSE_BEFORE: 'evolution:propose:before',
  EVOLUTION_PROPOSE_AFTER: 'evolution:propose:after',
  EVOLUTION_APPROVE: 'evolution:approve',
  EVOLUTION_REJECT: 'evolution:reject',
  EVOLUTION_APPLY_BEFORE: 'evolution:apply:before',
  EVOLUTION_APPLY_AFTER: 'evolution:apply:after',
  EVOLUTION_VERIFY: 'evolution:verify',
  EVOLUTION_ROLLBACK: 'evolution:rollback',
  EVOLUTION_AUDIT: 'evolution:audit',
  EVOLUTION_LEARN: 'evolution:learn',

  // ─── plugin: plugin loader (v3 implements) ────────
  PLUGIN_LOAD_REQUEST: 'plugin:load:request',
  PLUGIN_LOAD_DONE: 'plugin:load:done',

  // ─── plugin registry (PR 11a) ─────────────────────
  // Lifecycle events emitted by PluginRegistry on success paths.
  PLUGIN_REGISTER: 'plugin:register',
  PLUGIN_UNREGISTER: 'plugin:unregister',
  // Error events emitted on defensive error paths (registry never throws).
  PLUGIN_REGISTER_ERROR: 'plugin:register:error',
  PLUGIN_GET_ERROR: 'plugin:get:error',
  PLUGIN_UNREGISTER_ERROR: 'plugin:unregister:error',

  // ─── plugin loader (PR 11b) ───────────────────────
  // Per-stage success events. Loader NEVER throws — failures emit *_ERROR.
  PLUGIN_LOAD: 'plugin:load',
  PLUGIN_INIT: 'plugin:init',
  PLUGIN_ENABLE: 'plugin:enable',
  PLUGIN_DISABLE: 'plugin:disable',
  PLUGIN_UNLOAD: 'plugin:unload',
  // Per-stage error events (loader isolation: one bad plugin ≠ core down).
  PLUGIN_LOAD_ERROR: 'plugin:load:error',
  PLUGIN_INIT_ERROR: 'plugin:init:error',
  PLUGIN_ENABLE_ERROR: 'plugin:enable:error',
  PLUGIN_DISABLE_ERROR: 'plugin:disable:error',
  PLUGIN_UNLOAD_ERROR: 'plugin:unload:error',
});

/** Event domain groups (for namespace-scoped subscription) */
export const EVENT_DOMAINS = Object.freeze({
  CORE: 'core',
  LIFECYCLE: 'lifecycle',
  PROVIDER: 'provider',
  TOOL: 'tool',
  SKILL: 'skill',
  MEMORY: 'memory',
  EVOLUTION: 'evolution',
  PLUGIN: 'plugin',
});
