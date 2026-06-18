/**
 * T5 (Codex P1-2, 2026-06-18): self-evolve plugin load smoke test.
 *
 * tryPluginLoad is the dynamic-loader half of Darwin's self-evolve
 * close-the-loop guarantee. Static verify (npm test + lint + size-
 * check) can pass on a brand-new plugin/*.js file that still throws
 * at import time. tryPluginLoad catches that class of bug before
 * Darwin reports success, by trying to dynamic-import each new
 * plugin file and surfacing the first error.
 *
 * Tests:
 *   1. real Darwin plugin/*.js files all import cleanly
 *   2. inject a broken plugin file → returns ok:false with the
 *      file path + error message
 *   3. no plugin files written → returns ok:null (skipped)
 *   4. applyResult is null → returns ok:null
 *   5. only non-plugin files written (e.g. evolution/*.js) → ok:true
 *      (nothing to load, treated as pass)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tryPluginLoad } from '../../evolution/self-evolve.js';

const __testDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__testDir, '..', '..');

const TMP = mkdtempSync(join(tmpdir(), 't5-'));

test('T5-1: real Darwin plugin/*.js files all import cleanly', async () => {
  // The shipped example plugin lives at plugin/__example__/logger.js;
  // production plugins are plugin/audit.js + plugin/metrics.js +
  // plugin/rate-limiter.js + plugin/llm-cache.js.
  const applyResult = {
    applied: true,
    files_written: [
      'plugin/audit.js',
      'plugin/metrics.js',
      'plugin/rate-limiter.js',
      'plugin/llm-cache.js',
    ],
  };
  const result = await tryPluginLoad(applyResult, REPO_ROOT);
  assert.equal(result.ok, true, `expected ok:true, got: ${result.error}`);
  assert.equal(result.error, null);
  assert.ok(result.duration_ms >= 0);
});

test('T5-2: inject a broken plugin file → ok:false + file path in error', async () => {
  // Create a tmp dir with a plugin/ subdir and a broken file.
  const tmp = mkdtempSync(join(tmpdir(), 't5-broken-'));
  mkdirSync(join(tmp, 'plugin'), { recursive: true });
  writeFileSync(
    join(tmp, 'plugin', 'broken.js'),
    '// intentionally broken: references an undefined symbol at top level\n' +
      'throw new Error("T5 deliberately broken");\n',
    'utf8',
  );
  const applyResult = {
    applied: true,
    files_written: ['plugin/broken.js'],
  };
  const result = await tryPluginLoad(applyResult, tmp);
  assert.equal(result.ok, false);
  assert.match(result.error, /plugin\/broken\.js/);
  assert.match(result.error, /T5 deliberately broken/);
  rmSync(tmp, { recursive: true, force: true });
});

test('T5-3: no plugin files written → ok:null (skipped)', async () => {
  const applyResult = {
    applied: true,
    files_written: [],
  };
  const result = await tryPluginLoad(applyResult, REPO_ROOT);
  assert.equal(result.ok, null);
  assert.equal(result.error, null);
  assert.equal(result.duration_ms, 0);
});

test('T5-4: applyResult is null → ok:null (skipped)', async () => {
  const result = await tryPluginLoad(null, REPO_ROOT);
  assert.equal(result.ok, null);
  assert.equal(result.error, null);
  assert.equal(result.duration_ms, 0);
});

test('T5-5: only non-plugin files written → ok:true (nothing to load)', async () => {
  // Use the real REPO_ROOT; evolution/ files exist and import cleanly.
  const applyResult = {
    applied: true,
    files_written: ['evolution/catalogue.js', 'evolution/propose.js'],
  };
  const result = await tryPluginLoad(applyResult, REPO_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
});

test.afterAll?.(() => {
  try {
    if (existsSync(TMP)) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch {
    /* best-effort cleanup */
  }
});
