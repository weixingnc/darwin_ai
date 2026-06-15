/** tail tool tests — V3_ROADMAP P1 (P3+ cycle 4, 8/8 catalogue close). No npm dep. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tail } from './tail.js';
const T = (p) => mkdtempSync(join(tmpdir(), p));
const L = (n) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n') + '\n';
const L20 = L(20);
const tree = () => {
  const r = T('tail-');
  writeFileSync(
    join(r, 'a.js'),
    L(20).replace(/L(\d+)/g, (_, n) => `alpha-${n}`),
  );
  writeFileSync(join(r, 'b.js'), 'one\ntwo\nthree\n');
  writeFileSync(join(r, 'c.txt'), 't1\nt2\nt3\nt4\nt5\n');
  mkdirSync(join(r, 'sub'));
  writeFileSync(
    join(r, 'sub', 'd.js'),
    L(7).replace(/L(\d+)/g, (_, n) => `d-${n}`),
  );
  return r;
};
test('tail: shape conforms to tool contract', () => {
  assert.equal(typeof tail, 'object');
  assert.equal(tail.name, 'tail');
  assert.equal(typeof tail.description, 'string');
  assert.ok(tail.description.length > 0);
  assert.equal(tail.schema.type, 'object');
  assert.ok(Array.isArray(tail.schema.required));
  for (const k of ['cwd', 'include', 'n']) {
    assert.ok(!tail.schema.required.includes(k));
  }
  assert.equal(tail.schema.properties.cwd.type, 'string');
  assert.equal(tail.schema.properties.include.type, 'string');
  assert.equal(tail.schema.properties.n.type, 'integer');
});
test('tail.execute: returns { files: [{file, lines: string[]}] } shape', async () => {
  const r = await tail.execute({ cwd: tree(), include: '**/*.js' });
  assert.equal(typeof r, 'object');
  assert.ok(Array.isArray(r.files));
  assert.ok(r.files.length > 0);
  for (const e of r.files) {
    assert.equal(typeof e.file, 'string');
    assert.ok(Array.isArray(e.lines));
    for (const ln of e.lines) {
      assert.equal(typeof ln, 'string');
    }
  }
});
test('tail.execute: default n=10 — file with 20 lines returns last 10 in order', async () => {
  const r = T('tail-d-');
  writeFileSync(join(r, 'only.js'), L20);
  const out = await tail.execute({ cwd: r, include: '**/*.js' });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].file, 'only.js');
  assert.equal(out.files[0].lines.length, 10);
  assert.equal(out.files[0].lines[0], 'L11');
  assert.equal(out.files[0].lines[9], 'L20');
});
test('tail.execute: n=3 — returns last 3 lines of 20-line file in order', async () => {
  const r = T('tail-3-');
  writeFileSync(join(r, 'x.js'), L20);
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 3 });
  assert.deepEqual(out.files[0].lines, ['L18', 'L19', 'L20']);
});
test('tail.execute: n=0 means unlimited — returns all 20 lines', async () => {
  const r = T('tail-0-');
  writeFileSync(join(r, 'x.js'), L20);
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 0 });
  assert.equal(out.files[0].lines.length, 20);
  assert.equal(out.files[0].lines[0], 'L1');
  assert.equal(out.files[0].lines[19], 'L20');
});
test('tail.execute: file shorter than n returns all lines (no padding, no error)', async () => {
  const r = T('tail-s-');
  writeFileSync(join(r, 'short.js'), 'one\ntwo\nthree\n');
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 10 });
  assert.deepEqual(out.files[0].lines, ['one', 'two', 'three']);
});
test('tail.execute: empty file is listed with empty lines array', async () => {
  const r = T('tail-e-');
  writeFileSync(join(r, 'empty.js'), '');
  const out = await tail.execute({ cwd: r, include: '**/*.js' });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].file, 'empty.js');
  assert.deepEqual(out.files[0].lines, []);
});
test('tail.execute: multi-file — each file has its own last-N lines', async () => {
  const out = await tail.execute({ cwd: tree(), include: '**/*.js', n: 2 });
  assert.equal(out.files.length, 3);
  const byFile = Object.fromEntries(out.files.map((e) => [e.file, e.lines]));
  assert.deepEqual(byFile['a.js'], ['alpha-19', 'alpha-20']);
  assert.deepEqual(byFile['b.js'], ['two', 'three']);
  assert.deepEqual(byFile['sub/d.js'], ['d-6', 'd-7']);
});
test('tail.execute: include glob skips non-matching extensions', async () => {
  const r = tree();
  const rJs = await tail.execute({ cwd: r, include: '**/*.js' });
  for (const e of rJs.files) {
    assert.ok(e.file.endsWith('.js'));
  }
  assert.equal(rJs.files.length, 3);
  const rAll = await tail.execute({ cwd: r, include: '**/*', n: 2 });
  assert.equal(rAll.files.length, 4);
  const c = rAll.files.find((e) => e.file === 'c.txt');
  assert.ok(c);
  assert.deepEqual(c.lines, ['t4', 't5']);
});
test('tail.execute: cwd default is process.cwd() and does not throw', async () => {
  const out = await tail.execute({});
  assert.equal(typeof out, 'object');
  assert.ok(Array.isArray(out.files));
});
test('tail.execute: cwd override uses tmpdir as root (isolated)', async () => {
  const r = tree();
  const other = T('tail-x-');
  assert.equal((await tail.execute({ cwd: other, include: '**/*.js' })).files.length, 0);
  assert.equal((await tail.execute({ cwd: r, include: '**/*.js' })).files.length, 3);
});
test('tail.execute: file unreadable (EACCES) skipped silently', async () => {
  const r = T('tail-u-');
  const locked = join(r, 'locked.js');
  writeFileSync(locked, 'secret\nstuff\n');
  if (process.getuid && process.getuid() === 0) {
    assert.equal((await tail.execute({ cwd: r, include: '**/*.js' })).files.length, 1);
    return;
  }
  try {
    chmodSync(locked, 0o000);
    const out = await tail.execute({ cwd: r, include: '**/*.js' });
    assert.equal(out.files.length, 0, 'unreadable file must be skipped');
  } finally {
    try {
      chmodSync(locked, 0o644);
    } catch {
      /* ignore */
    }
  }
});
test('tail.execute: symlink to file is followed (both files return their last lines)', async () => {
  const r = T('tail-sym-');
  writeFileSync(join(r, 'real.js'), 'alpha\nbeta\ngamma\ndelta\n');
  symlinkSync(join(r, 'real.js'), join(r, 'link.js'));
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 3 });
  assert.deepEqual(out.files.map((e) => e.file).sort(), ['link.js', 'real.js']);
  for (const e of out.files) {
    assert.deepEqual(e.lines, ['beta', 'gamma', 'delta']);
  }
});
test('tail.execute: posix paths (no backslashes)', async () => {
  const r = T('tail-p-');
  mkdirSync(join(r, 'deep'));
  writeFileSync(join(r, 'deep', 'nested.js'), 'one\ntwo\nthree\n');
  const out = await tail.execute({ cwd: r, include: '**/*.js' });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].file, 'deep/nested.js');
  assert.ok(!out.files[0].file.includes('\\'), 'paths must be posix');
});
test('tail.execute: result is sorted by file path', async () => {
  const r = T('tail-sort-');
  writeFileSync(join(r, 'zeta.js'), 'z1\nz2\n');
  writeFileSync(join(r, 'alpha.js'), 'a1\na2\n');
  writeFileSync(join(r, 'mu.js'), 'm1\nm2\n');
  const out = await tail.execute({ cwd: r, include: '**/*.js' });
  assert.deepEqual(
    out.files.map((e) => e.file),
    ['alpha.js', 'mu.js', 'zeta.js'],
  );
});
test('tail.execute: file with no trailing newline — last line still counted', async () => {
  const r = T('tail-nt-');
  writeFileSync(join(r, 'noTrailing.js'), 'one\ntwo\nthree');
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 0 });
  assert.deepEqual(out.files[0].lines, ['one', 'two', 'three']);
});
test('tail.execute: n=1 returns only the last line', async () => {
  const r = T('tail-1-');
  writeFileSync(join(r, 'x.js'), 'first\nsecond\nthird\n');
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 1 });
  assert.equal(out.files[0].lines.length, 1);
  assert.equal(out.files[0].lines[0], 'third');
});
test('tail.execute: non-existent cwd returns empty files array (no throw)', async () => {
  const out = await tail.execute({
    cwd: join(tmpdir(), 'tail-ghost-' + Date.now()),
    include: '**/*.js',
  });
  assert.equal(out.files.length, 0);
});
test('tail.execute: last-N order with trailing \\n — n=2 of "a\\nb\\nc\\n" returns ["b","c"]', async () => {
  const r = T('tail-tl-');
  writeFileSync(join(r, 'three.js'), 'a\nb\nc\n');
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 2 });
  assert.deepEqual(out.files[0].lines, ['b', 'c']);
});
test('tail.execute: binary file does not crash (utf-8 decode may have invalid chars)', async () => {
  const r = T('tail-bin-');
  writeFileSync(join(r, 'blob.js'), Buffer.from([0xff, 0xfe, 0x41, 0x0a, 0x42, 0x0a, 0x43, 0x0a]));
  const out = await tail.execute({ cwd: r, include: '**/*.js', n: 10 });
  assert.equal(out.files.length, 1);
  assert.ok(out.files[0].lines.join('').length > 0);
});
