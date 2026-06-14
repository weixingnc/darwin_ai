/**
 * OpenClawSkillAdapter unit tests — PR-26a. 12 cases.
 * node:test + node:assert. Mirrors tests/core/skill-loader.test.js style.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOpenClawSkillFile,
  isOpenClawSkillContent,
} from '../../core/openclaw-skill-adapter.js';

const FM = (body, fm) => '---\n' + fm + '\n---\n' + body;

test('1. missing frontmatter → null', () => {
  assert.equal(parseOpenClawSkillFile('a.md', '# no fm'), null);
});
test('2. empty frontmatter `--- \\n---` → null (no name)', () => {
  assert.equal(parseOpenClawSkillFile('a.md', '---\n---\nbody'), null);
});
test('3. missing name → null', () => {
  assert.equal(parseOpenClawSkillFile('a.md', FM('b', 'description: hi')), null);
});
test('4. name with uppercase → lowercased to valid', () => {
  const e = parseOpenClawSkillFile('a.md', FM('b', 'name: Weather\ndescription: sky stuff'));
  assert.equal(e.name, 'weather');
});
test('5. L1 minimal (name only) → source=openclaw-l1, triggers=[name]', () => {
  const e = parseOpenClawSkillFile('a.md', FM('b', 'name: ping'));
  assert.equal(e.source, 'openclaw-l1');
  assert.deepEqual(e.triggers, ['ping']);
  assert.equal(e.triggerType, 'substring');
  assert.equal(e.priority, 50);
});
test('6. L2 complete → source=openclaw-l2, openclawMetadata preserved', () => {
  const e = parseOpenClawSkillFile(
    'a.md',
    FM(
      'b',
      "name: weather\ndescription: 'Get forecasts'\nmetadata: { openclaw: { emoji: ☔, requires: { bins: [curl] } } }",
    ),
  );
  assert.equal(e.source, 'openclaw-l2');
  assert.match(e.openclawMetadata, /openclaw/);
  assert.match(e.openclawMetadata, /☔/);
});
test('7. L2 english first sentence → ≤4 tokens, lowercase', () => {
  const e = parseOpenClawSkillFile(
    'a.md',
    FM('b', 'name: weather\ndescription: Current weather and forecasts with wttr.in via curl'),
  );
  assert.ok(e.triggers.length <= 4);
  assert.ok(e.triggers.every((t) => t === t.toLowerCase()));
});
test('8. L2 description with CJK punctuation → tokens split on CJK punct', () => {
  // Note: PR-21 NAME_RE is [a-z0-9-]+ (no CJK), so name is ASCII. CJK content
  // lives in `description`; inferTrig splits on Chinese punctuation 。
  const e = parseOpenClawSkillFile(
    'a.md',
    FM('b', 'name: weather\ndescription: 查询北京、上海、广州天气。'),
  );
  assert.ok(e.triggers.length >= 1);
  // First token is the first CJK block, lowercased
  assert.ok(e.triggers[0].includes('北京') || e.triggers[0].includes('查询'));
});
test('9. darwinTriggers explicit → overrides L2 inference', () => {
  const e = parseOpenClawSkillFile(
    'a.md',
    FM('b', 'name: weather\ndescription: unrelated text\ndarwinTriggers:\n  - /w\n  - forecast'),
  );
  assert.deepEqual(e.triggers, ['/w', 'forecast']);
});
test('10. darwinTriggerType command-prefix → triggerType correct', () => {
  const e = parseOpenClawSkillFile(
    'a.md',
    FM('b', 'name: weather\ndescription: hi\ndarwinTriggerType: command-prefix'),
  );
  assert.equal(e.triggerType, 'command-prefix');
});
test('11. description inferred to empty → fallback to [name], still loaded', () => {
  // description with only stopwords / punctuation → empty after inference → L1 fallback
  const e = parseOpenClawSkillFile('a.md', FM('b', 'name: x\ndescription: !!!'));
  assert.deepEqual(e.triggers, ['x']);
});
test('12. priority default 50; hint + systemPromptHint dual-key', () => {
  const e = parseOpenClawSkillFile('a.md', FM('b', 'name: x\ndescription: hello'));
  assert.equal(e.priority, 50);
  assert.equal(e.hint, 'hello');
  assert.equal(e.systemPromptHint, 'hello');
});
test('13. malformed input never throws; isOpenClawSkillContent gates v2', () => {
  // isOpenClawSkillContent is the routing function — PR-27 loader calls it
  // BEFORE deciding parser. v2 SKILL.md (has triggers/version) → false.
  assert.equal(isOpenClawSkillContent('no fm'), false);
  assert.equal(isOpenClawSkillContent(FM('b', 'name: x\ntriggers: [t]\nversion: 1.0.0')), false);
  assert.equal(isOpenClawSkillContent(FM('b', 'name: x\ndescription: y')), true);
  // name only (no v2 fields) → L1 OpenClaw
  assert.equal(isOpenClawSkillContent(FM('b', 'name: x')), true);
  // parseOpenClawSkillFile does not throw on bad inputs
  assert.equal(parseOpenClawSkillFile('a.md', null), null);
  assert.equal(parseOpenClawSkillFile('', '---\n---\n'), null);
});
