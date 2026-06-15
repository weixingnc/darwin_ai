import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { codeReview } from './code-review.js';

describe('code-review — catalog contract', () => {
  test('name matches the diagnose catalogue', () => assert.equal(codeReview.name, 'code-review'));
  test('triggers include review/code review/lgtm/检查代码', () => {
    for (const t of ['review', 'code review', 'lgtm', '检查代码']) {
      assert.ok(codeReview.triggers.includes(t), `missing trigger: ${t}`);
    }
  });
  test('description is non-empty', () => assert.ok(codeReview.description.length > 0));
});

describe('code-review — input guards', () => {
  test('empty diff → empty-diff response', async () => {
    const r = await codeReview.execute('');
    assert.equal(r.output, 'empty diff');
    assert.deepEqual(r.issues, []);
  });
  test('null/undefined/number/bool/object → invalid input', async () => {
    for (const bad of [null, undefined, 42, true, {}]) {
      const r = await codeReview.execute(bad);
      assert.equal(r.output, 'invalid input', `input=${String(bad)}`);
      assert.deepEqual(r.issues, []);
    }
  });
  test('summary present and zeroed on empty input', async () => {
    const s = (await codeReview.execute('')).summary;
    assert.equal(s.total, 0);
    assert.equal(s.errors, 0);
    assert.equal(s.warnings, 0);
    assert.equal(s.files_reviewed, 0);
  });
});

describe('code-review — built-in rules', () => {
  const fire = async (diff, rule) =>
    (await codeReview.execute(diff)).issues.find((i) => i.rule === rule);
  test('no-todo (warn)', async () =>
    assert.equal((await fire('+ // TODO: fix', 'no-todo')).severity, 'warn'));
  test('no-console-log (warn)', async () =>
    assert.equal((await fire("+ console.log('x');", 'no-console-log')).severity, 'warn'));
  test('no-debugger (error)', async () =>
    assert.equal((await fire('+ debugger;', 'no-debugger')).severity, 'error'));
  test('no-var (warn)', async () =>
    assert.equal((await fire('+ var x = 1;', 'no-var')).severity, 'warn'));
  test('no-empty-function (warn)', async () =>
    assert.equal((await fire('+ function foo() {}', 'no-empty-function')).severity, 'warn'));
  test('max-line-length default 100', async () =>
    assert.ok(await fire('+ ' + 'a'.repeat(200), 'max-line-length')));
  test('options.maxLineLength overrides default', async () => {
    const r = await codeReview.execute('+ ' + 'b'.repeat(60), { options: { maxLineLength: 50 } });
    assert.ok(r.issues.find((i) => i.rule === 'max-line-length'));
  });
});

describe('code-review — composition', () => {
  test('multi-rule diff surfaces issues from different rules', async () => {
    const r = await codeReview.execute('+ var x = 1;\n+ console.log(x);\n+ debugger;');
    const rules = new Set(r.issues.map((i) => i.rule));
    assert.ok(rules.has('no-var') && rules.has('no-console-log') && rules.has('no-debugger'));
    assert.equal(r.issues.length, 3);
  });
  test('summary counts errors and warnings', async () => {
    const s = (await codeReview.execute('+ var x = 1;\n+ debugger;')).summary;
    assert.equal(s.total, 2);
    assert.equal(s.errors, 1);
    assert.equal(s.warnings, 1);
  });
  test('options.rules restricts to specified rules only', async () => {
    const r = await codeReview.execute('+ var x = 1;\n+ debugger;', {
      options: { rules: ['no-var'] },
    });
    assert.ok(r.issues.every((i) => i.rule === 'no-var'));
  });
});

describe('code-review — robustness', () => {
  test('plain text without +/- prefix is treated as additions', async () => {
    assert.ok((await codeReview.execute('var x = 1;')).issues.find((i) => i.rule === 'no-var'));
  });
  test('very large diff (10k lines) does not crash', async () => {
    const r = await codeReview.execute('+ const x = 1;\n'.repeat(10_000));
    assert.equal(typeof r.output, 'string');
    assert.ok(Array.isArray(r.issues));
  });
});
