/**
 * summarizer skill tests — TDD red→green.
 * Validates the catalog entry + execute() stub behavior (slice + ellipsis).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizer } from './summarizer.js';

describe('summarizer skill — catalog contract', () => {
  test('name matches the diagnose catalogue', () => {
    assert.equal(summarizer.name, 'summarizer');
  });

  test('triggers include summarize / summary / tldr', () => {
    assert.ok(Array.isArray(summarizer.triggers));
    assert.ok(summarizer.triggers.includes('summarize'));
    assert.ok(summarizer.triggers.includes('summary'));
    assert.ok(summarizer.triggers.includes('tldr'));
  });

  test('description is non-empty', () => {
    assert.equal(typeof summarizer.description, 'string');
    assert.ok(summarizer.description.length > 0);
  });
});

describe('summarizer skill — execute()', () => {
  test('short input (<=200 chars) is returned verbatim, no ellipsis', async () => {
    const txt = 'short text';
    const r = await summarizer.execute(txt);
    assert.equal(r.output, txt);
  });

  test('long input (>200 chars) is sliced to 200 chars + ellipsis', async () => {
    const long = 'a'.repeat(500);
    const r = await summarizer.execute(long);
    assert.ok(r.output.length <= 201);
    assert.ok(r.output.endsWith('…'));
    assert.ok(r.output.startsWith('a'.repeat(200)));
  });

  test('non-string input is coerced via String()', async () => {
    const r = await summarizer.execute(42);
    assert.equal(r.output, '42');
  });

  test('null/undefined input is coerced safely', async () => {
    const r = await summarizer.execute(null);
    assert.equal(r.output, 'null');
    const r2 = await summarizer.execute(undefined);
    assert.equal(r2.output, 'undefined');
  });

  test('result is an object with output string', async () => {
    const r = await summarizer.execute('anything');
    assert.equal(typeof r, 'object');
    assert.equal(typeof r.output, 'string');
  });

  test('multibyte safe: unicode input is sliced (best-effort)', async () => {
    const zh = '一二三四五六七八九十'.repeat(50); // 100 chars of zh
    const r = await summarizer.execute(zh);
    assert.ok(r.output.length <= 201);
    assert.ok(r.output.endsWith('…'));
  });
});
