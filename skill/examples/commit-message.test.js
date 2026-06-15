/** commit-message skill tests — TDD red→green. ADR-009 mechanical stub. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { commitMessage } from './commit-message.js';

const D = {
  docs: 'diff --git a/docs/V2_LAUNCH_NOTE.md b/docs/V2_LAUNCH_NOTE.md\n+hello\n',
  test: 'diff --git a/tests/foo.test.js b/tests/foo.test.js\n+it()\n',
  pkg: 'diff --git a/package.json b/package.json\n+{}\n',
  apply: 'diff --git a/evolution/apply.js b/evolution/apply.js\n+x\n',
  grep: 'diff --git a/tool/builtins/grep.js b/tool/builtins/grep.js\n+g\n',
  mixed:
    'diff --git a/core/a.js b/core/a.js\n+x\ndiff --git a/skill/examples/b.js b/skill/examples/b.js\n+y\n',
  stats: '+ one\n+ two\n+ three\n- old\n',
  rename:
    'diff --git a/old.js b/new.js\nsimilarity index 95%\nrename from old.js\nrename to new.js\n+ x\n',
  long: 'diff --git a/core/very-deeply-nested-module/very-long-file-name-here.js b/core/very-deeply-nested-module/very-long-file-name-here.js\n+h\n',
};
const ZERO = { files_changed: 0, insertions: 0, deletions: 0 };
const typeOf = async (d) => (await commitMessage.execute(d)).suggested.type;
const scopeOf = async (d) => (await commitMessage.execute(d)).suggested.scope;

describe('commit-message — catalog contract', () => {
  test('name', () => assert.equal(commitMessage.name, 'commit-message'));
  test('triggers', () => {
    for (const t of ['commit', 'commit message', 'commitmsg', '提交信息']) {
      assert.ok(commitMessage.triggers.includes(t), `missing: ${t}`);
    }
  });
  test('description non-empty', () => assert.ok(commitMessage.description.length > 0));
});

describe('commit-message — input guards', () => {
  test('empty diff', async () => {
    const r = await commitMessage.execute('');
    assert.equal(r.output, 'chore: empty diff');
    assert.equal(r.suggested.type, 'chore');
    assert.deepEqual(r.stats, ZERO);
  });
  test('invalid input', async () => {
    for (const bad of [null, undefined, 42, true, {}]) {
      const r = await commitMessage.execute(bad);
      assert.equal(r.output, 'chore: invalid input');
      assert.deepEqual(r.issues, []);
      assert.deepEqual(r.stats, ZERO);
    }
  });
});

describe('commit-message — auto type', () => {
  test('docs', async () => assert.equal(await typeOf(D.docs), 'docs'));
  test('test', async () => assert.equal(await typeOf(D.test), 'test'));
  test('chore', async () => assert.equal(await typeOf(D.pkg), 'chore'));
});

describe('commit-message — auto scope', () => {
  test('apply', async () => assert.equal(await scopeOf(D.apply), 'apply'));
  test('tool', async () => assert.equal(await scopeOf(D.grep), 'tool'));
  test('mixed → undefined', async () => assert.equal(await scopeOf(D.mixed), undefined));
});

describe('commit-message — stats', () => {
  test('+/- counts', async () => {
    const r = await commitMessage.execute(D.stats);
    assert.equal(r.stats.insertions, 3);
    assert.equal(r.stats.deletions, 1);
  });
});

describe('commit-message — options', () => {
  test('type override', async () =>
    assert.equal(
      (await commitMessage.execute(D.docs, { options: { type: 'feat' } })).suggested.type,
      'feat',
    ));
  test('scope override', async () =>
    assert.equal(
      (await commitMessage.execute(D.apply, { options: { scope: 'evolution' } })).suggested.scope,
      'evolution',
    ));
  test('breaking footer', async () => {
    const r = await commitMessage.execute('+ change\n', { options: { breaking: true } });
    assert.ok(r.suggested.footer.includes('BREAKING CHANGE'));
  });
});

describe('commit-message — format', () => {
  test('header ≤ 100', async () =>
    assert.ok((await commitMessage.execute(D.long)).output.split('\n')[0].length <= 100));
  test('valid type prefix', async () => {
    const r = await commitMessage.execute('+ hello\n');
    assert.ok(
      /^(feat|fix|docs|style|refactor|test|chore|perf|revert|merge)(\(.*\))?!?: /.test(r.output),
    );
  });
});

describe('commit-message — robustness', () => {
  test('10k lines', async () => {
    const r = await commitMessage.execute('+ const x = 1;\n'.repeat(10_000));
    assert.equal(typeof r.output, 'string');
    assert.ok(r.stats.insertions >= 10_000);
  });
  test('binary diff', async () =>
    assert.equal(
      typeof (await commitMessage.execute('Binary files a/img.png and b/img.png differ\n')).output,
      'string',
    ));
  test('rename = 1 file', async () =>
    assert.equal((await commitMessage.execute(D.rename)).stats.files_changed, 1));
});
