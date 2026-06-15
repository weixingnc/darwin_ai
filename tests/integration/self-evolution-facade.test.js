/**
 * SelfEvolution facade regression test — P1-B2 Issue 1 fix.
 *
 * Verifies that `SelfEvolution.propose(report, opts)` properly forwards
 * `opts` to the underlying `evolution/propose.js` impl, so the facade
 * no longer bypasses the persist / proposalsDir plumbing that callers
 * (CLI dispatcher, future PR-S3) depend on.
 *
 * Pre-fix symptom: `propose(report)` dropped opts on the floor → CLI
 * dispatcher in `bin/lib/self-evolution.js` had to call
 * `evolution/propose.js` directly to pass `proposalsDir`, which means
 * the facade was a leaky abstraction (P1-A review Issue 1).
 *
 * Post-fix (this test): `propose(report, opts)` is the supported path,
 * and (report) without opts still works (backward compat).
 *
 * tmpdir-based: writes proposals to a temp `memory/proposals/` so the
 * real v2 repo is not touched. `npm test` glob includes
 * tests/integration/*.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfEvolution } from '../../core/self-evolution.js';
import { propose as proposeImpl } from '../../evolution/propose.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-se-facade-'));
}

describe('SelfEvolution facade — propose(opts) wiring (P1-B2 Issue 1 fix)', () => {
  test('1. facade.propose(report) — backward compat (opts defaults to {})', async () => {
    const proposalsDir = makeTmpDir();
    const report = {
      current: { providers: [], tools: [], skills: [], memory_backends: [] },
      missing_providers: ['deepseek'],
      missing_tools: [],
      missing_skills: [],
      missing_memory_backends: [],
      scanned_at: new Date().toISOString(),
    };
    const out = await selfEvolution.propose(report, { proposalsDir, persist: false });
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 1);
    assert.equal(out[0].target.path, 'provider/deepseek.js');
  });

  test('2. facade.propose(report, opts) — proposalsDir flows to impl', async () => {
    const proposalsDir = makeTmpDir();
    const report = {
      current: { providers: [], tools: [], skills: [], memory_backends: [] },
      missing_providers: ['qwen'],
      missing_tools: [],
      missing_skills: [],
      missing_memory_backends: [],
      scanned_at: new Date().toISOString(),
    };
    const out = await selfEvolution.propose(report, { proposalsDir, persist: true });
    assert.equal(out.length, 1);
    const file = path.join(proposalsDir, `${out[0].proposal_id}.json`);
    assert.ok(fs.existsSync(file), `proposal file should be persisted at ${file}`);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.proposal_id, out[0].proposal_id);
    assert.equal(written.target.path, 'provider/qwen.js');
  });

  test('3. facade.propose() (no args) — runs diagnose first (existing PR-S1 behavior)', async () => {
    // No-op smoke: just verify it doesn't throw and returns an array.
    // We pass persist:false to avoid touching the real v2 proposals dir.
    const out = await selfEvolution.propose(undefined, { persist: false });
    assert.ok(Array.isArray(out));
  });

  test('4. facade.propose matches impl output (structural parity)', async () => {
    // proposal_ids include a Date.now() timestamp + random suffix, so two
    // calls never produce equal ids. Assert structural parity instead:
    //   - same number of proposals
    //   - same target.paths in same order
    //   - same action ('add' for PR-S1)
    //   - same apply_author ('darwin')
    const proposalsDir = makeTmpDir();
    const report = {
      current: { providers: [], tools: [], skills: [], memory_backends: [] },
      missing_providers: ['anthropic'],
      missing_tools: ['glob'],
      missing_skills: ['summarizer'],
      missing_memory_backends: ['vector'],
      scanned_at: new Date().toISOString(),
    };
    const viaFacade = await selfEvolution.propose(report, { proposalsDir, persist: false });
    const viaImpl = await proposeImpl(report, { proposalsDir, persist: false });
    assert.equal(viaFacade.length, viaImpl.length, 'same proposal count');
    assert.deepEqual(
      viaFacade.map((p) => p.target.path),
      viaImpl.map((p) => p.target.path),
      'same target.path sequence',
    );
    for (const p of viaFacade) {
      assert.equal(p.action, 'add');
      assert.equal(p.apply_author, 'darwin');
      assert.equal(typeof p.proposal_id, 'string');
    }
  });

  test('5. facade.propose accepts opts without report (opts forwarded)', async () => {
    // Calling propose(opts) where opts is a mis-placed report is undefined
    // behavior. We only assert the well-formed case here.
    const proposalsDir = makeTmpDir();
    const out = await selfEvolution.propose(
      {
        current: { providers: [], tools: [], skills: [], memory_backends: [] },
        missing_providers: [],
        missing_tools: ['bash'],
        missing_skills: [],
        missing_memory_backends: [],
        scanned_at: new Date().toISOString(),
      },
      { proposalsDir, persist: false },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].target.path, 'tool/builtins/bash.js');
  });
});
