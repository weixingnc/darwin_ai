/**
 * Echo tool — TDD (PR-? P1 closed-loop demo).
 *
 * Verifies the contract Darwin's tool registry expects:
 *   - shape: { name, description, schema, async execute }
 *   - execute({ input }) → { output: input } verbatim
 *   - boundary cases: empty string, unicode, JSON-stringified object
 *   - error: non-string input throws TypeError
 *
 * TDD rationale (F-3 lesson): write tests for the *actual* tool registry
 * contract — not for an idealised one. v2 Darwin's tool-call protocol
 * (PR 7a/7b) passes a single args object to `execute(args)`, so we test
 * exactly that shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { echo } from './echo.js';

test('echo: shape conforms to tool contract', () => {
  assert.equal(typeof echo, 'object');
  assert.equal(echo.name, 'echo');
  assert.equal(typeof echo.description, 'string');
  assert.ok(echo.description.length > 0, 'description must be human-readable');
  assert.equal(echo.schema.type, 'object');
  assert.ok(Array.isArray(echo.schema.required), 'schema.required must be an array');
  assert.ok(echo.schema.required.includes('input'));
});

test('echo.execute: returns { output: input } verbatim', async () => {
  const r = await echo.execute({ input: 'hello' });
  assert.deepEqual(r, { output: 'hello' });
});

test('echo.execute: handles empty string', async () => {
  const r = await echo.execute({ input: '' });
  assert.deepEqual(r, { output: '' });
});

test('echo.execute: handles unicode verbatim', async () => {
  const r = await echo.execute({ input: '你好 🌍 — \n\t' });
  assert.equal(r.output, '你好 🌍 — \n\t');
});

test('echo.execute: handles JSON-stringified input', async () => {
  const payload = JSON.stringify({ a: 1, b: [2, 3] });
  const r = await echo.execute({ input: payload });
  assert.equal(r.output, payload);
});

test('echo.execute: throws TypeError on non-string input', async () => {
  await assert.rejects(
    () => echo.execute({ input: 42 }),
    (err) => err instanceof TypeError && /string/i.test(err.message),
  );
  await assert.rejects(
    () => echo.execute({ input: null }),
    (err) => err instanceof TypeError,
  );
  await assert.rejects(
    () => echo.execute({ input: undefined }),
    (err) => err instanceof TypeError,
  );
});

test('echo.execute: called with empty args object does not crash on access', async () => {
  // The D-2 tool-caller protocol (PR 7a) destructures { input } with a
  // default = {} so an empty args call surfaces as a TypeError (not a
  // silent `undefined` return). This test pins that contract.
  await assert.rejects(
    () => echo.execute(),
    (err) => err instanceof TypeError,
  );
});
