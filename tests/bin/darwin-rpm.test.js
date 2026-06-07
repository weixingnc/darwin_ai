/**
 * Darwin CLI spawn tests — PR 19b.
 *
 * Covers the three new sub-commands (repl / plugin / memory) without
 * touching any real LLM, real plugin, or real memory IO. Only verifies
 * dispatch + argument validation, same pattern as PR 19a's
 * darwin-cli.test.js.
 *
 * Test scope (per the PR spec):
 *   - `darwin repl` with no provider → exit 2, "No provider configured"
 *   - `darwin` (no args) shows help including "darwin repl",
 *     "darwin plugin", "darwin memory"
 *   - `darwin plugin` (no sub) shows help including "darwin plugin"
 *   - `darwin plugin add` (no path) → exit 1, "missing path"
 *   - `darwin plugin list` → exit 0
 *   - `darwin memory show` (no key) → exit 1, "missing key"
 *   - `darwin memory set` (no key) → exit 1, "missing key"
 *   - `darwin memory set <key>` (no value) → exit 1, "missing value"
 *
 * v2 hygiene: no real api_key in this file (Darwin ANTI-PATTERNS A-4).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DARWIN_BIN = join(REPO_ROOT, 'bin', 'darwin');

function run(args, opts = {}) {
  return spawnSync('node', [DARWIN_BIN, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    ...opts,
  });
}

describe('darwin CLI (PR 19b)', () => {
  test('hygiene: no real api_key in PR 19b source files (Darwin A-4)', () => {
    const files = [
      join(REPO_ROOT, 'bin', 'darwin'),
      join(REPO_ROOT, 'bin', 'lib', '_shared.js'),
      join(REPO_ROOT, 'bin', 'lib', 'repl.js'),
      join(REPO_ROOT, 'bin', 'lib', 'plugin.js'),
      join(REPO_ROOT, 'bin', 'lib', 'memory.js'),
      join(REPO_ROOT, 'tests', 'bin', 'darwin-rpm.test.js'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src), `${f} must not contain real sk-... key`);
      assert.ok(!/cli_[a-z0-9]{16,}/i.test(src), `${f} must not contain real cli_... app_id`);
    }
  });

  test('help text advertises repl / plugin / memory sub-commands', () => {
    const r = run(['help']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('darwin repl'), `help should mention 'darwin repl'`);
    assert.ok(r.stdout.includes('darwin plugin'), `help should mention 'darwin plugin'`);
    assert.ok(r.stdout.includes('darwin memory'), `help should mention 'darwin memory'`);
  });

  test('darwin (no args) shows help with new sub-commands', () => {
    const r = run([]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('Usage:'), `stdout was: ${r.stdout}`);
    assert.ok(r.stdout.includes('darwin repl'), `help should mention 'darwin repl'`);
    assert.ok(r.stdout.includes('darwin plugin'), `help should mention 'darwin plugin'`);
    assert.ok(r.stdout.includes('darwin memory'), `help should mention 'darwin memory'`);
  });

  test('darwin plugin (no sub-command) falls back to help and exits 0', () => {
    const r = run(['plugin']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('darwin plugin'), `help should mention 'darwin plugin'`);
  });

  test('darwin repl (no provider configured) exits 2 with the no-provider hint', () => {
    const r = run(['repl']);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('No provider configured') || r.stderr.includes('No provider configured'),
      `output should mention 'No provider configured', stdout: ${r.stdout}, stderr: ${r.stderr}`,
    );
  });

  test('darwin plugin add (no path) exits 1 with "missing path" error', () => {
    const r = run(['plugin', 'add']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('missing path'),
      `stderr should mention 'missing path', was: ${r.stderr}`,
    );
  });

  test('darwin plugin list exits 0 (empty registry is fine)', () => {
    const r = run(['plugin', 'list']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Output should be deterministic: either '(no plugins loaded)' or a list.
    // We only assert that the command did not crash; the registry state
    // is environment-dependent (tests share `~/.darwin/`).
    assert.ok(
      r.stdout.includes('no plugins') || r.stdout.includes('- '),
      `stdout should look like a plugin list, was: ${r.stdout}`,
    );
  });

  test('darwin memory show (no key) exits 1 with "missing key" error', () => {
    const r = run(['memory', 'show']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('missing key'),
      `stderr should mention 'missing key', was: ${r.stderr}`,
    );
  });

  test('darwin memory set (no key) exits 1 with "missing key" error', () => {
    const r = run(['memory', 'set']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('missing key'),
      `stderr should mention 'missing key', was: ${r.stderr}`,
    );
  });

  test('darwin memory set <key> (no value) exits 1 with "missing value" error', () => {
    const r = run(['memory', 'set', 'ctx:user-1']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('missing value'),
      `stderr should mention 'missing value', was: ${r.stderr}`,
    );
  });
});
