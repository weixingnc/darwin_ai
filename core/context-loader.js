/**
 * ContextLoader — unified 5-layer context assembly for any chat/repl/agent call.
 *
 * Solves the "memory writes but doesn't show in conversation" pain: callers
 * used to do ad-hoc personality + history splicing in 3 different files
 * (chat.js, repl.js, _shared.js). Adding a new layer = edit N places.
 *
 * 6 layers, in priority order:
 *   L1  Static identity      (hard-coded baseline; always-on by default)
 *   L2  Dynamic personality  (memory: darwin-personality; user-editable)
 *   L3  Long-term learnings  (memory: user-* keys; W2 plugin writes here)
 *   L4  Recent history       (memory: darwin-repl-history; sliding window)
 *   L6  Skill trigger hint   (PR-23: current turn triggers → SKILL systemPromptHint)
 *   L5  Current turn         (caller-provided; not in loader)
 *
 * Note: L6 is positioned between L4 and caller-L5 by design — see
 * PR_DESIGN_23_24_25.md §2 (let LLM see history then immediately the
 * skill hint, not at the end).
 *
 * Usage:
 *   const { systemMessages, meta } = await loadContext({
 *     memory, historyMessages, skillRegistry, currentTurn,
 *   });
 *   const fullMessages = [...systemMessages, { role: 'user', content: text }];
 *
 * Each layer is independently togglable via `config` (defaults in DEFAULT_OPTS).
 * No layer ever throws — missing memory, missing keys, malformed values all
 * degrade gracefully to "skip this layer". v2 design choice: defensive.
 */

const PERSONALITY_KEY = 'darwin-personality';
const LEARNINGS_PREFIX = 'user-';
const LEARNINGS_MAX = 20;
const LEARNINGS_VALUE_CAP = 200;

// L6 defaults (PR-23)
const DEFAULT_INCLUDE_SKILL_TRIGGER = true;
const DEFAULT_SKILL_TRIGGER_MAX = 2;

const DEFAULT_IDENTITY =
  '你是 Darwin, 一个自我进化的数字生命体. 简洁中文, 默认 ≤3 选项, 拍板前给方案.';

const DEFAULT_OPTS = {
  includeIdentity: true,
  includePersonality: true,
  includeLearnings: true,
  includeHistory: true,
  historyLimit: 10,
  historyCharCap: 180,
  identityText: DEFAULT_IDENTITY,
};

/** Extract a usable string from a memory value (string | {content} | null). */
function _extractString(v) {
  if (typeof v === 'string' && v.trim().length > 0) {
    return v;
  }
  if (v && typeof v === 'object' && typeof v.content === 'string' && v.content.trim().length > 0) {
    return v.content;
  }
  return null;
}

/** Format the last N turns as a "you already know this user" system block. */
function _historyToContext(messages, { historyLimit, historyCharCap }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const recent = messages.slice(-historyLimit);
  const lines = recent.map((m) => {
    const label = m?.role === 'user' ? '用户' : '你';
    const trimmed = String(m?.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, historyCharCap);
    return `${label}: ${trimmed}`;
  });
  return `以下是你与该用户最近的对话历史（请记住关键信息，回复时自然引用即可）:\n${lines.join('\n')}`;
}

/** Aggregate all `user-*` keys into a single "known preferences" block. */
async function _loadLearnings(memory) {
  if (!memory || typeof memory.list !== 'function' || typeof memory.get !== 'function') {
    return null;
  }
  let keys;
  try {
    keys = await memory.list(LEARNINGS_PREFIX);
  } catch {
    return null;
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    return null;
  }
  const limited = keys.slice(0, LEARNINGS_MAX);
  const entries = [];
  for (const k of limited) {
    try {
      const v = await memory.get(k);
      const s = _extractString(v);
      if (s) {
        entries.push(`- ${k}: ${s.slice(0, LEARNINGS_VALUE_CAP)}`);
      }
    } catch {
      /* skip this key, keep trying others */
    }
  }
  if (entries.length === 0) {
    return null;
  }
  return `该用户的已知偏好与习惯:\n${entries.join('\n')}`;
}

