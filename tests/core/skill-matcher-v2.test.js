/**
 * SkillMatcherV2 unit tests — PR-26b. 12 cases.
 * node:test + node:assert. Mirrors tests/core/openclaw-skill-adapter.test.js.
 * Design: docs/PR_DESIGN_26_OPENCLAW_COMPAT.md §8.3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSkillsV2, matchByTriggerType } from '../../core/skill-matcher-v2.js';
import { matchSkills } from '../../core/skill-registry.js';

// Silence stderr (warns) for tests that intentionally trigger fallbacks.
const silent = () => {
  const o = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  return () => {
    process.stderr.write = o;
  };
};
const E = (name, triggers, tt, hint = 'h') => ({
  name,
  triggers,
  triggerType: tt,
  hint,
  systemPromptHint: hint,
});

test('1. substring hit — byte-equal to PR-23 matchSkills', () => {
  const r = new Map();
  r.set('w', E('w', ['天气', 'weather'], 'substring'));
  const t = '北京天气怎么样';
  const strip = (arr) =>
    arr.map((m) => ({
      name: m.name,
      triggerHit: m.triggerHit,
      systemHint: m.systemHint,
      source: m.source,
    }));
  assert.deepEqual(
    strip(matchSkillsV2({ text: t, registry: r })),
    strip(matchSkills({ text: t, registry: r })),
  );
  const v = matchSkillsV2({ text: t, registry: r })[0];
  assert.equal(v.matcherVersion, 'v2');
  assert.equal(v.triggerType, 'substring');
});

test('2. exact hit — case-insensitive trimmed; no substring-of match', () => {
  const r = new Map();
  r.set('p', E('p', ['ping'], 'exact'));
  assert.equal(matchSkillsV2({ text: '  PING  ', registry: r }).length, 1);
  assert.equal(
    matchSkillsV2({ text: 'pingpong', registry: r }).length,
    0,
    'exact must not substring-match',
  );
});

test('3. regex hit — `.*` and case-insensitive', () => {
  const r = new Map();
  r.set('w', E('w', ['wea.*er'], 'regex'));
  assert.equal(matchSkillsV2({ text: 'the WEATHER today', registry: r }).length, 1);
  assert.equal(matchSkillsV2({ text: 'sunny', registry: r }).length, 0);
});

test('4. command-prefix hit — `/` trigger', () => {
  const r = new Map();
  r.set('w', E('w', ['/weather'], 'command-prefix'));
  assert.equal(matchSkillsV2({ text: '/weather now', registry: r }).length, 1);
  assert.equal(matchSkillsV2({ text: 'tell me weather', registry: r }).length, 0);
});

test('5. empty text / null text / null registry → []', () => {
  assert.deepEqual(matchSkillsV2({ text: '', registry: new Map() }), []);
  assert.deepEqual(matchSkillsV2({ text: null, registry: new Map() }), []);
  assert.deepEqual(matchSkillsV2({ text: 'hi' }), []);
  assert.deepEqual(matchSkillsV2({ text: 'hi', registry: null }), []);
});

test('6. registry empty → []', () => {
  assert.deepEqual(matchSkillsV2({ text: 'hello', registry: new Map() }), []);
});

test('7. triggerType missing → substring default (PR-21a legacy compat)', () => {
  const R = silent();
  try {
    const r = new Map();
    r.set('w', { name: 'w', triggers: ['天气'], systemPromptHint: 'h' }); // no triggerType
    const m = matchSkillsV2({ text: '北京天气', registry: r });
    assert.equal(m.length, 1);
    assert.equal(m[0].triggerType, 'substring');
    assert.equal(m[0].triggerHit, '天气');
  } finally {
    R();
  }
});

test('8. triggerType invalid → warn + substring fallback', () => {
  const R = silent();
  try {
    const r = new Map();
    r.set('w', E('w', ['天气'], 'glob'));
    const m = matchSkillsV2({ text: '北京天气', registry: r });
    assert.equal(m.length, 1);
    assert.equal(m[0].triggerType, 'substring');
  } finally {
    R();
  }
});

test('9. regex compile fail → warn + substring fallback for that trigger', () => {
  const R = silent();
  try {
    const r = new Map();
    r.set('w', E('w', ['[invalid'], 'regex'));
    const m = matchSkillsV2({ text: 'has [invalid] inside', registry: r });
    assert.equal(m.length, 1);
    assert.equal(m[0].triggerHit, '[invalid');
  } finally {
    R();
  }
});

test('10. command-prefix trigger without `/` → warn + substring fallback', () => {
  const R = silent();
  try {
    const r = new Map();
    r.set('w', E('w', ['weather'], 'command-prefix'));
    const m = matchSkillsV2({ text: 'tell me weather now', registry: r });
    assert.equal(m.length, 1);
    assert.equal(m[0].triggerHit, 'weather');
  } finally {
    R();
  }
});

test('11. perf — 1000 substring entries < 10ms (clean, no warns)', () => {
  const r = new Map();
  for (let i = 0; i < 1000; i++) {
    r.set('s' + i, E('s' + i, ['trigger' + i, 'foo' + i], 'substring'));
  }
  matchSkillsV2({ text: 'trigger500', registry: r }); // warmup
  const s = performance.now();
  for (let i = 0; i < 10; i++) {
    matchSkillsV2({ text: 'trigger500', registry: r });
  }
  const avg = (performance.now() - s) / 10;
  assert.ok(avg < 10, `expected < 10ms, got ${avg.toFixed(2)}ms`);
});

test('12. matchByTriggerType — null on empty hint / malformed entry / empty triggers', () => {
  assert.equal(
    matchByTriggerType(
      { name: 'x', triggers: ['x'], triggerType: 'substring', systemPromptHint: '' },
      'x',
    ),
    null,
  );
  assert.equal(matchByTriggerType(null, 'x'), null);
  assert.equal(matchByTriggerType({}, 'x'), null);
  assert.equal(
    matchByTriggerType(
      { name: 'x', triggers: [], triggerType: 'substring', systemPromptHint: 'h' },
      'x',
    ),
    null,
  );
});
