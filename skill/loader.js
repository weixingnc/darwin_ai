/**
 * SkillLoader — 5-stage skill lifecycle (discover→load→validate→register→unload).
 *
 * Stages:
 *   1. discover  — scan a directory for *.js files
 *   2. load      — dynamic-import each module, extract default export
 *   3. validate  — call skill.validate() (ISkill contract), emit SKILL_LOAD_ERROR on fail
 *   4. register  — registry.register(skill) (defensive, never throws)
 *   5. unload    — skill.destroy() then registry.unregister(name)
 *
 * v2 design (PR 16b, skeleton only):
 * - discovers from the dir passed in (caller decides; default usage: skill/__example__/)
 *   NOTE: does NOT scan a user-skill dir yet — that's Darwin's self-evolution to add.
 * - one bad skill must not break the others (error isolation; ANTI-PATTERNS A-5).
 * - cross-module communication = EventBus only (no HookManager, A-5).
 * - no process.env reads (A-4: ConfigResolver is the only config path).
 * - no dependency on plugin/loader.js (parallel, not coupled).
 * - no hot reload (Darwin self-evolves that later).
 *
 * Style parity with plugin/loader.js — but intentionally simpler:
 *   plugin has a 7-stage state machine (UNLOADED→LOADED→INITIALIZED→ENABLED→DISABLED);
 *   skill is a 5-stage warm/cool flow packed into a single discoverSkills() call
 *   (chat / code / search skills don't need runtime enable/disable — they're
 *   pure abilities invoked via invoke(), not lifecycle hooks).
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ISkill } from './interface.js';
import { EVENTS } from '../core/events.js';

/**
 * Discover + load + validate + register skills from a directory.
 *
 * @param {object} opts
 * @param {import('../core/event-bus.js').EventBus} opts.eventBus
 * @param {import('./registry.js').SkillRegistry} opts.registry
 * @param {string} opts.dir - absolute or relative path; missing dir → []
 * @returns {Promise<Array<{name: string, version?: string, status: 'loaded'|'error', error?: string}>>}
 */
export async function discoverSkills(opts = {}) {
  if (!opts || !opts.eventBus) {
    throw new TypeError('[SkillLoader] discoverSkills: opts.eventBus is required');
  }
  if (!opts.registry) {
    throw new TypeError('[SkillLoader] discoverSkills: opts.registry is required');
  }
  if (typeof opts.dir !== 'string' || opts.dir.length === 0) {
    throw new TypeError('[SkillLoader] discoverSkills: opts.dir must be non-empty string');
  }
  const bus = opts.eventBus;
  const registry = opts.registry;
  const root = resolve(opts.dir);
  const out = [];
  // Stage 0: directory gate (non-existent / not a dir → return [] quietly).
  let entries;
  try {
    if (!(await stat(root)).isDirectory()) {
      return out;
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.js')) {
      continue;
    }
    const full = join(root, e.name);
    const result = await loadAndRegisterOne({ full, fileName: e.name, bus, registry });
    out.push(result);
  }
  return out;
}

/**
 * Internal helper: load one skill file → validate → register.
 * Returns a result entry for the discoverSkills output array.
 * Kept private (not exported) — discoverSkills is the public API.
 *
 * @param {object} args
 * @param {string} args.full
 * @param {string} args.fileName
 * @param {import('../core/event-bus.js').EventBus} args.bus
 * @param {import('./registry.js').SkillRegistry} args.registry
 * @returns {Promise<{name: string, version?: string, status: 'loaded'|'error', error?: string}>}
 */
