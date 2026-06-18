/**
 * Evolution Catalogue — persistent, auditable, JSON-backed catalogue
 * (P2g, 2026-06-18).
 *
 * Before P2g: every catalogue (PROVIDER_CATALOGUE / TOOL_CATALOGUE / etc.)
 * lived as a hardcoded const inside evolution/diagnose.js. Adding an
 * item meant editing source code + tests. Darwin couldn't answer
 * "what's currently expected to be installed?" without re-running
 * diagnose and parsing its output.
 *
 * P2g makes catalogues a first-class observable:
 *   1. **Persistent** — evolution/catalogue.json on disk. Survives
 *      process restarts; committable to git for review.
 *   2. **Auditable** — every mutation is logged to evolution/catalogue.log
 *      (append-only JSONL). `audit()` returns the change history.
 *   3. **Layered** — hardcoded `DEFAULTS` are the baseline (so the
 *      Darwin repo still works on a fresh clone with no catalogue.json).
 *      The on-disk file is an OVERLAY that ADDS to the defaults; it
 *      can't REMOVE them. This guarantees the baseline catalogue
 *      (what Darwin needs to function) is always present.
 *   4. **Self-evolution aware** — `proposeGrowth(category)` is the
 *      "Darwin decides what to install next" hook. It surfaces the
 *      next item from `GROWTH_CANDIDATES` (a small opinionated list
 *      curated by PM) that isn't yet in the merged catalogue. The
 *      caller (propose.js, self-evolve.js) decides whether to actually
 *      propose it as a proposal and write a plugin file.
 *
 * What P2g does NOT do:
 *   - It does NOT auto-install anything. It only surfaces candidates.
 *   - It does NOT replace the diagnose.js catalogues (those are kept
 *     in sync via `loadCatalogue()` which diagnoses calls instead of
 *     reading the hardcoded consts).
 *   - It does NOT decide priority. PRIORITY_ORDER lives in propose.js.
 *
 * Usage:
 *   import { loadCatalogue, addToCatalogue, proposeGrowth, audit } from './catalogue.js';
 *   const cat = loadCatalogue();                       // merged view
 *   const next = proposeGrowth('plugins');             // 'metrics' | null
 *   addToCatalogue('plugins', 'metrics', { reason: 'P2g growth cycle' });
 *   const history = audit();                           // [{ts, op, ...}, ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(REPO_ROOT, 'evolution', 'catalogue.json');
const LOG_FILE = path.join(REPO_ROOT, 'evolution', 'catalogue.log');

/**
 * P2g baseline. Mirrors what diagnose.js had pre-P2g (P2c-2 grew
 * PLUGIN_CATALOGUE from 1 → 2; these lists must stay in sync with
 * the legacy hardcoded consts in diagnose.js until P3 migrates the
 * hardcoded catalogues into this module entirely).
 */
const DEFAULTS = Object.freeze({
  providers: [
    'anthropic',
    'openai',
    'deepseek',
    'qwen',
    'gemini',
    'claude-3.5',
  ],
  memory_backends: ['filesystem', 'sqlite', 'vector'],
  tools: [
    'read-file',
    'write-file',
    'bash',
    'glob',
    'grep',
    'head',
    'tail',
    'wc',
  ],
  skills: [
    'hello-world',
    'summarizer',
    'translator',
    'code-review',
    'commit-message',
    'test-generator',
  ],
  platforms: ['feishu'],
  plugins: ['logger', 'audit'],
});

/**
 * P2g growth candidates — the "next organ Darwin might want to install"
 * list. PM-curated; Darwin never adds to this list itself. Darwin
 * SURFACES these via proposeGrowth(); PM (or self-evolve with
 * confirm:true) commits them via addToCatalogue().
 *
 * Order is priority-ordered: the FIRST item not yet in the catalogue
 * is what proposeGrowth() returns. PM can reorder this list to
 * express "I'd rather Darwin install metrics next over metrics-alt".
 */
const GROWTH_CANDIDATES = Object.freeze({
  plugins: [
    'metrics', // PM-curated next plugin: collect plugin lifecycle metrics
  ],
});

function readJsonOrEmpty(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function ensureFile(file, defaultContent) {
  try {
    fs.accessSync(file, fs.constants.F_OK);
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, defaultContent, 'utf8');
  }
}

