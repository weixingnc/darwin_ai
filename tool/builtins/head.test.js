/**
 * head tool tests — V3_ROADMAP P1 (P3+ long-meat cycle 3). No npm dep.
 * 17 cases; self-contained mkdtempSync tmp-trees (mirrors wc.test.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { head } from './head.js';

/** 4-file tree: a.js(20L), b.js(3L), c.txt(5L), sub/d.js(7L) */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'head-'));
  const a = Array.from({ length: 20 }, (_, i) => `alpha-${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'a.js'), a);
  writeFileSync(join(root, 'b.js'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'c.txt'), 't1\nt2\nt3\nt4\nt5\n');
  mkdirSync(join(root, 'sub'));
  const d = Array.from({ length: 7 }, (_, i) => `d-${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'sub', 'd.js'), d);
  return root;
}

test('head: shape conforms to tool contract', () => {
  assert.equal(typeof head, 'object');
  assert.equal(head.name, 'head');
  assert.equal(typeof head.description, 'string');
  assert.ok(head.description.length > 0);
  assert.equal(head.schema.type, 'object');
  assert.ok(Array.isArray(head.schema.required));
  for (const k of ['cwd', 'include', 'n']) {
    assert.ok(!head.schema.required.includes(k));
  }
  assert.equal(head.schema.properties.cwd.type, 'string');
  assert.equal(head.schema.properties.include.type, 'string');
  assert.equal(head.schema.properties.n.type, 'integer');
});

test('head.execute: returns { files: [{file, lines: string[]}] } shape', async () => {
  const r = await head.execute({ cwd: makeTree(), include: '**/*.js' });
  assert.equal(typeof r, 'object');
  assert.ok(Array.isArray(r.files));
  assert.ok(r.files.length > 0);
  for (const entry of r.files) {
    assert.equal(typeof entry.file, 'string');
    assert.ok(Array.isArray(entry.lines));
    for (const ln of entry.lines) {
      assert.equal(typeof ln, 'string');
    }
  }
});

test('head.execute: default n=10 — file with 20 lines returns 10 lines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-d-'));
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'only.js'), lines);
  const r = await head.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].file, 'only.js');
  assert.equal(r.files[0].lines.length, 10);
  assert.equal(r.files[0].lines[0], 'L1');
  assert.equal(r.files[0].lines[9], 'L10');
});
test('head.execute: n=3 — returns first 3 lines of 20-line file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-3-'));
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'x.js'), lines);
  const r = await head.execute({ cwd: root, include: '**/*.js', n: 3 });
  assert.equal(r.files[0].lines.length, 3);
  assert.deepEqual(r.files[0].lines, ['L1', 'L2', 'L3']);
});
test('head.execute: n=0 means unlimited — returns all 20 lines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-0-'));
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'x.js'), lines);
  const r = await head.execute({ cwd: root, include: '**/*.js', n: 0 });
  assert.equal(r.files[0].lines.length, 20);
  assert.equal(r.files[0].lines[0], 'L1');
  assert.equal(r.files[0].lines[19], 'L20');
});
test('head.execute: file shorter than n returns all lines (no padding, no error)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-s-'));
  writeFileSync(join(root, 'short.js'), 'one\ntwo\nthree\n');
  const r = await head.execute({ cwd: root, include: '**/*.js', n: 10 });
  assert.equal(r.files[0].lines.length, 3);
  assert.deepEqual(r.files[0].lines, ['one', 'two', 'three']);
});
test('head.execute: empty file is listed with empty lines array', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-e-'));
  writeFileSync(join(root, 'empty.js'), '');
  const r = await head.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].file, 'empty.js');
  assert.deepEqual(r.files[0].lines, []);
});

