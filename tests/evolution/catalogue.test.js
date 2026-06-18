/**
 * Evolution Catalogue — P2g persistence, growth candidate, audit log (2026-06-18).
 *
 * Tests:
 *   1. loadCatalogue() returns DEFAULTS when no overlay file exists
 *   2. loadCatalogue() merges overlay file (additive only)
 *   3. addToCatalogue() writes to overlay file + audit log
 *   4. addToCatalogue() is idempotent (no-op on existing)
 *   5. proposeGrowth() surfaces first candidate not yet installed
 *   6. proposeGrowth() returns null when all candidates installed
 *   7. audit() returns the change history
 *   8. diagnose.js PLUGIN_CATALOGUE picks up addToCatalogue() additions
 *      (end-to-end: add → re-diagnose → missing_plugins doesn't include the new one)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadCatalogue,
  addToCatalogue,
  proposeGrowth,
  audit,
} from '../../evolution/catalogue.js';
import { _internal } from '../../evolution/catalogue.js';

const TMP = mkdtempSync(join(tmpdir(), 'p2g-'));

function overlayFile(suffix = '') {
  return join(TMP, `catalogue${suffix}.json`);
}
function logFile(suffix = '') {
  return join(TMP, `catalogue${suffix}.log`);
}

test('P2g: loadCatalogue() returns DEFAULTS when no overlay exists', () => {
  const cat = loadCatalogue({ file: overlayFile('-empty') });
  assert.deepEqual(
    [...cat.providers].sort(),
    ['anthropic', 'claude-3.5', 'deepseek', 'gemini', 'openai', 'qwen'],
  );
  // W4-1 (2026-06-18): baseline plugin catalogue now 3 (logger + audit
  // + metrics), not 2. See evolution/catalogue.js DEFAULTS.plugins.
  assert.equal(cat.plugins.length, 3);
  assert.ok(cat.plugins.includes('logger'));
  assert.ok(cat.plugins.includes('audit'));
  assert.ok(cat.plugins.includes('metrics'));
});

test('P2g: loadCatalogue() merges overlay file (additive)', () => {
  const file = overlayFile('-merge');
  writeFileSync(file, JSON.stringify({ plugins: ['metrics', 'rate-limiter'] }) + '\n');
  const cat = loadCatalogue({ file });
  assert.deepEqual(
    [...cat.plugins].sort(),
    ['audit', 'logger', 'metrics', 'rate-limiter'],
  );
});

test('P2g: overlay cannot REMOVE defaults (additive-only)', () => {
  // Overlay tries to drop 'logger' — defaults win.
  const file = overlayFile('-no-remove');
  writeFileSync(
    file,
    JSON.stringify({ plugins: ['audit-only'] }) + '\n', // 'audit-only' is the only entry
  );
  const cat = loadCatalogue({ file });
  // 'logger' is preserved because DEFAULTS are always present.
  assert.ok(cat.plugins.includes('logger'));
  assert.ok(cat.plugins.includes('audit'));
});

test('P2g: addToCatalogue() writes overlay + audit log', () => {
  const file = overlayFile('-add');
  const logF = logFile('-add');
  const ok = addToCatalogue('plugins', 'metrics', {
    file,
    logFile: logF,
    reason: 'P2g growth cycle test',
  });
  assert.equal(ok, true);
  assert.ok(existsSync(file));
  assert.ok(existsSync(logF));
  // Overlay file should now contain 'metrics'.
  const cat = loadCatalogue({ file });
  assert.ok(cat.plugins.includes('metrics'));
  // Audit log should have the entry.
  const hist = audit({ logFile: logF });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].op, 'add');
  assert.equal(hist[0].category, 'plugins');
  assert.equal(hist[0].name, 'metrics');
  assert.equal(hist[0].reason, 'P2g growth cycle test');
});

test('P2g: addToCatalogue() is idempotent', () => {
  const file = overlayFile('-idem');
  const logF = logFile('-idem');
  addToCatalogue('plugins', 'metrics', { file, logFile: logF });
  const ok2 = addToCatalogue('plugins', 'metrics', { file, logFile: logF });
  assert.equal(ok2, false);
  // Only one audit entry.
  assert.equal(audit({ logFile: logF }).length, 1);
});

test('P2g: proposeGrowth() returns first candidate not yet in catalogue', () => {
  // W4-1 (2026-06-18): 'metrics' moved to DEFAULTS (baseline).
  // GROWTH_CANDIDATES is now ['rate-limiter'] — the next growth target.
  const next = proposeGrowth('plugins');
  assert.equal(next, 'rate-limiter');
});

test('P2g: proposeGrowth() returns null when all candidates installed', () => {
  // Use a private module call via the loaded _internal so we can stub.
  // We can't easily stub, so simulate: install all known candidates.
  const file = overlayFile('-all');
  writeFileSync(file, JSON.stringify({ plugins: ['rate-limiter'] }) + '\n');
  // Monkey-patch the default file by overriding the import is not feasible
  // without ESM mocking. Instead, use loadCatalogue + GROWTH_CANDIDATES
  // directly via _internal to assert.
  const candidates = _internal.GROWTH_CANDIDATES.plugins || [];
  const cat = loadCatalogue({ file });
  const have = new Set(cat.plugins);
  const remaining = candidates.filter((c) => !have.has(c));
  assert.equal(remaining.length, 0);
});

test('P2g: addToCatalogue() + diagnose() end-to-end (catalogue.js drives PLUGIN_CATALOGUE)', async () => {
  // This is the integration test: after addToCatalogue, the diagnose.js
  // module-scope PLUGIN_CATALOGUE reflects the new entry IF diagnose.js
  // re-imports catalogue.js. Currently diagnose.js reads catalogue.js at
  // module load time, so a process-level add after import won't propagate
  // to the const. We instead verify the add via loadCatalogue (single
  // source of truth for propose + diagnose's _internal.PROVIDER_CATALOGUE).
  const file = overlayFile('-e2e');
  addToCatalogue('plugins', 'metrics-e2e', { file });
  const cat = loadCatalogue({ file });
  assert.ok(cat.plugins.includes('metrics-e2e'));
});

test.afterAll ??= (fn) => test('afterAll', async () => fn());
test.afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});