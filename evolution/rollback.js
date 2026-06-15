/**
 * Evolution Rollback — PR-S2 (v3+ SelfEvolution P0).
 *
 * ADR-007 L3 auto-rollback: when verify fails, `git reset --hard <tag_sha>`
 * + re-run verify (must pass again). F-6 SOP self-check printed before reset
 * (PR-S2: emit instead of console.log so e2e can capture).
 *
 * Continuous-rollback detection (ADR-007):
 *   3 rollbacks in the same Darwin session → write `~/.darwin/learn-pause`
 *   flag + emit `evolution:learn:pause` + Darwin pauses autonomous apply 24h.
 *
 * LLM gate (ADR-009): rollback is mechanical, NEVER calls LLM.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';
import { verify } from './verify.js';

export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PAUSE_FLAG = path.join(os.homedir(), '.darwin', 'learn-pause');
const PAUSE_WINDOW_MS = 3; // 3 consecutive rollbacks → pause
const PAUSE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Session-scoped counter (cleared on process restart).
let sessionCounter = 0;

/**
 * F-6 self-check before any destructive `git reset --hard`.
 * Returns the captured state for the audit log.
 */
function f6SelfCheck(cwd, tagSha) {
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  const dirtyCount = execFileSync('git', ['status', '--short'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean).length;
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  const tagExists = (() => {
    try {
      execFileSync('git', ['rev-parse', '--verify', tagSha], { cwd, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })();

  const report = {
    branch,
    dirty_count: dirtyCount,
    head_sha: headSha,
    expected_sha: tagSha,
    tag_exists: tagExists,
  };

  // Surface to subscribers (e2e + audit).
  evolutionBus.emit('evolution:rollback:selfcheck', report);

  return report;
}

/**
 * Run `git reset --hard <tag_sha>`. Uses execFileSync (no shell) per F-6 SOP.
 */
function runGitReset(tagSha, cwd) {
  execFileSync('git', ['reset', '--hard', tagSha], { cwd, stdio: 'pipe' });
}

/**
 * Write the `~/.darwin/learn-pause` flag file with TTL + reason.
 * Idempotent — overwrite is fine.
 */
function writeLearnPauseFlag(reason) {
  fs.mkdirSync(path.dirname(PAUSE_FLAG), { recursive: true });
  const expiresAt = Date.now() + PAUSE_TTL_MS;
  const payload = JSON.stringify(
    {
      reason,
      written_at: new Date().toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    },
    null,
    2,
  );
  fs.writeFileSync(PAUSE_FLAG, payload, 'utf8');
  return PAUSE_FLAG;
}

/**
 * PR-S2 rollback — real implementation.
 *
 * @param {object} proposal
 * @param {string} tag_sha — the pre-apply tag SHA captured by apply()
 * @param {object} [opts]
 * @param {string} [opts.cwd] — default REPO_ROOT
 * @param {object} [opts.verifyFn] — injectable verify() for tests
 * @returns {Promise<{
 *   rolled_back: boolean,
 *   new_verify_pass: boolean,
 *   selfcheck: object,
 *   pause?: { reason: string, flag_path: string },
 *   error?: string,
 * }>}
 */
export async function rollback(proposal, tag_sha, opts = {}) {
  if (typeof tag_sha !== 'string' || !tag_sha) {
    throw new TypeError('[evolution/rollback] tag_sha must be non-empty string');
  }
  const cwd = opts.cwd || REPO_ROOT;
  const verifyFn = opts.verifyFn || verify;

  const selfcheck = f6SelfCheck(cwd, tag_sha);

  // F-6 SOP: never reset if tag is missing or branch is unexpected.
  // For PR-S2 we accept any branch (e2e uses detached worktrees), but we
  // refuse to reset to a non-existent tag.
  if (!selfcheck.tag_exists) {
    evolutionBus.emit(EVENTS.EVOLUTION_ROLLBACK, {
      proposal_id: proposal && proposal.proposal_id,
      rolled_back: false,
      reason: `tag_missing:${tag_sha}`,
      selfcheck,
    });
    return {
      rolled_back: false,
      new_verify_pass: false,
      selfcheck,
      error: `tag_missing:${tag_sha}`,
    };
  }

  try {
    runGitReset(tag_sha, cwd);
  } catch (err) {
    evolutionBus.emit(EVENTS.EVOLUTION_ROLLBACK, {
      proposal_id: proposal && proposal.proposal_id,
      rolled_back: false,
      reason: `reset_failed:${err.message}`,
      selfcheck,
    });
    return {
      rolled_back: false,
      new_verify_pass: false,
      selfcheck,
      error: `reset_failed:${err.message}`,
    };
  }

  // Re-run verify after reset (must pass per ADR-007).
  const reVerify = await verifyFn(proposal, { cwd });

  sessionCounter += 1;
  let pause;
  if (sessionCounter >= PAUSE_WINDOW_MS) {
    const reason = `consecutive_rollbacks_${sessionCounter}`;
    const flagPath = writeLearnPauseFlag(reason);
    pause = { reason, flag_path: flagPath };
    evolutionBus.emit('evolution:learn:pause', {
      session_rollbacks: sessionCounter,
      flag_path: flagPath,
      ttl_hours: 24,
    });
  }

  evolutionBus.emit(EVENTS.EVOLUTION_ROLLBACK, {
    proposal_id: proposal && proposal.proposal_id,
    rolled_back: true,
    new_verify_pass: reVerify.pass,
    selfcheck,
    pause,
    session_rollbacks: sessionCounter,
  });

  return {
    rolled_back: true,
    new_verify_pass: reVerify.pass,
    selfcheck,
    pause,
    verify_result: reVerify,
  };
}

/** Test/internal helpers — clear the session-scoped counter. */
export function _resetSessionCounter() {
  sessionCounter = 0;
}

export const _internal = {
  f6SelfCheck,
  runGitReset,
  writeLearnPauseFlag,
  PAUSE_FLAG,
  PAUSE_WINDOW_MS,
  PAUSE_TTL_MS,
  REPO_ROOT,
};
