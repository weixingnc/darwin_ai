/**
 * Glob tool tests — V3_ROADMAP P1.
 *
 * Validates glob.execute() contract: pattern compilation, recursive walk,
 * posix-relative path output. NO npm dep used (no `glob` / `minimatch`).
 *
 * Run: `node --test tool/builtins/glob.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { glob } from './glob.js';

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'gl-'));
  // tree:
  //   a.js
  //   b.js
  //   c.txt
  //   sub/
  //     d.js
  //     deeper/
  //       e.js
  //   .hidden.js
  writeFileSync(join(root, 'a.js'), '');
  writeFileSync(join(root, 'b.js'), '');
  writeFileSync(join(root, 'c.txt'), '');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'd.js'), '');
  mkdirSync(join(root, 'sub', 'deeper'));
  writeFileSync(join(root, 'sub', 'deeper', 'e.js'), '');
  writeFileSync(join(root, '.hidden.js'), '');
  return root;
}

test('glob: shape conforms to tool contract', () => {
  assert.equal(typeof glob, 'object');
  assert.equal(glob.name, 'glob');
  assert.equal(typeof glob.description, 'string');
  assert.ok(glob.description.length > 0);
  assert.equal(glob.schema.type, 'object');
  assert.ok(Array.isArray(glob.schema.required));
  assert.ok(glob.schema.required.includes('pattern'));
});

test('glob.execute: ** matches all .js files recursively (incl. dotfiles)', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: '**/*.js', cwd: root });
  assert.ok(Array.isArray(r.files));
  const set = new Set(r.files);
  // posix-relative
  for (const f of r.files) {
    assert.ok(!f.includes('\\'), 'paths must be posix (no backslashes)');
  }
  assert.ok(set.has('a.js'), 'must match a.js');
  assert.ok(set.has('b.js'), 'must match b.js');
  assert.ok(set.has('sub/d.js'), 'must match sub/d.js');
  assert.ok(set.has('sub/deeper/e.js'), 'must match sub/deeper/e.js');
  assert.ok(!set.has('c.txt'), 'must NOT match c.txt');
  // Darwin's glob is deliberately minimal (no bash dotfile semantics).
  // `**` matches dotfiles too. If we ever need bash-style, add a
  // `dot: true` opt-in flag (not in P1-B1 scope).
  assert.ok(set.has('.hidden.js'), '** matches dotfiles (no bash dotfile semantics in P1-B1)');
});

test('glob.execute: * matches single-segment wildcard (no /)', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: '*.js', cwd: root });
  const set = new Set(r.files);
  assert.ok(set.has('a.js'));
  assert.ok(set.has('b.js'));
  assert.ok(!set.has('sub/d.js'), '* must NOT cross /');
  assert.ok(!set.has('sub/deeper/e.js'));
});

test('glob.execute: ? matches exactly one non-/ char', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: '?.js', cwd: root });
  const set = new Set(r.files);
  assert.ok(set.has('a.js'));
  assert.ok(set.has('b.js'));
  assert.ok(!set.has('c.txt'));
  assert.ok(!set.has('ab.js'), '? must match exactly one char');
});

test('glob.execute: [abc] character class', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: '[ab].js', cwd: root });
  const set = new Set(r.files);
  assert.ok(set.has('a.js'));
  assert.ok(set.has('b.js'));
  assert.ok(!set.has('c.txt'));
});

test('glob.execute: [!ab] negated character class', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: '[!ab].js', cwd: root });
  // [!ab] would match single-char filenames not in {a,b}; c.txt != .js suffix
  // and our pattern is `[!ab].js` — exact two-char filename + .js
  // => c.js, d.js, etc., but we only have a/b/c.txt/sub/...
  // c.txt doesn't match, so files = []
  assert.deepEqual(r.files, []);
});

test('glob.execute: subdir/**/*.js — recursive inside subdir', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: 'sub/**/*.js', cwd: root });
  const set = new Set(r.files);
  assert.ok(set.has('sub/d.js'));
  assert.ok(set.has('sub/deeper/e.js'));
  assert.ok(!set.has('a.js'), 'sub-prefix must restrict to sub/');
});

test('glob.execute: files are sorted', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: '**/*.js', cwd: root });
  const sorted = [...r.files].sort();
  assert.deepEqual(r.files, sorted, 'files array must be sorted');
});

test('glob.execute: returns relative posix paths even on platforms with \\', async () => {
  // sep is '/' on Linux, so this is a smoke test that the toPosix helper
  // is at least present and doesn't break output. On Linux, sep === '/',
  // so the path looks the same.
  const root = makeTree();
  const r = await glob.execute({ pattern: '**/*.js', cwd: root });
  for (const f of r.files) {
    assert.ok(f === f.split(sep).join('/'), 'path must use / separators');
  }
});

test('glob.execute: empty result for no match', async () => {
  const root = makeTree();
  const r = await glob.execute({ pattern: 'no-such-file-*.xyz', cwd: root });
  assert.deepEqual(r.files, []);
});

test('glob.execute: throws TypeError on non-string pattern', async () => {
  await assert.rejects(
    () => glob.execute({ pattern: 42 }),
    (err) => err instanceof TypeError && /pattern/i.test(err.message),
  );
  await assert.rejects(
    () => glob.execute({ pattern: '' }),
    (err) => err instanceof TypeError,
  );
  await assert.rejects(
    () => glob.execute({}),
    (err) => err instanceof TypeError,
  );
});
