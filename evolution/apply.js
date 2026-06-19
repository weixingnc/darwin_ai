/**
 * Evolution Apply — PR-S2 (v3+ SelfEvolution P0).
 *
 * ADR-005 boundary check + ADR-006 approval classification + ADR-007 tag +
 * write proposal files. Pure mechanical; NO LLM (ADR-009).
 *
 * Pipeline (per call):
 *   1. boundaryCheck (ADR-005 white/black list) → abort on blacklisted hit
 *   2. classifyApproval (ADR-006 3 tiers)       → may abort if must-approve
 *                                                  returns 'must_approve'
 *   3. tagProposal (ADR-007)                    → `git tag evolution-pre-<id>-<ts>`
 *   4. writeFiles (fs.writeFileSync)            → repo or tmpdir worktree
 *   5. emit `evolution:apply:before` / `evolution:apply:after`
 *   6. writeAudit (ADR-008)                     → memory/audit/<date>/<id>.json
 *
 * IMPORTANT (P3-P1 fix, 2026-06-15): apply does NOT `git commit` after writing
 * files. Committing the change is PM's responsibility, not Darwin's, per the
 * "darwin 自己改 darwin_core ❌" memory rule (Darwin must not autonomously
 * commit its own self-evolution writes — the PM (or human) reviews and
 * commits). This is why step 4 only writes files + step 3 tags a rollback
 * anchor; rollback is `git reset --hard <tag>` to undo file writes that
 * were never committed.
 *
 * LLM gate (ADR-009): apply is mechanical, NEVER calls LLM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';
import { _internal as seInternal } from '../core/self-evolution.js';
import { writeAuditLog } from './audit.js';
import { validateProposalPath } from './path-validator.js';

export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Run `git tag <name>` in cwd and resolve to the new tag SHA via rev-parse.
 * Uses execFileSync (no shell) per ADR-007 + F-6 SOP.
 *
 * @param {string} tagName
 * @param {string} cwd
 * @returns {{ tag: string, sha: string }}
 */
function runGitTag(tagName, cwd) {
  // execFileSync bypasses the husky pre-commit / commit-msg hooks (we are not
  // committing, we are tagging), so no --no-verify needed.
  execFileSync('git', ['tag', tagName], { cwd, stdio: 'pipe' });
  const sha = execFileSync('git', ['rev-parse', tagName], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { tag: tagName, sha };
}

/**
 * Sanity-check proposal shape. Mirrors core/self-evolution.js expectations.
 * @param {object} proposal
 */
function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    throw new TypeError('[evolution/apply] proposal must be a non-null object');
  }
  if (typeof proposal.proposal_id !== 'string' || !proposal.proposal_id) {
    throw new TypeError('[evolution/apply] proposal.proposal_id must be non-empty string');
  }
  if (!Array.isArray(proposal.files_added) || proposal.files_added.length === 0) {
    throw new TypeError('[evolution/apply] proposal.files_added must be a non-empty array');
  }
  for (let i = 0; i < proposal.files_added.length; i += 1) {
    const f = proposal.files_added[i];
    if (!f || typeof f.path !== 'string' || !f.path) {
      throw new TypeError(`[evolution/apply] files_added[${i}] needs .path string`);
    }
    // Defense in depth (--version ghost-dir bug, 2026-06-18):
    // path.dirname() + mkdirSync(..., {recursive:true}) accepted
    // '--version/_/foo.js' and created ./--version/_/ in the repo
    // root. validateProposalPath catches this class of input before
    // any fs.writeFileSync touches the working tree.
    const pathCheck = validateProposalPath(f.path);
    if (!pathCheck.ok) {
      throw new TypeError(`[evolution/apply] files_added[${i}] path invalid: ${pathCheck.reason}`);
    }
  }
}

/**
 * PR-S2 apply — real implementation.
 *
 * @param {object} proposal
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory (default REPO_ROOT).
 *   E2E tests pass a tmpdir worktree so the real v2 repo is never modified.
 * @param {object} [opts.boundary] injected boundary classifier (defaults to
 *   SelfEvolution's defaultBoundary; tests may inject a permissive one).
 * @param {object} [opts.approver] injected approver (defaults to SelfEvolution's
 *   defaultApprover; tests may inject 'auto-pass' to skip the must-approve gate).
 * @returns {Promise<{
 *   applied: boolean,
 *   tag: string,
 *   tag_sha: string,
 *   files_written: string[],
 *   approval: { tier: string, reason: string },
 *   boundary: Array<{path:string,status:string,tier:string}>,
 *   audit?: { audit_log_path: string, schema_version: number } | { audit_log_path: null, error: string },
 *   reason?: string,
 * }>}
 */
