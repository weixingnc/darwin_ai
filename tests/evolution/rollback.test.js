/**
 * Rollback unit tests — PR-S2.
 *
 * Exercises evolution/rollback.js: `git reset --hard <tag>` + re-verify +
 * continuous-rollback pause flag. Uses tmpdir git repos + injected
 * `verifyFn` so we don't shell out to npm.
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rollback, _resetSessionCounter, _internal } from '../../evolution/rollback.js';

function makeTmpRepo(initialContent = 'init') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'file.txt'), initialContent);
  execFileSync('git', ['add', 'file.txt'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: root, stdio: 'pipe' });
  // Tag the initial state.
  execFileSync('git', ['tag', 'baseline'], { cwd: root, stdio: 'pipe' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { root, baselineSha: sha };
}

/** Modify the repo: write a new file + commit. Returns the new HEAD SHA. */
function applyChange(cwd, newContent) {
  fs.writeFileSync(path.join(cwd, 'file.txt'), newContent);
  execFileSync('git', ['add', 'file.txt'], { cwd: root(cwd), stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'change'], { cwd: root(cwd), stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root(cwd),
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}
function root(p) {
  return p;
}

test('rollback: resets HEAD to tag + re-runs verify', async () => {
  _resetSessionCounter();
  const { root: cwd, baselineSha } = makeTmpRepo();
  // Apply a change (commit on top of baseline).
  const newSha = applyChange(cwd, 'new content');
  assert.notEqual(newSha, baselineSha);
  const verifyFn = async () => ({
    pass: true,
    summary: { test_pass: true, lint_pass: true, size_check_pass: true },
  });
  const res = await rollback({ proposal_id: 'rb-1' }, baselineSha, { cwd, verifyFn });
  assert.equal(res.rolled_back, true);
  assert.equal(res.new_verify_pass, true);
  // HEAD must now be back at baseline.
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  assert.equal(headSha, baselineSha);
  // File content back to original.
  assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'init');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('rollback: missing tag → rolled_back:false + error includes tag_missing', async () => {
  _resetSessionCounter();
  const { root: cwd } = makeTmpRepo();
  const res = await rollback({ proposal_id: 'rb-2' }, 'deadbeef00000000', { cwd });
  assert.equal(res.rolled_back, false);
  assert.match(res.error, /tag_missing/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('rollback: missing tag_sha → throws TypeError', async () => {
  await assert.rejects(() => rollback({}, ''), TypeError);
  await assert.rejects(() => rollback({}, null), TypeError);
});

test('rollback: emits evolution:rollback event with selfcheck + pause', async () => {
  _resetSessionCounter();
  const { root: cwd, baselineSha } = makeTmpRepo();
  applyChange(cwd, 'x');
  const { evolutionBus } = await import('../../evolution/_bus.js');
  const { EVENTS } = await import('../../core/events.js');
  const captured = [];
  const handler = (p) => captured.push(p);
  evolutionBus.on(EVENTS.EVOLUTION_ROLLBACK, handler);
  try {
    const verifyFn = async () => ({ pass: true });
    await rollback({ proposal_id: 'rb-evt' }, baselineSha, { cwd, verifyFn });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].rolled_back, true);
    assert.ok(captured[0].selfcheck);
    assert.equal(typeof captured[0].selfcheck.head_sha, 'string');
  } finally {
    evolutionBus.off(EVENTS.EVOLUTION_ROLLBACK, handler);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('rollback: 3 consecutive rollbacks → writes ~/.darwin/learn-pause flag + emit learn:pause', async () => {
  _resetSessionCounter();
  const { root: cwd, baselineSha } = makeTmpRepo();
  applyChange(cwd, 'a');
  const verifyFn = async () => ({ pass: true });
  // Three rollbacks in a row.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await rollback({ proposal_id: `rb-pause-${i}` }, baselineSha, { cwd, verifyFn });
  }
  // Flag file must exist.
  const flag = path.join(os.homedir(), '.darwin', 'learn-pause');
  assert.ok(fs.existsSync(flag), `expected ${flag} to exist`);
  const parsed = JSON.parse(fs.readFileSync(flag, 'utf8'));
  assert.match(parsed.reason, /consecutive_rollbacks/);
  assert.ok(typeof parsed.expires_at === 'string');
  // Cleanup flag (so we don't pollute the host).
  fs.unlinkSync(flag);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('rollback: selfcheck reflects branch + dirty count + tag_exists', async () => {
  const { root: cwd, baselineSha } = makeTmpRepo();
  const sc = _internal.f6SelfCheck(cwd, baselineSha);
  assert.equal(sc.branch, 'main');
  assert.equal(sc.dirty_count, 0);
  assert.equal(sc.tag_exists, true);
  assert.equal(sc.expected_sha, baselineSha);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('rollback: selfcheck reports tag_exists:false for unknown SHA', () => {
  const { root: cwd } = makeTmpRepo();
  const sc = _internal.f6SelfCheck(cwd, 'notasha');
  assert.equal(sc.tag_exists, false);
  fs.rmSync(cwd, { recursive: true, force: true });
});
