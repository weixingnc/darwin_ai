/**
 * OpenClaw Skill Adapter — PR-26a. Maps OpenClaw SKILL.md to Darwin v2
 * SkillEntry so PR-21 registerSkill + PR-23 matchSkills consume unchanged.
 * Design: docs/PR_DESIGN_26_OPENCLAW_COMPAT.md v0.1 (2026-06-15). Never throws.
 */

import fs from 'node:fs';
import path from 'node:path';
import { _internal, registerSkill } from './skill-loader.js';

const { parseYaml, constants: C } = _internal;
const { MAX_HINT, MAX_BODY, P_MIN, P_MAX, P_DEF } = C;
const L1 = 'openclaw-l1';
const L2 = 'openclaw-l2';
const TTD = 'substring';
const MAX_T = 4;
const MAX_L = 64;
const MAX_N = 32;
const NR = /^[a-z0-9-]+$/;
const RX = /[*^$(]/;
const TT_SET = new Set(['exact', 'substring', 'regex', 'command-prefix']);
const log = (m) => process?.stderr?.write?.('[openclaw-skill-adapter] ' + m + '\n');

// PR-21a parseYaml returns flow-style `{ ... }` as a raw string. Detect the
// OpenClaw `metadata: { openclaw: ... }` shape and return the whole string
// for PR-27 to re-parse (整块保留).
function getOcMeta(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const s = raw.trim();
  return s[0] === '{' && s[s.length - 1] === '}' && /(^|,|\{)\s*openclaw\s*:/.test(s) ? s : null;
}

// §3.2: first sentence ≤64 chars, split whitespace/cjk-punct, first 4 tokens, lowercase.
function inferTrig(d) {
  if (typeof d !== 'string' || !d) {
    return [];
  }
  const m = d
    .replace(/^["']|["']$/g, '')
    .trim()
    .match(/^[^.!?。！？]+/);
  const s = (m ? m[0].trim() : '').slice(0, MAX_L).trim();
  if (!s) {
    return [];
  }
  return s
    .split(/[\s,，.。;；:：!?？、]+/)
    .filter(Boolean)
    .slice(0, MAX_T)
    .map((t) => t.toLowerCase());
}

// §4.4: `/` → command-prefix, regex chars → regex, single token → exact, else substring.
function inferTT(d) {
  if (typeof d !== 'string' || !d) {
    return TTD;
  }
  const t = d.trim();
  if (t.startsWith('/')) {
    return 'command-prefix';
  }
  return RX.test(d) ? 'regex' : /[\s,，.。;；:：!?？、]/.test(t) ? TTD : 'exact';
}

// triggers: explicit > L2 infer > L1 [name]. Empty after inference → fallback to [name].
function resolveTriggers(raw, desc, lvl, name, fp) {
  let trig;
  if (Array.isArray(raw)) {
    const f = raw
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().toLowerCase());
    trig = f.length ? f : inferTrig(desc);
  } else if (lvl === L2) {
    trig = inferTrig(desc);
  } else {
    trig = [name];
  }
  if (!trig.length) {
    if (lvl === L2) {
      log('description empty after inference in ' + fp);
    }
    trig = [name];
  }
  return trig;
}

// triggerType: explicit (valid) > explicit (invalid → warn) > implicit (L2) > substring.
function resolveTT(raw, lvl, desc) {
  if (typeof raw === 'string' && TT_SET.has(raw)) {
    return raw;
  }
  if (raw !== null && raw !== undefined) {
    log('bad darwinTriggerType "' + raw + '"');
  }
  return lvl === L2 ? inferTT(desc) : TTD;
}

function parseMeta(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return null;
  }
  let meta;
  try {
    meta = parseYaml(m[1]);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const n = typeof meta.name === 'string' ? meta.name.toLowerCase().trim() : '';
  if (!n || n.length > MAX_N || !NR.test(n)) {
    return null;
  }
  return { name: n, body: m[2], meta };
}
function safePri(raw) {
  if (raw === undefined) {
    return P_DEF;
  }
  const x = Number(raw);
  return Number.isFinite(x) ? (x < P_MIN ? P_MIN : x > P_MAX ? P_MAX : x) : P_DEF;
}

export function parseOpenClawSkillFile(fp, content) {
  try {
    if (typeof content !== 'string' || !content || typeof fp !== 'string' || !fp) {
      return null;
    }
    const r = parseMeta(content);
    if (!r) {
      return null;
    }
    const { name, body: rawBody, meta } = r;
    const oc = getOcMeta(meta.metadata);
    const desc = typeof meta.description === 'string' ? meta.description : '';
    const lvl = oc || desc.trim() ? L2 : L1;
    const trig = resolveTriggers(meta.darwinTriggers, desc, lvl, name, fp);
    const tt = resolveTT(meta.darwinTriggerType, lvl, desc);
    const hint = desc.length > MAX_HINT ? desc.slice(0, MAX_HINT) : desc;
    const pri = safePri(meta.darwinPriority);
    const body = rawBody.slice(0, MAX_BODY);
    const entry = {
      name,
      version: '0.0.0',
      triggers: trig,
      triggerType: tt,
      hint,
      systemPromptHint: hint,
      priority: pri,
      source: lvl === L2 ? L2 : L1,
      path: fp,
      body,
    };
    if (oc) {
      entry.openclawMetadata = oc;
    }
    return entry;
  } catch {
    return null;
  }
}

export function adaptOpenClawSkills(dir, reg) {
  const emp = { loaded: 0, skipped: [], total: 0, l1Count: 0, l2Count: 0 };
  if (!reg || typeof reg.set !== 'function' || typeof dir !== 'string' || !dir) {
    return emp;
  }
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log('readdir "' + dir + '" failed: ' + err.message);
    return emp;
  }
  const files = [];
  for (const d of dirents) {
    if (d.isFile() && /\.md(?:down)?$/i.test(d.name)) {
      files.push(path.join(dir, d.name));
    }
  }
  const r = { loaded: 0, skipped: [], total: files.length, l1Count: 0, l2Count: 0 };
  for (const abs of files) {
    let c;
    try {
      c = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      r.skipped.push({ path: abs, reason: 'read_error' });
      log('read ' + abs + ': ' + err.message);
      continue;
    }
    const e = parseOpenClawSkillFile(abs, c);
    if (!e) {
      r.skipped.push({ path: abs, reason: 'openclaw_compat_failed' });
      continue;
    }
    const res = registerSkill(reg, e);
    if (res.ok) {
      r.loaded += 1;
      r[e.source === L2 ? 'l2Count' : 'l1Count'] += 1;
    } else {
      r.skipped.push({ path: abs, reason: res.errorCode || 'register_failed' });
    }
  }
  return r;
}

// Heuristic: has frontmatter + `name`, and no v2-only fields (triggers/
// triggerType/version). OpenClaw uses `description` and `metadata.openclaw`.
export function isOpenClawSkillContent(content) {
  if (typeof content !== 'string' || !content) {
    return false;
  }
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m || !/^name\s*:/m.test(m[1])) {
    return false;
  }
  const fm = m[1];
  const oc = /^description\s*:/m.test(fm) || /metadata\s*:\s*\{[^}]*openclaw/.test(fm);
  const v2 = /\btriggers\s*:/.test(fm) || /\btriggerType\s*:/.test(fm) || /\bversion\s*:/m.test(fm);
  // OpenClaw if has oc marker (and no v2) OR has only `name` (L1 minimal).
  return (oc && !v2) || (!oc && !v2);
}