/**
 * Load the merged catalogue (defaults + on-disk overlay).
 * Overlay is additive: it can ADD items to a category, but never REMOVE
 * defaults. This guarantees Darwin's baseline (the consts it needs to
 * function) is always present.
 *
 * @param {object} [opts]
 * @param {string} [opts.file] override the overlay file path (tests use this)
 * @returns {object} {providers, tools, skills, memory_backends, platforms, plugins}
 */
export function loadCatalogue(opts = {}) {
  const file = opts.file || DEFAULT_FILE;
  const overlay = readJsonOrEmpty(file);
  const out = {};
  for (const cat of Object.keys(DEFAULTS)) {
    const base = DEFAULTS[cat];
    const extra = Array.isArray(overlay[cat]) ? overlay[cat] : [];
    // Merge, dedupe, lowercase. Defaults first (stable order), then overlay.
    const seen = new Set(base.map((s) => s.toLowerCase()));
    const merged = [...base];
    for (const name of extra) {
      const k = String(name).toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(k);
      }
    }
    out[cat] = Object.freeze(merged);
  }
  return Object.freeze(out);
}

/**
 * Persist an ADD to the catalogue overlay file. Audit-logged.
 * Adding an item already present is a no-op (returns false).
 *
 * @param {string} category
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.file] override overlay file path (tests)
 * @param {string} [opts.logFile] override audit log path (tests)
 * @param {string} [opts.reason] recorded in audit log
 * @returns {boolean} true if added, false if already present
 */
export function addToCatalogue(category, name, opts = {}) {
  const file = opts.file || DEFAULT_FILE;
  const logFile = opts.logFile || LOG_FILE;
  const reason = opts.reason || 'unspecified';
  const cat = String(category || '').toLowerCase();
  const nm = String(name || '').toLowerCase();
  if (!DEFAULTS[cat]) {
    throw new Error(`addToCatalogue: unknown category "${category}"`);
  }
  if (!nm) {
    throw new Error('addToCatalogue: name required');
  }
  ensureFile(file, JSON.stringify({}, null, 2) + '\n');
  const overlay = readJsonOrEmpty(file);
  const list = Array.isArray(overlay[cat]) ? overlay[cat].slice() : [];
  if (list.map((s) => String(s).toLowerCase()).includes(nm)) {
    return false; // already present
  }
  list.push(nm);
  overlay[cat] = list;
  fs.writeFileSync(file, JSON.stringify(overlay, null, 2) + '\n', 'utf8');
  appendAudit({
    op: 'add',
    category: cat,
    name: nm,
    reason,
    file,
  }, logFile);
  return true;
}

/**
 * Surface the next growth candidate for a category that isn't yet
 * in the merged catalogue. Returns null if all candidates are
 * already installed (or no candidates are configured for this category).
 *
 * P2g hook for self-evolve: every cycle, self-evolve calls
 * `proposeGrowth('plugins')` to learn what Darwin would LIKE to install
 * next, then proposes it as a regular plugin proposal.
 *
 * @param {string} category
 * @returns {string|null}
 */
export function proposeGrowth(category) {
  const cat = String(category || '').toLowerCase();
  const candidates = GROWTH_CANDIDATES[cat] || [];
  const current = loadCatalogue()[cat] || [];
  const have = new Set(current);
  for (const c of candidates) {
    if (!have.has(String(c).toLowerCase())) {
      return c;
    }
  }
  return null;
}

/**
 * Read the audit log. Returns an array of {ts, op, category?, name?,
 * reason?, file?} entries in append order (oldest first).
 *
 * @param {object} [opts]
 * @param {string} [opts.logFile] override audit log path
 * @returns {Array<object>}
 */
export function audit(opts = {}) {
  const logFile = opts.logFile || LOG_FILE;
  let raw;
  try {
    raw = fs.readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {continue;}
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function appendAudit(entry, logFile) {
  const ts = new Date().toISOString();
  const full = { ts, ...entry };
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(full) + '\n', 'utf8');
}

export const _internal = {
  DEFAULTS,
  GROWTH_CANDIDATES,
  DEFAULT_FILE,
  LOG_FILE,
  REPO_ROOT,
};