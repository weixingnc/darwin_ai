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

export const SKILL_MATCH_SOURCE_REGISTRY = 'registry';
export const SKILL_MATCH_SOURCE_MEMORY = 'memory'; // reserved for v3

/**
 * Create a new SkillRegistry (Map<name, SkillEntry>).
 * Returns the underlying Map so callers can `.set()` / `.get()` directly.
 * The Map's insertion order is the matching order.
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
 * @returns {Array<{name:string, triggerHit:string, systemHint:string, source:string}>}
 *   - empty array if text/registry missing, or no matches
 *   - never throws
 */
export function matchSkills({ text, registry, max = 2 } = {}) {
  // Defensive: any bad input → empty array. L6 is "never throw".
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  if (!registry || typeof registry.entries !== 'function') {
    return [];
  }
  if (typeof max !== 'number' || max <= 0 || !Number.isFinite(max)) {
    return [];
  }
  return _scanRegistry(text, registry, max);
}

/**
 * Inner scan — separated to keep matchSkills under the lint complexity cap.
 * Pre-condition: text is a non-empty string, registry is a Map-like with
 * .entries(), max is a positive finite number.
 */
function _scanRegistry(text, registry, max) {
  const needle = text.toLowerCase();
  const matches = [];

  for (const [name, entry] of registry.entries()) {
    if (matches.length >= max) {
      break;
    }
    const triggerHit = _firstMatchingTrigger(entry, needle);
    if (triggerHit === null) {
      continue;
    }
    matches.push({
      name: typeof name === 'string' ? name : (entry && entry.name) || '',
      triggerHit,
      systemHint: entry.systemPromptHint,
      source: SKILL_MATCH_SOURCE_REGISTRY,
    });
  }

  return matches;
}

/**
 * Return the first valid trigger (string, non-empty) that appears in `needle`
 * (already lowercased), or null. Also returns null if the entry is malformed
 * or has an empty systemPromptHint.
 */
function _firstMatchingTrigger(entry, needle) {
  if (!entry || !Array.isArray(entry.triggers) || entry.triggers.length === 0) {
    return null;
  }
  if (typeof entry.systemPromptHint !== 'string' || entry.systemPromptHint.length === 0) {
    return null;
  }
  for (const trigger of entry.triggers) {
    if (typeof trigger !== 'string' || trigger.length === 0) {
      continue;
    }
    if (needle.includes(trigger.toLowerCase())) {
      return trigger;
    }
  }
  return null;
}
