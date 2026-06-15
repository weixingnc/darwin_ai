/**
 * Verify unit tests — PR-S2.
 *
 * Exercises evolution/verify.js with injected `runners` so we don't shell out
 * to `npm test` / `npm run lint` / `npm run size-check` from unit tests.
 * The full real-runner path is covered by the e2e test.
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, _internal } from '../../evolution/verify.js';

const { parseTest, parseLint, parseSizeCheck } = _internal;

function makeRunners(opts = {}) {
  return {
    test:
      opts.test ||
      (() => ({
        code: 0,
        stdout: 'ℹ tests 100\nℹ pass 100\nℹ fail 0\n',
        stderr: '',
        duration_ms: 5,
      })),
    lint:
      opts.lint ||
      (() => ({
        code: 0,
        stdout: '',
        stderr: '',
        duration_ms: 5,
      })),
    size_check:
      opts.size_check ||
      (() => ({
        code: 0,
        stdout: '✓ All 42 file(s) within 1000 lines.\n',
        stderr: '',
        duration_ms: 5,
      })),
  };
}

test('verify: all three pass → returns pass:true', async () => {
  const res = await verify({}, { runners: makeRunners() });
  assert.equal(res.pass, true);
  assert.equal(res.summary.test_pass, true);
  assert.equal(res.summary.lint_pass, true);
  assert.equal(res.summary.size_check_pass, true);
  assert.equal(res.details.test.parsed.total, 100);
});

test('verify: test fail → pass:false, summary.test_pass=false', async () => {
  const runners = makeRunners({
    test: () => ({
      code: 1,
      stdout: 'ℹ tests 100\nℹ pass 95\nℹ fail 5\n',
      stderr: 'fail',
      duration_ms: 5,
    }),
  });
  const res = await verify({}, { runners });
  assert.equal(res.pass, false);
  assert.equal(res.summary.test_pass, false);
  assert.equal(res.summary.lint_pass, true);
  assert.equal(res.summary.size_check_pass, true);
});

test('verify: lint errors → pass:false, summary.lint_pass=false', async () => {
  const runners = makeRunners({
    lint: () => ({
      code: 1,
      stdout: '',
      stderr: '3 problems (2 errors, 1 warning)',
      duration_ms: 5,
    }),
  });
  const res = await verify({}, { runners });
  assert.equal(res.pass, false);
  assert.equal(res.summary.lint_pass, false);
  assert.equal(res.details.lint.parsed.errors, 2);
  assert.equal(res.details.lint.parsed.warnings, 1);
});

test('verify: size-check violations → pass:false', async () => {
  const runners = makeRunners({
    size_check: () => ({
      code: 1,
      stdout:
        '✗ evolution/apply.js: 1234 lines\n✓ All other file(s) within 1000 lines.\n1 file(s) exceed 1000 lines.',
      stderr: '',
      duration_ms: 5,
    }),
  });
  const res = await verify({}, { runners });
  assert.equal(res.pass, false);
  assert.equal(res.summary.size_check_pass, false);
  assert.equal(res.details.size_check.parsed.all_under_limit, false);
});

test('verify: emits evolution:verify event with summary', async () => {
  const { evolutionBus } = await import('../../evolution/_bus.js');
  const { EVENTS } = await import('../../core/events.js');
  const captured = [];
  const handler = (p) => captured.push(p);
  evolutionBus.on(EVENTS.EVOLUTION_VERIFY, handler);
  try {
    await verify({}, { runners: makeRunners() });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].pass, true);
    assert.ok(captured[0].summary);
  } finally {
    evolutionBus.off(EVENTS.EVOLUTION_VERIFY, handler);
  }
});

// ── parser unit tests ─────────────────────────────────────────────

test('parseTest: extracts total/pass/fail from summary line', () => {
  const r = parseTest({
    stdout: 'ℹ tests 50\nℹ pass 48\nℹ fail 2\n',
    stderr: '',
    code: 0,
  });
  assert.equal(r.total, 50);
  assert.equal(r.pass, 48);
  assert.equal(r.fail, 2);
});

test('parseTest: missing summary → unknown pass/fail', () => {
  const r = parseTest({ stdout: 'no summary', stderr: '', code: 0 });
  assert.equal(r.pass, 'unknown');
  assert.equal(r.fail, 0);
});

test('parseLint: extracts errors and warnings', () => {
  const r = parseLint({
    stdout: '',
    stderr: '5 problems (3 errors, 2 warnings)',
    code: 1,
  });
  assert.equal(r.errors, 3);
  assert.equal(r.warnings, 2);
});

test('parseLint: no findings → 0/0', () => {
  const r = parseLint({ stdout: '', stderr: '', code: 0 });
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 0);
});

test('parseSizeCheck: success → all_under_limit:true', () => {
  const r = parseSizeCheck({
    stdout: '✓ All 78 file(s) within 1000 lines.\n',
    stderr: '',
    code: 0,
  });
  assert.equal(r.files, 78);
  assert.equal(r.all_under_limit, true);
  assert.equal(r.violations, 0);
});

test('parseSizeCheck: violation → all_under_limit:false', () => {
  const r = parseSizeCheck({
    stdout:
      '✗ a.js: 2000 lines\n✓ All other file(s) within 1000 lines.\n1 file(s) exceed 1000 lines.',
    stderr: '',
    code: 1,
  });
  assert.equal(r.all_under_limit, false);
  assert.equal(r.violations, 1);
});
