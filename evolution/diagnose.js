/**
 * Evolution Diagnose — scan Darwin's current capability surface.
 *
 * PR-S1 (v3+ SelfEvolution P0): "chicken" half — give Darwin introspection
 * over its own modules so it knows what is missing before proposing changes.
 *
 * Design contract (ADR-009): NO LLM calls. Pure fs readdir + deterministic
 * classification. Deterministic = reproducible = auditable.
 *
 * v3+ P1 catalogue (V3_ROADMAP §"🔴 P0 SelfEvolution"):
 *   - providers: openai / anthropic / deepseek / qwen
 *   - built-in tools: read-file / write-file / bash / glob / grep
 *   - skill examples: hello-world / summarizer / translator
 *   - memory backends: filesystem / sqlite / vector
 *
 * Event flow:
 *   evolution:diagnose:before → [scan] → evolution:diagnose:after
 *
 * The diagnose contract is consumed by evolution/propose.js — the shape of
 * `result.missing_*` is the proposal generator's input. Keep this stable
 * until PR-S2; PR-S2 may add fields but must not remove or rename.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';

// LLM gate (ADR-009): diagnose never calls LLM. Explicit constant so a
// reviewer can grep the file and verify the gate.
export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Darwin repo root = one level up from evolution/.
const REPO_ROOT = path.resolve(__dirname, '..');

// Canonical catalogues. PR-S1 picks a small, finite set; P1 will extend.
// "stem" matches a file *stem* (provider/foo.js → stem 'foo'). We compare
// case-insensitively to be lenient about filename casing.
const PROVIDER_CATALOGUE = ['anthropic', 'openai', 'deepseek', 'qwen', 'gemini', 'claude-3.5'].map(
  (s) => s.toLowerCase(),
);
const TOOL_CATALOGUE = [
  'read-file',
  'write-file',
  'bash',
  'glob',
  'grep',
  'head',
  'tail',
  'wc',
].map((s) => s.toLowerCase());
const SKILL_CATALOGUE = [
  'hello-world',
  'summarizer',
  'translator',
  'code-review',
  'commit-message',
  'test-generator',
].map((s) => s.toLowerCase());
const MEMORY_CATALOGUE = ['filesystem', 'sqlite', 'vector'].map((s) => s.toLowerCase());
// P3+ cycle 8 prep (2026-06-15): platform adapters = ingress/egress for
// external messaging platforms. P2 priority per V3_ROADMAP. V2 reserved
// 'adapter-feishu' config key (core/config-resolver.js) but no adapter
// was implemented; this catalogue entry closes the loop.
const PLATFORM_CATALOGUE = ['feishu'].map((s) => s.toLowerCase());
// P2b (2026-06-17): plugins catalogue = plugin names Darwin expects to have
// available. Convention: plugin/<subdir>/<file>.js exports default with
// {name, version, capabilities, init, ...} per IPlugin. Examples live in
// plugin/__example__/ — they count as available (stems readable from
// filesystem) so Darwin can introspect them via diagnose without
// importing. Real plugin catalogue (production plugins) lives in
// `plugin/` root or `plugin/<name>/index.js` style (future).
//
// P2c-2 (2026-06-18): extended with 'audit' — first non-example production
// plugin in plugin/. audit subscribes to evolution:propose:after +
// evolution:apply:after and records them in an in-memory log. PLUGIN_CATALOGUE
// growth 1→2 marks Darwin's first real "装新器官" — Darwin decides to install
// a plugin, then verifies the install via re-diagnose. Subsequent cycles
// can extend this list to grow the production plugin surface.
const PLUGIN_CATALOGUE = ['logger', 'audit'].map((s) => s.toLowerCase());

// Scan roots. Absent dirs are reported as fully-missing, not throw.
// P1-B2 (2026-06-15): memory_backends now scans BOTH `memory/` (top-level,
// convention `*-backend.js`) AND `memory/backends/` (ADR-005 sub-dir
// convention). New backends may live at either path; the union covers both
// layouts. See `listMemoryBackendStems` below.
const SCAN_ROOTS = {
  providers: path.join(REPO_ROOT, 'provider'),
  tools: path.join(REPO_ROOT, 'tool', 'builtins'),
  skills: path.join(REPO_ROOT, 'skill', 'examples'),
  memory_backends: path.join(REPO_ROOT, 'memory', 'backends'),
  memory_backends_root: path.join(REPO_ROOT, 'memory'),
  platforms: path.join(REPO_ROOT, 'platform'),
  plugins: path.join(REPO_ROOT, 'plugin'),
};

/**
 * Safely list `.js` file stems in a directory. Missing dir → empty array.
 * Never throws — v2 hygiene defensive default (matches skill-loader pattern).
 * @param {string} dir absolute path
 * @returns {string[]} lowercased file stems
 */
function listJsStems(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) {
      continue;
    }
    if (!e.name.toLowerCase().endsWith('.js')) {
      continue;
    }
    out.push(e.name.slice(0, -3).toLowerCase());
  }
  return out;
}

function diff(catalogue, present) {
  const set = new Set(present);
  return catalogue.filter((name) => !set.has(name));
}

