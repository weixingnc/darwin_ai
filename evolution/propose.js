/**
 * Evolution Propose — turn a diagnose report into a structured proposal.
 *
 * PR-S1 (v3+ SelfEvolution P0): produce one JSON proposal per missing
 * capability. Persist to `memory/proposals/<proposal_id>.json`. Emit
 * `evolution:propose:before` / `evolution:propose:after`.
 *
 * Design contract (ADR-009): NO LLM. Rule-based: "what is missing → add it".
 * Rule templates are inline (P1 may swap in richer templates).
 *
 * Proposal shape (ADR-008 schema v0):
 *   {
 *     proposal_id:  uuid-like id (PR-S1: deterministic prefix + timestamp),
 *     action:       'add' | 'modify'  (PR-S1 only emits 'add'),
 *     target:       { path, type, rationale },
 *     files_added:  [{ path, lines_estimated }],
 *     expected_verify: { test, lint, size_check },
 *     apply_author: 'darwin',
 *     created_at:   ISO string,
 *   }
 *
 * Priority order (PR-S1):
 *   1. providers     (highest — LLM protocol surface)
 *   2. memory_backends
 *   3. tools
 *   4. skills        (lowest — non-critical demos)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';
import { diagnose as runDiagnose } from './diagnose.js';

// LLM gate (ADR-009): propose (default path) is rule-based, no LLM.
export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROPOSALS_DIR = path.join(REPO_ROOT, 'memory', 'proposals');

// Rule templates per category. `path` is relative to REPO_ROOT. `lines_estimated`
// is an honest guess (PR-S1 skeleton stubs ~30 lines + the 1-line plugin
// manifest lines the user will paste later).
const TARGET_TEMPLATES = {
  providers: (name) => ({
    path: `provider/${name}.js`,
    type: 'provider',
    rationale: `Add ${name} LLM provider — v3+ P1 catalogue item missing from current Darwin surface.`,
  }),
  memory_backends: (name) => ({
    path: `memory/backends/${name}.js`,
    type: 'memory_backend',
    rationale: `Add ${name} memory backend — v3+ P1 catalogue item missing from current Darwin surface.`,
  }),
  tools: (name) => ({
    path: `tool/builtins/${name}.js`,
    type: 'builtin_tool',
    rationale: `Add ${name} built-in tool — v3+ P1 catalogue item missing from current Darwin surface.`,
  }),
  skills: (name) => ({
    path: `skill/examples/${name}.js`,
    type: 'skill_example',
    rationale: `Add ${name} skill example — v3+ P1 catalogue item missing from current Darwin surface.`,
  }),
};

const PRIORITY_ORDER = ['providers', 'memory_backends', 'tools', 'skills'];

function newProposalId(category, name) {
  // Short, human-readable, deterministic-shape id (PR-S1; PR-S2 may switch to uuid v4).
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `prop-${category.slice(0, 3)}-${name}-${ts}-${rand}`;
}

function buildProposal(category, name) {
  const tmpl = TARGET_TEMPLATES[category];
  const target = tmpl(name);
  return {
    proposal_id: newProposalId(category, name),
    action: 'add',
    target,
    files_added: [{ path: target.path, lines_estimated: 30 }],
    expected_verify: { test: true, lint: true, size_check: true },
    apply_author: 'darwin',
    created_at: new Date().toISOString(),
  };
}

function writeProposalFile(proposalsDir, proposal) {
  fs.mkdirSync(proposalsDir, { recursive: true });
  const file = path.join(proposalsDir, `${proposal.proposal_id}.json`);
  fs.writeFileSync(file, JSON.stringify(proposal, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Convert a diagnose report into a list of proposals. By default also
 * persists each proposal as JSON under `memory/proposals/`.
 *
 * @param {object} [report] — diagnose report; if omitted, runs diagnose first.
 * @param {object} [opts]
 * @param {string} [opts.proposalsDir] override PROPOSALS_DIR (tests inject a tmpdir)
 * @param {boolean} [opts.persist=true] whether to write JSON files
 * @returns {Promise<Array<object>>}
 */
export async function propose(report, opts = {}) {
  const proposalsDir = opts.proposalsDir || PROPOSALS_DIR;
  const persist = opts.persist !== false;

  evolutionBus.emit(EVENTS.EVOLUTION_PROPOSE_BEFORE, { has_report: !!report });

  const effective = report || (await runDiagnose());

  const proposals = [];
  for (const cat of PRIORITY_ORDER) {
    const key = `missing_${cat}`;
    const missing = effective[key] || [];
    for (const name of missing) {
      proposals.push(buildProposal(cat, name));
    }
  }

  const writtenPaths = [];
  if (persist) {
    for (const p of proposals) {
      writtenPaths.push(writeProposalFile(proposalsDir, p));
    }
  }

  evolutionBus.emit(EVENTS.EVOLUTION_PROPOSE_AFTER, {
    count: proposals.length,
    written_paths: writtenPaths,
  });

  return proposals;
}

export const _internal = {
  buildProposal,
  newProposalId,
  TARGET_TEMPLATES,
  PRIORITY_ORDER,
  PROPOSALS_DIR,
};
