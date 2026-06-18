/**
 * T7-W1 (Codex P1-4, 2026-06-19) — addToCatalogue() must honour
 * the NODE_ENV=test audit-log fallback.
 *
 * Background (T4 + reviewer evidence):
 *   T4 (399347a) added TEST_LOG_FILE in evolution/catalogue.js and
 *   made appendAudit() default to it in test mode:
 *     const target = logFile || TEST_LOG_FILE;
 *   But addToCatalogue (the only production caller of appendAudit
 *   in the catalogue module) resolved its own `logFile` default
 *   to LOG_FILE before calling appendAudit:
 *     const logFile = opts.logFile || LOG_FILE;
 *     appendAudit(entry, logFile);
 *   Because the caller passed LOG_FILE, appendAudit's
 *   `logFile || TEST_LOG_FILE` fallback was never reached. Tests
 *   calling addToCatalogue() without opts.logFile wrote to the
 *   PRODUCTION evolution/catalogue.log. Reviewer observed 14
 *   `metrics-e2e` entries in the production log after a T4-era
 *   `npm test` run.
 *
 * Fix (catalogue.js):
 *   const logFile = opts.logFile || TEST_LOG_FILE;
 *   The same constant appendAudit uses. TEST_LOG_FILE itself is
 *   NODE_ENV-aware (== LOG_FILE in production, == tmp file in test),
 *   so production callers are unaffected.
 *
 * This test pins the contract: addToCatalogue() called from a test
 * without an explicit logFile opt must NOT grow the production log.
 * Extracted to its own file (per darwin-coder brief redline) so
 * tests/evolution/catalogue.test.js stays under the 200-line
 * single-file soft cap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addToCatalogue } from '../../evolution/catalogue.js';

const __testDir = dirname(fileURLToPath(import.meta.url));
const PROD_LOG = join(__testDir, '..', '..', 'evolution', 'catalogue.log');
const TMP = mkdtempSync(join(tmpdir(), 't7-w1-'));

test('T7-W1: addToCatalogue() in test mode does NOT pollute production catalogue.log', () => {
  // Snapshot production log size BEFORE the addToCatalogue call.
  const prodBefore = existsSync(PROD_LOG) ? readFileSync(PROD_LOG, 'utf8').length : 0;
  // Use an isolated overlay file so we don't touch the real
  // evolution/catalogue.json. No opts.logFile — this is the
  // exact call shape that polluted the production log pre-fix.
  const isolatedFile = join(TMP, 'catalogue-w1.json');
  const uniqueName = `t7-w1-${Date.now()}-${process.hrtime.bigint().toString(16)}`;
  const ok = addToCatalogue('plugins', uniqueName, { file: isolatedFile });
  assert.equal(ok, true);
  // Production log size must NOT have grown.
  const prodAfter = existsSync(PROD_LOG) ? readFileSync(PROD_LOG, 'utf8').length : 0;
  assert.equal(
    prodAfter,
    prodBefore,
    'production catalogue.log must not grow when addToCatalogue is called from a test without opts.logFile',
  );
});
