/**
 * Apply unit tests — PR-S2.
 *
 * Exercises evolution/apply.js (ADR-005 boundary + ADR-006 approval +
 * ADR-007 git tag + file write). Uses tmpdir fixtures + injected boundary /
 * approver so we don't depend on the real v2 repo state and don't run real
 * git tags in CI without intent.
 *
 * P3-P1 fix (2026-06-15): two new tests at the bottom cover the
 * "darwin 自己改 darwin_core ❌" rule + ADR-008 audit log:
 *   - no_auto_commit: apply must NOT invoke `git commit` (PM's job).
 *   - writes_audit_log: apply must write a real JSON audit log to
 *     memory/audit/<date>/<proposal_id>.json (ADR-008 must-have fields).
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { apply, _internal } from '../../evolution/apply.js';

/** Make a tmpdir that doubles as a git repo so `git tag` works. */
function makeTmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-'));
  childProcess.execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: root,
    stdio: 'pipe',
  });
  childProcess.execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: root,
    stdio: 'pipe',
  });
  childProcess.execFileSync('git', ['config', 'user.name', 'test'], { cwd: root, stdio: 'pipe' });
  // First commit so HEAD exists.
  fs.writeFileSync(path.join(root, '.gitkeep'), '');
  childProcess.execFileSync('git', ['add', '.gitkeep'], { cwd: root, stdio: 'pipe' });
  childProcess.execFileSync('git', ['commit', '--quiet', '-m', 'init'], {
    cwd: root,
    stdio: 'pipe',
  });
  return root;
}

/** Permissive boundary + approver stubs. Used by default in success tests. */
const autoApprover = {
  classify() {
    return { tier: 'green', reason: 'auto-test' };
  },
};

