/**
 * tests/bin/chat-stream.test.js -- V31: `darwin chat --stream` output.
 *
 * Verifies the line protocol that web/server.js translates to SSE:
 *   "chunk:<text>"  -> data frame { type: "chunk", text }
 *   "done:"         -> data frame { type: "done" }
 *   "error:<msg>"   -> data frame { type: "error", error }
 *
 * v2 hygiene: no real api_key. Test env has no provider configured,
 * so we exercise the error path (line: "error:No provider configured...").
 * The full streaming chunk path needs a real provider and is covered
 * by provider tests (anthropic.test.js / openai-compatible.test.js)
 * + a V31.1 e2e that wires a mock provider.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DARWIN_BIN = join(REPO_ROOT, 'bin', 'darwin');

function run(args, opts = {}) {
  return spawnSync('node', [DARWIN_BIN, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

describe('darwin chat --stream (V31)', () => {
  test('hygiene: no real api_key in chat.js (Darwin A-4)', () => {
    const src = readFileSync(join(REPO_ROOT, 'bin', 'lib', 'chat.js'), 'utf8');
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src), 'bin/lib/chat.js must not contain real sk-... key');
  });

  test('darwin chat --help mentions --stream and the line protocol', () => {
    const r = run(['chat', '--help']);
    assert.equal(r.status, 0, 'stderr: ' + r.stderr);
    assert.ok(r.stdout.includes('--stream'), 'should mention --stream flag');
    assert.ok(r.stdout.includes('chunk:'), 'should document chunk: prefix');
    assert.ok(r.stdout.includes('done:'), 'should document done: prefix');
    assert.ok(r.stdout.includes('error:'), 'should document error: prefix');
  });

  test('darwin chat --stream with no provider writes error: line and exits 2', () => {
    // Test env has no provider configured; chat --stream must
    // emit "error:No provider configured..." and exit 2.
    const r = run(['chat', '--stream', 'hello']);
    assert.equal(r.status, 2, 'expected exit 2, got ' + r.status);
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    const errorLine = lines.find((l) => l.startsWith('error:'));
    assert.ok(errorLine, 'expected an error: line, got stdout:\n' + r.stdout);
    assert.ok(
      errorLine.toLowerCase().includes('provider'),
      'error: line should mention provider, was: ' + errorLine,
    );
  });

  test('darwin chat --stream with no message exits 1 with usage error', () => {
    const r = run(['chat', '--stream']);
    assert.equal(r.status, 1, 'expected exit 1, got ' + r.status);
    assert.ok(
      r.stderr.includes('missing message'),
      'stderr should mention "missing message", was: ' + r.stderr,
    );
  });

  test('darwin chat (no --stream) without message exits 1 with usage error (V23 compat)', () => {
    const r = run(['chat']);
    assert.equal(r.status, 1, 'expected exit 1, got ' + r.status);
    assert.ok(
      r.stderr.includes('missing message'),
      'stderr should mention "missing message", was: ' + r.stderr,
    );
  });

  test('darwin chat --stream with --no-stream reverts to V23 default mode', () => {
    // --no-stream must override any earlier --stream (defensive).
    // Still no provider, so we expect the V23-style warning on stdout
    // and exit 2.
    const r = run(['chat', '--stream', '--no-stream', 'hello']);
    assert.equal(r.status, 2, 'expected exit 2, got ' + r.status);
    // The V23 default writes a unicode-warning line, not "error:".
    assert.ok(
      !r.stdout.startsWith('error:'),
      'default mode should not write error: prefix, got: ' + r.stdout,
    );
  });
});
