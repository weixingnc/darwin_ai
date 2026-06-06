/**
 * Smoke test: verifies the test runner works.
 * PR 1 deliverable — proves `npm test` is functional.
 * Real tests start in PR 2 (event-bus).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

test('node test runner works', () => {
  assert.equal(1 + 1, 2);
});

test('package metadata present', () => {
  assert.equal(pkg.name, 'darwin');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module');
});
