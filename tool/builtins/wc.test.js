/** wc tool tests — V3_ROADMAP P1 (P3+ long-meat cycle 2). No npm dep. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wc } from './wc.js';

const ZERO = { lines: 0, words: 0, bytes: 0, files: 0 };

function makeTree() {
  // a.js:2L2W11B, b.js:1L3W14B, c.txt:1L2W10B, sub/d.js:2L3W18B (tab is whitespace)
  const root = mkdtempSync(join(tmpdir(), 'wc-'));
  writeFileSync(join(root, 'a.js'), 'alpha\nbeta\n');
  writeFileSync(join(root, 'b.js'), 'one two three\n');
  writeFileSync(join(root, 'c.txt'), 'TODO here\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'd.js'), 'deep\nnested\twords\n');
  return root;
}

test('wc: shape conforms to tool contract', () => {
  assert.equal(typeof wc, 'object');
  assert.equal(wc.name, 'wc');
  assert.equal(typeof wc.description, 'string');
  assert.ok(wc.description.length > 0);
  assert.equal(wc.schema.type, 'object');
  assert.ok(Array.isArray(wc.schema.required));
  assert.ok(!wc.schema.required.includes('cwd'));
  assert.ok(!wc.schema.required.includes('include'));
  assert.equal(wc.schema.properties.cwd.type, 'string');
  assert.equal(wc.schema.properties.include.type, 'string');
});

test('wc.execute: returns { lines, words, bytes, files } shape', async () => {
  const root = makeTree();
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  for (const k of ['lines', 'words', 'bytes', 'files']) {
    assert.equal(typeof r[k], 'number');
    assert.ok(Number.isInteger(r[k]));
  }
  assert.ok(r.files > 0);
});

test('wc.execute: empty result when no files match', async () => {
  const r = await wc.execute({ cwd: mkdtempSync(join(tmpdir(), 'wce-')), include: '**/*.js' });
  assert.deepEqual(r, ZERO);
});

test('wc.execute: single file exact lines/words/bytes/files', async () => {
  // "hello world\nfoo bar baz\n" → 24B, 2 lines (two \n), 5 words, 1 file
  const root = mkdtempSync(join(tmpdir(), 'wc1-'));
  writeFileSync(join(root, 'only.js'), 'hello world\nfoo bar baz\n');
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.bytes, 24);
  assert.equal(r.lines, 2);
  assert.equal(r.words, 5);
  assert.equal(r.files, 1);
});

test('wc.execute: multi-file sums across files', async () => {
  // include=**/*.js → a.js(2L/2W/11B) + b.js(1L/3W/14B) + d.js(2L/3W/18B) = 5L 8W 43B 3 files
  const r = await wc.execute({ cwd: makeTree(), include: '**/*.js' });
  assert.equal(r.files, 3);
  assert.equal(r.lines, 5);
  assert.equal(r.words, 8);
  assert.equal(r.bytes, 43);
});

test('wc.execute: include glob skips non-matching extensions', async () => {
  const root = makeTree();
  const rJs = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.equal(rJs.files, 3, 'must skip c.txt');
  const rAll = await wc.execute({ cwd: root, include: '**/*' });
  assert.equal(rAll.files, 4);
  // c.txt adds 10B, 1 line, 2 words
  assert.equal(rAll.bytes, rJs.bytes + 10);
  assert.equal(rAll.lines, rJs.lines + 1);
  assert.equal(rAll.words, rJs.words + 2);
});

test('wc.execute: cwd default is process.cwd() and does not throw', async () => {
  const r = await wc.execute({});
  for (const k of ['lines', 'words', 'bytes', 'files']) {
    assert.equal(typeof r[k], 'number');
    assert.ok(r[k] >= 0);
  }
});

test('wc.execute: cwd override uses tmpdir as root', async () => {
  const root = makeTree();
  const other = mkdtempSync(join(tmpdir(), 'wcx-'));
  assert.deepEqual(await wc.execute({ cwd: other, include: '**/*.js' }), ZERO);
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.ok(r.files > 0);
});

