/**
 * Diagnose scan tests — PR-S1 (deep-path copy).
 *
 * Mirrors tests/evolution-diagnose.test.js but lives under tests/evolution/
 * to match the src layout (evolution/diagnose.js). Exercises:
 *   - report shape (current.*, missing_*, scanned_at)
 *   - catalogue diffing (missing dirs → fully-missing)
 *   - `_internal.listJsStems` defensive path (missing dir → [])
 *   - `repoRoot` injection (tmpdir mock instead of real repo)
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnose, _internal } from '../../evolution/diagnose.js';

const { listJsStems, diff, SCAN_ROOTS, PROVIDER_CATALOGUE } = _internal;
const TOTAL_PROVIDERS = PROVIDER_CATALOGUE.length; // 6 (anthropic/openai/deepseek/qwen/gemini/claude-3.5)

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-deep-'));
  fs.mkdirSync(path.join(root, 'provider'), { recursive: true });
  fs.writeFileSync(path.join(root, 'provider', 'anthropic.js'), '// stub');
  fs.writeFileSync(path.join(root, 'provider', 'README.md'), 'irrelevant');
  fs.mkdirSync(path.join(root, 'tool', 'builtins'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skill', 'examples'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory', 'backends'), { recursive: true });
  return root;
}

test('diagnose: real repo returns full report shape', async () => {
  const r = await diagnose();
  assert.ok(r.current);
  for (const k of ['providers', 'tools', 'skills', 'memory_backends']) {
    assert.ok(Array.isArray(r.current[k]), k);
  }
  for (const k of [
    'missing_providers',
    'missing_tools',
    'missing_skills',
    'missing_memory_backends',
  ]) {
    assert.ok(Array.isArray(r[k]), k);
  }
  assert.equal(typeof r.scanned_at, 'string');
});

test('diagnose: tmpdir mock — present provider is in current, rest missing', async () => {
  const root = makeRepo();
  const r = await diagnose({ repoRoot: root });
  assert.deepEqual(r.current.providers, ['anthropic']);
  assert.equal(r.missing_providers.length, TOTAL_PROVIDERS - 1); // catalogue - present
  assert.ok(r.missing_tools.includes('read-file'));
  assert.ok(r.missing_skills.includes('hello-world'));
  assert.ok(r.missing_memory_backends.includes('filesystem'));
});

test('diagnose: tmpdir mock — file stem casing is lowercased', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'provider', 'OpenAI.js'), '// stub');
  const r = await diagnose({ repoRoot: root });
  assert.ok(r.current.providers.includes('openai'), 'OpenAI.js → stem openai');
  // makeRepo wrote anthropic.js; we add OpenAI.js; missing = catalogue - 2
  assert.equal(r.current.providers.length, 2);
  assert.equal(r.missing_providers.length, TOTAL_PROVIDERS - 2);
  assert.deepEqual(r.missing_providers.sort(), ['claude-3.5', 'deepseek', 'gemini', 'qwen']);
});

test('diagnose: empty catalogue dir → all entries missing', async () => {
  const root = makeRepo();
  fs.unlinkSync(path.join(root, 'provider', 'anthropic.js'));
  const r = await diagnose({ repoRoot: root });
  assert.equal(r.missing_providers.length, TOTAL_PROVIDERS);
  assert.equal(r.current.providers.length, 0);
});

test('listJsStems: missing directory returns empty array (no throw)', () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-a-dir-' + Date.now());
  assert.deepEqual(listJsStems(missing), []);
});

test('listJsStems: non-.js files are filtered out', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lstjs-'));
  fs.writeFileSync(path.join(d, 'a.js'), '');
  fs.writeFileSync(path.join(d, 'b.txt'), '');
  fs.writeFileSync(path.join(d, 'c.md'), '');
  assert.deepEqual(listJsStems(d), ['a']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('diff: pure set difference (catalogue − present)', () => {
  assert.deepEqual(diff(['a', 'b', 'c'], ['a']), ['b', 'c']);
  assert.deepEqual(diff(['a'], ['a', 'b']), []);
  assert.deepEqual(diff([], ['a']), []);
});

test('SCAN_ROOTS: points to canonical Darwin layout', () => {
  assert.match(SCAN_ROOTS.providers, /\/provider$/);
  assert.match(SCAN_ROOTS.tools, /\/tool\/builtins$/);
  assert.match(SCAN_ROOTS.skills, /\/skill\/examples$/);
  assert.match(SCAN_ROOTS.memory_backends, /\/memory\/backends$/);
});
