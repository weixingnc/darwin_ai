/**
 * SkillMatcherV2 — extends PR-23 matchSkills with 4 trigger types
 * (exact / substring / regex / command-prefix). PR-26b (2026-06-15).
 *
 * Design: docs/PR_DESIGN_26_OPENCLAW_COMPAT.md §4-§6. Reuses PR-21/23
 * triggerType enum (TT_SET = exact|substring|regex|command-prefix).
 *
 * Constraints:
 *   - Strict superset of PR-23 matchSkills substring path (byte-equal).
 *   - Never throws. Bad input → [] or null. warn-only on recoverable errors.
 *   - Pure function. No I/O, no registry mutation, no shared state.
 *
 * PR-27 integration: replace PR-23 matchSkills import in
 * core/skill-registry.js with this module (one-line diff per design §10.1).
 */

import { SKILL_MATCH_SOURCE_REGISTRY } from './skill-registry.js';

const TT_SET = new Set(['exact', 'substring', 'regex', 'command-prefix']);
const TT_DEFAULT = 'substring';
const MATCHER_VERSION = 'v2';
const MAX_DEFAULT = 2;
const log = (m) => process?.stderr?.write?.('[skill-matcher-v2] ' + m + '\n');

// _matchByExact — case-insensitive equality on trimmed text.
function _matchByExact(trigger, text) {
  if (typeof trigger !== 'string' || !trigger) {
    return null;
  }
  return text.trim().toLowerCase() === trigger.toLowerCase() ? trigger : null;
}

// _matchBySubstring — byte-equal to PR-23 _firstMatchingTrigger substring
// branch: text.toLowerCase().includes(trigger.toLowerCase()).
function _matchBySubstring(trigger, needle) {
  if (typeof trigger !== 'string' || !trigger) {
    return null;
  }
  return needle.includes(trigger.toLowerCase()) ? trigger : null;
}

// _matchByRegex — case-insensitive regex with compile-fail fallback.
// Per design §6.2: regex compile fail → warn + fall back to substring
// (only that trigger; entry stays matched via other triggers).
function _matchByRegex(trigger, text) {
  if (typeof trigger !== 'string' || !trigger) {
    return null;
  }
  try {
    return new RegExp(trigger, 'i').test(text) ? trigger : null;
  } catch (err) {
    log('regex compile failed for "' + trigger + '": ' + err.message);
    return _matchBySubstring(trigger, text.toLowerCase());
  }
}

// _matchByCommandPrefix — case-insensitive startsWith on trimmed text.
// Per design §6.2: trigger not starting with `/` → warn + fall back
// to substring (only that trigger).
function _matchByCommandPrefix(trigger, text) {
  if (typeof trigger !== 'string' || !trigger) {
    return null;
  }
  if (trigger[0] !== '/') {
    log('command-prefix trigger "' + trigger + '" missing leading "/" → substring fallback');
    return _matchBySubstring(trigger, text.toLowerCase());
  }
  return text.trim().toLowerCase().startsWith(trigger.toLowerCase()) ? trigger : null;
}

// matchByTriggerType — dispatch on entry.triggerType. Missing or unknown
// type → 'substring' (warn on truly unknown, not on missing/default).
// Returns the original trigger string (case preserved) or null.
export function matchByTriggerType(entry, text) {
  // Defensive: malformed input → null. Never throws.
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (typeof text !== 'string' || !text) {
    return null;
  }
  if (!Array.isArray(entry.triggers) || entry.triggers.length === 0) {
    return null;
  }
  // Entry-level hint guard (matches PR-23 contract; L6 won't inject empty hint).
  if (typeof entry.systemPromptHint !== 'string' || entry.systemPromptHint.length === 0) {
    return null;
  }
  const tt = entry.triggerType;
  // Missing/undefined → default substring path (PR-23 backward compat).
  if (tt === undefined || tt === null) {
    return _scanTriggers(entry.triggers, text, TT_DEFAULT);
  }
  if (!TT_SET.has(tt)) {
    log('unknown triggerType "' + tt + '" → substring fallback');
    return _scanTriggers(entry.triggers, text, TT_DEFAULT);
  }
  return _scanTriggers(entry.triggers, text, tt);
}

// Inner dispatch: pick matcher per triggerType, iterate triggers, first-hit-wins.
// Byte-equal to PR-23 _firstMatchingTrigger for substring branch.
function _scanTriggers(triggers, text, tt) {
  for (const trigger of triggers) {
    if (typeof trigger !== 'string' || trigger.length === 0) {
      continue;
    }
    let hit = null;
    if (tt === 'exact') {
      hit = _matchByExact(trigger, text);
    } else if (tt === 'regex') {
      hit = _matchByRegex(trigger, text);
    } else if (tt === 'command-prefix') {
      hit = _matchByCommandPrefix(trigger, text);
    } else {
      // 'substring' (default) — byte-equal to PR-23.
      hit = _matchBySubstring(trigger, text.toLowerCase());
    }
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

// _normalizeTriggerType — public TT_SET.has check + default fallback.
function _normalizeTriggerType(t) {
  return typeof t === 'string' && TT_SET.has(t) ? t : TT_DEFAULT;
}

// _resolveName — entry-level name resolution (matches PR-23 contract).
function _resolveName(name, entry) {
  if (typeof name === 'string' && name) {
    return name;
  }
  return (entry && entry.name) || '';
}

// _buildMatch — assemble SkillMatch from a hit (PR-23 core fields + v2 extras).
function _buildMatch(name, entry, triggerHit) {
  return {
    name: _resolveName(name, entry),
    triggerHit,
    systemHint: entry.systemPromptHint,
    source: SKILL_MATCH_SOURCE_REGISTRY,
    triggerType: _normalizeTriggerType(entry && entry.triggerType),
    matcherVersion: MATCHER_VERSION,
  };
}

// _validArgs — guard clause for matchSkillsV2 (byte-equal to PR-23 input checks).
function _validArgs(text, registry, max) {
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }
  if (!registry || typeof registry.entries !== 'function') {
    return false;
  }
  if (typeof max !== 'number' || max <= 0 || !Number.isFinite(max)) {
    return false;
  }
  return true;
}

// matchSkillsV2 — strict superset of PR-23 matchSkills. Returns array of
// SkillMatch enriched with triggerType + matcherVersion:'v2'.
// Cap matches at `max` (default 2). Insertion order (Map iteration order).
// Never throws. Bad input → [].
export function matchSkillsV2({ text, registry, max = MAX_DEFAULT } = {}) {
  if (!_validArgs(text, registry, max)) {
    return [];
  }
  const matches = [];
  for (const [name, entry] of registry.entries()) {
    if (matches.length >= max) {
      break;
    }
    const triggerHit = matchByTriggerType(entry, text);
    if (triggerHit === null) {
      continue;
    }
    matches.push(_buildMatch(name, entry, triggerHit));
  }
  return matches;
}
