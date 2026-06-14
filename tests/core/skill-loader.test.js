/**
 * SkillLoader tests — PR-21a. 12 unit + 6 integration (18 cases).
 * node:test + node:assert (matches tests/core/ style).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFile, loadAll } from '../../core/skill-loader.js';
import { matchSkills, createRegistry } from '../../core/skill-registry.js';

const FM = (body, fm) => '---\n' + fm + '\n---\n' + body;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
const write = (d, n, c) => fs.writeFileSync(path.join(d, n), c);

// ── UNIT: parseSkillFile (12) ───────────────────────────────────────────

test('parse: missing frontmatter → null', () => {
  assert.equal(parseSkillFile('a.md', '# no fm'), null);
});
test('parse: empty frontmatter `--- \\n---` → null (no name)', () => {
  assert.equal(parseSkillFile('a.md', '---\n---\nbody'), null);
});
test('parse: missing name → null', () => {
  assert.equal(parseSkillFile('a.md', FM('b', 'priority: 50')), null);
});
test('parse: name with uppercase → lowercased to valid name', () => {
  // Design §1.3: name regex is [a-z0-9-]+. PR-21 normalises case at parse
  // time so the registry key is always lowercase (PR-23 match is
  // case-insensitive too, this is purely canonicalisation).
  const e = parseSkillFile('a.md', FM('b', 'name: Weather'));
  assert.equal(e.name, 'weather');
});
test('parse: name > 32 chars → null', () => {
  assert.equal(parseSkillFile('a.md', FM('b', 'name: ' + 'a'.repeat(33))), null);
});
test('parse: defaults triggerType=substring', () => {
  assert.equal(
    parseSkillFile('a.md', FM('b', 'name: x\ntriggers: [foo]')).triggerType,
    'substring',
  );
});
test('parse: explicit triggerType=exact accepted', () => {
  assert.equal(parseSkillFile('a.md', FM('b', 'name: x\ntriggerType: exact')).triggerType, 'exact');
});
test('parse: invalid triggerType → falls back to substring', () => {
  assert.equal(
    parseSkillFile('a.md', FM('b', 'name: x\ntriggerType: weird')).triggerType,
    'substring',
  );
});
test('parse: priority 250 → clamped to 100', () => {
  assert.equal(parseSkillFile('a.md', FM('b', 'name: x\npriority: 250')).priority, 100);
});
test('parse: priority -5 → clamped to 0', () => {
  assert.equal(parseSkillFile('a.md', FM('b', 'name: x\npriority: -5')).priority, 0);
});
test('parse: hint > 2000 chars → truncated', () => {
  const e = parseSkillFile('a.md', FM('b', 'name: x\nhint: "' + 'x'.repeat(3000) + '"'));
  assert.equal(e.hint.length, 2000);
});
test('parse: well-formed → full entry with body', () => {
  const e = parseSkillFile(
    'a.md',
    FM('# Real body', 'name: weather\nversion: 1.0.0\ntriggers:\n  - 天气\npriority: 70'),
  );
  assert.equal(e.name, 'weather');
  assert.equal(e.version, '1.0.0');
  assert.deepEqual(e.triggers, ['天气']);
  assert.equal(e.priority, 70);
  assert.equal(e.body, '# Real body');
});

// ── INTEGRATION: loadAll + register + unregister + PR-23 round-trip (6) ─

test('loadAll: 3 valid → all loaded, registry.size=3', () => {
  const d = tmp();
  write(d, 'a.md', FM('A', 'name: alpha\ntriggers: [a]'));
  write(d, 'b.markdown', FM('B', 'name: beta\ntriggers: [b]'));
  write(d, 'c.md', FM('C', 'name: gamma\ntriggers: [c]'));
  const r = createRegistry();
  const res = loadAll(d, r);
  assert.equal(res.loaded.length, 3);
  assert.equal(res.skipped.length, 0);
  assert.equal(r.size, 3);
});
test('loadAll: 1 broken + 2 valid → 2 loaded + 1 skipped, no throw', () => {
  const d = tmp();
  write(d, 'g1.md', FM('ok', 'name: g1\ntriggers: [x]'));
  write(d, 'bad.md', 'no frontmatter');
  write(d, 'g2.md', FM('ok', 'name: g2\ntriggers: [y]'));
  const r = createRegistry();
  const res = loadAll(d, r);
  assert.equal(res.loaded.length, 2);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].reason, 'parse_failed');
  assert.equal(r.size, 2);
});
test('loadAll: priority desc sort → high, mid, low insertion order', () => {
  const d = tmp();
  write(d, 'l.md', FM('L', 'name: low\npriority: 10'));
  write(d, 'h.md', FM('H', 'name: high\npriority: 90'));
  write(d, 'm.md', FM('M', 'name: mid\npriority: 50'));
  const r = createRegistry();
  loadAll(d, r);
  assert.deepEqual([...r.keys()], ['high', 'mid', 'low']);
});
test('loadAll: duplicate name → higher priority wins, lower in skipped', () => {
  const d = tmp();
  write(d, 'a.md', FM('A', 'name: x\npriority: 50'));
  write(d, 'b.md', FM('B', 'name: x\npriority: 80'));
  const r = createRegistry();
  const res = loadAll(d, r);
  assert.equal(r.size, 1);
  assert.equal(r.get('x').body, 'B');
  assert.equal(res.skipped[0].reason, 'duplicate_lower_priority');
});
test('loadAll + matchSkills: PR-23 reads systemPromptHint (dual key) case-insensitive', () => {
  const d = tmp();
  write(d, 'w.md', FM('Use weather tool.', 'name: weather\ntriggers: [天气]'));
  const r = createRegistry();
  loadAll(d, r);
  const matches = matchSkills({ text: '北京天气', registry: r, max: 2 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'weather');
  assert.equal(matches[0].systemHint, 'Use weather tool.');
});
test('loadAll: missing dir → empty result, no throw', () => {
  const r = createRegistry();
  const res = loadAll('/no/such/dir/' + Date.now(), r);
  assert.deepEqual(res.loaded, []);
  assert.equal(res.total, 0);
  assert.equal(r.size, 0);
});
