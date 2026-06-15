/**
 * Apply unit tests — PR-S2.
 *
 * Exercises evolution/apply.js (ADR-005 boundary + ADR-006 approval +
 * ADR-007 git tag + file write). Uses tmpdir fixtures + injected boundary /
 * approver so we don't depend on the real v2 repo state and don't run real
 * git tags in CI without intent.
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply, _internal } from '../../evolution/apply.js';

/** Make a tmpdir that doubles as a git repo so `git tag` works. */
function makeTmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root, stdio: 'pipe' });
  // First commit so HEAD exists.
  fs.writeFileSync(path.join(root, '.gitkeep'), '');
  execFileSync('git', ['add', '.gitkeep'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: root, stdio: 'pipe' });
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
  const tagSha = execFileSync('git', ['rev-parse', res.tag], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
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
