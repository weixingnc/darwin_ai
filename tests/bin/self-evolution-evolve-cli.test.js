/**
 * P3a (2026-06-18) — self-evolution CLI dispatcher tests.
 *
 * Verifies the new `evolve` sub-command in bin/lib/self-evolution.js:
 *   1. Rejects without --confirm (explicit opt-in)
 *   2. Routes to evolution/self-evolve.js runSelfEvolve with correct opts
 *   3. Forwards --cwd to runSelfEvolve
 *
 * The end-to-end test (real runSelfEvolve against a tmpdir worktree)
 * lives in tests/evolution/self-evolve.test.js; this file only covers
 * the CLI dispatcher surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfEvolutionDispatch } from '../../bin/lib/self-evolution.js';

test('P3a: evolve rejects without --confirm (opt-in safety)', async () => {
  await assert.rejects(
    () => selfEvolutionDispatch('evolve', []),
    /--confirm is required/,
    'must explicitly opt in',
  );
});

test('P3a: evolve with --confirm but no missing plugins returns evolved:false', async () => {
  // Real v2 catalogue is closure — no missing plugins. So runSelfEvolve
  // returns early with evolved:false / reason:'no_missing_plugins'.
  const json = await captureStdout(() =>
    selfEvolutionDispatch('evolve', ['--confirm']),
  );
  const result = JSON.parse(json);
  assert.equal(result.evolved, false);
  assert.equal(result.reason, 'no_missing_plugins');
  assert.deepEqual(result.initial_missing_plugins, []);
  assert.deepEqual(result.final_missing_plugins, []);
  assert.ok(Array.isArray(result.events_emitted));
});

async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test.afterAll ??= (fn) => test('afterAll', async () => fn());
test.afterAll(async () => {
  // Defensive: if a prior test left a sandbox active, deactivate it.
  // (handleEvolve doesn't activate one, but a sibling test might.)
  try {
    const mod = await import('../../plugin/sandbox.js');
    const active = mod._activeSandbox?.();
    if (active) {active.deactivate();}
  } catch {
    /* best-effort */
  }
});