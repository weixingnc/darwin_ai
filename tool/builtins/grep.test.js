/**
 * Grep tool tests — V3_ROADMAP P1.
 *
 * Validates grep.execute() contract: regex search across files under cwd,
 * returns { matches: [{file, line, text}] } with cwd-relative posix paths.
 * NO npm dep used (no `minimatch`); uses inline glob compiler for `include`.
 *
 * Run: `node --test tool/builtins/grep.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { grep } from './grep.js';

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'gr-'));
  // tree:
  //   a.js     (3 lines: l1=alpha, l2=TODO, l3=beta)
  //   b.js     (2 lines: l1=foo, l2=TODO)
  //   c.txt    (1 line: TODO)        — should be skipped by include=**/*.js
  //   sub/
  //     d.js   (1 line: TODO)        — matched recursively
  writeFileSync(join(root, 'a.js'), 'alpha\nTODO fix this\nbeta\n');
  writeFileSync(join(root, 'b.js'), 'foo\nTODO and that\n');
  writeFileSync(join(root, 'c.txt'), 'TODO txt\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'd.js'), 'TODO deep\n');
  return root;
}

test('grep: shape conforms to tool contract', () => {
  assert.equal(typeof grep, 'object');
  assert.equal(grep.name, 'grep');
  assert.equal(typeof grep.description, 'string');
  assert.ok(grep.description.length > 0);
  assert.equal(grep.schema.type, 'object');
  assert.ok(Array.isArray(grep.schema.required));
  assert.ok(grep.schema.required.includes('pattern'));
  assert.equal(grep.schema.properties.maxResults.type, 'integer');
});

test('grep.execute: returns { matches: [{file, line, text}] } shape', async () => {
  const root = makeTree();
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  assert.ok(Array.isArray(r.matches));
  assert.ok(r.matches.length > 0);
  for (const m of r.matches) {
    assert.equal(typeof m.file, 'string');
    assert.equal(typeof m.line, 'number');
    assert.equal(typeof m.text, 'string');
  }
});

test('grep.execute: empty / non-string / missing pattern → TypeError', async () => {
  await assert.rejects(
    () => grep.execute({ pattern: '' }),
    (err) => err instanceof TypeError && /pattern/i.test(err.message),
  );
  await assert.rejects(
    () => grep.execute({ pattern: 42 }),
    (err) => err instanceof TypeError,
  );
  await assert.rejects(
    () => grep.execute({}),
    (err) => err instanceof TypeError,
  );
});

test('grep.execute: bad regex → TypeError', async () => {
  await assert.rejects(
    () => grep.execute({ pattern: '[' }),
    (err) => err instanceof TypeError,
  );
});

test('grep.execute: no match → { matches: [] }', async () => {
  const root = makeTree();
  const r = await grep.execute({ pattern: 'NEVER_PRESENT_XYZ', cwd: root, include: '**/*.js' });
  assert.deepEqual(r.matches, []);
});

test('grep.execute: single file, line is 1-indexed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gr1-'));
  writeFileSync(join(root, 'only.js'), 'line one\nTODO match here\nline three\n');
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].line, 2, 'line must be 1-indexed (2, not 1)');
  assert.equal(r.matches[0].file, 'only.js');
  assert.match(r.matches[0].text, /TODO match here/);
});

test('grep.execute: multi-file, sorted by file then line', async () => {
  const root = makeTree();
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  // expected: a.js:l2, b.js:l2, sub/d.js:l1
  const files = r.matches.map((m) => m.file);
  assert.deepEqual(files, ['a.js', 'b.js', 'sub/d.js']);
  assert.equal(r.matches[0].line, 2);
  assert.equal(r.matches[1].line, 2);
  assert.equal(r.matches[2].line, 1);
});

test('grep.execute: maxResults caps total matches', async () => {
  const root = makeTree();
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js', maxResults: 2 });
  assert.equal(r.matches.length, 2, 'must cap at maxResults=2');
});

test('grep.execute: include glob skips non-matching extensions', async () => {
  const root = makeTree();
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  // c.txt has "TODO" but .js include must skip it
  for (const m of r.matches) {
    assert.ok(m.file.endsWith('.js'), `must skip .txt, got: ${m.file}`);
  }
  assert.equal(r.matches.length, 3, 'a.js + b.js + sub/d.js');
});

test('grep.execute: returns cwd-relative posix paths (no backslashes)', async () => {
  const root = makeTree();
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  for (const m of r.matches) {
    assert.ok(!m.file.includes('\\'), `path must be posix, got: ${m.file}`);
    assert.equal(m.file, m.file.split(sep).join('/'));
  }
});

test('grep.execute: cwd default is process.cwd()', async () => {
  // When cwd is omitted, default to process.cwd() and don't throw.
  // Use a long random sentinel that won't collide with any source file.
  const sentinel = 'GR_TEST_SENTINEL_4f3a9b1c7d8e2f6a_QQQ_ZZZZ';
  const r = await grep.execute({ pattern: sentinel });
  assert.ok(Array.isArray(r.matches));
  for (const m of r.matches) {
    assert.equal(typeof m.file, 'string');
    assert.equal(typeof m.line, 'number');
    assert.equal(typeof m.text, 'string');
  }
});

test('grep.execute: cwd override uses tmpdir as root', async () => {
  const root = makeTree();
  // Outside root, we should find nothing.
  const other = mkdtempSync(join(tmpdir(), 'grx-'));
  const r = await grep.execute({ pattern: 'TODO', cwd: other, include: '**/*.js' });
  assert.deepEqual(r.matches, []);
  // Inside root, we should find matches.
  const r2 = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  assert.ok(r2.matches.length > 0);
});

test('grep.execute: symlink to file is followed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grs-'));
  writeFileSync(join(root, 'real.js'), 'TODO in real\n');
  symlinkSync(join(root, 'real.js'), join(root, 'link.js'));
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  // Both real.js and link.js should appear (walking follows symlinks).
  const files = r.matches.map((m) => m.file).sort();
  assert.ok(files.includes('real.js'));
  assert.ok(files.includes('link.js'));
});

test('grep.execute: empty file → no crash, no match', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gre-'));
  writeFileSync(join(root, 'empty.js'), '');
  const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
  assert.deepEqual(r.matches, []);
});

test('grep.execute: binary file → no crash, may match', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grb-'));
  const buf = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x10]),
    Buffer.from('TODO'),
    Buffer.from([0x00, 0xab]),
  ]);
  writeFileSync(join(root, 'blob.bin'), buf);
  const r = await grep.execute({ pattern: 'TODO', cwd: root });
  // Regex tests each line; binary may split oddly. Just assert no throw + shape OK.
  assert.ok(Array.isArray(r.matches));
});

test('grep.execute: unreadable file is skipped silently, does not throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gru-'));
  const locked = join(root, 'locked.js');
  writeFileSync(locked, 'TODO here\n');
  // Skip if running as root (chmod 000 is bypassed for root).
  if (process.getuid && process.getuid() === 0) {
    const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
    assert.ok(Array.isArray(r.matches));
    return;
  }
  try {
    chmodSync(locked, 0o000);
    const r = await grep.execute({ pattern: 'TODO', cwd: root, include: '**/*.js' });
    assert.ok(Array.isArray(r.matches), 'must return matches array even if some files unreadable');
  } finally {
    try {
      chmodSync(locked, 0o644);
    } catch {
      /* ignore */
    }
  }
});