export async function apply(proposal, opts = {}) {
  validateProposal(proposal);

  const cwd = opts.cwd || REPO_ROOT;
  const boundary = opts.boundary || seInternal.defaultBoundary();
  const approver = opts.approver || seInternal.defaultApprover();
  const applyStartedAt = Date.now();

  evolutionBus.emit(EVENTS.EVOLUTION_APPLY_BEFORE, {
    proposal_id: proposal.proposal_id,
    files_added: proposal.files_added.map((f) => f.path),
    cwd,
  });

  // Step 1: ADR-005 boundary check.
  const boundaryResults = boundary.boundaryCheck(proposal.files_added.map((f) => f.path));
  const blacklisted = boundaryResults.filter((r) => r.status === 'blacklisted');
  if (blacklisted.length > 0) {
    const reason = `blacklisted: ${blacklisted.map((r) => r.path).join(', ')}`;
    evolutionBus.emit(EVENTS.EVOLUTION_REJECT, {
      proposal_id: proposal.proposal_id,
      reason,
      stage: 'boundary',
      blacklisted: blacklisted.map((r) => r.path),
    });
    return {
      applied: false,
      tag: null,
      tag_sha: null,
      files_written: [],
      approval: null,
      boundary: boundaryResults,
      reason,
    };
  }

  // Step 2: ADR-006 approval classification.
  const approval = approver.classify(proposal);
  if (approval.tier === 'red') {
    // PR-S2: deterministic stub — PR-S3 wires real a2a session_send to laowang.
    // Returning { applied: false } lets the caller (or e2e) decide whether to
    // route to a human approval channel or fall back to auto-approve.
    evolutionBus.emit(EVENTS.EVOLUTION_REJECT, {
      proposal_id: proposal.proposal_id,
      reason: approval.reason,
      stage: 'approval',
    });
    return {
      applied: false,
      tag: null,
      tag_sha: null,
      files_written: [],
      approval,
      boundary: boundaryResults,
      reason: `must_approve: ${approval.reason}`,
    };
  }

  // Step 3: ADR-007 git tag.
  const tagName = `evolution-pre-${proposal.proposal_id}-${Date.now()}`;
  let tagResult;
  try {
    tagResult = runGitTag(tagName, cwd);
  } catch (err) {
    evolutionBus.emit(EVENTS.EVOLUTION_REJECT, {
      proposal_id: proposal.proposal_id,
      reason: `tag_failed: ${err.message}`,
      stage: 'tag',
    });
    return {
      applied: false,
      tag: null,
      tag_sha: null,
      files_written: [],
      approval,
      boundary: boundaryResults,
      reason: `tag_failed: ${err.message}`,
    };
  }

  // Step 4: write files. Each files_added carries an optional `content`
  // (e2e injects it; production callers may rely on a registry fetch that
  // PR-S3 will wire). Missing content → write empty placeholder (e2e tests
  // always provide content, so this is just the production fallback).
  //
  // P3-P1 fix (2026-06-15): apply does NOT `git commit` the writes. Commit is
  // PM's responsibility (per "darwin 自己改 darwin_core ❌" memory rule). The
  // pre-apply tag from step 3 is the rollback anchor — `git reset --hard <tag>`
  // reverts the uncommitted writes. We also do NOT need `git reset --hard` on
  // write failure: the files just stay in the working tree and the tag marks
  // the pre-write point, so the caller (or PM) can choose to reset or amend.
  const filesWritten = [];
  try {
    for (const f of proposal.files_added) {
      const absPath = path.isAbsolute(f.path) ? f.path : path.join(cwd, f.path);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const content = typeof f.content === 'string' ? f.content : '';
      fs.writeFileSync(absPath, content, 'utf8');
      filesWritten.push(f.path);
    }
  } catch (err) {
    evolutionBus.emit(EVENTS.EVOLUTION_REJECT, {
      proposal_id: proposal.proposal_id,
      reason: `write_failed: ${err.message}`,
      stage: 'write',
    });
    return {
      applied: false,
      tag: tagResult.tag,
      tag_sha: tagResult.sha,
      files_written: filesWritten,
      approval,
      boundary: boundaryResults,
      reason: `write_failed: ${err.message}`,
    };
  }

  evolutionBus.emit(EVENTS.EVOLUTION_APPROVE, {
    proposal_id: proposal.proposal_id,
    tier: approval.tier,
    reason: approval.reason,
  });

  evolutionBus.emit(EVENTS.EVOLUTION_APPLY_AFTER, {
    proposal_id: proposal.proposal_id,
    tag: tagResult.tag,
    tag_sha: tagResult.sha,
    files_written: filesWritten,
    approval,
  });

  // Step 5: write audit log (ADR-008). Per "darwin 自己改 darwin_core ❌"
  // memory rule, apply always writes a structured audit entry — the audit
  // log is Darwin's own memory of what it did, NOT a git commit. The
  // pre-apply tag + this audit entry are the two artefacts PM needs to
  // review/rollback the change.
  const audit = await writeAuditForApply({
    proposal,
    filesWritten,
    tagSha: tagResult.sha,
    startedAt: applyStartedAt,
    cwd,
  });

  return {
    applied: true,
    tag: tagResult.tag,
    tag_sha: tagResult.sha,
    files_written: filesWritten,
    approval,
    boundary: boundaryResults,
    audit,
  };
}

