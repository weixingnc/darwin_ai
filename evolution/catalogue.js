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
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MODULE_REPO_ROOT is the hardcoded repo root for this module (the Darwin
// main repo). Catalogue overlay files are read from this path by default.
// Tests / self-evolve worktrees can override via loadCatalogue({file:...})
// or by setting DARWIN_CATALOGUE_FILE env var. See loadCatalogue() docs.
const MODULE_REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(MODULE_REPO_ROOT, 'evolution', 'catalogue.json');
const LOG_FILE = path.join(MODULE_REPO_ROOT, 'evolution', 'catalogue.log');
// T4 (Codex P1-1, 2026-06-18): when NODE_ENV=test, redirect the
// audit log to a per-test temp file. Without this, every test
// run pollutes the production evolution/catalogue.log with
// synthetic entries (which would then be returned by audit()
// and confuse any real consumer). The temp file is regenerated
// on every test process start.
const TEST_LOG_FILE =
  process.env.NODE_ENV === 'test' ? path.join(os.tmpdir(), 'darwin-test-catalogue.log') : LOG_FILE;
// V10.1 (2026-06-20): worktree isolation. When 'darwin self-evolution'
// runs in a tmpdir worktree (V4-V9 cycles), the catalogue.json overlay
// lives in /tmp/ but NODE_ENV is NOT 'test'. T7-W1's fix only catches
// the test-mode path, so V4-V9 worktree cycles wrote 336/342 entries
// (98%) to the production log. ISOLATED_LOG_FILE catches those worktree
// writes without touching LOG_FILE (production) or TEST_LOG_FILE (test).
const ISOLATED_LOG_FILE = path.join(os.tmpdir(), 'darwin-catalogue-isolated.log');

/**
 * V10.1 (2026-06-20): resolve the audit-log path for a catalogue add.
 * Priority (first match wins):
 *   1. explicit opts.logFile (caller override, e.g. test fixtures)
 *   2. NODE_ENV=test -> TEST_LOG_FILE (T7-W1 contract preserved)
 *   3. catalogue.json in /tmp/ (worktree cycle) -> ISOLATED_LOG_FILE
 *   4. otherwise -> LOG_FILE (production)
 *
 * This is the single source of truth for "which log file does this
 * catalogue add go to". Both addToCatalogue() and any future callers
 * (e.g. proposeGrowth-driven self-evolve) MUST go through here.
 */
function resolveLogFile(opts = {}) {
  if (opts.logFile) {
    return opts.logFile;
  }
  // V10.1 (2026-06-20): file-path check wins over NODE_ENV=test. The
  // /tmp/ marker means "this is a worktree cycle" regardless of
  // whether NODE_ENV=test is also set (e.g. running unit tests inside
  // a worktree). Routing worktree adds to ISOLATED_LOG_FILE protects
  // the production log even when NODE_ENV is incidentally 'test'.
  // T7-W1 contract (production never polluted) is still satisfied
  // because the file in T7-W1's test is always in /tmp/.
  const file = opts.file || DEFAULT_FILE;
  if (typeof file === 'string' && (file.includes('/tmp/') || file.startsWith(os.tmpdir()))) {
    return ISOLATED_LOG_FILE;
  }
  if (process.env.NODE_ENV === 'test') {
    return TEST_LOG_FILE;
  }
  return LOG_FILE;
}

/**
 * P2g baseline. Mirrors what diagnose.js had pre-P2g (P2c-2 grew
 * PLUGIN_CATALOGUE from 1 → 2; these lists must stay in sync with
 * the legacy hardcoded consts in diagnose.js until P3 migrates the
 * hardcoded catalogues into this module entirely).
 */
const DEFAULTS = Object.freeze({
  providers: ['anthropic', 'openai', 'deepseek', 'qwen', 'gemini', 'claude-3.5'],
  memory_backends: ['filesystem', 'sqlite', 'vector'],
  tools: ['read-file', 'write-file', 'bash', 'glob', 'grep', 'head', 'tail', 'wc'],
  skills: [
    'hello-world',
    'summarizer',
    'translator',
    'code-review',
    'commit-message',
    'test-generator',
  ],
  platforms: ['feishu'],
  // W4-1 (2026-06-18): added 'metrics' — third production plugin,
  // Darwin's observability layer (per-topic counters + avg duration).
  // W6-2 (2026-06-18): added 'llm-cache' — fifth production plugin,
  // LRU+TTL cache for LLM responses (deterministic key from
  // messages+model, see plugin/llm-cache.js + plugin/llm-cache-key.js).
  // V6-1 (2026-06-19): added 'feishu-notify' — sixth production plugin,
  // Darwin self-evolution events → Feishu DM push via platform/feishu.js
  // (V5.1 real IM v1 wire). Subscribes to evolution:apply:after +
  // evolution:audit, forwards formatted status messages to a configured
  // open_id. Mirrors W6-2 precedent (data-only update to DEFAULTS).
  // V7-2 (2026-06-19): added 'cron-audit' — seventh production plugin,
  // CRON scheduler → evolution:audit heartbeat. Subscribes to
  // lifecycle/cron.js 'cron:tick', emits 'evolution:audit' with a
  // heartbeat payload (proposal_id='heartbeat-<source>-<ts>',
  // action='heartbeat', outcome='info'). plugin/feishu-notify then
  // pushes the card to Feishu DM — closing the cron → audit → card
  // chain. Plugin order: example (logger) → audit (P2c-2) → metrics (W4-1)
  //              → rate-limiter (W5-1) → llm-cache (W6-2) →
  //              feishu-notify (V6-1) → cron-audit (V7-2).
  plugins: [
    'logger',
    'audit',
    'metrics',
    'rate-limiter',
    'llm-cache',
    'feishu-notify',
    'cron-audit',
  ],
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
    // W4-1 (2026-06-18): 'metrics' moved to DEFAULTS.plugins — it shipped
    // as a hand-written production plugin (plugin/metrics.js), so the
    // baseline catalogue now includes it. Growth candidates should
    // surface things that aren't yet installed.
    // W6-2 (2026-06-18): 'rate-limiter' and 'llm-cache' both moved to
    // DEFAULTS.plugins after shipping.
    // V6-1 (2026-06-19): 'feishu-notify' also shipped (Darwin
    // self-evolution events → Feishu DM push).
    // V7-2 (2026-06-19): 'cron-audit' also shipped (CRON scheduler →
    // evolution:audit heartbeat). The list is currently empty (all
    // candidates are now installed). PM can add new candidates (e.g.
    // 'tracer' for distributed trace spans) when ready.
  ],
  providers: [
    // V4 cycle 3 (2026-06-19): 'deepseek-e2e' closure for deepseek-reasoner
    //   R1 reasoning surface (e2e mock-fetch + ProviderRegistry + catalogue
    //   sandboxed marker). Not a new provider — deepseek is in DEFAULTS.providers
    //   already; the e2e closure just proves the R1 wire.
    // V8 cycle 1 (2026-06-19): 'qwen-r1-e2e' closure for Qwen R1 reasoning
    //   surface (Qwen3 / QwQ with enable_thinking=true). Not a new provider —
    //   qwen is in DEFAULTS.providers already; this V8.1 e2e closure proves
    //   the reasoning_content wire parity with deepseek-reasoner.
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
 * W3-2 (2026-06-18): the overlay file path is no longer hardcoded to
 * the module's repo root. By default it uses MODULE_REPO_ROOT (the main
 * repo), but callers can pass:
 *   - opts.file: absolute path to the overlay JSON file
 *   - process.env.DARWIN_CATALOGUE_FILE: same, as env var (useful for
 *     self-evolve worktrees where the worktree has its own catalogue
 *     that should be honored, not the main repo's)
 *   - opts.repoRoot: derives <repoRoot>/evolution/catalogue.json
 * Without any of these, the file defaults to MODULE_REPO_ROOT
 * (back-compat).
 *
 * @param {object} [opts]
 * @param {string} [opts.file] override the overlay file path (tests use this)
 * @param {string} [opts.repoRoot] derive file from <repoRoot>/evolution/catalogue.json
 * @returns {object} {providers, tools, skills, memory_backends, platforms, plugins}
 */
export function loadCatalogue(opts = {}) {
  let file;
  if (opts.file) {
    file = opts.file;
  } else if (opts.repoRoot) {
    file = path.join(opts.repoRoot, 'evolution', 'catalogue.json');
  } else if (process.env.DARWIN_CATALOGUE_FILE) {
    file = process.env.DARWIN_CATALOGUE_FILE;
  } else {
    file = DEFAULT_FILE;
  }
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
 * T6 (Codex P1-3, 2026-06-18): before the audit entry is appended,
 * drop a `catalogue-pre-<timestamp>-<name>` git tag at the current
 * commit in `opts.cwd` (default MODULE_REPO_ROOT). Tag creation is
 * BEST-EFFORT: if cwd is not a git repo / no HEAD / `git tag`
 * returns non-zero → warn and set `tag=null` (the audit entry still
 * records the add). The tag name is exposed to callers via the
 * `tag` field on the audit entry; if the add was skipped (idempotent
 * no-op), no tag is created and no audit entry is written (existing
 * T4 behaviour).
 *
 * @param {string} category
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.file] override overlay file path (tests)
 * @param {string} [opts.logFile] override audit log path (tests)
 * @param {string} [opts.reason] recorded in audit log
 * @param {string} [opts.cwd] working dir for the pre-tag (default MODULE_REPO_ROOT)
 * @returns {boolean} true if added, false if already present
 */
export function addToCatalogue(category, name, opts = {}) {
  const file = opts.file || DEFAULT_FILE;
  // T7-W1 (2026-06-19): when the caller doesn't pass an explicit
  // `logFile`, fall back to TEST_LOG_FILE (not LOG_FILE) so the
  // NODE_ENV=test routing that appendAudit applies is actually
  // reached. Previously we resolved to LOG_FILE here, which
  // bypassed the test fallback and let `npm test` write synthetic
  // entries into the production evolution/catalogue.log (reviewer
  // evidence: 14 lines of `metrics-e2e` after a T4-era test run).
  // TEST_LOG_FILE itself is the same constant appendAudit uses
  // and is already NODE_ENV-aware (== LOG_FILE in prod, == tmp file
  // in test), so production callers are unaffected.
  // V10.1 (2026-06-20): route via resolveLogFile (worktree isolation).
  // T7-W1 fix used 'opts.logFile || TEST_LOG_FILE' which worked for
  // npm test but missed worktree cycles (NODE_ENV !== 'test'). The
  // new helper also catches the worktree path (file in /tmp/) and
  // routes to ISOLATED_LOG_FILE.
  const logFile = resolveLogFile(opts);
  const reason = opts.reason || 'unspecified';
  const tagCwd = opts.cwd || MODULE_REPO_ROOT;
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
  // T6: best-effort pre-tag at the current commit. Tag is recorded
  // on the audit entry; on any git failure we log a warn and proceed
  // with tag=null (the catalogue add still succeeds).
  const tag = tryTagCataloguePre(tagCwd, nm);
  list.push(nm);
  overlay[cat] = list;
  fs.writeFileSync(file, JSON.stringify(overlay, null, 2) + '\n', 'utf8');
  appendAudit(
    {
      op: 'add',
      category: cat,
      name: nm,
      reason,
      file,
      tag,
    },
    logFile,
  );
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
    if (!line.trim()) {
      continue;
    }
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
  // T4 (2026-06-18): route to TEST_LOG_FILE in test mode so
  // synthetic entries don't pollute the production log.
  const target = logFile || TEST_LOG_FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, JSON.stringify(full) + '\n', 'utf8');
}

/**
 * T6 (Codex P1-3, 2026-06-18): drop a `catalogue-pre-<ts>-<name>`
 * git tag at the current commit in `cwd`, as a rollback anchor for
 * catalogue overlay mutations. Best-effort: on any failure
 * (cwd is not a git repo, no HEAD, `git tag` returns non-zero, etc.)
 * we log a warn and return null. The caller records the tag (or null)
 * on the audit entry.
 *
 * Design notes:
 *   - We use execFileSync (not execSync) per ADR-007 F-6 SOP
 *     (no shell, no injection surface from `name` or `cwd`).
 *   - The tag is sync (caller is sync; no `await` here).
 *   - Uniqueness: Date.now() ms + `process.hrtime.bigint()` (hex
 *     tail) defends against rapid-fire calls colliding on the same
 *     millisecond.
 *   - The tag is created BEFORE the overlay file is written so a
 *     post-mortem `git reset --hard <tag>` undoes the catalogue
 *     mutation too.
 *
 * @param {string} cwd working directory for the tag (must be a git repo)
 * @param {string} name the catalogue item being added (used in tag name)
 * @returns {string|null} tag name on success, null on any failure
 */
export function tryTagCataloguePre(cwd, name) {
  if (typeof cwd !== 'string' || !cwd) {
    // eslint-disable-next-line no-console
    console.warn('[catalogue] tryTagCataloguePre: cwd required, skipping tag');
    return null;
  }
  const safeName =
    String(name || 'item')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item';
  const hrt = process.hrtime.bigint().toString(16);
  const tagName = `catalogue-pre-${Date.now()}-${hrt}-${safeName}`;
  try {
    // Create the tag. execFileSync (no shell) is safe even though
    // safeName has been scrubbed above.
    execFileSync('git', ['tag', tagName], { cwd, stdio: 'pipe' });
    return tagName;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[catalogue] tryTagCataloguePre: git tag failed in ${cwd}: ${err && err.message ? err.message : err}`,
    );
    return null;
  }
}

export const _internal = {
  DEFAULTS,
  GROWTH_CANDIDATES,
  DEFAULT_FILE,
  LOG_FILE,
  TEST_LOG_FILE,
  ISOLATED_LOG_FILE,
  resolveLogFile,
  appendAudit,
  tryTagCataloguePre,
  MODULE_REPO_ROOT,
};
