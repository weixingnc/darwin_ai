/**
 * ISkill: skill contract (data interface).
 *
 * Concrete skills are plain {name, version, capabilities, init, ...} objects
 * validated via ISkill.validate (duck typing) at registry time.
 *
 * v2 design (PR 16a, skeleton only): skills are Darwin's "abilities" — the
 * things Darwin CAN DO (chat / code / search / ...). They are passive
 * capabilities invoked via invoke/stream; they do NOT mutate Darwin's own
 * lifecycle (that is the IPlugin contract). One ISkill contract, N skills
 * (chat, code, search) — v1 ANTI-PATTERNS A-3 lesson: don't write the same
 * provider twice, share one contract.
 *
 * Implementation note: ISkill is a plain object (not a class) because
 * classes have read-only `name`/`length` that we can't override cleanly.
 * Mirrors IProvider (PR 6) + IPlugin (PR 11a) + IAdapter (PR 12a) + IMemory
 * (PR 13a).
 */

export const ISkill = {
  name: '', // sentinel: real skill must set its own name (e.g. 'chat', 'code')
  version: '0.0.0', // sentinel: real skill must set semver string
  // Default capabilities: 'invoke' | 'stream' | 'tool-use'
  capabilities: ['invoke', 'stream', 'tool-use'],
  prototype: {
    // init({eventBus, config, container}) — subscribe, resolve config
    init(_ctx) {
      throw new Error('[ISkill] init() not implemented');
    },
    // destroy() — unsubscribe, release handles. Idempotent.
    destroy() {
      throw new Error('[ISkill] destroy() not implemented');
    },
    // invoke({input, context}) → Promise<{output}> — primary call path
    invoke(_args) {
      throw new Error('[ISkill] invoke() not implemented');
    },
    // stream({input, context}) → AsyncIterable<chunk> — streaming variant
    stream(_args) {
      throw new Error('[ISkill] stream() not implemented');
    },
    // validate(input) → boolean | throws — pre-check input shape
    validate(_input) {
      throw new Error('[ISkill] validate() not implemented');
    },
  },
  validate(skill) {
    if (!skill || typeof skill !== 'object') {
      throw new TypeError('[ISkill] validate: skill must be object');
    }
    if (typeof skill.name !== 'string' || skill.name.length === 0) {
      throw new TypeError('[ISkill] validate: skill.name must be non-empty string');
    }
    if (typeof skill.version !== 'string' || skill.version.length === 0) {
      throw new TypeError('[ISkill] validate: skill.version must be non-empty string');
    }
    if (!Array.isArray(skill.capabilities)) {
      throw new TypeError(
        `[ISkill] validate: skill.capabilities must be array (got ${typeof skill.capabilities})`,
      );
    }
    for (const cap of skill.capabilities) {
      if (typeof cap !== 'string') {
        throw new TypeError('[ISkill] validate: each capability must be string');
      }
    }
    return { ok: true };
  },
};
