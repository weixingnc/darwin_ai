/**
 * translator skill tests — TDD red→green.
 * Validates the catalog entry + execute() stub (target param + prefix).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { translator } from './translator.js';

describe('translator skill — catalog contract', () => {
  test('name matches the diagnose catalogue', () => {
    assert.equal(translator.name, 'translator');
  });

  test('triggers include translate / translation / 翻译', () => {
    assert.ok(Array.isArray(translator.triggers));
    assert.ok(translator.triggers.includes('translate'));
    assert.ok(translator.triggers.includes('translation'));
    assert.ok(translator.triggers.includes('翻译'));
  });

  test('description is non-empty', () => {
    assert.equal(typeof translator.description, 'string');
    assert.ok(translator.description.length > 0);
  });
});

describe('translator skill — execute()', () => {
  test('default target is "en"', async () => {
    const r = await translator.execute('hello');
    assert.equal(r.output, '[translated to en] hello');
  });

  test('target = "zh" via context.target', async () => {
    const r = await translator.execute('hello', { target: 'zh' });
    assert.equal(r.output, '[translated to zh] hello');
  });

  test('target via context.options.target', async () => {
    const r = await translator.execute('bonjour', { options: { target: 'fr' } });
    assert.equal(r.output, '[translated to fr] bonjour');
  });

  test('non-string input coerced via String()', async () => {
    const r = await translator.execute(123, { target: 'ja' });
    assert.equal(r.output, '[translated to ja] 123');
  });

  test('null input coerced safely', async () => {
    const r = await translator.execute(null);
    assert.equal(r.output, '[translated to en] null');
  });

  test('result is an object with output string', async () => {
    const r = await translator.execute('x');
    assert.equal(typeof r, 'object');
    assert.equal(typeof r.output, 'string');
  });

  test('unicode / 中文 round-trip safe', async () => {
    const r = await translator.execute('你好', { target: 'en' });
    assert.equal(r.output, '[translated to en] 你好');
  });
});