async function loadAndRegisterOne({ full, fileName, bus, registry }) {
  // Stage 1+2: load (dynamic import) + extract default export.
  let mod;
  try {
    mod = await import(pathToFileURL(full).href);
  } catch (err) {
    bus.emit(EVENTS.SKILL_LOAD_ERROR, {
      path: full,
      reason: 'import failed',
      error: err?.message || String(err),
    });
    return { name: fileName, status: 'error', error: `import failed: ${err?.message || err}` };
  }
  const skill = mod?.default;
  if (!skill || typeof skill !== 'object' || typeof skill.name !== 'string') {
    bus.emit(EVENTS.SKILL_LOAD_ERROR, {
      path: full,
      reason: 'no default object export with .name',
    });
    return { name: fileName, status: 'error', error: 'no default object export with .name' };
  }
  // Stage 3: shape validation (ISkill contract; throws on bad shape).
  try {
    ISkill.validate(skill);
  } catch (err) {
    bus.emit(EVENTS.SKILL_LOAD_ERROR, {
      path: full,
      name: skill.name,
      reason: 'shape invalid',
      error: err?.message || String(err),
    });
    return { name: skill.name, status: 'error', error: `shape invalid: ${err?.message || err}` };
  }
  // Stage 3b: skill-level validate() (semantic check; skill decides).
  if (typeof skill.validate === 'function' && !skill.validate()) {
    bus.emit(EVENTS.SKILL_LOAD_ERROR, {
      path: full,
      name: skill.name,
      reason: 'validate failed',
    });
    return { name: skill.name, status: 'error', error: 'validate failed' };
  }
  // Stage 4: register via defensive registry (never throws; emits
  // SKILL_REGISTER_ERROR + SKILL_LOAD_ERROR on duplicate).
  if (registry.has(skill.name)) {
    bus.emit(EVENTS.SKILL_LOAD_ERROR, {
      path: full,
      name: skill.name,
      reason: `name "${skill.name}" is already registered`,
    });
    return {
      name: skill.name,
      status: 'error',
      error: `name "${skill.name}" is already registered`,
    };
  }
  registry.register(skill); // emits SKILL_REGISTER on success
  bus.emit(EVENTS.SKILL_LOAD, {
    name: skill.name,
    version: skill.version,
    capabilities: [...(skill.capabilities || [])],
    path: full,
  });
  return { name: skill.name, version: skill.version, status: 'loaded' };
}

/**
 * Unload a skill by name: call destroy() (best-effort, never throws), then
 * unregister from the registry. The defensive shape mirrors plugin/loader.js
 * stage 5 (unload is its own public API so Darwin can hot-swap skills later).
 *
 * @param {object} opts
 * @param {import('../core/event-bus.js').EventBus} opts.eventBus
 * @param {import('./registry.js').SkillRegistry} opts.registry
 * @param {string} opts.name
 * @returns {{ok: boolean, name?: string, error?: string}}
 */
export function unloadSkill(opts = {}) {
  if (!opts || !opts.eventBus) {
    return { ok: false, error: '[SkillLoader] unloadSkill: opts.eventBus is required' };
  }
  if (!opts.registry) {
    return { ok: false, error: '[SkillLoader] unloadSkill: opts.registry is required' };
  }
  if (typeof opts.name !== 'string' || opts.name.length === 0) {
    return { ok: false, error: '[SkillLoader] unloadSkill: opts.name must be non-empty string' };
  }
  const bus = opts.eventBus;
  const registry = opts.registry;
  const skill = registry.get(opts.name);
  if (!skill) {
    return { ok: false, error: `skill "${opts.name}" not registered` };
  }
  // destroy is best-effort: a throwing destroy must not strand the skill
  // in the registry (mirrors plugin/loader.js unload error path).
  if (typeof skill.destroy === 'function') {
    try {
      const r = skill.destroy({ eventBus: bus });
      if (r && typeof r.then === 'function') {
        // Fire-and-forget; loader doesn't await destroy (sync API).
        r.catch(() => {});
      }
    } catch {
      /* swallow — defensive unload never throws */
    }
  }
  registry.unregister(opts.name); // emits SKILL_UNREGISTER on success
  return { ok: true, name: opts.name };
}
