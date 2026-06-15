/**
 * Read-file tool tests — V3_ROADMAP P1.
 *
 * Verifies the tool contract Darwin's tool registry expects (mirrors
 * tool/builtins/echo.test.js pattern).
 *
 * Contract pinned here:
 *   - shape: { name, description, schema, async execute }
 *   - execute({ path }) → { content: string, bytes: number }
 *   - boundary: non-string path → TypeError; missing file → Error
 *
 * Run: `node --test tool/builtins/read-file.test.js`
 * (tool/builtins/* is intentionally OUT of `npm test` glob per P1-A decision:
 *  these tools are Darwin-self-evolved, not v2 launch test scope.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from './read-file.js';

test('read-file: shape conforms to tool contract', () => {
  assert.equal(typeof readFile, 'object');
  assert.equal(readFile.name, 'read-file');
  assert.equal(typeof readFile.description, 'string');
  assert.ok(readFile.description.length > 0);
  assert.equal(readFile.schema.type, 'object');
  assert.ok(Array.isArray(readFile.schema.required));
  assert.ok(readFile.schema.required.includes('path'));
});

test('read-file.execute: returns { content, bytes } for UTF-8 file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'));
  const p = join(dir, 'hello.txt');
  const body = '你好 world\nline 2';
  writeFileSync(p, body, 'utf8');
  const r = await readFile.execute({ path: p });
  assert.equal(r.content, body);
  assert.equal(typeof r.bytes, 'number');
  assert.ok(r.bytes > 0, 'bytes must be > 0 for a non-empty file');
  assert.equal(r.bytes, Buffer.byteLength(body, 'utf8'), 'bytes = utf-8 byte length');
});

test('read-file.execute: returns empty content for empty file (bytes=0)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'));
  const p = join(dir, 'empty.txt');
  writeFileSync(p, '', 'utf8');
  const r = await readFile.execute({ path: p });
  assert.equal(r.content, '');
  assert.equal(r.bytes, 0);
});

test('read-file.execute: reads json content intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'));
  const p = join(dir, 'data.json');
  const obj = { a: 1, b: [2, 3], c: 'hi\nwith newline' };
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  const r = await readFile.execute({ path: p });
  assert.deepEqual(JSON.parse(r.content), obj);
});

test('read-file.execute: throws TypeError on non-string path', async () => {
  await assert.rejects(
    () => readFile.execute({ path: 42 }),
    (err) => err instanceof TypeError && /path/i.test(err.message),
  );
  await assert.rejects(
    () => readFile.execute({ path: null }),
    (err) => err instanceof TypeError,
  );
  await assert.rejects(
    () => readFile.execute({ path: '' }),
    (err) => err instanceof TypeError && /non-empty/.test(err.message),
  );
  await assert.rejects(
    () => readFile.execute(),
    (err) => err instanceof TypeError,
  );
});

test('read-file.execute: throws Error on missing file (ENOENT)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'));
  const p = join(dir, 'definitely-missing.txt');
  await assert.rejects(
    () => readFile.execute({ path: p }),
    (err) => err && /ENOENT/.test(err.message),
  );
});
