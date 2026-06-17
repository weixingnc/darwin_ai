/**
 * Darwin CLI spawn tests — PR 19a.
 *
 * No real API calls (would cost money). Only verifies:
 *   - `darwin help` exits 0, stdout contains "Usage:"
 *   - `darwin` (no args) exits 0, stdout contains "Usage:"
 *   - `darwin chat` (no message) exits 1, stderr contains "missing message"
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

function run(args) {
  return spawnSync('node', [DARWIN_BIN, ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

describe('darwin CLI (PR 19a)', () => {
  test('hygiene: no real api_key in source files (Darwin A-4)', () => {
    const files = [
      join(REPO_ROOT, 'bin', 'darwin'),
      join(REPO_ROOT, 'bin', 'lib', 'chat.js'),
      join(REPO_ROOT, 'bin', 'lib', 'config.js'),
      join(REPO_ROOT, 'tests', 'bin', 'darwin-cli.test.js'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src), `${f} must not contain real sk-... key`);
      assert.ok(!/cli_[a-z0-9]{16,}/i.test(src), `${f} must not contain real cli_... app_id`);
    }
  });

  test('darwin help exits 0 and shows Usage', () => {
    const r = run(['help']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('Usage:'), `stdout was: ${r.stdout}`);
  });

  test('darwin (no args) shows help and exits 0', () => {
    const r = run([]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('Usage:'), `stdout was: ${r.stdout}`);
    assert.ok(r.stdout.includes('darwin chat'), `help should mention 'darwin chat'`);
    assert.ok(r.stdout.includes('darwin config'), `help should mention 'darwin config'`);
  });

  test('darwin chat (no message) exits 1 with "missing message" error', () => {
    const r = run(['chat']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('missing message'),
      `stderr should mention 'missing message', was: ${r.stderr}`,
    );
  });

  test('darwin config add (no module) exits 1 with "missing module" error', () => {
    const r = run(['config', 'add']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('missing module'),
      `stderr should mention 'missing module', was: ${r.stderr}`,
    );
  });

  test('darwin config add (unknown module) exits 1 with "unknown module" error', () => {
    const r = run(['config', 'add', 'not-a-real-module']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('unknown module'),
      `stderr should mention 'unknown module', was: ${r.stderr}`,
    );
  });

  test('darwin config show exits 0 and redacts secrets', () => {
    const r = run(['config', 'show']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Should not contain raw ${...} placeholders from .env
    assert.ok(r.stdout.includes('provider-anthropic'), `should list provider-anthropic section`);
    // If any provider is configured, api_key should be redacted
    // (no real keys ever appear in show output)
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(r.stdout), `must not leak real keys`);
  });

  test('darwin plugin add <example> prints plugin name, not [object Object] (P2a bug fix)', () => {
    const r = run(['plugin', 'add', './plugin/__example__/logger.js']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('→ logger'),
      `stdout should include '→ logger' (plugin name), was: ${r.stdout}`,
    );
    assert.ok(
      !r.stdout.includes('[object Object]'),
      `stdout must not include '[object Object]' (regression: loader returns ErrorHandler shape, not bare string)`,
    );
  });

  test('darwin plugin list exits 0 (no plugins loaded in fresh process)', () => {
    const r = run(['plugin', 'list']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Snapshot of empty registry is fine; CLI runs in fresh process per invocation
  });
});
