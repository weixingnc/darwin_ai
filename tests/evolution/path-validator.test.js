/**
 * Tests for evolution/path-validator.js (PR for --version ghost-dir bug).
 *
 * Run via: npm test (picked up by `tests/evolution/*.test.js` glob).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProposalPath, validateProposalPaths } from '../../evolution/path-validator.js';

test('validateProposalPath: accepts normal Darwin write targets', () => {
  const cases = [
    'provider/foo.js',
    'tool/builtins/bar.js',
    'memory/backends/baz.js',
    'skill/examples/qux.js',
    'platform/quux.js',
    'plugin/corge.js',
    'tests/grault.js',
    'docs/garply.md',
    'plugin/audit.js',
    'evolution/catalogue.js',
  ];
  for (const p of cases) {
    const r = validateProposalPath(p);
    assert.equal(r.ok, true, `expected ok for ${p}, got ${JSON.stringify(r)}`);
  }
});

test('validateProposalPath: rejects the --version ghost-dir bug', () => {
  const cases = [
    '--version',
    '--version/_/foo.js',
    '--version/foo.js',
    '-foo.js',
    'plugin/-evil.js',
    'provider/--injection.js',
  ];
  for (const p of cases) {
    const r = validateProposalPath(p);
    assert.equal(r.ok, false, `expected reject for ${p}, got ${JSON.stringify(r)}`);
    assert.ok(
      r.reason.includes('-') || r.reason.includes('--'),
      `reason should mention dash bug: ${r.reason}`,
    );
  }
});

test('validateProposalPath: rejects path traversal', () => {
  const cases = [
    '../foo',
    '../../etc/passwd',
    'foo/../../bar',
    'foo/../bar/baz.js',
    'foo/./../bar',
  ];
  for (const p of cases) {
    const r = validateProposalPath(p);
    assert.equal(r.ok, false, `expected reject for ${p}, got ${JSON.stringify(r)}`);
  }
});

test('validateProposalPath: rejects absolute paths', () => {
  const cases = ['/etc/passwd', '/home/weixing/darwin/foo.js', '/tmp/anything'];
  for (const p of cases) {
    const r = validateProposalPath(p);
    assert.equal(r.ok, false, `expected reject for ${p}, got ${JSON.stringify(r)}`);
  }
});

test('validateProposalPath: rejects hidden files (.env, .git, etc)', () => {
  const cases = ['.env', '.git/hooks/pre-commit', 'plugin/.secret.js', 'provider/..js'];
  for (const p of cases) {
    const r = validateProposalPath(p);
    assert.equal(r.ok, false, `expected reject for ${p}, got ${JSON.stringify(r)}`);
  }
});

test('validateProposalPath: rejects non-string / empty / too long', () => {
  assert.equal(validateProposalPath('').ok, false);
  assert.equal(validateProposalPath(null).ok, false);
  assert.equal(validateProposalPath(undefined).ok, false);
  assert.equal(validateProposalPath(42).ok, false);
  assert.equal(validateProposalPath({}).ok, false);
  assert.equal(validateProposalPath('a'.repeat(600)).ok, false);
});

test('validateProposalPath: normalises return value', () => {
  const r = validateProposalPath('plugin/./audit.js');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 'plugin/audit.js');
});

test('validateProposalPaths: short-circuits on first bad path', () => {
  const r = validateProposalPaths([
    { path: 'plugin/audit.js' },
    { path: '--version/foo.js' },
    { path: 'provider/foo.js' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /filesAdded\[1\]/);
});

test('validateProposalPaths: returns all normalized paths on success', () => {
  const r = validateProposalPaths([{ path: 'plugin/audit.js' }, { path: 'plugin/./metrics.js' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.normalized, ['plugin/audit.js', 'plugin/metrics.js']);
});

test('validateProposalPaths: rejects non-array input', () => {
  assert.equal(validateProposalPaths(null).ok, false);
  assert.equal(validateProposalPaths('foo').ok, false);
  assert.equal(validateProposalPaths({}).ok, false);
});
