/**
 * hello-world skill tests — TDD red→green.
 * Validates skill catalog entry so SelfEvolution.diagnose stops reporting
 * hello-world as missing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { helloWorld } from './hello-world.js';

describe('hello-world skill — catalog contract', () => {
  test('name matches the diagnose catalogue', () => {
    assert.equal(helloWorld.name, 'hello-world');
  });

  test('description is non-empty string', () => {
    assert.equal(typeof helloWorld.description, 'string');
    assert.ok(helloWorld.description.length > 0);
  });

  test('triggers contains hello', () => {
    assert.ok(Array.isArray(helloWorld.triggers));
    assert.ok(helloWorld.triggers.includes('hello'));
  });

  test('systemPromptHint is a string', () => {
    assert.equal(typeof helloWorld.systemPromptHint, 'string');
  });

  test('execute is an async function', () => {
    assert.equal(typeof helloWorld.execute, 'function');
  });
});

describe('hello-world skill — execute()', () => {
  test('returns { output: "world" } for any input', async () => {
    const r = await helloWorld.execute('hello');
    assert.deepEqual(r, { output: 'world' });
  });

  test('returns { output: "world" } for empty input (idempotent)', async () => {
    const r = await helloWorld.execute('');
    assert.equal(r.output, 'world');
  });

  test('returns { output: "world" } for unicode input', async () => {
    const r = await helloWorld.execute('你好');
    assert.equal(r.output, 'world');
  });
});