/**
 * Load 6-layer context for one LLM call.
 * @param {object} args
 * @param {object|null} args.memory - IMemory instance (or null = skip memory layers)
 * @param {Array} args.historyMessages - prior user/assistant turns (caller-loaded)
 * @param {object} [args.config] - per-layer toggles + tunables (see DEFAULT_OPTS)
 * @param {object} [args.skillRegistry] - SkillRegistry (Map<name, SkillEntry>) for L6 (PR-23)
 * @param {object} [args.currentTurn] - { text: string } — only the text is scanned for L6 triggers
 * @returns {Promise<{systemMessages: Array, meta: object}>}
 *   systemMessages: ordered [{role:'system', content:'...'}, ...] ready to prepend
 *   meta: { layers: string[], counts: { history: number, learnings: number, skills?: number } }
 *   The 'skills' count is only present when L6 injected at least one skill hint.
 */
export async function loadContext({
  memory = null,
  historyMessages = [],
  config = {},
  skillRegistry = null,
  currentTurn = null,
} = {}) {
  const opts = { ...DEFAULT_OPTS, ...config };
  const systemMessages = [];
  const meta = { layers: [], counts: { history: 0, learnings: 0 } };

  if (
    opts.includeIdentity &&
    typeof opts.identityText === 'string' &&
    opts.identityText.length > 0
  ) {
    systemMessages.push({ role: 'system', content: opts.identityText });
    meta.layers.push('identity');
  }

  if (opts.includePersonality && memory) {
    const v = await memory.get(PERSONALITY_KEY);
    const text = _extractString(v);
    if (text) {
      systemMessages.push({ role: 'system', content: text });
      meta.layers.push('personality');
    }
  }

  if (opts.includeLearnings) {
    const learnings = await _loadLearnings(memory);
    if (learnings) {
      systemMessages.push({ role: 'system', content: learnings });
      meta.layers.push('learnings');
      meta.counts.learnings = (learnings.match(/^- /gm) || []).length;
    }
  }

  if (opts.includeHistory) {
    const ctx = _historyToContext(historyMessages, {
      historyLimit: opts.historyLimit,
      historyCharCap: opts.historyCharCap,
    });
    if (ctx) {
      systemMessages.push({ role: 'system', content: ctx });
      meta.layers.push('history');
      meta.counts.history = Math.min(opts.historyLimit, historyMessages.length);
    }
  }

  // L6 — SKILL trigger injection (PR-23). Silently skipped on any error.
  // Position: right after L4 history, before caller's L5 current turn.
  // Never throws: registry is null → skip; match fails → skip.
  const includeSkillTrigger =
    opts.includeSkillTrigger !== undefined
      ? opts.includeSkillTrigger
      : DEFAULT_INCLUDE_SKILL_TRIGGER;
  const skillTriggerMax =
    opts.skillTriggerMax !== undefined ? opts.skillTriggerMax : DEFAULT_SKILL_TRIGGER_MAX;
  if (includeSkillTrigger) {
    await _injectSkillLayer({ systemMessages, meta, skillRegistry, currentTurn, skillTriggerMax });
  }

  return { systemMessages, meta };
}

/**
 * L6 injection helper — kept as a separate function to keep loadContext's
 * cyclomatic complexity under the lint cap. Mutates systemMessages + meta
 * in place. Never throws.
 */
async function _injectSkillLayer({
  systemMessages,
  meta,
  skillRegistry,
  currentTurn,
  skillTriggerMax,
}) {
  try {
    // Lazy require to keep this file decoupled from skill-registry at
    // top-level (also avoids circular-import risk in v3 when registry
    // starts depending on memory).
    const { matchSkills } = await import('./skill-registry.js');
    const matches = matchSkills({
      text: currentTurn && typeof currentTurn.text === 'string' ? currentTurn.text : null,
      registry: skillRegistry,
      max: skillTriggerMax,
    });
    if (matches.length === 0) {
      return;
    }
    const lines = matches.map((m) => `- [${m.name}] (触发词: "${m.triggerHit}") ${m.systemHint}`);
    systemMessages.push({
      role: 'system',
      content: `当前对话触发的可用技能:\n${lines.join('\n')}`,
    });
    meta.layers.push('skills');
    meta.counts.skills = matches.length;
  } catch {
    // L6 never throws — registry.match failure or import error → silent skip
  }
}

export const _internal = {
  _extractString,
  _historyToContext,
  _loadLearnings,
  _injectSkillLayer,
  DEFAULT_OPTS,
  DEFAULT_IDENTITY,
  DEFAULT_INCLUDE_SKILL_TRIGGER,
  DEFAULT_SKILL_TRIGGER_MAX,
};
