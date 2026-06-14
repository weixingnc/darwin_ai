/**
 * SkillLoader — parse SKILL.md frontmatter + load skills directory into
 * the existing SkillRegistry (PR-23). PR-21a: 4 exports, never throws.
 *
 * Design contract: docs/PR_DESIGN_21_SKILL_LOADER.md v0.1 (2026-06-15).
 * Constraints: do not modify core/skill-registry.js (PR-23) or
 * core/context-loader.js (PR-22); no new npm deps; no fs.watch here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SKILL_MATCH_SOURCE_REGISTRY } from './skill-registry.js';

const MAX_NAME = 32;
const MAX_HINT = 2000;
const MAX_BODY = 50 * 1024;
const MAX_TRIG = 100;
const MAX_TLEN = 64;
const P_MIN = 0;
const P_MAX = 100;
const P_DEF = 50;
const TT_DEF = 'substring';
const V_DEF = '0.0.0';
const SRC_DEF = 'local';
const TRIG_MAX = 2;
const HINT_FB = 200;
const NAME_RE = /^[a-z0-9-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const TT_SET = new Set(['exact', 'substring', 'regex', 'command-prefix']);

const log = (m) => process?.stderr?.write?.('[skill-loader] ' + m + '\n');

// Parse the minimal frontmatter schema (§1.2): scalars + one list (triggers).
// Avoids full YAML dep. Recognised: `key: scalar`, `key: "q"`, `key: 'q'`,
// `triggers:\n  - a\n  - b`. Unrecognised indented lines are skipped.
function parseYaml(src) {
  const out = {};
  const lines = src.split(/\r?\n/);
  let listKey = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) {
      continue;
    }
    if (raw[0] === ' ' || raw[0] === '\t') {
      if (listKey && /^\s*-\s/.test(raw)) {
        out[listKey].push(unquote(raw.replace(/^\s*-\s+/, '').trim()));
      }
      continue;
    }
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest === '') {
      const nxt = lines[i + 1] || '';
      if (/^\s*-\s/.test(nxt)) {
        out[key] = [];
        listKey = key;
        continue;
      }
      out[key] = '';
      listKey = null;
      continue;
    }
    // Flow-style list: `triggers: [a, b, c]`
    if (rest[0] === '[' && rest[rest.length - 1] === ']') {
      const inner = rest.slice(1, -1).trim();
      if (inner === '') {
        out[key] = [];
      } else {
        out[key] = inner.split(',').map((s) => unquote(s.trim()));
      }
      listKey = null;
      continue;
    }
    listKey = null;
    out[key] = unquote(rest.trim());
  }
  return out;
}

function unquote(s) {
  if (s.length >= 2) {
    const f = s[0];
    const l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  if (typeof v !== 'string') {
    return NaN;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function parseTriggers(raw) {
  let arr = [];
  if (Array.isArray(raw)) {
    arr = raw.slice(0, MAX_TRIG);
  } else if (typeof raw === 'string' && raw) {
    arr = [raw];
  }
  const out = [];
  for (const t of arr) {
    if (typeof t !== 'string') {
      continue;
    }
    const s = t.trim();
    if (!s || s.length > MAX_TLEN) {
      continue;
    }
    out.push(s.toLowerCase());
  }
  return out;
}

function extractName(raw) {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  const n = raw.toLowerCase();
  if (n.length > MAX_NAME || !NAME_RE.test(n)) {
    return null;
  }
  return n;
}

function extractVersion(raw, filePath) {
  if (typeof raw !== 'string' || !raw) {
    return V_DEF;
  }
  if (SEMVER_RE.test(raw)) {
    return raw;
  }
  log('bad version "' + raw + '" in ' + filePath);
  return V_DEF;
}

function extractTriggerType(raw, filePath) {
  if (typeof raw !== 'string' || !raw) {
    return TT_DEF;
  }
  if (TT_SET.has(raw)) {
    return raw;
  }
  log('bad triggerType "' + raw + '" in ' + filePath);
  return 'substring';
}

function extractHint(raw, body) {
  if (typeof raw === 'string' && raw) {
    return raw;
  }
  if (body) {
    return body.slice(0, HINT_FB);
  }
  return '';
}

function extractPriority(raw, filePath) {
  if (raw === undefined || raw === null) {
    return P_DEF;
  }
  const n = toInt(raw);
  if (Number.isNaN(n)) {
    log('bad priority in ' + filePath);
    return P_DEF;
  }
  if (n < P_MIN) {
    log('priority clamped to ' + P_MIN + ' in ' + filePath);
    return P_MIN;
  }
  if (n > P_MAX) {
    log('priority clamped to ' + P_MAX + ' in ' + filePath);
    return P_MAX;
  }
  return n;
}

// parseSkillFile: pure. Returns SkillEntry or null. Never throws.
export function parseSkillFile(filePath, content) {
  try {
    if (typeof content !== 'string' || !content || typeof filePath !== 'string' || !filePath) {
      return null;
    }
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fm) {
      return null;
    }
    let meta;
    try {
      meta = parseYaml(fm[1]);
    } catch {
      return null;
    }
    if (!meta || typeof meta !== 'object') {
      return null;
    }
    const name = extractName(meta.name);
    if (!name) {
      return null;
    }
    const hint = extractHint(meta.hint, fm[2]);
    return {
      name,
      version: extractVersion(meta.version, filePath),
      triggers: parseTriggers(meta.triggers),
      triggerType: extractTriggerType(meta.triggerType, filePath),
      hint:
        hint.length > MAX_HINT
          ? (log('hint > ' + MAX_HINT + ' in ' + filePath), hint.slice(0, MAX_HINT))
          : hint,
      priority: extractPriority(meta.priority, filePath),
      source: SRC_DEF,
      path: filePath,
      body: truncateBody(fm[2] || ''),
    };
  } catch {
    return null;
  }
}

function truncateBody(body) {
  if (body.length > MAX_BODY) {
    return body.slice(0, MAX_BODY);
  }
  return body;
}

// loadAll: scan skillsDir, broken files → skipped[] + warn. Never throws.
export function loadAll(skillsDir, registry) {
  const result = { loaded: [], skipped: [], total: 0 };
  if (!isValidRegistry(registry)) {
    log('loadAll: invalid registry');
    return result;
  }
  if (typeof skillsDir !== 'string' || !skillsDir) {
    return result;
  }
  const files = listSkillFiles(skillsDir);
  if (files === null) {
    return result;
  }
  result.total = files.length;
  const valid = parseAllFiles(files, result);
  // priority desc → registry insertion order = match order (PR-23 contract).
  valid.sort((a, b) => b.priority - a.priority);
  for (const e of valid) {
    const r = registerSkill(registry, e);
    if (r.ok) {
      result.loaded.push(e.name);
    } else {
      result.skipped.push({ path: e.path, reason: r.errorCode || 'register_failed' });
    }
  }
  return result;
}

function isValidRegistry(reg) {
  return !!(reg?.set && reg?.get);
}

function listSkillFiles(skillsDir) {
  let stat;
  try {
    stat = fs.statSync(skillsDir);
  } catch (err) {
    log('loadAll: stat "' + skillsDir + '" failed: ' + err.message);
    return null;
  }
  if (!stat.isDirectory()) {
    return null;
  }
  let dirents;
  try {
    dirents = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    log('loadAll: readdir failed: ' + err.message);
    return null;
  }
  const files = [];
  for (const d of dirents) {
    if (!d.isFile()) {
      continue;
    }
    const n = d.name.toLowerCase();
    if (n.endsWith('.md') || n.endsWith('.markdown')) {
      files.push(path.join(skillsDir, d.name));
    }
  }
  return files;
}

function parseAllFiles(files, result) {
  const valid = [];
  for (const abs of files) {
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      result.skipped.push({ path: abs, reason: 'read_error' });
      log('loadAll: read ' + abs + ': ' + err.message);
      continue;
    }
    const entry = parseSkillFile(abs, content);
    if (!entry) {
      result.skipped.push({ path: abs, reason: 'parse_failed' });
      continue;
    }
    valid.push(entry);
  }
  return valid;
}

// registerSkill: dual-key write (hint + systemPromptHint) for PR-23 compat.
export function registerSkill(registry, entry) {
  if (!isValidRegistry(registry)) {
    return { ok: false, errorCode: 'invalid_registry' };
  }
  if (!isValidEntry(entry)) {
    return { ok: false, errorCode: 'invalid_entry' };
  }
  const conflict = checkDuplicate(registry, entry);
  if (conflict) {
    return conflict;
  }
  registry.set(entry.name, buildStored(entry));
  return { ok: true };
}

function isValidEntry(entry) {
  return !!(entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name);
}

function checkDuplicate(registry, entry) {
  const existing = registry.get(entry.name);
  if (!existing) {
    return null;
  }
  const np = typeof entry.priority === 'number' ? entry.priority : P_DEF;
  const op = typeof existing.priority === 'number' ? existing.priority : P_DEF;
  if (np <= op) {
    log('"' + entry.name + '" dup with lower/equal priority, skipped');
    return { ok: false, errorCode: 'duplicate_lower_priority' };
  }
  log('"' + entry.name + '" overwritten (new p=' + np + ' > old p=' + op + ')');
  return null;
}

function buildStored(entry) {
  const h = typeof entry.hint === 'string' ? entry.hint : '';
  return {
    name: entry.name,
    version: typeof entry.version === 'string' ? entry.version : V_DEF,
    triggers: Array.isArray(entry.triggers) ? entry.triggers : [],
    hint: h,
    systemPromptHint: h,
    triggerType: typeof entry.triggerType === 'string' ? entry.triggerType : TT_DEF,
    priority: typeof entry.priority === 'number' ? entry.priority : P_DEF,
    source: typeof entry.source === 'string' ? entry.source : SRC_DEF,
    path: typeof entry.path === 'string' ? entry.path : '',
    body: typeof entry.body === 'string' ? entry.body : '',
  };
}

export function unregisterSkill(registry, name) {
  if (!registry?.delete || typeof name !== 'string' || !name) {
    return false;
  }
  return registry.delete(name);
}

export { SKILL_MATCH_SOURCE_REGISTRY };

// Test handle: internal helpers + constants.
export const _internal = {
  parseYaml,
  toInt,
  unquote,
  parseTriggers,
  constants: {
    MAX_NAME,
    MAX_HINT,
    MAX_BODY,
    MAX_TRIG,
    MAX_TLEN,
    P_MIN,
    P_MAX,
    P_DEF,
    TT_DEF,
    V_DEF,
    SRC_DEF,
    TRIG_MAX,
  },
};
