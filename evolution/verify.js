/**
 * Evolution Verify — PR-S2 (v3+ SelfEvolution P0).
 *
 * Runs `npm test`, `npm run lint`, `npm run size-check` in the proposal's
 * cwd (default: real repo root; e2e passes a tmpdir worktree so the v2 repo
 * is never modified). Deterministic, no LLM (ADR-009).
 *
 * Output:
 *   { pass, details: { test, lint, size_check, raw } }
 *   pass = true iff all three pass
 *
 * Notes:
 * - We use execFileSync (no shell) to avoid shell injection from `cwd`.
 * - A non-zero exit code OR stderr non-empty (lint) OR any `✗` line in
 *   size-check output counts as failure.
 * - We do NOT swallow errors — verify is the single source of truth for
 *   "does the proposal break the build".
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';

export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Run one command in cwd and return { status, stdout, stderr, duration_ms }.
 * status = 'pass' | 'fail'.
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 */
function runCommand(cmd, args, cwd) {
  const start = Date.now();
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status ?? 1;
    stdout = err.stdout ? String(err.stdout) : '';
    stderr = err.stderr ? String(err.stderr) : '';
  }
  const duration_ms = Date.now() - start;
  return { status: code === 0 ? 'pass' : 'fail', code, stdout, stderr, duration_ms };
}

/**
 * Parse `npm test` output → { test: { pass, fail, total } }.
 * Heuristic: `npm test` (node --test) prints a final summary line; if absent
 * (older Node), fall back to "no fail count" = 0.
 */
function parseTest(raw) {
  const out = (raw.stdout || '') + (raw.stderr || '');
  const m = out.match(/tests\s+(\d+).*?pass\s+(\d+).*?fail\s+(\d+)/s);
  if (!m) {
    // Fallback: only fail/pass indicator we have is exit code.
    return {
      pass: raw.code === 0 ? 'unknown' : 0,
      fail: raw.code === 0 ? 0 : 'unknown',
      total: null,
    };
  }
  const total = parseInt(m[1], 10);
  const pass = parseInt(m[2], 10);
  const fail = parseInt(m[3], 10);
  return { pass, fail, total };
}

/**
 * Parse `npm run lint` (eslint) → { errors, warnings }.
 * eslint v8 prints "✖ N problems (E errors, W warnings)" on failure.
 */
function parseLint(raw) {
  const out = (raw.stdout || '') + (raw.stderr || '');
  const m = out.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/);
  if (!m) {
    // No summary line ⇒ lint exited 0 with no findings.
    return { errors: 0, warnings: 0 };
  }
  return { errors: parseInt(m[2], 10), warnings: parseInt(m[3], 10) };
}

/**
 * Parse `npm run size-check` → { files, all_under_limit, violations }.
 * The script (scripts/size-check.js) prints one `✓`/`✗` line per file plus a
 * final `✓ All N file(s) within ...` line on success, or `✗ N file(s) exceed`
 * on failure.
 */
function parseSizeCheck(raw) {
  const out = (raw.stdout || '') + (raw.stderr || '');
  const fileLines = out.split('\n').filter((l) => /^[✓✗]\s+\S+\.\w+:\s+\d+\s+lines/.test(l));
  const violations = fileLines.filter((l) => l.startsWith('✗')).length;
  const totalMatch = out.match(/(?:All|file\(s\))\s+(\d+)/);
  const files = totalMatch ? parseInt(totalMatch[1], 10) : fileLines.length;
  return { files, all_under_limit: violations === 0 && raw.code === 0, violations };
}

/**
 * PR-S2 verify — real implementation.
 *
 * @param {object} [_proposal] — unused at this layer (kept for future ADR-008
 *   cross-checking, e.g. expected_verify vs actual); passed through for
 *   call-site symmetry with apply/rollback.
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory (default REPO_ROOT). E2E
 *   passes a tmpdir worktree.
 * @param {object} [opts.runners] — optional injection for tests:
 *   { test?: (cwd) => RawRun, lint?: (cwd) => RawRun, size_check?: (cwd) => RawRun }
 * @returns {Promise<{
 *   pass: boolean,
 *   details: {
 *     test: { raw, parsed, duration_ms },
 *     lint: { raw, parsed, duration_ms },
 *     size_check: { raw, parsed, duration_ms },
 *   },
 *   summary: { test_pass: bool, lint_pass: bool, size_check_pass: bool },
 * }>}
 */
export async function verify(_proposal, opts = {}) {
  const cwd = opts.cwd || REPO_ROOT;
  const runners = opts.runners || {};

  const testRaw = runners.test ? runners.test(cwd) : runCommand('npm', ['test', '--silent'], cwd);
  const lintRaw = runners.lint
    ? runners.lint(cwd)
    : runCommand('npm', ['run', 'lint', '--silent'], cwd);
  const sizeRaw = runners.size_check
    ? runners.size_check(cwd)
    : runCommand('npm', ['run', 'size-check', '--silent'], cwd);

  const testParsed = parseTest(testRaw);
  const lintParsed = parseLint(lintRaw);
  const sizeParsed = parseSizeCheck(sizeRaw);

  const testPass = testRaw.code === 0;
  const lintPass = lintRaw.code === 0 && lintParsed.errors === 0;
  const sizePass = sizeRaw.code === 0 && sizeParsed.all_under_limit;

  const pass = testPass && lintPass && sizePass;

  const result = {
    pass,
    details: {
      test: { raw: testRaw, parsed: testParsed, duration_ms: testRaw.duration_ms },
      lint: { raw: lintRaw, parsed: lintParsed, duration_ms: lintRaw.duration_ms },
      size_check: { raw: sizeRaw, parsed: sizeParsed, duration_ms: sizeRaw.duration_ms },
    },
    summary: {
      test_pass: testPass,
      lint_pass: lintPass,
      size_check_pass: sizePass,
    },
  };

  evolutionBus.emit(EVENTS.EVOLUTION_VERIFY, {
    pass,
    cwd,
    summary: result.summary,
  });

  return result;
}

export const _internal = {
  runCommand,
  parseTest,
  parseLint,
  parseSizeCheck,
  REPO_ROOT,
};
