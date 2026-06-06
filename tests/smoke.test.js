/**
 * Smoke test: verifies the test runner works.
 * PR 1 deliverable — proves `npm test` is functional.
 * Real tests start in PR 2 (event-bus).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node test runner works', () => {
  assert.equal(1 + 1, 2);
});

test('package metadata present', async () => {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  assert.equal(pkg.default.name, 'darwin');
  assert.equal(pkg.default.version, '0.1.0');
});
