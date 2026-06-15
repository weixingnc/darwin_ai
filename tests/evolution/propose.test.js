/**
 * Propose unit tests — PR-S1 (deep-path copy).
 *
 * Mirrors tests/evolution-propose.test.js but lives under tests/evolution/
 * to match the src layout (evolution/propose.js). Exercises:
 *   - priority order (providers → memory → tools → skills)
 *   - proposal shape (proposal_id / action / target / files_added / etc.)
 *   - JSON persistence under memory/proposals/
 *   - `persist=false` skips writing files
 *   - `proposalsDir` injection
 *   - `buildProposal` / `TARGET_TEMPLATES` / `PRIORITY_ORDER` internals
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { propose, _internal } from '../../evolution/propose.js';

const { buildProposal, TARGET_TEMPLATES, PRIORITY_ORDER } = _internal;

function fakeReport() {
  return {
    current: { providers: [], tools: [], skills: [], memory_backends: [] },
    missing_providers: ['deepseek', 'qwen'],
    missing_tools: ['glob'],
    missing_skills: ['hello-world'],
    missing_memory_backends: ['vector'],
  };
}

test('propose: returns one proposal per missing capability', async () => {
  const r = fakeReport();
  const ps = await propose(r, { persist: false });
  assert.equal(ps.length, 5); // 2 providers + 1 tool + 1 skill + 1 memory
});

test('propose: priority order is providers → memory → tools → skills', async () => {
  const ps = await propose(fakeReport(), { persist: false });
  const order = ps.map((p) => p.target.type);
  assert.deepEqual(order, [
    'provider',
    'provider',
    'memory_backend',
    'builtin_tool',
    'skill_example',
  ]);
});

test('propose: each proposal has the ADR-008 schema shape', async () => {
  const ps = await propose(fakeReport(), { persist: false });
  for (const p of ps) {
    assert.equal(typeof p.proposal_id, 'string');
    assert.match(p.proposal_id, /^prop-[a-z]{3}-[a-z0-9-]+-[a-z0-9]+-[a-f0-9]+$/);
    assert.equal(p.action, 'add');
    assert.equal(p.apply_author, 'darwin');
    assert.ok(p.target && typeof p.target.path === 'string');
    assert.ok(Array.isArray(p.files_added) && p.files_added.length >= 1);
    assert.equal(p.files_added[0].path, p.target.path);
    assert.equal(typeof p.files_added[0].lines_estimated, 'number');
    assert.ok(
      p.expected_verify &&
        p.expected_verify.test &&
        p.expected_verify.lint &&
        p.expected_verify.size_check,
    );
    assert.equal(typeof p.created_at, 'string');
  }
});

test('propose: persists JSON files when persist=true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-deep-'));
  const ps = await propose(fakeReport(), { proposalsDir: dir, persist: true });
  assert.equal(ps.length, 5);
  const written = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(written.length, 5);
  const first = JSON.parse(fs.readFileSync(path.join(dir, written[0]), 'utf8'));
  assert.equal(first.action, 'add');
  assert.equal(first.apply_author, 'darwin');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('propose: persist=false returns proposals without writing files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-deep-nopersist-'));
  const ps = await propose(fakeReport(), { proposalsDir: dir, persist: false });
  assert.equal(ps.length, 5);
  assert.equal(fs.readdirSync(dir).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('propose: no report passed → runs diagnose first (no throw on real repo)', async () => {
  const ps = await propose(undefined, { persist: false });
  assert.ok(Array.isArray(ps));
  for (const p of ps) {
    assert.equal(p.apply_author, 'darwin');
  }
});

test('propose: empty missing_* arrays → empty proposal list', async () => {
  const empty = {
    current: { providers: [], tools: [], skills: [], memory_backends: [] },
    missing_providers: [],
    missing_tools: [],
    missing_skills: [],
    missing_memory_backends: [],
  };
  const ps = await propose(empty, { persist: false });
  assert.equal(ps.length, 0);
});

test('buildProposal: target.path matches category template', () => {
  const cases = [
    ['providers', 'deepseek', 'provider/deepseek.js'],
    ['memory_backends', 'vector', 'memory/backends/vector.js'],
    ['tools', 'glob', 'tool/builtins/glob.js'],
    ['skills', 'hello-world', 'skill/examples/hello-world.js'],
  ];
  for (const [cat, name, expected] of cases) {
    const p = buildProposal(cat, name);
    assert.equal(p.target.path, expected);
    assert.equal(
      p.target.type,
      cat === 'memory_backends'
        ? 'memory_backend'
        : cat === 'tools'
          ? 'builtin_tool'
          : cat === 'skills'
            ? 'skill_example'
            : 'provider',
    );
  }
});

test('TARGET_TEMPLATES + PRIORITY_ORDER internals are stable', () => {
  assert.deepEqual(PRIORITY_ORDER, ['providers', 'memory_backends', 'tools', 'skills']);
  for (const cat of Object.keys(TARGET_TEMPLATES)) {
    const t = TARGET_TEMPLATES[cat]('x');
    assert.equal(typeof t.path, 'string');
    assert.equal(typeof t.type, 'string');
    assert.match(t.rationale, /v3\+ P1 catalogue/);
  }
});
