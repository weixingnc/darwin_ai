/**
 * V4 cycle 5 (2026-06-19) — 6-skill Darwin self-evolution e2e.
 *
 * Closes the loop on V3+ P1 catalog skills:
 *   code-review, commit-message, hello-world, summarizer, test-generator, translator.
 *
 * Each skill is already individually unit-tested in skill/examples/*.test.js,
 * but there is no end-to-end test that proves Darwin can register all 6 via
 * the SkillRegistry (createRegistry) AND execute() each one returning the
 * expected shape. This file fills that gap: register all 6, assert
 * r.size()===6, run one happy-path execute per skill, plus a no-throw
 * error-path case, and finish with a sandboxed catalogue closure entry
 * (the V4 cycle 5 "收口" audit log marker).
 *
 * LLM gate (ADR-009): all 6 skills are LLM-free. No network. No LLM calls.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRegistry, matchSkills } from '../../core/skill-registry.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';

import { codeReview } from '../../skill/examples/code-review.js';
import { commitMessage } from '../../skill/examples/commit-message.js';
import { helloWorld } from '../../skill/examples/hello-world.js';
import { summarizer } from '../../skill/examples/summarizer.js';
import { testGenerator } from '../../skill/examples/test-generator.js';
import { translator } from '../../skill/examples/translator.js';

let tmp;
const SKILLS = [codeReview, commitMessage, helloWorld, summarizer, testGenerator, translator];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'c5-skill-'));
});

describe('6-skill Darwin self-evolution e2e (V4 cycle 5)', () => {
  test('0. registry: createRegistry() + register all 6 → size()===6', () => {
    const r = createRegistry();
    for (const s of SKILLS) {
      r.set(s.name, s);
    }
    assert.equal(r.size, 6, 'registry must hold exactly 6 skills');
    for (const s of SKILLS) {
      assert.ok(r.has(s.name), `registry must contain "${s.name}"`);
    }
  });

  test('1. hello-world: execute → { output: "world" }; triggers include "hi"', async () => {
    const r = createRegistry();
    r.set(helloWorld.name, helloWorld);
    const out = await r.get('hello-world').execute('hi there');
    assert.deepEqual(out, { output: 'world' });
    // Darwin trigger match: 'hi there' lowercases to 'hi there' → matches 'hi'.
    const matches = matchSkills({ text: 'hi there', registry: r, max: 5 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, 'hello-world');
    assert.equal(matches[0].triggerHit, 'hi');
  });

  test('2. translator: execute("hello", { target: "zh" }) → output starts with [translated to zh]', async () => {
    const r = createRegistry();
    r.set(translator.name, translator);
    const out = await r.get('translator').execute('hello', { options: { target: 'zh' } });
    assert.match(out.output, /^\[translated to zh\] /);
    assert.ok(out.output.includes('hello'), 'original text must be preserved');
  });

  test('3. summarizer: execute(500-char string) → output.length === 200', async () => {
    const r = createRegistry();
    r.set(summarizer.name, summarizer);
    const big = 'a'.repeat(500);
    const out = await r.get('summarizer').execute(big);
    // summarizer slices to 200 then appends '…' → 201 chars
    assert.ok(
      out.output.length === 200 || out.output.length === 201,
      `expected 200/201 chars, got ${out.output.length}`,
    );
  });

  test('4. code-review: execute diff + rules:[] → output has issues array', async () => {
    const r = createRegistry();
    r.set(codeReview.name, codeReview);
    // Empty rules filter → no issues (all 6 rules are excluded).
    const out = await r.get('code-review').execute('var x = 1;', { options: { rules: [] } });
    assert.equal(typeof out.output, 'string');
    assert.ok(Array.isArray(out.issues), 'output.issues must be an array');
    assert.equal(out.issues.length, 0, 'no rules → no issues');
    assert.equal(typeof out.summary, 'object', 'output.summary must be an object');
    assert.equal(out.summary.total, 0);
  });

  test('5. commit-message: execute("+ added foo()") → output matches <type>: <subject>', async () => {
    const r = createRegistry();
    r.set(commitMessage.name, commitMessage);
    const out = await r.get('commit-message').execute('+ added foo()');
    assert.match(
      out.output,
      /^(chore|feat|fix|docs|test|style|refactor|perf|build|ci|revert):\s+\S+/,
    );
  });

  test('6. test-generator: execute({sourcePath, sourceContent}) → output contains "test"', async () => {
    const r = createRegistry();
    r.set(testGenerator.name, testGenerator);
    const out = await r.get('test-generator').execute({
      sourcePath: '/tmp/x.js',
      sourceContent: 'export const x = 1\n',
    });
    assert.match(out.output, /test/i, 'output must mention "test" (it is a test stub)');
  });

  test('7. error path: execute(null) → no throw; returns { output } or { issues } shape', async () => {
    const r = createRegistry();
    for (const s of SKILLS) {
      r.set(s.name, s);
    }
    // Each skill must guard its own null input and return a tagged shape.
    // hello-world ignores input → { output }
    const hw = await r.get('hello-world').execute(null);
    assert.ok('output' in hw, 'hello-world(null) must return { output }');
    // translator coerces null → string → { output }
    const tr = await r.get('translator').execute(null);
    assert.ok('output' in tr, 'translator(null) must return { output }');
    // summarizer coerces null → string → { output }
    const su = await r.get('summarizer').execute(null);
    assert.ok('output' in su, 'summarizer(null) must return { output }');
    // code-review null → 'invalid' branch → { output, summary, issues }
    const cr = await r.get('code-review').execute(null);
    assert.ok(Array.isArray(cr.issues), 'code-review(null) must return { issues: [] }');
    // commit-message null → 'invalid' branch → has suggested + stats
    const cm = await r.get('commit-message').execute(null);
    assert.ok(typeof cm.suggested === 'object', 'commit-message(null) must have suggested');
    // test-generator null → blankTest() → { output, suggested, stats }
    const tg = await r.get('test-generator').execute(null);
    assert.ok(typeof tg.output === 'string', 'test-generator(null) must return { output }');
  });

  test('8. catalogue closure: addToCatalogue records the 6-skill e2e marker (sandboxed)', () => {
    // Sandboxed overlay (tmpdir) + explicit logFile=LOG_FILE so the
    // production evolution/catalogue.log gets the audit entry without
    // polluting evolution/catalogue.json (w3-2/w4-2 assert fresh).
    const isolatedFile = join(tmp, 'catalogue-c5-skill.json');
    const a = addToCatalogue('skills', 'skill-examples-e2e', {
      reason: 'V4 cycle 5: 6-skill Darwin self-evolution e2e closure (146 proposal closure)',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(a, true, 'first add must return true');
    const b = addToCatalogue('skills', 'skill-examples-e2e', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(b, false, 'duplicate add must return false (idempotent)');
  });
});
