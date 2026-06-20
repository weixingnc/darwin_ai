/**
 * Darwin Skill Contract -- V10.5 cross-sibling shape guard.
 *
 * For every skill under skill/examples/, this test pins the exact set of
 * keys that execute() returns. The expected shape lives in
 * `docs/skill-contract.md` (the authoritative table). If anyone changes
 * a return shape (adds / drops a key), this test fails and forces a
 * contract-aware redesign.
 *
 * Universal invariant: `output` is a non-empty string for every skill.
 *
 * Per-skill inputs are kept minimal (string or `{topic, payload}` shape)
 * so the test does not depend on any provider / LLM / network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { helloWorld } from '../skill/examples/hello-world.js';
import { summarizer } from '../skill/examples/summarizer.js';
import { translator } from '../skill/examples/translator.js';
import { codeReview } from '../skill/examples/code-review.js';
import { commitMessage } from '../skill/examples/commit-message.js';
import { testGenerator } from '../skill/examples/test-generator.js';
import { feishuCard } from '../skill/examples/feishu-card.js';

const SINGLE_KEY = ['output'];

describe('Skill contract -- single-key shape (output only)', () => {
  for (const [name, skill, input, ctx] of [
    ['hello-world', helloWorld, 'hello', undefined],
    ['summarizer', summarizer, 'Some long text that should be summarized.', undefined],
    ['translator', translator, 'Hello', { options: { target: 'zh' } }],
    [
      'feishu-card (V8.2 aligned)',
      feishuCard,
      { topic: 'evolution:audit', payload: { proposal_id: 'p-1' } },
      undefined,
    ],
  ]) {
    test(`${name}: execute() returns exactly { output: string }`, async () => {
      const r = await skill.execute(input, ctx);
      assert.deepEqual(Object.keys(r).sort(), SINGLE_KEY);
      assert.equal(typeof r.output, 'string');
      assert.ok(r.output.length > 0, `${name}.output should be non-empty`);
    });
  }
});

describe('Skill contract -- multi-key shape (output + programmatic hints)', () => {
  test('commit-message: execute() returns { output, suggested, stats }', async () => {
    const r = await commitMessage.execute('diff --git a/foo.js b/foo.js\n+new line', {});
    // On the valid path: output + suggested + stats.
    // On the 'invalid' input path: also has issues: [].
    const keys = Object.keys(r).sort();
    assert.ok(
      keys.includes('output') && keys.includes('suggested') && keys.includes('stats'),
      `commit-message must include output/suggested/stats, got: ${JSON.stringify(keys)}`,
    );
    assert.equal(typeof r.output, 'string');
    assert.ok(r.output.length > 0);
  });

  test('test-generator: execute() returns { output, suggested, stats }', async () => {
    const r = await testGenerator.execute('export function add(a, b) { return a + b; }', {
      sourcePath: '/tmp/add.js',
    });
    const keys = Object.keys(r).sort();
    assert.ok(
      keys.includes('output') && keys.includes('suggested') && keys.includes('stats'),
      `test-generator must include output/suggested/stats, got: ${JSON.stringify(keys)}`,
    );
    assert.equal(typeof r.output, 'string');
    assert.ok(r.output.length > 0);
  });

  test('code-review: execute() returns { output, summary, issues }', async () => {
    const r = await codeReview.execute('var x = 1; console.log(x);', {});
    const keys = Object.keys(r).sort();
    assert.ok(
      keys.includes('output') && keys.includes('summary') && keys.includes('issues'),
      `code-review must include output/summary/issues, got: ${JSON.stringify(keys)}`,
    );
    assert.equal(typeof r.output, 'string');
    assert.ok(r.output.length > 0);
  });
});

describe('Skill contract -- universal output invariant', () => {
  test('every skill: output is always a non-empty string', async () => {
    const cases = [
      ['hello-world', () => helloWorld.execute('hi')],
      ['summarizer', () => summarizer.execute('text to summarize')],
      ['translator', () => translator.execute('bonjour', { options: { target: 'en' } })],
      ['feishu-card', () => feishuCard.execute({ topic: 'evolution:audit', payload: {} })],
      ['commit-message', () => commitMessage.execute('+added line')],
      [
        'test-generator',
        () => testGenerator.execute('export const x = 1;', { sourcePath: '/tmp/x.js' }),
      ],
      ['code-review', () => codeReview.execute('var x = 1;')],
    ];
    for (const [name, runner] of cases) {
      const r = await runner();
      assert.equal(typeof r.output, 'string', `${name}.output should be string`);
      assert.ok(r.output.length > 0, `${name}.output should be non-empty`);
    }
  });
});