test('head.execute: multi-file — each file has its own lines array', async () => {
  const r = await head.execute({ cwd: makeTree(), include: '**/*.js', n: 5 });
  assert.equal(r.files.length, 3);
  const byFile = Object.fromEntries(r.files.map((e) => [e.file, e.lines]));
  assert.equal(byFile['a.js'].length, 5);
  assert.equal(byFile['a.js'][0], 'alpha-1');
  assert.equal(byFile['b.js'].length, 3);
  assert.deepEqual(byFile['b.js'], ['one', 'two', 'three']);
  assert.equal(byFile['sub/d.js'].length, 5);
  assert.equal(byFile['sub/d.js'][0], 'd-1');
});
test('head.execute: include glob skips non-matching extensions', async () => {
  const root = makeTree();
  const rJs = await head.execute({ cwd: root, include: '**/*.js' });
  for (const entry of rJs.files) {
    assert.ok(entry.file.endsWith('.js'));
  }
  assert.equal(rJs.files.length, 3);
  const rAll = await head.execute({ cwd: root, include: '**/*' });
  assert.equal(rAll.files.length, 4);
  const c = rAll.files.find((e) => e.file === 'c.txt');
  assert.ok(c);
  assert.equal(c.lines.length, 5);
});
test('head.execute: cwd default is process.cwd() and does not throw', async () => {
  const r = await head.execute({});
  assert.equal(typeof r, 'object');
  assert.ok(Array.isArray(r.files));
});
test('head.execute: cwd override uses tmpdir as root (isolated)', async () => {
  const root = makeTree();
  const other = mkdtempSync(join(tmpdir(), 'head-x-'));
  const r0 = await head.execute({ cwd: other, include: '**/*.js' });
  assert.equal(r0.files.length, 0);
  const r1 = await head.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r1.files.length, 3);
});

test('head.execute: file unreadable (EACCES) skipped silently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-u-'));
  const locked = join(root, 'locked.js');
  writeFileSync(locked, 'secret\nstuff\n');
  if (process.getuid && process.getuid() === 0) {
    // root bypasses chmod 000
    const r = await head.execute({ cwd: root, include: '**/*.js' });
    assert.equal(r.files.length, 1);
    return;
  }
  try {
    chmodSync(locked, 0o000);
    const r = await head.execute({ cwd: root, include: '**/*.js' });
    assert.equal(r.files.length, 0, 'unreadable file must be skipped');
  } finally {
    try {
      chmodSync(locked, 0o644);
    } catch {
      /* ignore */
    }
  }
});

test('head.execute: symlink to file is followed (both files return their lines)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-sym-'));
  writeFileSync(join(root, 'real.js'), 'alpha\nbeta\ngamma\n');
  symlinkSync(join(root, 'real.js'), join(root, 'link.js'));
  const r = await head.execute({ cwd: root, include: '**/*.js', n: 2 });
  const files = r.files.map((e) => e.file).sort();
  assert.deepEqual(files, ['link.js', 'real.js']);
  for (const entry of r.files) {
    assert.deepEqual(entry.lines, ['alpha', 'beta']);
  }
});
test('head.execute: posix paths (no backslashes)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-p-'));
  mkdirSync(join(root, 'deep'));
  writeFileSync(join(root, 'deep', 'nested.js'), 'one\ntwo\n');
  const r = await head.execute({ cwd: root, include: '**/*.js' });
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].file, 'deep/nested.js');
  assert.ok(!r.files[0].file.includes('\\'), 'paths must be posix');
});
test('head.execute: result is sorted by file path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-sort-'));
  writeFileSync(join(root, 'zeta.js'), 'z1\nz2\n');
  writeFileSync(join(root, 'alpha.js'), 'a1\na2\n');
  writeFileSync(join(root, 'mu.js'), 'm1\nm2\n');
  const r = await head.execute({ cwd: root, include: '**/*.js' });
  const files = r.files.map((e) => e.file);
  assert.deepEqual(files, ['alpha.js', 'mu.js', 'zeta.js']);
});
test('head.execute: file with no trailing newline — last line still counted', async () => {
  // "one\ntwo\nthree" → split('\n') = ['one','two','three'] (no trailing '' entry)
  const root = mkdtempSync(join(tmpdir(), 'head-nt-'));
  writeFileSync(join(root, 'noTrailing.js'), 'one\ntwo\nthree');
  const r = await head.execute({ cwd: root, include: '**/*.js', n: 0 });
  assert.deepEqual(r.files[0].lines, ['one', 'two', 'three']);
});
test('head.execute: n=1 returns only the first line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'head-1-'));
  writeFileSync(join(root, 'x.js'), 'first\nsecond\nthird\n');
  const r = await head.execute({ cwd: root, include: '**/*.js', n: 1 });
  assert.equal(r.files[0].lines.length, 1);
  assert.equal(r.files[0].lines[0], 'first');
});

test('head.execute: non-existent cwd returns empty files array (no throw)', async () => {
  const ghost = join(tmpdir(), 'head-ghost-' + Date.now());
  const r = await head.execute({ cwd: ghost, include: '**/*.js' });
  assert.equal(r.files.length, 0);
});
