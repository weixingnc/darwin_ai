/**
 * W4-2 (2026-06-18) — Darwin grows its 4th plugin (rate-limiter)
 * end-to-end via CLI.
 *
 * W3-2 already proved the CLI surface works for any missing plugin
 * (used 'w3-2-demo-plugin' as the target). W4-2 is the canonical
 * test: it uses Darwin's PM-curated growth target ('rate-limiter',
 * the next item in GROWTH_CANDIDATES.plugins) to prove the full
 * closed loop works on a "real" growth candidate, not a synthetic
 * test fixture.
 *
 * The injected plugin doesn't need to be a real implementation —
 * propose.js generates a manifest stub from PLUGIN_CONTENT_TEMPLATE
 * (P2c-1). What matters is: the CLI takes a missing plugin from
 * the catalogue overlay, runs the closed loop, writes the stub
 * to disk, and the build still passes (because the stub throws
 * "not implemented" in lifecycle methods but doesn't run them
 * at load time).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'bin', 'darwin');

function makeWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w4-2-cli-'));
  execFileSync('git', ['worktree', 'add', '--detach', root, 'HEAD'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.email', 'w4-2@local'], {
    cwd: root,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'w4-2-test'], {
    cwd: root,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: root,
    stdio: 'pipe',
  });
  execFileSync('chmod', ['+x', path.join(root, 'bin', 'darwin')], {
    cwd: root,
    stdio: 'pipe',
  });
  return root;
}

function cleanupWorktree(root) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', root], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  } catch {
    /* best-effort */
  }
  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Inject a missing plugin into the worktree's catalogue overlay. */
function injectMissingPlugin(worktree, newPlugins) {
  const filePath = path.join(worktree, 'evolution', 'catalogue.json');
  let overlay = {};
  if (fs.existsSync(filePath)) {
    overlay = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  overlay.plugins = Array.from(new Set([...(overlay.plugins || []), ...newPlugins]));
  fs.writeFileSync(filePath, JSON.stringify(overlay, null, 2));
  execFileSync('git', ['add', 'evolution/catalogue.json'], {
    cwd: worktree,
    stdio: 'pipe',
  });
  execFileSync(
    'git',
    ['commit', '-m', 'test: inject rate-limiter (w4-2)', '--no-verify'],
    { cwd: worktree, stdio: 'pipe' },
  );
}

/** Run the CLI as a child process and return {stdout, stderr, code}. */
function runCli(worktree, args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args, '--cwd', worktree], {
      cwd: worktree,
      stdio: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    }).toString('utf8');
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString('utf8') : '',
      stderr: err.stderr ? err.stderr.toString('utf8') : '',
      code: err.status ?? 1,
    };
  }
}

describe('W4-2: Darwin grows its 4th plugin (rate-limiter) via CLI', () => {
  let worktree;

  before(() => {
    worktree = makeWorktree();
  });

  after(() => {
    if (worktree) {
      cleanupWorktree(worktree);
    }
  });

  test('rate-limiter is in GROWTH_CANDIDATES (PM-curated next growth target)', async () => {
    // W4-1 (2026-06-18): 'metrics' moved to DEFAULTS (shipped). Growth
    // candidates are now ['rate-limiter']. This test guards the
    // candidate list from accidental edits that would break the
    // "Darwin decides what to install next" contract (P2g §4).
    const catalogueModule = await import('../../evolution/catalogue.js');
    const candidates = catalogueModule._internal.GROWTH_CANDIDATES.plugins;
    assert.ok(
      Array.isArray(candidates),
      'GROWTH_CANDIDATES.plugins is an array',
    );
    assert.ok(
      candidates.includes('rate-limiter'),
      'rate-limiter is the next growth candidate',
    );
  });

  test('W5-1: rate-limiter is shipped, Darwin no longer evolves it', () => {
    // W4-2 (before W5-1) proved the closed loop on 'rate-limiter' as a
    // missing plugin. W5-1 (this cycle) shipped the real implementation
    // of plugin/rate-limiter.js, so the catalogue is now closure for
    // rate-limiter — running evolve --confirm should return
    // evolved:false / reason:no_missing_plugins, NOT try to grow it
    // again. The injectMissingPlugin call below is a no-op because the
    // target is already present in the worktree's plugin/ directory.
    const target = 'rate-limiter';
    injectMissingPlugin(worktree, ['logger', 'audit', 'metrics', target]);

    const result = runCli(worktree, ['self-evolution', 'evolve', '--confirm']);
    assert.equal(result.code, 0, `CLI exit 0; stderr: ${result.stderr.slice(0, 500)}`);
    const json = JSON.parse(result.stdout);
    // The worktree (from HEAD = 5648477, which includes W5-1's
    // plugin/rate-limiter.js) sees a closed catalogue. Darwin does
    // not re-grow rate-limiter.
    assert.equal(json.evolved, false, `expected evolved:false, got ${JSON.stringify(json)}`);
    assert.equal(json.reason, 'no_missing_plugins');
    assert.deepEqual(json.initial_missing_plugins, []);
    // Sanity: the real plugin file is on disk.
    const pluginPath = path.join(worktree, 'plugin', `${target}.js`);
    assert.ok(fs.existsSync(pluginPath), 'rate-limiter plugin file exists');
  });

  test('W5-1 (regression): Darwin still grows a fresh missing plugin', () => {
    // W4-2 was originally a 'rate-limiter' e2e. The closed-loop
    // contract — "Darwin grows any missing plugin and verify passes" —
    // is what we want to keep guarded. Use a synthetic fixture name
    // (the worktree's catalogue.json overlay includes it; the worktree
    // has no file with that name, so it counts as missing).
    const target = 'w5-1-fresh-demo';
    injectMissingPlugin(worktree, ['logger', 'audit', 'metrics', target]);

    const result = runCli(worktree, ['self-evolution', 'evolve', '--confirm']);
    assert.equal(result.code, 0, `CLI exit 0; stderr: ${result.stderr.slice(0, 500)}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.evolved, true, `expected evolved:true, got ${JSON.stringify(json)}`);
    assert.deepEqual(json.initial_missing_plugins, [target]);
    assert.ok(json.proposal, 'proposal attached');
    assert.ok(json.apply_result, 'apply_result attached');
    assert.equal(json.apply_result.applied, true);
    assert.ok(json.verify_result, 'verify_result attached');
    assert.equal(json.verify_result.pass, true, 'verify must pass');
    assert.deepEqual(json.final_missing_plugins, [], 'catalogue closure');

    const pluginPath = path.join(worktree, 'plugin', `${target}.js`);
    assert.ok(fs.existsSync(pluginPath), 'fresh plugin file created on disk');
    const stub = fs.readFileSync(pluginPath, 'utf8');
    assert.ok(
      stub.includes('not implemented'),
      'fresh stub has "not implemented" placeholder methods (P2c-1 contract)',
    );
  });
});