test('wc.execute: file unreadable (EACCES) skipped silently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wcu-'));
  const locked = join(root, 'locked.js');
  writeFileSync(locked, 'TODO here\n');
  if (process.getuid && process.getuid() === 0) {
    const r = await wc.execute({ cwd: root, include: '**/*.js' });
    assert.ok(r.files >= 1, 'root bypasses chmod 000');
    return;
  }
  try {
    chmodSync(locked, 0o000);
    assert.deepEqual(await wc.execute({ cwd: root, include: '**/*.js' }), ZERO);
  } finally {
    try {
      chmodSync(locked, 0o644);
    } catch {
      /* ignore */
    }
  }
});

test('wc.execute: symlink to file is followed (counts both)', async () => {
  // "a b c\n" = 6 bytes; two files (real.js + link.js) = 12 bytes, 2 lines, 6 words
  const root = mkdtempSync(join(tmpdir(), 'wcs-'));
  writeFileSync(join(root, 'real.js'), 'a b c\n');
  symlinkSync(join(root, 'real.js'), join(root, 'link.js'));
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.files, 2);
  assert.equal(r.bytes, 12);
  assert.equal(r.lines, 2);
  assert.equal(r.words, 6);
});

test('wc.execute: empty file is counted (files=1) with zeros', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wcz-'));
  writeFileSync(join(root, 'empty.js'), '');
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.deepEqual(r, { lines: 0, words: 0, bytes: 0, files: 1 });
});

test('wc.execute: file without trailing newline counts \\n chars (GNU wc -l)', async () => {
  // "one\ntwo\nthree" has 2 newlines → GNU wc -l reports 2 lines.
  // Spec: lines = number of \n chars (matches GNU wc -l semantics).
  const root = mkdtempSync(join(tmpdir(), 'wcn-'));
  writeFileSync(join(root, 'noTrailing.js'), 'one\ntwo\nthree');
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.lines, 2);
  assert.equal(r.words, 3);
  assert.equal(r.bytes, 13);
  assert.equal(r.files, 1);
});

test('wc.execute: word counting splits on whitespace (tabs+spaces)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wcw-'));
  writeFileSync(join(root, 'w.js'), '  hello\tworld  \n  foo\t\tbar  \n');
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.words, 4); // hello, world, foo, bar
});

test('wc.execute: byte counting uses utf-8 (Buffer.byteLength)', async () => {
  // "中文\n" → 4 utf-8 bytes + 1 (\n) = 7 bytes
  const root = mkdtempSync(join(tmpdir(), 'wcb-'));
  writeFileSync(join(root, 'u.js'), '中文\n');
  const r = await wc.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.bytes, 7);
  assert.equal(r.lines, 1);
  assert.equal(r.files, 1);
});

test('wc.execute: non-existent cwd returns zeros without throwing', async () => {
  const ghost = join(tmpdir(), 'wc-ghost-' + Date.now());
  assert.deepEqual(await wc.execute({ cwd: ghost, include: '**/*.js' }), ZERO);
});

test('wc.execute: binary file does not crash, bytes >= raw length', async () => {
  // Spec: bytes = Buffer.byteLength(content, 'utf8'). For invalid UTF-8 bytes,
  // the decoder emits U+FFFD (3 utf-8 bytes each), so byte count can grow
  // beyond the raw file size. Assert >= raw length, no crash.
  const root = mkdtempSync(join(tmpdir(), 'wcbin-'));
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0xff, 0x10, 0x00, 0xab]));
  const r = await wc.execute({ cwd: root, include: '**/*' });
  assert.ok(r.bytes >= 5, `bytes=${r.bytes} must be >= raw 5`);
  assert.equal(r.files, 1);
  assert.ok(r.lines >= 0);
  assert.ok(r.words >= 0);
});

test('wc.execute: very long line (>1MB) no whitespace: 0 \\n, 1 word, 2 MB bytes', async () => {
  // No \n in content → lines=0 (per GNU wc -l semantics: lines = \n count).
  // One whitespace-free token → words=1. bytes = utf-8 length = 2 MB.
  const root = mkdtempSync(join(tmpdir(), 'wcl-'));
  const bigFile = join(root, 'big.js');
  writeFileSync(bigFile, 'x'.repeat(2 * 1024 * 1024));
  try {
    const r = await wc.execute({ cwd: root, include: '**/*.js' });
    assert.equal(r.lines, 0);
    assert.equal(r.words, 1);
    assert.equal(r.bytes, 2 * 1024 * 1024);
    assert.equal(r.files, 1);
  } finally {
    try {
      rmSync(bigFile);
    } catch {
      /* ignore */
    }
  }
});
