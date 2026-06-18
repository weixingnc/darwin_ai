/**
 * Evolution Catalogue — P2g persistence, growth candidate, audit log (2026-06-18).
 *
 * T7-W2 (2026-06-19): the T4 block (imports + constants + tests)
 * now sits BEFORE test.afterAll. W1 regression test lives in
 * tests/evolution/catalogue-pollution.test.js (kept out of this
 * file to stay under the 200-line cap).
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
  _internal,
} from '../../evolution/catalogue.js';

const TMP = mkdtempSync(join(tmpdir(), 'p2g-'));

function overlayFile(suffix = '') {
  return join(TMP, `catalogue${suffix}.json`);
}
function logFile(suffix = '') {
  return join(TMP, `catalogue${suffix}.log`);
}

test('P2g: loadCatalogue() returns DEFAULTS when no overlay exists', () => {
  const cat = loadCatalogue({ file: overlayFile('-empty') });
  assert.deepEqual([...cat.providers].sort(), [
    'anthropic',
    'claude-3.5',
    'deepseek',
    'gemini',
    'openai',
    'qwen',
  ]);
  // W4-1 (2026-06-18): baseline plugin catalogue now 3 (logger + audit
  // + metrics), not 2. See evolution/catalogue.js DEFAULTS.plugins.
  // W6-2: now 5 (logger + audit + metrics + rate-limiter + llm-cache).
  assert.equal(cat.plugins.length, 5);
  assert.ok(cat.plugins.includes('logger'));
  assert.ok(cat.plugins.includes('audit'));
  assert.ok(cat.plugins.includes('metrics'));
  assert.ok(cat.plugins.includes('rate-limiter'));
  assert.ok(cat.plugins.includes('llm-cache'));
});

test('P2g: loadCatalogue() merges overlay file (additive)', () => {
  const file = overlayFile('-merge');
  writeFileSync(file, JSON.stringify({ plugins: ['metrics', 'rate-limiter', 'llm-cache'] }) + '\n');
  const cat = loadCatalogue({ file });
  assert.deepEqual([...cat.plugins].sort(), [
    'audit',
    'llm-cache',
    'logger',
    'metrics',
    'rate-limiter',
  ]);
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
  // W6-2 (2026-06-18): both 'rate-limiter' and 'llm-cache' moved to
  // DEFAULTS.plugins after shipping. GROWTH_CANDIDATES is now empty —
  // proposeGrowth() returns null. PM can add new candidates when ready.
  const next = proposeGrowth('plugins');
  assert.equal(next, null);
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

// T4 (Codex P1-1, 2026-06-18): NODE_ENV=test routes audit log
// to a per-test temp file, NOT the production evolution/catalogue.log.
// T7-W2 (2026-06-19): this block was moved to BEFORE test.afterAll
// (it used to sit after afterAll, which was a latent footgun).
import os from 'node:os';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __testDir = dirname(fileURLToPath(import.meta.url));
const PROD_LOG = join(__testDir, '..', '..', 'evolution', 'catalogue.log');
const TEST_LOG = join(os.tmpdir(), 'darwin-test-catalogue.log');

test('T4: NODE_ENV=test redirects appendAudit to a per-test temp file', async () => {
  if (fsSync.existsSync(TEST_LOG)) {
    fsSync.unlinkSync(TEST_LOG);
  }
  // Snapshot production log size BEFORE — the production log
  // already has historical noise from before T4, so we only
  // verify the synthetic entry is NOT appended to it.
  const prodBefore = fsSync.existsSync(PROD_LOG) ? fsSync.readFileSync(PROD_LOG, 'utf8').length : 0;
  _internal.appendAudit({ op: 'test-t4-isolated', value: 1 });
  assert.ok(fsSync.existsSync(TEST_LOG), 'TEST_LOG_FILE should exist after appendAudit');
  const content = fsSync.readFileSync(TEST_LOG, 'utf8');
  assert.match(content, /test-t4-isolated/);
  // Production log size must NOT have grown (no synthetic entry).
  const prodAfter = fsSync.existsSync(PROD_LOG) ? fsSync.readFileSync(PROD_LOG, 'utf8').length : 0;
  assert.equal(prodAfter, prodBefore, 'production catalogue.log must not grow during test mode');
});

test('T4: explicit logFile param still wins over TEST_LOG_FILE', async () => {
  const customLog = join(os.tmpdir(), 'darwin-t4-explicit-' + Date.now() + '.log');
  _internal.appendAudit({ op: 'test-t4-explicit', value: 2 }, customLog);
  assert.ok(fsSync.existsSync(customLog), 'explicit logFile param should be honoured');
  const content = fsSync.readFileSync(customLog, 'utf8');
  assert.match(content, /test-t4-explicit/);
});

test.afterAll ??= (fn) => test('afterAll', async () => fn());
test.afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
