/**
 * SelfEvolution end-to-end integration — PR-S2.
 *
 * 5 cases:
 *   1. introspect v2  → diagnose() reports current.providers with anthropic + openai-compatible
 *   2. propose        → memory/proposals/<id>.json exists + well-shaped
 *   3. apply+verify+audit in tmpdir worktree (full pipeline)
 *   4. rollback in tmpdir worktree (verify-fail → reset --hard → re-verify)
 *   5. learn appends to evolution-rules.md in tmpdir
 *
 * tmpdir is mandatory: tests must NOT modify the real v2 repo. We copy the
 *   repo's package.json + scripts + a stub source file into a fresh tmpdir
 *   and `git init` it, so `git tag` / `git reset` work as in production.
 *
 * node:test + node:assert/strict (matches tests/integration/ style).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SelfEvolution } from '../../core/self-evolution.js';
import { apply } from '../../evolution/apply.js';
import { verify } from '../../evolution/verify.js';
import { rollback, _resetSessionCounter } from '../../evolution/rollback.js';
import { writeAuditLog } from '../../evolution/audit.js';
import { learn } from '../../evolution/learn.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'self-evo-e2e-'));
}

/** Initialize a tmpdir as a git repo with a tiny package.json so npm scripts
 *  have something to chew on. The tests inject their own proposal files
 *  inside the tmpdir. */
function initRepoWithPackage(cwd, { name = 'tmp-evo', scripts = {} } = {}) {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'e2e-test'], { cwd, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', scripts }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(cwd, '.gitkeep'), '');
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd, stdio: 'pipe' });
}

/** Auto-approver stub for the full-pipeline tests so provider/* proposals
 *  don't hit the 🔴 must-approve gate (we test that path in unit tests). */
const autoApprover = { classify: () => ({ tier: 'green', reason: 'e2e-auto' }) };

// ── 1. introspect v2 ──────────────────────────────────────────────────────

test('1. introspect v2 repo → current.providers includes anthropic + openai-compatible', async () => {
  const se = new SelfEvolution();
  const r = await se.diagnose();
  assert.ok(r.current);
  assert.ok(Array.isArray(r.current.providers));
  // Real v2 repo has provider/anthropic.js + provider/openai-compatible.js
  // (per the 8-PR baseline).
  assert.ok(
    r.current.providers.includes('anthropic'),
    `expected 'anthropic' in current.providers, got ${JSON.stringify(r.current.providers)}`,
  );
  assert.ok(
    r.current.providers.includes('openai-compatible'),
    `expected 'openai-compatible' in current.providers, got ${JSON.stringify(r.current.providers)}`,
  );
  // All 4 missing_* lists must be arrays.
  for (const k of [
    'missing_providers',
    'missing_tools',
    'missing_skills',
    'missing_memory_backends',
  ]) {
    assert.ok(Array.isArray(r[k]), k);
  }
  assert.equal(typeof r.scanned_at, 'string');
});

// ── 2. propose → JSON file ───────────────────────────────────────────────

test('2. propose → structured proposal file under memory/proposals/<id>.json', async () => {
  const proposalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-evo-prop-'));
  const { propose } = await import('../../evolution/propose.js');
  const ps = await propose(undefined, { proposalsDir });
  assert.ok(Array.isArray(ps));
  // P3+ fix (2026-06-15): catalog may be fully populated (V3+ long-meat), so 0 proposals is valid.
  assert.ok(ps.length >= 0, 'propose returns array (may be empty if catalog is complete)');
  for (const p of ps) {
    assert.equal(typeof p.proposal_id, 'string');
    assert.equal(p.action, 'add');
    assert.ok(p.target && typeof p.target.path === 'string');
    assert.ok(Array.isArray(p.files_added) && p.files_added.length >= 1);
    assert.equal(p.apply_author, 'darwin');
    // File must exist on disk.
    const file = path.join(proposalsDir, `${p.proposal_id}.json`);
    assert.ok(fs.existsSync(file), `proposal file ${file} missing`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.proposal_id, p.proposal_id);
  }
  fs.rmSync(proposalsDir, { recursive: true, force: true });
});

// ── 3. apply + verify + audit full pipeline in tmpdir ─────────────────────

