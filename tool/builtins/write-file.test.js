/**
 * Write-file tool tests — V3_ROADMAP P1.
 *
 * Contract pinned:
 *   - shape: { name, description, schema, async execute }
 *   - execute({ path, content }) → { ok: true, bytes: number, path: string }
 *   - boundary: non-string path/content → TypeError; creates parent dirs
 *
 * Run: `node --test tool/builtins/write-file.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from './write-file.js';

test('write-file: shape conforms to tool contract', () => {
  assert.equal(typeof writeFile, 'object');
  assert.equal(writeFile.name, 'write-file');
  assert.equal(typeof writeFile.description, 'string');
  assert.ok(writeFile.description.length > 0);
  assert.equal(writeFile.schema.type, 'object');
  assert.ok(Array.isArray(writeFile.schema.required));
  assert.ok(writeFile.schema.required.includes('path'));
  assert.ok(writeFile.schema.required.includes('content'));
});

test('write-file.execute: writes UTF-8 content, returns { ok, bytes, path }', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  const p = join(dir, 'out.txt');
  const body = 'hello world 你好\n';
  const r = await writeFile.execute({ path: p, content: body });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, Buffer.byteLength(body, 'utf8'));
  assert.equal(r.path, p);
  assert.equal(readFileSync(p, 'utf8'), body);
});

test('write-file.execute: overwrites existing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  const p = join(dir, 'overwrite.txt');
  const { writeFileSync: ws } = await import('node:fs');
  ws(p, 'OLD', 'utf8');
  const r = await writeFile.execute({ path: p, content: 'NEW' });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(p, 'utf8'), 'NEW');
});

test('write-file.execute: creates missing parent dirs (mkdir recursive)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  const p = join(dir, 'a', 'b', 'c', 'deep.txt');
  const r = await writeFile.execute({ path: p, content: 'deep' });
  assert.equal(r.ok, true);
  assert.ok(existsSync(p), 'file should exist after write');
  assert.equal(readFileSync(p, 'utf8'), 'deep');
});

test('write-file.execute: writes empty string (zero bytes)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  const p = join(dir, 'empty.txt');
  const r = await writeFile.execute({ path: p, content: '' });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 0);
  assert.equal(readFileSync(p, 'utf8'), '');
});

test('write-file.execute: throws TypeError on non-string path', async () => {
  await assert.rejects(
    () => writeFile.execute({ path: 1, content: 'x' }),
    (err) => err instanceof TypeError && /path/i.test(err.message),
  );
  await assert.rejects(
    () => writeFile.execute({ path: '', content: 'x' }),
    (err) => err instanceof TypeError,
  );
});

test('write-file.execute: throws TypeError on non-string content', async () => {
  await assert.rejects(
    () => writeFile.execute({ path: '/tmp/x', content: 123 }),
    (err) => err instanceof TypeError && /content/i.test(err.message),
  );
  await assert.rejects(
    () => writeFile.execute({ path: '/tmp/x', content: null }),
    (err) => err instanceof TypeError,
  );
  await assert.rejects(
    () => writeFile.execute({ path: '/tmp/x' }),
    (err) => err instanceof TypeError,
  );
});
