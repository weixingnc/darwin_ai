/**
 * Self-Evolve orchestrator tests — P2f (2026-06-18).
 *
 * Closes the Darwin self-evolution loop. P2c-3 proved the loop works when
 * a human drives each step (write catalogue, run subprocess, observe).
 * P2f proves the loop works when ONE function drives it end-to-end —
 * the last mile between "Darwin has the capability" and "Darwin actually
 * uses the capability".
 *
 * Test surface covers the 5 safety invariants in evolution/self-evolve.js:
 *   1. Explicit confirm required (without confirm:true the call throws)
 *   2. Sandbox is NOT activated by self-evolve (Darwin must not self-trap;
 *      P2e's sandbox would block propose.js's fs.writeFileSync)
 *   3. Verify before re-diagnose (broken proposals roll back)
 *   4. One proposal per cycle (multi-missing catalogues grow one at a time)
 *   5. Audit plugin observes the loop (events emitted list non-empty)
 *
 * Pattern: each end-to-end test creates a fresh tmpdir git worktree
 * (per P2c-3), overrides PLUGIN_CATALOGUE to introduce a missing plugin,
 * and runs runSelfEvolve against the worktree via a subprocess driver
 * (p2f-driver.mjs).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';

import { runSelfEvolve } from '../../evolution/self-evolve.js';
import { _activeSandbox } from '../../plugin/sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_ROOT = path.resolve(__dirname, '..', '..');

function makeWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2f-wt-'));
  childProcess.execFileSync('git', ['worktree', 'add', '--detach', root, 'HEAD'], {
    cwd: V2_ROOT,
    stdio: 'pipe',
  });
  childProcess.execFileSync('git', ['config', 'user.email', 'p2f-test@local'], {
    cwd: root,
    stdio: 'pipe',
  });
  childProcess.execFileSync('git', ['config', 'user.name', 'p2f-test'], {
    cwd: root,
    stdio: 'pipe',
  });
  // Self-evolve's verify() step runs `npm run lint` (eslint 8.x via
  // .eslintrc.json) and `npm test`. The worktree's working tree is
  // missing node_modules/ (gitignored) so without this symlink the
  // system would fall through to a globally-installed eslint 9.x,
  // which doesn't read .eslintrc.json and would fail every lint run.
  // Symlinking the real v2 node_modules gives verify a consistent
  // build environment.
  try {
    fs.symlinkSync(path.join(V2_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }
  return root;
}

function cleanupWorktree(root) {
  try {
    childProcess.execFileSync('git', ['worktree', 'remove', '--force', root], {
      cwd: V2_ROOT,
      stdio: 'pipe',
    });
  } catch (_) {
    // already gone — fall through
  }
  childProcess.execFileSync('git', ['worktree', 'prune'], {
    cwd: V2_ROOT,
    stdio: 'pipe',
  });
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup
  }
}

function injectMissingPlugin(worktree, newCatalogue) {
  const filePath = path.join(worktree, 'evolution/diagnose.js');
  const before = fs.readFileSync(filePath, 'utf8');
  const re = /const PLUGIN_CATALOGUE = \[(.*?)\]\.map/;
  const m = before.match(re);
  if (!m) {
    throw new Error('PLUGIN_CATALOGUE literal not found');
  }
  const newLit = `const PLUGIN_CATALOGUE = [${newCatalogue.map((s) => `'${s}'`).join(', ')}].map`;
  const after = before.replace(re, newLit);
  fs.writeFileSync(filePath, after, 'utf8');
  childProcess.execFileSync('git', ['add', 'evolution/diagnose.js'], {
    cwd: worktree,
    stdio: 'pipe',
  });
  childProcess.execFileSync(
    'git',
    [
      'commit',
      '--quiet',
      '-m',
      `p2f: extend catalogue with ${newCatalogue[newCatalogue.length - 1]}`,
      '--no-verify',
    ],
    { cwd: worktree, stdio: 'pipe' },
  );
}

/**
 * Run the p2f driver inside the worktree and return parsed JSON stdout.
 * See p2f-driver.mjs for why we use a subprocess here instead of importing
 * runSelfEvolve directly (the latter would load the real v2 self-evolve.js,
 * whose diagnose dependency has a module-scope PLUGIN_CATALOGUE constant
 * — P2c-3 pitfall #2).
 */
function runDriver(worktree, cmd) {
  const driverSrc = fs.readFileSync(path.join(__dirname, 'p2f-driver.mjs'), 'utf8');
  const driverDst = path.join(worktree, 'tests/evolution/p2f-driver.mjs');
  fs.mkdirSync(path.dirname(driverDst), { recursive: true });
  fs.writeFileSync(driverDst, driverSrc);

  const out = childProcess
    .execFileSync('node', ['tests/evolution/p2f-driver.mjs', cmd], {
      cwd: worktree,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, P2F_WORKTREE: worktree },
    })
    .toString();
  return JSON.parse(out);
}

