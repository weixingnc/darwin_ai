import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchSkillsDir, closeWatch } from '../../core/skill-watcher.js';
import { loadAll } from '../../core/skill-loader.js';
import { createRegistry } from '../../core/skill-registry.js';
const FM = (fm, b) => '---\n' + fm + '\n---\n' + b;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
const W = (d, n, c) => fs.writeFileSync(path.join(d, n), c);
const sl = (ms) => new Promise((r) => setTimeout(r, ms));
test('debounce: 3 rapid changes → 1 reparse', async () => {
  const d = tmp();
  W(d, 'g.md', FM('name: g\npriority: 10', 'v1'));
  const r = createRegistry();
  loadAll(d, r);
  const h = watchSkillsDir(d, r, { debounceMs: 30 });
  const before = r.get('g').body;
  for (const p of [20, 30, 40]) {
    W(d, 'g.md', FM('name: g\npriority: ' + p, 'v' + p));
    await sl(10);
  }
  await sl(80);
  assert.equal(r.size, 1);
  assert.notEqual(r.get('g').body, before);
  closeWatch(h);
});
test('delete: file removed → unregisterSkill', async () => {
  const d = tmp();
  W(d, 'k.md', FM('name: k\ntriggers: [k]', 'K'));
  const r = createRegistry();
  loadAll(d, r);
  const h = watchSkillsDir(d, r, { debounceMs: 20 });
  assert.equal(r.has('k'), true);
  fs.unlinkSync(path.join(d, 'k.md'));
  await sl(60);
  assert.equal(r.has('k'), false);
  closeWatch(h);
});
test('broken reparse: invalid file → keep old entry', async () => {
  const d = tmp();
  W(d, 'b.md', FM('name: b\ntriggers: [b]', 'first'));
  const r = createRegistry();
  loadAll(d, r);
  const h = watchSkillsDir(d, r, { debounceMs: 20 });
  W(d, 'b.md', 'no frontmatter at all');
  await sl(60);
  assert.equal(r.has('b'), true);
  assert.equal(r.get('b').body, 'first');
  closeWatch(h);
});
test('close: later file changes do not touch registry', async () => {
  const d = tmp();
  W(d, 'c.md', FM('name: c\ntriggers: [c]', 'orig'));
  const r = createRegistry();
  loadAll(d, r);
  const h = watchSkillsDir(d, r, { debounceMs: 20 });
  closeWatch(h);
  W(d, 'c.md', FM('name: c\ntriggers: [c]', 'after'));
  await sl(60);
  assert.equal(r.get('c').body, 'orig');
});
test('missing dir: paused handle + error, no throw', () => {
  const r = createRegistry();
  const h = watchSkillsDir('/no/such/dir/' + Date.now(), r, { debounceMs: 20 });
  assert.equal(h.paused, true);
  assert.ok(h.error);
  closeWatch(h);
});
test('on(error): subscribe API exposes listener registration', () => {
  const r = createRegistry();
  const h = watchSkillsDir(tmp(), r, { debounceMs: 20 });
  let n = 0;
  h.on('error', () => n++);
  h.on('not-real', () => n++);
  assert.equal(typeof h.on, 'function');
  assert.equal(n, 0);
  closeWatch(h);
});