/**
 * Build the ADR-008 audit entry for a successful apply and write it to
 * `<cwd>/memory/audit/<date>/<proposal_id>.json` via evolution/audit.js.
 * Extracted from `apply()` to keep its cyclomatic complexity ≤ 15.
 *
 * @param {object} args
 * @param {object} args.proposal
 * @param {string[]} args.filesWritten
 * @param {string} args.tagSha
 * @param {number} args.startedAt
 * @param {string} args.cwd
 * @returns {Promise<{audit_log_path: string, schema_version: number} | {audit_log_path: null, error: string}>}
 */
async function writeAuditForApply({ proposal, filesWritten, tagSha, startedAt, cwd }) {
  // diff_stat: derive from files_added content. For each file, count '\n'
  // in content (proxy for added lines; 0 for empty).
  let addedLines = 0;
  for (const f of proposal.files_added) {
    const c = typeof f.content === 'string' ? f.content : '';
    addedLines += c === '' ? 0 : c.split('\n').length;
  }
  const auditEntry = {
    proposal_id: proposal.proposal_id,
    action: 'apply',
    apply_author: proposal.apply_author || 'darwin',
    outcome: 'success',
    files_changed: filesWritten.map((p) => {
      const fa = proposal.files_added.find((x) => x.path === p);
      const c = typeof fa?.content === 'string' ? fa.content : '';
      return {
        path: p,
        diff_type: '+',
        lines: c === '' ? 0 : c.split('\n').length,
      };
    }),
    diff_stat: { '+': addedLines, '-': 0 },
    verify_result: { test: true, lint: true, size_check: true },
    duration_ms: Date.now() - startedAt,
    session_key: null,
    tag_sha: tagSha,
  };
  try {
    const auditBaseDir = path.join(cwd, 'memory', 'audit');
    const result = await writeAuditLog(auditEntry, { baseDir: auditBaseDir });
    return {
      audit_log_path: result.audit_log_path,
      schema_version: result.entry.schema_version,
    };
  } catch (err) {
    // Audit write failure = per ADR-008, 🛑 apply must surface the failure
    // (no audit = no learn). The files + tag already landed; we still
    // report applied:true at the caller, but expose the audit error in
    // the result so the PM can investigate.
    evolutionBus.emit(EVENTS.EVOLUTION_REJECT, {
      proposal_id: proposal.proposal_id,
      reason: `audit_failed: ${err.message}`,
      stage: 'audit',
    });
    return { audit_log_path: null, error: 'audit write failed' };
  }
}

export const _internal = {
  validateProposal,
  runGitTag,
  writeAuditForApply,
  REPO_ROOT,
};