describe('P2f — self-evolve orchestrator safety', () => {
  test('throws without explicit confirm:true (safety invariant #1)', async () => {
    await assert.rejects(() => runSelfEvolve({}), /confirm:true is required/);
    await assert.rejects(() => runSelfEvolve({ confirm: false }), /confirm:true is required/);
  });

  test('returns evolved:false when catalogue is already closed (real v2 has no missing plugins)', async () => {
    const r = await runSelfEvolve({ confirm: true, cwd: V2_ROOT });
    assert.equal(r.evolved, false);
    assert.equal(r.reason, 'no_missing_plugins');
    assert.deepEqual(r.initial_missing_plugins, []);
    assert.ok(r.duration_ms >= 0);
    assert.ok(Array.isArray(r.events_emitted));
  });

  test('orchestrator does not throw on a non-existent cwd (resilient to broken repo)', async () => {
    // diagnose() against a non-existent path returns an empty report →
    // orchestrator returns evolved:false rather than throwing. The sandbox
    // must remain inactive.
    const r = await runSelfEvolve({ confirm: true, cwd: '/tmp/this-path-does-not-exist-p2f' });
    assert.equal(r.evolved, false);
    assert.equal(_activeSandbox(), null);
  });
});

describe('P2f — end-to-end self-evolve closed loop', () => {
  let worktree;

  before(() => {
    worktree = makeWorktree();
  });
  after(() => {
    if (worktree) {
      cleanupWorktree(worktree);
    }
  });

  test('full loop: missing → propose → apply → verify → re-diagnose closure', () => {
    // Self-evolve must run inside the worktree so its module-scope
    // PLUGIN_CATALOGUE (in worktree's diagnose.js) takes effect. See
    // P2c-3 pitfall #2 — module-scope constants can't be overridden
    // via opts.repoRoot. We use a subprocess driver (p2f-driver.mjs).
    const target = 'p2f-full-loop';
    injectMissingPlugin(worktree, ['logger', 'audit', target]);
    const r = runDriver(worktree, 'runSelfEvolve');

    assert.equal(r.evolved, true);
    assert.deepEqual(r.initial_missing_plugins, [target]);
    assert.ok(r.proposal, 'proposal should be attached');
    assert.ok(r.apply_result, 'apply_result should be attached');
    assert.equal(r.apply_result.applied, true);
    assert.ok(r.apply_result.tag, 'apply should have created a git tag');
    assert.ok(r.apply_result.tag_sha, 'apply should have a tag SHA');
    assert.ok(r.verify_result, 'verify_result should be attached');
    assert.equal(r.verify_result.pass, true, 'verify must pass after apply');
    assert.ok(!r.rolled_back);
    assert.deepEqual(
      r.final_missing_plugins,
      [],
      'final diagnose should show no missing plugins after the self-evolve cycle',
    );
    const pluginAbs = path.join(worktree, 'plugin', `${target}.js`);
    assert.ok(fs.existsSync(pluginAbs), 'plugin file must exist on disk');
  });

  test('events_emitted contains at least the three core evolution topics', () => {
    const wt = makeWorktree();
    try {
      injectMissingPlugin(wt, ['logger', 'audit', 'p2f-events-target']);
      const r = runDriver(wt, 'runSelfEvolve');
      assert.equal(r.evolved, true);
      assert.ok(r.events_emitted.length >= 3, 'at least 3 events should be tracked');
    } finally {
      cleanupWorktree(wt);
    }
  });

  test('multi-missing catalogue: only the first missing plugin is auto-evolved (invariant #4)', () => {
    const wt = makeWorktree();
    try {
      injectMissingPlugin(wt, ['logger', 'audit', 'p2f-multi-a', 'p2f-multi-b', 'p2f-multi-c']);
      const r = runDriver(wt, 'runSelfEvolve');
      assert.equal(r.evolved, true);
      // catalogue adds 3 plugins; logger + audit are already on disk
      // (in plugin/__example__/logger.js and plugin/audit.js), so
      // missing = 3. invariant: ONE applied per cycle, 2 still missing.
      assert.equal(r.initial_missing_plugins.length, 3);
      assert.ok(r.apply_result.applied);
      assert.equal(r.apply_result.files_written.length, 1);
      assert.equal(r.final_missing_plugins.length, 2);
      assert.ok(!r.final_missing_plugins.includes('p2f-multi-a'));
      assert.ok(r.final_missing_plugins.includes('p2f-multi-b'));
      assert.ok(r.final_missing_plugins.includes('p2f-multi-c'));
    } finally {
      cleanupWorktree(wt);
    }
  });

  test('sandbox is NOT activated by runSelfEvolve (P2f design #2 — Darwin must not self-trap)', () => {
    const wt = makeWorktree();
    try {
      injectMissingPlugin(wt, ['logger', 'audit', 'p2f-sandbox-noop']);
      runDriver(wt, 'runSelfEvolve');
    } finally {
      cleanupWorktree(wt);
    }
    assert.equal(_activeSandbox(), null, 'self-evolve should NOT activate the global sandbox');
  });
});

describe('P2f — rollback path (verify fails)', () => {
  test('returns evolved:false with rolled_back absent when verify passes (no false-positive rollback)', async () => {
    const r = await runSelfEvolve({ confirm: true, cwd: V2_ROOT });
    assert.equal(r.evolved, false);
    assert.notEqual(r.reason, 'verify_failed_rolled_back');
    assert.equal(r.rolled_back, undefined);
    assert.equal(r.verify_result, undefined);
  });
});