/** List memory backend stems from BOTH `memory/` and `memory/backends/`.
 *  Top-level files must end in `-backend.js` (e.g. `vector-backend.js` →
 *  stem `vector`); sub-dir files use any `.js` stem. Deduplicates. */
function listMemoryBackendStems(rootDir, subDir) {
  const out = new Set();
  // Top-level: `memory/<name>-backend.js` → stem = `<name>`
  for (const stem of listJsStems(rootDir)) {
    if (stem.endsWith('-backend')) {
      out.add(stem.slice(0, -'-backend'.length));
    }
  }
  // Sub-dir: `memory/backends/<name>.js` → stem = `<name>`
  for (const stem of listJsStems(subDir)) {
    out.add(stem);
  }
  return Array.from(out).sort();
}

/** List plugin stems from `plugin/`. Skips core contracts
 *  (registry/loader/interface) and underscored dirs (convention: __example__,
 *  __test__, __fixtures__). Plugin layout: either
 *  `plugin/<name>.js` (root, single-file plugin) or
 *  `plugin/<name>/<file>.js` (sub-dir plugin; first .js file's stem is the
 *  plugin name). Examples in `__example__/` are scanned as available
 *  plugins for Darwin introspection. Deduplicates. */
function listPluginStems(rootDir) {
  const out = new Set();
  // Root: `plugin/<name>.js` → stem = `<name>` (skip core infra + contracts).
  // `registry`/`loader`/`interface` are the P2a/b/d loader contracts.
  // `sandbox` is the P2e runtime enforcement helper — infrastructure,
  // not a plugin. Skipping it keeps PLUGIN_CATALOGUE ⊆ listPluginStems
  // honest (the diagnostic invariant from PR 9).
  for (const stem of listJsStems(rootDir)) {
    if (['registry', 'loader', 'interface', 'sandbox'].includes(stem)) {
      continue;
    }
    out.add(stem);
  }
  // Sub-dir: `plugin/<dir>/<file>.js` → stem = `<file>` (skip __* dirs)
  let dirs = [];
  try {
    dirs = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return Array.from(out).sort();
  }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) {
      continue;
    }
    if (d.name.startsWith('_')) {
      // __example__, __test__, __fixtures__ — convention: skip but still
      // scan their contents as available (so examples count as plugins).
    }
    let sub;
    try {
      sub = fs.readdirSync(path.join(rootDir, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of sub) {
      if (!f.isFile() || !f.name.endsWith('.js') || f.name.startsWith('.')) {
        continue;
      }
      out.add(f.name.slice(0, -3).toLowerCase());
    }
  }
  return Array.from(out).sort();
}

/**
 * Run the full scan and return a structured report.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] override REPO_ROOT (tests inject a tmpdir)
 * @returns {Promise<{
 *   current: { providers: string[], tools: string[], skills: string[], memory_backends: string[] },
 *   missing_providers: string[],
 *   missing_tools: string[],
 *   missing_skills: string[],
 *   missing_memory_backends: string[],
 *   scanned_at: string,
 * }>}
 */
export async function diagnose(opts = {}) {
  const root = opts.repoRoot || REPO_ROOT;
  const scanRoots = opts.repoRoot
    ? {
        providers: path.join(root, 'provider'),
        tools: path.join(root, 'tool', 'builtins'),
        skills: path.join(root, 'skill', 'examples'),
        memory_backends: path.join(root, 'memory', 'backends'),
        memory_backends_root: path.join(root, 'memory'),
        platforms: path.join(root, 'platform'),
        plugins: path.join(root, 'plugin'),
      }
    : SCAN_ROOTS;

  evolutionBus.emit(EVENTS.EVOLUTION_DIAGNOSE_BEFORE, { repo_root: root });

  const providers = listJsStems(scanRoots.providers);
  const tools = listJsStems(scanRoots.tools);
  const skills = listJsStems(scanRoots.skills);
  const memoryBackends = listMemoryBackendStems(
    scanRoots.memory_backends_root,
    scanRoots.memory_backends,
  );
  const platforms = listJsStems(scanRoots.platforms);
  const plugins = listPluginStems(scanRoots.plugins);

  const report = {
    current: {
      providers,
      tools,
      skills,
      memory_backends: memoryBackends,
      platforms,
      plugins,
    },
    missing_providers: diff(PROVIDER_CATALOGUE, providers),
    missing_tools: diff(TOOL_CATALOGUE, tools),
    missing_skills: diff(SKILL_CATALOGUE, skills),
    missing_memory_backends: diff(MEMORY_CATALOGUE, memoryBackends),
    missing_platforms: diff(PLATFORM_CATALOGUE, platforms),
    missing_plugins: diff(PLUGIN_CATALOGUE, plugins),
    scanned_at: new Date().toISOString(),
  };

  evolutionBus.emit(EVENTS.EVOLUTION_DIAGNOSE_AFTER, { report });

  return report;
}

// Internal hooks for tests; mirror skill-loader `_internal` pattern (PR-21a).
export const _internal = {
  listJsStems,
  listMemoryBackendStems,
  listPluginStems,
  diff,
  SCAN_ROOTS,
  REPO_ROOT,
  PROVIDER_CATALOGUE,
  PLUGIN_CATALOGUE,
};
