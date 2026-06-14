/**
 * SkillRegistry — pure-function SKILL trigger matcher for ContextLoader L6.
 *
 * L6 of ContextLoader needs to inject a SKILL `systemPromptHint` into the
 * system prompt when the current turn text matches any registered skill's
 * trigger substrings. The matcher is intentionally a pure function
 * (no I/O, no history read, no memory read) — only the caller's
 * `currentTurn.text` is scanned.
 *
 * SkillEntry contract (v1):
 *   {
 *     name: string,
 *     triggers: string[],         // substring match (case-insensitive)
 *     systemPromptHint: string,   // injected into system prompt when matched
 *     // future: source / semantic fields (v3)
 *   }
 *
 * Security note: `triggers` strings flow into the system prompt via
 * L6 injection. Do NOT put PII (names, tokens, user input fragments)
 * in triggers — they will be visible to the LLM and any loggers.
 *
 * Match strategy: case-insensitive substring, first-match-wins
 * (iteration order of the registry Map is insertion order in JS,
 * which is the contract callers rely on). Capped to `max`.
 *
 * Pure function: no side effects, no I/O, deterministic for given inputs.
 *
 * Usage:
 *   const registry = createRegistry();
 *   registry.set('weather', {
 *     name: 'weather',
 *     triggers: ['天气', 'weather'],
 *     systemPromptHint: '调用 weather tool 获取实时数据.',
 *   });
 *   const matches = matchSkills({ text: '北京天气', registry, max: 2 });
 *   // -> [{ name: 'weather', triggerHit: '天气', systemHint: '...', source: 'registry' }]
 */

// PR-27: route matchSkills through PR-26b v2 matcher so triggerType metadata
// is honoured (PR-21 review advisory 1). v2 is a strict superset of the
// prior substring-only path; signature and return shape are preserved.
import { matchSkillsV2 as matchSkillsV2Impl } from './skill-matcher-v2.js';

export const SKILL_MATCH_SOURCE_REGISTRY = 'registry';
export const SKILL_MATCH_SOURCE_MEMORY = 'memory'; // reserved for v3

/**
 * Create a new SkillRegistry (Map<name, SkillEntry>).
 * Returns the underlying Map so callers can `.set()` / `.get()` directly.
 * The Map's insertion order is the matching order.
 *
 * v1 implementation: thin Map wrapper. v3 may upgrade to a class
 * with frozen entries and registration-time schema validation.
 */
export function createRegistry() {
  return new Map();
}

/**
 * Pure function: match current turn text against registry skills.
 *
 * @param {object} args
 * @param {string|null|undefined} args.text - current turn text to scan (caller-provided)
 * @param {Map<string, object>|null|undefined} args.registry - SkillRegistry (Map)
 * @param {number} [args.max=2] - max matches to return (skillTriggerMax)
 * @returns {Array<{name:string, triggerHit:string, systemHint:string, source:string, triggerType:string, matcherVersion:string}>}
 *   - empty array if text/registry missing, or no matches
 *   - never throws
 *   - PR-27: delegates to skill-matcher-v2 (PR-26b); output gains triggerType + matcherVersion
 */
export function matchSkills(args = {}) {
  // PR-27 switch: route through v2 matcher so triggerType metadata is honoured.
  // v2 is a strict superset of the prior substring-only path (byte-equal for
  // substring), so existing PR-23 callers see no behaviour change except for
  // the two extra fields on each SkillMatch.
  return matchSkillsV2Impl(args);
}
