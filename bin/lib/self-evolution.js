/**
 * Darwin CLI — `darwin self-evolution <sub> [...]` (P1 closed-loop demo).
 *
 * 8 sub-sub-commands, all JSON output to stdout (machine-parseable for e2e):
 *   diagnose   — scan current capability surface (REAL, evolution/diagnose.js)
 *   propose    — generate change proposals (REAL, evolution/propose.js)
 *   apply      — apply a proposal (REAL, evolution/apply.js) — ADR-006 approval gate
 *   verify     — run npm test/lint/size-check (REAL, evolution/verify.js)
 *   rollback   — git reset --hard to pre-apply tag (REAL, evolution/rollback.js)
 *   audit      — write audit log entry (REAL, evolution/audit.js)
 *   learn      — append rule to evolution-rules.md (REAL, evolution/learn.js)
 *   evolve     — run one self-evolve cycle (REAL, evolution/self-evolve.js)
 *                P3a (2026-06-18): CLI exposure for the P2f orchestrator.
 *                Requires --confirm:true to actually run (P2f design #1).
 *
 * Args:
 *   --auto-approve    skip the must-approve gate (e2e only — ADR-006 mocks laowang)
 *   --cwd <path>      working directory (default repo root; e2e passes tmpdir)
 *   --proposals-dir   override proposals dir (e2e)
 *   --runners         e2e: comma-separated mock runner names (mock-test-fail, etc)
 *   --confirm         P3a: required for `evolve` sub-command (mirror of opts.confirm:true)
 *
 * LLM gate (ADR-009): this dispatcher is mechanical, no LLM.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selfEvolution } from '../../core/self-evolution.js';
import { diagnose as diagnoseImpl } from '../../evolution/diagnose.js';
import { propose as proposeImpl } from '../../evolution/propose.js';
import { runSelfEvolve } from '../../evolution/self-evolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── Small helpers (one-purpose, low-complexity) ────────────────────

/** Parse --flag value pairs from argv tail. */
function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--auto-approve') {
      flags.autoApprove = true;
    } else if (a === '--confirm') {
      // P3a (2026-06-18): mirror of `runSelfEvolve({confirm:true})` — the
      // opt-in safety pattern. `--confirm` on its own (no value) is treated
      // as `--confirm true`. We don't accept `--confirm=false` because
      // the safety contract is explicit opt-in only.
      flags.confirm = true;
    } else if (a === '--cwd') {
      flags.cwd = rest[++i];
    } else if (a === '--proposals-dir') {
      flags.proposalsDir = rest[++i];
    } else if (a === '--runners') {
      flags.runners = rest[++i] ? rest[i].split(',') : [];
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/** Auto-approve approver (e2e only — ADR-006 mocks laowang). */
function buildAutoApprover() {
  return {
    classify(_proposal) {
      return { tier: 'green', reason: 'auto_approve_flag' };
    },
  };
}

/** JSON output helper. */
function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

/** Load a proposal JSON by id. */
function loadProposal(proposalId, proposalsDir) {
  const dir = proposalsDir || path.join(REPO_ROOT, 'memory', 'proposals');
  const file = path.join(dir, `${proposalId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`proposal not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Resolve the proposals dir from flags (cwd-aware). */
function proposalsDirFromFlags(flags) {
  if (flags.proposalsDir) {
    return flags.proposalsDir;
  }
  if (flags.cwd) {
    return path.join(flags.cwd, 'memory', 'proposals');
  }
  return undefined;
}

/** Read the tag SHA sidecar written by apply() (F-8: never trust memory). */
function readTagSha(proposalId, cwd) {
  const base = cwd || REPO_ROOT;
  const file = path.join(base, `.evolution-tag-${proposalId}`);
  if (!fs.existsSync(file)) {
    throw new Error(`tag-sha file not found: ${file}. Run apply first.`);
  }
  return fs.readFileSync(file, 'utf8').trim();
}

/** Mock verify.js runners for e2e fault injection. */
function buildRunners(names) {
  const runners = {};
  for (const n of names) {
    if (n === 'mock-test-fail') {
      runners.test = () => ({
        status: 'fail',
        code: 1,
        stdout: '✗ mock test fail',
        stderr: '',
        duration_ms: 1,
      });
    } else if (n === 'mock-lint-fail') {
      runners.lint = () => ({
        status: 'fail',
        code: 1,
        stdout: '1 problems (1 errors, 0 warnings)',
        stderr: '',
        duration_ms: 1,
      });
    } else if (n === 'mock-size-fail') {
      runners.size_check = () => ({
        status: 'fail',
        code: 1,
        stdout: '✗ 1 file(s) exceed 1000 lines',
        stderr: '',
        duration_ms: 1,
      });
    } else if (n === 'real') {
      // fall through to default execFileSync
    } else {
      throw new Error(`unknown runner name: ${n}`);
    }
  }
  return runners;
}

// ─── Sub-command handlers (one per sub) ─────────────────────────────

async function handleDiagnose(flags) {
  if (flags.cwd && flags.cwd !== REPO_ROOT) {
    return emit(await diagnoseImpl({ repoRoot: flags.cwd }));
  }
  return emit(await selfEvolution.diagnose());
}

async function handlePropose(_positional, flags) {
  const opts = {};
  if (flags.proposalsDir) {
    opts.proposalsDir = flags.proposalsDir;
  }
  if (flags.cwd && flags.cwd !== REPO_ROOT) {
    const report = await diagnoseImpl({ repoRoot: flags.cwd });
    const proposals = await proposeImpl(report, opts);
    return emit({ proposals, count: proposals.length });
  }
  // Bypass selfEvolution facade: it doesn't pass opts through (PR-S1
  // signature gap), but the evolution/propose.js impl does. Calling the
  // impl directly keeps the dispatcher honest with the user's flags.
  const proposals = await proposeImpl(undefined, opts);
  return emit({ proposals, count: proposals.length });
}

async function handleApply(positional, flags) {
  const proposalId = positional[0];
  if (!proposalId) {
    throw new Error('apply: missing <proposal_id>. Usage: darwin self-evolution apply <id>');
  }
  const proposal = loadProposal(proposalId, proposalsDirFromFlags(flags));
  const approver = flags.autoApprove ? buildAutoApprover() : undefined;
  const result = await selfEvolution.apply(proposal, {
    cwd: flags.cwd || REPO_ROOT,
    approver,
  });
  // Persist tag_sha for later rollback (F-8).
  if (result && result.applied && result.tag_sha) {
    fs.writeFileSync(
      path.join(flags.cwd || REPO_ROOT, `.evolution-tag-${proposalId}`),
      result.tag_sha,
      'utf8',
    );
  }
  return emit(result);
}

async function handleVerify(positional, flags) {
  const proposalId = positional[0];
  if (!proposalId) {
    throw new Error('verify: missing <proposal_id>. Usage: darwin self-evolution verify <id>');
  }
  const proposal = loadProposal(proposalId, proposalsDirFromFlags(flags));
  const opts = { cwd: flags.cwd || REPO_ROOT };
  if (flags.runners && flags.runners.length) {
    opts.runners = buildRunners(flags.runners);
  }
  const result = await selfEvolution.verify(proposal, opts);
  return emit(result);
}

async function handleRollback(positional, flags) {
  const proposalId = positional[0];
  if (!proposalId) {
    throw new Error('rollback: missing <proposal_id>. Usage: darwin self-evolution rollback <id>');
  }
  const proposal = loadProposal(proposalId, proposalsDirFromFlags(flags));
  const tagSha = readTagSha(proposalId, flags.cwd);
  const result = await selfEvolution.rollback(proposal, {
    cwd: flags.cwd || REPO_ROOT,
    tagSha,
  });
  return emit(result);
}

async function handleAudit(positional, flags) {
  const action = positional[0];
  const proposalId = positional[1];
  if (!action || !proposalId) {
    throw new Error('audit: missing <action> <proposal_id>');
  }
  let payload = {};
  if (positional.length >= 3) {
    payload = JSON.parse(positional.slice(2).join(' '));
  } else {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text) {
        payload = JSON.parse(text);
      }
    } catch {
      payload = {};
    }
  }
  const entry = {
    ...payload,
    proposal_id: proposalId,
    action,
    apply_author: payload.apply_author || 'darwin',
    outcome: payload.outcome || 'success',
    files_changed: payload.files_changed || [],
    diff_stat: payload.diff_stat || { '+': 0, '-': 0 },
    duration_ms: typeof payload.duration_ms === 'number' ? payload.duration_ms : 0,
  };
  const opts = {};
  if (flags.cwd) {
    opts.baseDir = path.join(flags.cwd, 'memory', 'audit');
  }
  const result = await selfEvolution.audit(entry, opts);
  return emit(result);
}

async function handleLearn(positional, flags) {
  const insight = positional.join(' ').trim();
  if (!insight) {
    throw new Error('learn: missing <insight>. Usage: darwin self-evolution learn "rule"');
  }
  const opts = {};
  if (flags.cwd) {
    opts.learnDir = path.join(flags.cwd, 'memory', 'learnings');
  }
  const result = await selfEvolution.learn(insight, opts);
  return emit(result);
}

// P3a (2026-06-18): CLI exposure for the P2f self-evolve orchestrator.
// Forwarding only — runSelfEvolve owns the safety invariants (confirm
// required, sandbox not activated, verify-then-rollback, one plugin
// per cycle). This wrapper just bridges argv → opts.
async function handleEvolve(_positional, flags) {
  if (flags.confirm !== true) {
    throw new Error(
      'evolve: --confirm is required. Self-evolution is opt-in to prevent ' +
        'accidental triggers. See P2f design notes in evolution/self-evolve.js.',
    );
  }
  const result = await runSelfEvolve({
    confirm: true,
    cwd: flags.cwd || REPO_ROOT,
  });
  return emit(result);
}

// ─── Public dispatcher (low-complexity switch) ───────────────────────

const HANDLERS = {
  diagnose: handleDiagnose,
  propose: handlePropose,
  apply: handleApply,
  verify: handleVerify,
  rollback: handleRollback,
  audit: handleAudit,
  learn: handleLearn,
  evolve: handleEvolve,
};

/** dispatcher entry. Called by bin/darwin as selfEvolutionDispatch(sub, rest). */
export async function selfEvolutionDispatch(sub, rest) {
  const { flags, positional } = parseFlags(rest);
  const handler = HANDLERS[sub];
  if (!handler) {
    throw new Error(
      `unknown sub-command: ${sub}. Expected one of: ${Object.keys(HANDLERS).join(' / ')}`,
    );
  }
  return handler(positional, flags);
}