test('apply: writes files + creates tag in tmpdir repo', async () => {
  const cwd = makeTmpRepo();
  const proposal = {
    proposal_id: 'apply-test-1',
    action: 'add',
    target: { path: 'tool/builtins/foo.js', type: 'builtin_tool', rationale: 'test' },
    files_added: [
      { path: 'tool/builtins/foo.js', content: '// foo\n' },
      { path: 'tests/foo.test.js', content: '// test\n' },
    ],
    expected_verify: { test: true, lint: true, size_check: true },
    apply_author: 'darwin',
  };
  const res = await apply(proposal, { cwd, approver: autoApprover });
  assert.equal(res.applied, true, res.reason);
  assert.equal(res.files_written.length, 2);
  assert.match(res.tag, /^evolution-pre-apply-test-1-\d+$/);
  assert.match(res.tag_sha, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(cwd, 'tool/builtins/foo.js')));
  assert.ok(fs.existsSync(path.join(cwd, 'tests/foo.test.js')));
  // git tag must exist
  const tagSha = childProcess
    .execFileSync('git', ['rev-parse', res.tag], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    .trim();
  assert.equal(tagSha, res.tag_sha);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('apply: blacklisted file → returns applied:false + emits reject', async () => {
  const cwd = makeTmpRepo();
  const proposal = {
    proposal_id: 'apply-blacklist-1',
    action: 'modify',
    target: { path: 'core/event-bus.js', type: 'core', rationale: 'test' },
    files_added: [{ path: 'core/event-bus.js', content: '// bad' }],
    apply_author: 'darwin',
  };
  const res = await apply(proposal, { cwd, approver: autoApprover });
  assert.equal(res.applied, false);
  assert.match(res.reason, /blacklisted/);
  assert.deepEqual(res.files_written, []);
  // File must NOT have been written.
  assert.ok(!fs.existsSync(path.join(cwd, 'core/event-bus.js')));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('apply: tier=red → returns applied:false + reason includes must_approve', async () => {
  const cwd = makeTmpRepo();
  const proposal = {
    proposal_id: 'apply-mustapprove-1',
    action: 'add',
    target: { path: 'provider/foo.js', type: 'provider', rationale: 'new provider' },
    files_added: [{ path: 'provider/foo.js', content: '// x\n' }],
    apply_author: 'darwin',
  };
  const realApprover = (await import('../../core/self-evolution.js'))._internal.defaultApprover();
  const res = await apply(proposal, { cwd, approver: realApprover });
  assert.equal(res.applied, false);
  assert.equal(res.approval.tier, 'red');
  assert.match(res.reason, /must_approve/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('apply: missing proposal_id → throws TypeError', async () => {
  await assert.rejects(() => apply({ files_added: [{ path: 'a.js' }] }), TypeError);
});

test('apply: empty files_added → throws TypeError', async () => {
  await assert.rejects(() => apply({ proposal_id: 'x', files_added: [] }), TypeError);
});

test('apply: emits evolution:apply:before and :after events on success', async () => {
  const cwd = makeTmpRepo();
  const { evolutionBus } = await import('../../evolution/_bus.js');
  const { EVENTS } = await import('../../core/events.js');
  const events = [];
  const onBefore = (p) => events.push(['before', p]);
  const onAfter = (p) => events.push(['after', p]);
  evolutionBus.on(EVENTS.EVOLUTION_APPLY_BEFORE, onBefore);
  evolutionBus.on(EVENTS.EVOLUTION_APPLY_AFTER, onAfter);
  try {
    const proposal = {
      proposal_id: 'apply-events-1',
      action: 'add',
      target: { path: 'tests/x.test.js', type: 'test', rationale: 'r' },
      files_added: [{ path: 'tests/x.test.js', content: '// x\n' }],
      apply_author: 'darwin',
    };
    const res = await apply(proposal, { cwd, approver: autoApprover });
    assert.equal(res.applied, true);
    assert.equal(events.length, 2);
    assert.equal(events[0][0], 'before');
    assert.equal(events[1][0], 'after');
    assert.equal(events[0][1].proposal_id, 'apply-events-1');
    assert.equal(events[1][1].tag_sha, res.tag_sha);
  } finally {
    evolutionBus.off(EVENTS.EVOLUTION_APPLY_BEFORE, onBefore);
    evolutionBus.off(EVENTS.EVOLUTION_APPLY_AFTER, onAfter);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('_internal.validateProposal: rejects null and non-object', () => {
  assert.throws(() => _internal.validateProposal(null), TypeError);
  assert.throws(() => _internal.validateProposal('string'), TypeError);
  assert.throws(() => _internal.validateProposal({}), TypeError);
});

// ─────────────────────────────────────────────────────────────────────
// P3-P1 fix tests (2026-06-15) — Darwin越界 + audit log
// ─────────────────────────────────────────────────────────────────────

/** P3-P1 fix test strategy: ESM module namespace objects are sealed
 *  (configurable:false on every property), so we cannot monkey-patch
 *  childProcess.execFileSync to count `git commit` calls. Instead, we
 *  verify the OBSERVABLE outcome: HEAD must not advance, and the
 *  `git log` inside the apply's tmpdir repo must not contain any
 *  commit whose message starts with "evolution: apply". This is
 *  actually a more authoritative check than a spy — it proves the
 *  user-visible behaviour ("Darwin did not auto-commit") rather
 *  than an implementation detail. */
function countEvolutionCommits(cwd) {
  try {
    const out = childProcess.execFileSync('git', ['log', '--oneline', '--grep=^evolution: apply'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const lines = out.trim().split('\n').filter(Boolean);
    return lines.length;
  } catch {
    return 0;
  }
}

/** YYYY-MM-DD for `epochMs` in UTC — mirrors evolution/audit.js internal. */
function isoDate(epochMs = Date.now()) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

test('apply: does NOT auto-commit (Darwin越界 fix — commit is PM responsibility)', async () => {
  const cwd = makeTmpRepo();
  // Record HEAD SHA before apply so we can prove the apply call did not
  // advance HEAD (i.e. no new commit landed).
  const headBefore = childProcess
    .execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
    .trim();
  const commitsBefore = countEvolutionCommits(cwd);
  try {
    const res = await apply(
      {
        proposal_id: 'apply-no-autocommit-1',
        action: 'add',
        target: { path: 'tool/builtins/n.js', type: 'builtin_tool', rationale: 'r' },
        files_added: [{ path: 'tool/builtins/n.js', content: '// n\n' }],
        apply_author: 'darwin',
      },
      { cwd, approver: autoApprover },
    );
    assert.equal(res.applied, true, res.reason);
    // 1. HEAD must not advance — the definitive proof of "no auto-commit".
    const headAfter = childProcess
      .execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
      .trim();
    assert.equal(
      headAfter,
      headBefore,
      `apply must not create a new commit; HEAD moved from ${headBefore} to ${headAfter}`,
    );
    // 2. No `evolution: apply <id>` commit message should exist in history.
    const commitsAfter = countEvolutionCommits(cwd);
    assert.equal(
      commitsAfter,
      commitsBefore,
      `apply must not write any "evolution: apply" commit; before=${commitsBefore}, after=${commitsAfter}`,
    );
    // 3. The pre-apply tag from ADR-007 step 3 MUST still exist (sanity:
    //    we didn't accidentally delete the tag).
    assert.match(res.tag, /^evolution-pre-apply-no-autocommit-1-\d+$/);
    const tagList = childProcess
      .execFileSync('git', ['tag', '-l', res.tag], { cwd, encoding: 'utf8' })
      .trim();
    assert.equal(tagList, res.tag, 'pre-apply tag must exist after apply');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('apply: writes real audit log JSON to memory/audit/<date>/<proposal_id>.json', async () => {
  const cwd = makeTmpRepo();
  const proposal = {
    proposal_id: 'apply-audit-1',
    action: 'add',
    target: { path: 'tool/builtins/a.js', type: 'builtin_tool', rationale: 'r' },
    files_added: [
      { path: 'tool/builtins/a.js', content: '// a line 1\n// a line 2\n' },
      { path: 'tests/a.test.js', content: '// test\n' },
    ],
    apply_author: 'darwin',
  };
  try {
    const res = await apply(proposal, { cwd, approver: autoApprover });
    assert.equal(res.applied, true, res.reason);
    // Result must include audit summary pointing at the real path.
    assert.ok(res.audit, 'apply result must include .audit summary');
    assert.ok(
      res.audit.audit_log_path,
      `audit_log_path must be set on success; got: ${JSON.stringify(res.audit)}`,
    );
    const expectedDate = isoDate();
    const expectedPath = path.join(cwd, 'memory', 'audit', expectedDate, 'apply-audit-1.json');
    assert.equal(res.audit.audit_log_path, expectedPath);
    assert.ok(fs.existsSync(expectedPath), `audit log must exist on disk: ${expectedPath}`);
    const written = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    // ADR-008 must-have 9 fields the test brief calls out (8 schema fields
    // + tag_sha). writeAuditLog also adds schema_version + written_at.
    const required = [
      'proposal_id',
      'action',
      'files_changed',
      'diff_stat',
      'verify_result',
      'duration_ms',
      'outcome',
      'apply_author',
      'tag_sha',
    ];
    for (const k of required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(written, k),
        `audit log missing required field: ${k}`,
      );
    }
    // Field-level assertions.
    assert.equal(written.proposal_id, 'apply-audit-1');
    assert.equal(written.action, 'apply');
    assert.equal(written.outcome, 'success');
    assert.equal(written.apply_author, 'darwin');
    assert.equal(written.tag_sha, res.tag_sha);
    assert.ok(Array.isArray(written.files_changed));
    assert.equal(written.files_changed.length, 2);
    assert.equal(written.files_changed[0].path, 'tool/builtins/a.js');
    assert.equal(written.files_changed[0].diff_type, '+');
    assert.equal(written.diff_stat['+'], 5); // 3 + 2 (split('\n') counts trailing empty)
    assert.equal(written.diff_stat['-'], 0);
    assert.equal(written.verify_result.test, true);
    assert.equal(written.verify_result.lint, true);
    assert.equal(written.verify_result.size_check, true);
    assert.equal(typeof written.duration_ms, 'number');
    assert.equal(written.schema_version, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
