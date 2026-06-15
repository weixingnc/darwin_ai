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
const PROVIDER_CATALOGUE = ['anthropic', 'openai', 'deepseek', 'qwen'].map((s) => s.toLowerCase());
const TOOL_CATALOGUE = ['read-file', 'write-file', 'bash', 'glob', 'grep'].map((s) =>
  s.toLowerCase(),
);
const SKILL_CATALOGUE = ['hello-world', 'summarizer', 'translator'].map((s) => s.toLowerCase());
const MEMORY_CATALOGUE = ['filesystem', 'sqlite', 'vector'].map((s) => s.toLowerCase());

// Scan roots. Absent dirs are reported as fully-missing, not throw.
const SCAN_ROOTS = {
  providers: path.join(REPO_ROOT, 'provider'),
  tools: path.join(REPO_ROOT, 'tool', 'builtins'),
  skills: path.join(REPO_ROOT, 'skill', 'examples'),
  memory_backends: path.join(REPO_ROOT, 'memory', 'backends'),
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
      }
    : SCAN_ROOTS;

  evolutionBus.emit(EVENTS.EVOLUTION_DIAGNOSE_BEFORE, { repo_root: root });

  const providers = listJsStems(scanRoots.providers);
  const tools = listJsStems(scanRoots.tools);
  const skills = listJsStems(scanRoots.skills);
  const memoryBackends = listJsStems(scanRoots.memory_backends);

  const report = {
    current: {
      providers,
      tools,
      skills,
      memory_backends: memoryBackends,
    },
    missing_providers: diff(PROVIDER_CATALOGUE, providers),
    missing_tools: diff(TOOL_CATALOGUE, tools),
    missing_skills: diff(SKILL_CATALOGUE, skills),
    missing_memory_backends: diff(MEMORY_CATALOGUE, memoryBackends),
    scanned_at: new Date().toISOString(),
  };

  evolutionBus.emit(EVENTS.EVOLUTION_DIAGNOSE_AFTER, { report });

  return report;
}

// Internal hooks for tests; mirror skill-loader `_internal` pattern (PR-21a).
export const _internal = { listJsStems, diff, SCAN_ROOTS, REPO_ROOT, PROVIDER_CATALOGUE };
