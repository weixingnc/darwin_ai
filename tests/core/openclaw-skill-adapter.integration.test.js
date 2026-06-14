/**
 * OpenClawSkillAdapter integration tests — PR-26a. 6 cases.
 * node:test + node:assert. End-to-end with registry + fs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptOpenClawSkills } from '../../core/openclaw-skill-adapter.js';
import { createRegistry, matchSkills } from '../../core/skill-registry.js';

const FM = (body, fm) => '---\n' + fm + '\n---\n' + body;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
const write = (d, n, c) => fs.writeFileSync(path.join(d, n), c);

test('1. 3 valid OpenClaw SKILL.md → registry.size=3', () => {
  const d = tmp();
  write(d, 'a.md', FM('A', 'name: alpha\ndescription: first skill'));
  write(d, 'b.md', FM('B', 'name: beta\ndescription: second skill'));
  write(d, 'c.md', FM('C', 'name: gamma\ndescription: third skill'));
  const r = createRegistry();
  const res = adaptOpenClawSkills(d, r);
  assert.equal(res.loaded, 3);
  assert.equal(r.size, 3);
  assert.equal(res.skipped.length, 0);
});

test('2. mixed L1+L2 → l1Count + l2Count accurate', () => {
  const d = tmp();
  write(d, 'l1.md', FM('A', 'name: l1only')); // L1 (no description)
  write(d, 'l2a.md', FM('A', 'name: l2a\ndescription: detailed thing'));
  write(d, 'l2b.md', FM('A', 'name: l2b\ndescription: hi\nmetadata: { openclaw: { emoji: ✨ } }'));
  const r = createRegistry();
  const res = adaptOpenClawSkills(d, r);
  assert.equal(res.loaded, 3);
  assert.equal(res.l1Count, 1);
  assert.equal(res.l2Count, 2);
});

test('3. skillsDir does not exist → empty result, no throw', () => {
  const r = createRegistry();
  const res = adaptOpenClawSkills('/nonexistent/path/xyz', r);
  assert.equal(res.loaded, 0);
  assert.equal(res.total, 0);
  assert.equal(r.size, 0);
});

test('4. real OpenClaw fixture (weather SKILL.md) end-to-end → matchable via PR-23', () => {
  const d = tmp();
  write(
    d,
    'weather.md',
    FM(
      'Use wttr.in to fetch weather data.',
      "name: weather\ndescription: 'Current weather and forecasts with wttr.in via curl for locations, rain, temperature, travel planning.'\nmetadata: { openclaw: { emoji: ☔, requires: { bins: [curl] } } }",
    ),
  );
  const r = createRegistry();
  const res = adaptOpenClawSkills(d, r);
  assert.equal(res.loaded, 1);
  // PR-23 matchSkills should find it via inferred trigger
  const matches = matchSkills({ text: 'what is the weather in Shanghai', registry: r, max: 2 });
  assert.ok(matches.length >= 1, 'expected at least one match');
  assert.equal(matches[0].name, 'weather');
  assert.match(matches[0].systemHint, /wttr\.in/);
});

test('5. duplicate name + lower priority → skipped (PR-21 contract)', () => {
  const d = tmp();
  write(d, 'a.md', FM('A', 'name: dup\ndescription: first\ndarwinPriority: 80'));
  write(d, 'b.md', FM('B', 'name: dup\ndescription: second\ndarwinPriority: 30'));
  const r = createRegistry();
  const res = adaptOpenClawSkills(d, r);
  assert.equal(res.loaded, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].reason, 'duplicate_lower_priority');
  assert.equal(r.size, 1);
});

test('6. corrupt files → skipped, loaded count excludes them', () => {
  const d = tmp();
  write(d, 'good.md', FM('A', 'name: ok\ndescription: valid'));
  write(d, 'bad1.md', 'no frontmatter at all');
  write(d, 'bad2.md', FM('A', 'description: nameless skill'));
  write(d, 'bad3.md', '---\n---\nno name either');
  const r = createRegistry();
  const res = adaptOpenClawSkills(d, r);
  assert.equal(res.total, 4);
  assert.equal(res.loaded, 1);
  assert.equal(res.skipped.length, 3);
  for (const s of res.skipped) {
    assert.ok(['openclaw_compat_failed', 'read_error', 'invalid_name'].includes(s.reason));
  }
});