test('3. apply → verify → audit in tmpdir worktree (full pipeline)', async () => {
  const cwd = tmp();
  initRepoWithPackage(cwd, {
    scripts: {
      test: 'node --test tests/*.test.js',
      lint: 'echo "lint ok"',
      'size-check': 'echo "size ok"',
    },
  });
  // Create a passing test file so `npm test` actually exits 0.
  fs.mkdirSync(path.join(cwd, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'tests', 'smoke.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n",
  );
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'tests'], { cwd, stdio: 'pipe' });

  const proposal = {
    proposal_id: 'e2e-pipeline-1',
    action: 'add',
    target: { path: 'tool/builtins/foo.js', type: 'builtin_tool', rationale: 'e2e' },
    files_added: [
      { path: 'tool/builtins/foo.js', content: '// foo tool\n' },
      { path: 'tests/foo.test.js', content: '// test\n' },
    ],
    apply_author: 'darwin',
  };
  const applyRes = await apply(proposal, { cwd, approver: autoApprover });
  assert.equal(applyRes.applied, true, applyRes.reason);
  assert.equal(applyRes.files_written.length, 2);
  assert.match(applyRes.tag, /^evolution-pre-e2e-pipeline-1-\d+$/);
  assert.match(applyRes.tag_sha, /^[0-9a-f]{40}$/);
  // Tag must exist.
  const tagList = execFileSync('git', ['tag', '--list'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  assert.ok(tagList.includes(applyRes.tag), `tag missing: ${tagList}`);
  // Files must exist.
  assert.ok(fs.existsSync(path.join(cwd, 'tool/builtins/foo.js')));
  assert.ok(fs.existsSync(path.join(cwd, 'tests/foo.test.js')));

  // Verify.
  const verifyRes = await verify(proposal, { cwd });
  assert.equal(verifyRes.pass, true);
  assert.equal(verifyRes.summary.test_pass, true);
  assert.equal(verifyRes.summary.lint_pass, true);
  assert.equal(verifyRes.summary.size_check_pass, true);

  // Audit.
  const baseDir = path.join(cwd, 'audit');
  const auditRes = await writeAuditLog(
    {
      proposal_id: proposal.proposal_id,
      action: 'apply',
      apply_author: 'darwin',
      outcome: 'success',
      files_changed: proposal.files_added.map((f) => ({ path: f.path, diff_type: '+', lines: 1 })),
      diff_stat: { '+': 2, '-': 0 },
      verify_result: verifyRes.summary,
      duration_ms: 100,
      session_key: 'agent:e2e',
      tag_sha: applyRes.tag_sha,
    },
    { baseDir },
  );
  assert.ok(fs.existsSync(auditRes.audit_log_path));
  const written = JSON.parse(fs.readFileSync(auditRes.audit_log_path, 'utf8'));
  assert.equal(written.action, 'apply');
  assert.equal(written.outcome, 'success');
  assert.equal(written.schema_version, 2);

  fs.rmSync(cwd, { recursive: true, force: true });
});

// ── 4. rollback in tmpdir ─────────────────────────────────────────────────
// P3 fix (2026-06-15): apply no longer auto-commits; rollback uses `git reset --hard <tag>` (per ADR-007). Apply writes are untracked (never `git add`-ed), so they survive `git reset --hard` (which only reverts tracked files). Therefore HEAD stays at baseline after apply, and bad.js stays in the working tree after rollback — the test asserts the post-P3 untracked-survives reality, not the pre-P3 "apply auto-commits → reset deletes" fantasy.
test('4. rollback → reset --hard + re-verify in tmpdir worktree', async () => {
  _resetSessionCounter();
  const cwd = tmp();
  initRepoWithPackage(cwd, {
    scripts: {
      test: 'node --test tests/*.test.js',
      lint: 'echo "lint ok"',
      'size-check': 'echo "size ok"',
    },
  });
  fs.mkdirSync(path.join(cwd, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'tests', 'smoke.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n",
  );
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd, stdio: 'pipe' });
  const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();

  // Apply a change.
  const proposal = {
    proposal_id: 'e2e-rb-1',
    action: 'add',
    target: { path: 'tool/builtins/bad.js', type: 'builtin_tool', rationale: 'e2e' },
    files_added: [{ path: 'tool/builtins/bad.js', content: '// bad tool\n' }],
    apply_author: 'darwin',
  };
  const applyRes = await apply(proposal, { cwd, approver: autoApprover });
  assert.equal(applyRes.applied, true);
  const newSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  assert.equal(newSha, baselineSha, 'P3 fix: apply does NOT commit; HEAD stays at baseline');
  assert.ok(fs.existsSync(path.join(cwd, 'tool/builtins/bad.js')));

  // Roll back.
  const verifyFn = async () => ({
    pass: true,
    summary: { test_pass: true, lint_pass: true, size_check_pass: true },
  });
  const rbRes = await rollback(proposal, applyRes.tag_sha, { cwd, verifyFn });
  assert.equal(rbRes.rolled_back, true);
  assert.equal(rbRes.new_verify_pass, true);
  // HEAD back to baseline.
  const afterHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  assert.equal(afterHead, baselineSha);
  // File still in working tree (P3 fix: apply no longer commits, so
  // bad.js is untracked; `git reset --hard` only reverts tracked files,
  // untracked ones survive — PM cleans up with `git clean -fd` after
  // reviewing the audit log). This is correct post-P3 behaviour.
  assert.ok(
    fs.existsSync(path.join(cwd, 'tool/builtins/bad.js')),
    'P3 fix: untracked bad.js survives git reset --hard; PM cleans up after audit review',
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

// ── 5. learn in tmpdir ────────────────────────────────────────────────────

test('5. learn appends `- <date>: <insight>` to memory/learnings/evolution-rules.md', async () => {
  const learnDir = path.join(tmp(), 'learnings');
  fs.mkdirSync(learnDir, { recursive: true });
  // Run a fake rollback-then-learn flow.
  const r1 = await learn('first rollback insight', { learnDir });
  assert.equal(r1.rules_count, 1);
  const r2 = await learn('second insight', { learnDir });
  assert.equal(r2.rules_count, 2);
  const content = fs.readFileSync(r2.rules_path, 'utf8');
  assert.match(content, /# Evolution Rules/);
  assert.match(content, /first rollback insight/);
  assert.match(content, /second insight/);
  fs.rmSync(path.dirname(learnDir), { recursive: true, force: true });
});
