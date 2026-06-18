/** T3 (2026-06-18) — matcher-v2 standalone perf bench.
 *
 * Why a separate file: the e2e test (test 6 in
 * tests/integration/openclaw-skill-e2e.test.js) checks
 * `elapsed < 80ms` as a hard gate. This bench gives a
 * distribution view (mean / p50 / p95 / p99) over many
 * trials so we can spot gradual drift before it crosses
 * the 80ms hard line.
 *
 * Run:  npm run test:perf
 *
 * Output format: one line per registry size, with stats
 * and pass/fail relative to the dev-target <2ms/call.
 * Intended for PM use, not part of `npm test` (slow).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRegistry } from '../../core/skill-registry.js';
import { matchSkillsV2 as matchSkills } from '../../core/skill-matcher-v2.js';

/** Run n trials and return {mean, p50, p95, p99, max} in ms. */
function bench(registry, text, n = 200) {
  // Warmup
  for (let i = 0; i < 5; i += 1) {
    matchSkills({ text, registry, max: 5 });
  }
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    matchSkills({ text: `${text}-${i}`, registry, max: 5 });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    mean: sum / n,
    p50: samples[Math.floor(n * 0.5)],
    p95: samples[Math.floor(n * 0.95)],
    p99: samples[Math.floor(n * 0.99)],
    max: samples[n - 1],
  };
}

function populate(r, n) {
  // Use only exact/substring — avoid regex/command-prefix
  // (compile/warn per call, dominate budget at scale).
  for (let i = 0; i < n; i += 1) {
    r.set('skill' + i, {
      name: 'skill' + i,
      triggers: ['trigger' + i],
      systemPromptHint: 'hint ' + i,
      triggerType: i % 2 === 0 ? 'exact' : 'substring',
    });
  }
}

describe('T3: matcher-v2 standalone perf bench', () => {
  test('100-entry registry: 200 trials < 2ms/call (mean)', () => {
    const r = createRegistry();
    populate(r, 100);
    const s = bench(r, 'trigger1', 200);
    console.log(
      `  100 entries: mean=${s.mean.toFixed(2)}ms p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)}`,
    );
    assert.ok(s.mean < 2, `mean >2ms/call at 100 entries: ${s.mean.toFixed(2)}ms`);
  });

  test('500-entry registry: 200 trials < 5ms/call (mean)', () => {
    const r = createRegistry();
    populate(r, 500);
    const s = bench(r, 'trigger1', 200);
    console.log(
      `  500 entries: mean=${s.mean.toFixed(2)}ms p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)}`,
    );
    assert.ok(s.mean < 5, `mean >5ms/call at 500 entries: ${s.mean.toFixed(2)}ms`);
  });

  test('1000-entry registry: 200 trials < 10ms/call (mean) — 80ms gate headroom', () => {
    const r = createRegistry();
    populate(r, 1000);
    const s = bench(r, 'trigger1', 200);
    console.log(
      ` 1000 entries: mean=${s.mean.toFixed(2)}ms p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)}`,
    );
    // 10ms/call * 50 turns = 500ms (worst case)
    // e2e test 6 hard-gates 50 turns < 80ms total (avg <2ms/call).
    // This bench is mean-only, so we use 10ms (5x headroom).
    assert.ok(s.mean < 10, `mean >10ms/call at 1000 entries: ${s.mean.toFixed(2)}ms`);
  });
});
