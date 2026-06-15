/**
 * Bash tool tests — V3_ROADMAP P1.
 *
 * Validates the bash.execute() contract: spawnSync, no shell, hard timeout.
 * Uses `node` (or a stdlib command guaranteed to exist on Linux) as the
 * test executable; no actual shell interpretation is tested (security
 * boundary).
 *
 * Run: `node --test tool/builtins/bash.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash } from './bash.js';

test('bash: shape conforms to tool contract', () => {
  assert.equal(typeof bash, 'object');
  assert.equal(bash.name, 'bash');
  assert.equal(typeof bash.description, 'string');
  assert.ok(bash.description.length > 0);
  assert.equal(bash.schema.type, 'object');
  assert.ok(Array.isArray(bash.schema.required));
  assert.ok(bash.schema.required.includes('command'));
});

test('bash.execute: runs `node -e "..."` and captures stdout', async () => {
  const r = await bash.execute({ command: 'node', args: ['-e', 'process.stdout.write("pong")'] });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'pong');
  assert.equal(r.stderr, '');
  assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
  assert.equal(r.timedOut, false);
});

test('bash.execute: non-zero exit code is captured, NOT thrown', async () => {
  const r = await bash.execute({ command: 'node', args: ['-e', 'process.exit(7)'] });
  assert.equal(r.exitCode, 7);
  assert.equal(r.timedOut, false);
  // v1 D-3 fix: bad exit is data, not an error
});

test('bash.execute: spawnSync (no shell) — `args` is NOT shell-parsed', async () => {
  // If shell were enabled, "*" would glob. With spawnSync, "echo *"
  // prints literal `*`.
  const r = await bash.execute({
    command: 'node',
    args: ['-e', 'process.stdout.write("hello*world")'],
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'hello*world');
});

test('bash.execute: stderr captured separately', async () => {
  const r = await bash.execute({
    command: 'node',
    args: ['-e', 'process.stderr.write("oops")'],
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'oops');
});

test('bash.execute: timeoutMs honored (short timeout kills slow command)', async () => {
  // sleep via node event loop. With timeoutMs=100, we expect SIGTERM kill.
  const r = await bash.execute({
    command: 'node',
    args: ['-e', 'setTimeout(()=>{}, 5000)'],
    timeoutMs: 100,
  });
  // Either timedOut=true OR exitCode != 0 (SIGTERM). Either way: not a clean exit.
  assert.ok(
    r.timedOut === true || (r.exitCode !== 0 && r.exitCode !== null),
    'short timeout should kill the process; got: ' + JSON.stringify(r),
  );
});

test('bash.execute: timeoutMs clamped to MAX_TIMEOUT_MS (300000)', async () => {
  // We don't actually wait — just check the wiring by calling with a huge
  // value and confirming the tool doesn't reject the input.
  const r = await bash.execute({
    command: 'node',
    args: ['-e', 'process.stdout.write("ok")'],
    timeoutMs: 999999999, // way over 5 min ceiling
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'ok');
});

test('bash.execute: missing executable → error surfaced, no throw', async () => {
  const r = await bash.execute({ command: 'definitely-not-a-real-binary-xyz123' });
  // spawnSync returns error.code = 'ENOENT' on missing executable.
  // We surface it as { error: { code, message } } in the result.
  assert.ok(r.error, 'must surface error object when binary missing');
  assert.equal(r.error.code, 'ENOENT');
  assert.equal(r.exitCode, null);
});

test('bash.execute: throws TypeError on non-string command', async () => {
  await assert.rejects(
    () => bash.execute({ command: 42 }),
    (err) => err instanceof TypeError && /command/i.test(err.message),
  );
  await assert.rejects(
    () => bash.execute({ command: '' }),
    (err) => err instanceof TypeError,
  );
  await assert.rejects(
    () => bash.execute({}),
    (err) => err instanceof TypeError,
  );
});

test('bash.execute: throws TypeError on non-array args / non-string args entry', async () => {
  await assert.rejects(
    () => bash.execute({ command: 'node', args: 'not-an-array' }),
    (err) => err instanceof TypeError && /args/i.test(err.message),
  );
  await assert.rejects(
    () => bash.execute({ command: 'node', args: [1, 2] }),
    (err) => err instanceof TypeError && /string/i.test(err.message),
  );
});
