/**
 * W3-2 (2026-06-18) — Darwin self-evolve CLI end-to-end.
 *
 * Closes the P3a loop: `./bin/darwin self-evolution evolve --confirm`
 * against a tmpdir worktree actually grows a missing plugin on disk
 * and passes the post-apply verify gate. This is the "user-facing
 * self-evolution" smoke test — the proof that PM can type one
 * command and Darwin handles diagnose → propose → apply → verify
 * end-to-end.
 *
 * Pattern: borrow the P2f worktree harness (mkdtempSync + git
 * worktree add) but invoke the CLI as a child process instead of
 * the p2f-driver.mjs library wrapper. This proves the P3a CLI
 * surface (flags, --confirm gate, --cwd forwarding) actually
 * works, not just the underlying runSelfEvolve() function.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-2-cli-'));
  execFileSync('git', ['worktree', 'add', '--detach', root, 'HEAD'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.email', 'w3-2@local'], {
    cwd: root,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'w3-2-test'], {
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
    ['commit', '-m', 'test: inject missing plugin (w3-2)', '--no-verify'],
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

describe('W3-2: self-evolution evolve CLI end-to-end', () => {
  let worktree;

  before(() => {
    worktree = makeWorktree();
  });

  after(() => {
    if (worktree) {
      cleanupWorktree(worktree);
    }
  });

  test('without --confirm: CLI refuses (opt-in safety)', () => {
    const result = runCli(worktree, ['self-evolution', 'evolve']);
    assert.notEqual(result.code, 0, 'CLI should exit non-zero without --confirm');
    assert.ok(
      result.stderr.includes('--confirm is required') ||
        result.stdout.includes('--confirm is required'),
      'should explain why it refused',
    );
  });

  test('with --confirm but no missing plugins: evolved:false / no_missing_plugins', () => {
    // The worktree was made from a clean main with no catalogue overlay,
    // so all catalogues are closure — no evolution needed.
    const result = runCli(worktree, ['self-evolution', 'evolve', '--confirm']);
    assert.equal(result.code, 0, 'CLI should exit 0 when nothing to evolve');
    const json = JSON.parse(result.stdout);
    assert.equal(json.evolved, false);
    assert.equal(json.reason, 'no_missing_plugins');
  });

  test('with --confirm + injected missing plugin: evolves and creates plugin file', () => {
    // Inject a missing plugin and commit (so the worktree's catalogue
    // overlay has the missing item; diagnose picks it up).
    const target = 'w3-2-demo-plugin';
    injectMissingPlugin(worktree, ['logger', 'audit', target]);

    const result = runCli(worktree, ['self-evolution', 'evolve', '--confirm']);
    assert.equal(result.code, 0, `CLI exit 0; stderr: ${result.stderr}`);
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
    assert.ok(fs.existsSync(pluginPath), 'plugin file created on disk');
  });
});
