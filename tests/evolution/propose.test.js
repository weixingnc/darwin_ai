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
    current: {
      providers: [],
      tools: [],
      skills: [],
      memory_backends: [],
      platforms: [],
      plugins: [],
    },
    missing_providers: ['deepseek', 'qwen'],
    missing_tools: ['glob'],
    missing_skills: ['hello-world'],
    missing_memory_backends: ['vector'],
    missing_platforms: [],
    // P2c-1 (2026-06-18): include one missing plugin so the priority-order
    // test below asserts the new 'plugins' slot at the end of the chain.
    missing_plugins: ['audit'],
  };
}

test('propose: returns one proposal per missing capability', async () => {
  const r = fakeReport();
  const ps = await propose(r, { persist: false });
  // P2c-1 (2026-06-18): 2 providers + 1 memory + 1 tool + 1 skill + 0 platforms + 1 plugin
  assert.equal(ps.length, 6);
});

test('propose: priority order is providers → memory → tools → skills → platforms → plugins', async () => {
  const ps = await propose(fakeReport(), { persist: false });
  const order = ps.map((p) => p.target.type);
  assert.deepEqual(order, [
    'provider',
    'provider',
    'memory_backend',
    'builtin_tool',
    'skill_example',
    'plugin',
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
  // P2c-1: 6 proposals now (added 1 plugin)
  assert.equal(ps.length, 6);
  const written = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(written.length, 6);
  const first = JSON.parse(fs.readFileSync(path.join(dir, written[0]), 'utf8'));
  assert.equal(first.action, 'add');
  assert.equal(first.apply_author, 'darwin');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('propose: persist=false returns proposals without writing files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-deep-nopersist-'));
  const ps = await propose(fakeReport(), { proposalsDir: dir, persist: false });
  assert.equal(ps.length, 6);
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
    // P2c-1 (2026-06-18): plugin template lives at plugin/<name>.js
    ['plugins', 'audit', 'plugin/audit.js'],
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
            : cat === 'plugins'
              ? 'plugin'
              : 'provider',
    );
  }
});

test('TARGET_TEMPLATES + PRIORITY_ORDER internals are stable', () => {
  assert.deepEqual(PRIORITY_ORDER, [
    'providers',
    'memory_backends',
    'tools',
    'skills',
    // P3+ cycle 8 (2026-06-15): added platforms for 0→1 feishu adapter bridge.
    'platforms',
    // P2c-1 (2026-06-18): added plugins for Darwin "装新器官" 闭环.
    'plugins',
  ]);
  for (const cat of Object.keys(TARGET_TEMPLATES)) {
    const t = TARGET_TEMPLATES[cat]('x');
    assert.equal(typeof t.path, 'string');
    assert.equal(typeof t.type, 'string');
    // P2 catalogue (platforms / plugins) use P2 prefix; P1 catalogue uses P1.
    const expectedPrefix =
      cat === 'platforms' || cat === 'plugins' ? /v3\+ P2 catalogue/ : /v3\+ P1 catalogue/;
    assert.match(t.rationale, expectedPrefix);
  }
});

// P2c-1 (2026-06-18): plugin proposal must include a manifest stub in
// files_added[0].content that passes IPlugin.validate (P2d contract). The
// stub's lifecycle methods throw "not implemented" — PM fills those in.
test('propose: plugin proposal includes a valid IPlugin manifest stub', async () => {
  const { PLUGIN_CONTENT_TEMPLATE } = _internal;
  const stub = PLUGIN_CONTENT_TEMPLATE('audit');
  // Manifest must reference the plugin name and have the P2d-required fields.
  assert.match(stub, /name: 'audit'/);
  assert.match(stub, /version: '0\.1\.0'/);
  assert.match(stub, /capabilities: \['tool'\]/);
  assert.match(stub, /permissions: \['bus:on', 'log:info'\]/);
  // Lifecycle methods must throw "not implemented" so the stub is
  // obvious in the file (PM knows to fill in real behaviour). init takes
  // _ctx (the loader's eventBus + config injection point); the other three
  // take no args (matches logger.js shape — PR 11a + P2d convention).
  for (const m of ['init', 'destroy', 'enable', 'disable']) {
    const sig = m === 'init' ? `${m}\\(_ctx\\)` : `${m}\\(\\)`;
    assert.match(
      stub,
      new RegExp(`${sig}\\s*\\{[^}]*not implemented`),
      `${m} must throw "not implemented" in the stub`,
    );
  }
  // Proposal JSON wires the stub into files_added[0].content.
  const p = buildProposal('plugins', 'audit');
  assert.equal(p.files_added[0].content, stub);
  assert.equal(p.files_added[0].path, 'plugin/audit.js');
  assert.equal(p.target.type, 'plugin');
});

test('propose: end-to-end propose() with missing_plugins emits a writable proposal', async () => {
  const ps = await propose(fakeReport(), { persist: false });
  const pluginProposal = ps.find((p) => p.target.type === 'plugin');
  assert.ok(pluginProposal, 'expected a plugin proposal from fakeReport');
  // The proposal is directly consumable by evolution/apply.js: the file
  // body (manifest stub) lives in files_added[0].content, which apply.js
  // writes via fs.writeFileSync (step 4 of its pipeline). PM reviews the
  // stub post-apply and writes the real init() / destroy() / enable() /
  // disable() bodies — the stub is the "WHAT" half of Darwin's "装新器官".
  const content = pluginProposal.files_added[0].content;
  assert.ok(typeof content === 'string' && content.length > 0);
  // Verify the content actually evaluates to a valid IPlugin — importing
  // it through a quick eval would be heavy, so we assert the structural
  // markers the loader checks (name / version / capabilities / permissions
  // string literals).
  assert.match(content, /export default\s*\{/);
  assert.match(content, /name:\s*'audit'/);
});
