/**
 * SkillRegistry: central registry of Darwin's abilities (chat / code / search / ...).
 *
 * v2 rules (PR 16a, skeleton only):
 * - register(skill): validates via ISkill.validate, stores, emits SKILL_REGISTER
 *   → duplicate name / invalid shape: NEVER throws, emits SKILL_REGISTER_ERROR
 * - get(name): returns skill or undefined; on miss NEVER throws, emits SKILL_GET_ERROR
 * - has(name): boolean
 * - list(): array of skills (insertion order)
 * - unregister(name): removes + emits SKILL_UNREGISTER on success;
 *   on unknown name NEVER throws, emits SKILL_UNREGISTER_ERROR
 * - size(): count
 *
 * v2 startup rule (D-0): we do NOT enforce "only one active skill" at the
 * registry level. Multiple skills coexist (chat + code + search); Darwin's
 * self-evolution decides the routing / selection policy later. The registry
 * is multi-tenant by default. Style parity with MemoryRegistry (PR 13a).
 *
 * v1 lesson (ANTI-PATTERNS A-5): v1's skill layer silently swallowed errors.
 * v2 keeps the contract: errors are surfaced via EventBus, never thrown
 * across module boundaries. Cross-module communication = EventBus only.
 *
 * Style parity with PluginRegistry (PR 11a) + AdapterRegistry (PR 12a) +
 * MemoryRegistry (PR 13a) — defensive, never throws.
 *
 * Key difference vs IPlugin: IPlugin hooks core lifecycle (init/destroy
 * mutate Darwin itself); ISkill is a passive ability called via invoke().
 * Skills never call bus.emit(CORE_*) — they only listen / answer calls.
 */

import { ISkill } from './interface.js';
import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';

export class SkillRegistry {
  /**
   * @param {object} opts
   * @param {import('../core/event-bus.js').EventBus} opts.eventBus - REQUIRED
   */
  constructor(opts = {}) {
    if (!opts || !opts.eventBus) {
      throw new TypeError('[SkillRegistry] constructor: opts.eventBus is required');
    }
    this._bus = opts.eventBus;
    this._skills = new Map(); // name → skill
  }

  /** Register a skill. Validates shape first. NEVER throws. */
  register(skill) {
    const ctx = { context: 'skill.registry.register', name: skill?.name };
    const result = ErrorHandler.wrap(() => {
      ISkill.validate(skill);
      if (this._skills.has(skill.name)) {
        throw new Error(`[SkillRegistry] register: name "${skill.name}" is already registered`);
      }
      this._skills.set(skill.name, skill);
      this._bus.emit(EVENTS.SKILL_REGISTER, {
        name: skill.name,
        version: skill.version,
        capabilities: [...skill.capabilities],
      });
      return { ok: true, name: skill.name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.SKILL_REGISTER_ERROR, { ...result.error, context: ctx });
    }
    return this;
  }

  /** Get a skill by name. Returns undefined on miss. NEVER throws. */
  get(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[SkillRegistry] get: name must be non-empty string');
      }
      const s = this._skills.get(name);
      if (!s) {
        throw new Error(`[SkillRegistry] get: "${name}" not registered`);
      }
      return s;
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.SKILL_GET_ERROR, {
        ...result.error,
        context: { context: 'skill.registry.get', name },
      });
      return undefined;
    }
    return result.value;
  }

  /** Check if a name is registered. */
  has(name) {
    return this._skills.has(name);
  }

  /** List skills in insertion order. */
  list() {
    return Array.from(this._skills.values());
  }

  /** Number of registered skills. */
  size() {
    return this._skills.size;
  }

  /** Remove a skill. NEVER throws. */
  unregister(name) {
    const result = ErrorHandler.wrap(() => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('[SkillRegistry] unregister: name must be non-empty string');
      }
      const s = this._skills.get(name);
      if (!s) {
        throw new Error(`[SkillRegistry] unregister: "${name}" not registered`);
      }
      this._skills.delete(name);
      this._bus.emit(EVENTS.SKILL_UNREGISTER, {
        name,
        version: s.version,
        capabilities: [...s.capabilities],
      });
      return { ok: true, name };
    })();
    if (!result.ok) {
      this._bus.emit(EVENTS.SKILL_UNREGISTER_ERROR, {
        ...result.error,
        context: { context: 'skill.registry.unregister', name },
      });
    }
    return this;
  }
}
