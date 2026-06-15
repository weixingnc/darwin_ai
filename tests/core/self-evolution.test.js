/**
 * SelfEvolution 7-API contract tests — PR-S1 (deep-path copy).
 *
 * Mirrors tests/self-evolution.test.js but lives under tests/core/ to match
 * the src layout (core/self-evolution.js). The shallow file is kept for
 * backwards-compat with the legacy `npm test` glob; both files are
 * functionally equivalent — see the package.json `test` script for the
 * updated glob that picks up tests/core/ and tests/evolution/.
 *
 * node:test + node:assert/strict (matches tests/core/ style).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfEvolution, _internal } from '../../core/self-evolution.js';

const { defaultBoundary, defaultApprover, defaultTagger } = _internal;

// ── 7-API surface contract ─────────────────────────────────────────────

test('SelfEvolution: diagnose() returns a report with 4 missing_* arrays', async () => {
  const se = new SelfEvolution();
  const r = await se.diagnose();
  assert.ok(r.current);
  assert.ok(Array.isArray(r.missing_providers));
  assert.ok(Array.isArray(r.missing_tools));
  assert.ok(Array.isArray(r.missing_skills));
  assert.ok(Array.isArray(r.missing_memory_backends));
  assert.equal(typeof r.scanned_at, 'string');
});

test('SelfEvolution: propose() returns an array; each proposal is well-shaped', async () => {
  const se = new SelfEvolution();
  const proposals = await se.propose();
  assert.ok(Array.isArray(proposals));
  for (const p of proposals) {
    assert.equal(typeof p.proposal_id, 'string');
    assert.equal(p.action, 'add');
    assert.ok(p.target && typeof p.target.path === 'string');
    assert.ok(Array.isArray(p.files_added) && p.files_added.length > 0);
    assert.equal(p.apply_author, 'darwin');
    assert.equal(typeof p.created_at, 'string');
  }
});

test('SelfEvolution: apply/verify/rollback/learn delegate to PR-S2 real impls', async () => {
  // PR-S2: these no longer throw NotImplementedError. They delegate to
  // evolution/{apply,verify,rollback,learn}.js. We assert delegation by
  // checking that learn touches the file system under a tmpdir, and that
  // apply/verify/rollback remain callable (full e2e is in
  // tests/integration/self-evolution-e2e.test.js).
  const se = new SelfEvolution();
  await assert.rejects(() => se.learn(''), TypeError);
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prs2-deep-learn-'));
  const r = await se.learn('deep insight', { learnDir });
  assert.equal(typeof r.rules_path, 'string');
  assert.match(r.rules_path, /evolution-rules\.md$/);
  assert.ok(r.rules_count >= 1);
  fs.rmSync(learnDir, { recursive: true, force: true });
  assert.equal(typeof se.apply, 'function');
  assert.equal(typeof se.verify, 'function');
  assert.equal(typeof se.rollback, 'function');
});

test('SelfEvolution: audit() writes a JSON file under memory/audit/<date>/', async () => {
  // PR-S2: audit() destination moved from tmp/audit/ -> memory/audit/YYYY-MM-DD/.
  // We pass baseDir to a tmpdir so this test doesn't pollute the repo.
  const se = new SelfEvolution();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prs2-deep-audit-'));
  const res = await se.audit('apply', {
    proposal_id: 'deep-self-evo-1',
    note: 'deep-path',
    apply_author: 'darwin',
    outcome: 'success',
    files_changed: [{ path: 'a.js', diff_type: '+', lines: 1 }],
    duration_ms: 10,
    session_key: 'agent:test',
    tag_sha: 'abc1234',
    baseDir,
  });
  assert.equal(res.ok, undefined, 'PR-S2 audit returns { audit_log_path, entry }');
  assert.match(res.audit_log_path, /deep-self-evo-1\.json$/);
  assert.equal(res.entry.action, 'apply');
  assert.equal(res.entry.schema_version, 2);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('SelfEvolution: audit() rejects empty action', async () => {
  const se = new SelfEvolution();
  await assert.rejects(() => se.audit('', { x: 1 }), TypeError);
});

// ── DI helper contracts (PR-S2 wiring) ─────────────────────────────────

test('boundary.classify: blacklist hits core/ + lifecycle/ + ANTI_PATTERNS', () => {
  const b = defaultBoundary();
  const blacklist = [
    'core/event-bus.js',
    'core/config-resolver.js',
    'core/self-evolution.js',
    'lifecycle/bootstrap.js',
    'docs/ANTI_PATTERNS.md',
    'package.json',
    '.eslintrc.json',
  ];
  for (const p of blacklist) {
    const r = b.classify(p);
    assert.equal(r.status, 'blacklisted', p);
    assert.equal(r.tier, 'red', p);
  }
});

test('boundary.classify: whitelist hits provider/tool/skill/memory/docs/tests', () => {
  const b = defaultBoundary();
  const whitelist = [
    'provider/deepseek.js',
    'tool/builtins/glob.js',
    'skill/examples/summarizer.js',
    'memory/backends/vector.js',
    'docs/USAGE.md',
    'tests/foo.test.js',
  ];
  for (const p of whitelist) {
    const r = b.classify(p);
    assert.equal(r.status, 'whitelisted', p);
    assert.equal(r.tier, 'green', p);
  }
});

test('boundary.boundaryCheck: wraps classify across a list', () => {
  const b = defaultBoundary();
  const out = b.boundaryCheck(['provider/x.js', 'core/event-bus.js', 'random/file.js']);
  assert.deepEqual(
    out.map((x) => x.status),
    ['whitelisted', 'blacklisted', 'unknown'],
  );
});

test('approver.classify: provider→red, tool→yellow, skill/memory→green', () => {
  const a = defaultApprover();
  const cases = [
    ['provider/x.js', 'red'],
    ['tool/builtins/glob.js', 'yellow'],
    ['skill/examples/foo.js', 'green'],
    ['memory/backends/vector.js', 'green'],
  ];
  for (const [p, tier] of cases) {
    const r = a.classify({ target: { path: p }, files_added: [{ path: p }] });
    assert.equal(r.tier, tier, p);
  }
});

test('approver.classify: blacklist hit → red regardless of target', () => {
  const a = defaultApprover();
  const r = a.classify({
    target: { path: 'skill/examples/x.js' },
    files_added: [{ path: 'core/event-bus.js' }],
  });
  assert.equal(r.tier, 'red');
  assert.match(r.reason, /blacklisted/);
});

test('tagger.tagProposal: returns deterministic name, does NOT call git', () => {
  const t = defaultTagger();
  const r = t.tagProposal('prop-prov-deepseek-abc-123');
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'PR_S1_STUB');
  assert.match(r.tag, /^evolution-pre-prop-prov-deepseek-abc-123-\d+$/);
});

test('tagger.tagProposal: rejects empty proposalId', () => {
  const t = defaultTagger();
  assert.throws(() => t.tagProposal(''), TypeError);
});
