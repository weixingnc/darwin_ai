/** test-generator skill tests — TDD red→green. ADR-009 mechanical stub. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { testGenerator } from './test-generator.js';

const SRC = 'export function add(a, b) { return a + b; }\n';
const ZERO = { cases: 0, lines: 0, imports: 0, stubs: 0 };
const calls = (s) => (s.match(/^\s*test\(/gm) || []).length;

describe('test-generator — catalog contract', () => {
  test('name', () => assert.equal(testGenerator.name, 'test-generator'));
  test('triggers', () => {
    for (const t of ['test', 'generate test', 'testgen', '生成测试']) {
      assert.ok(testGenerator.triggers.includes(t), `missing: ${t}`);
    }
  });
  test('description non-empty', () => assert.ok(testGenerator.description.length > 0));
});

describe('test-generator — input guards', () => {
  test('empty → fallback', async () => {
    const r = await testGenerator.execute('');
    assert.ok(r.output.startsWith('/**'));
    assert.deepEqual(r.stats, ZERO);
  });
  test('invalid input', async () => {
    for (const bad of [null, undefined, 42, true, {}]) {
      assert.deepEqual((await testGenerator.execute(bad)).stats, ZERO);
    }
  });
});

describe('test-generator — file path', () => {
  test('foo.js → tests/foo.test.js', async () => {
    const r = await testGenerator.execute('foo.js');
    assert.ok(
      r.suggested.testPath.includes('tests/') && r.suggested.testPath.includes('foo.test.js'),
    );
    assert.ok(/from\s+['"]\.\/foo\.js['"]/.test(r.output));
  });
  test('nested src/lib/bar.js', async () =>
    assert.ok(
      (await testGenerator.execute('src/lib/bar.js')).suggested.testPath.includes('bar.test.js'),
    ));
});

describe('test-generator — source parsing', () => {
  test('const / function / class kinds', async () => {
    assert.equal(
      (await testGenerator.execute('export const g = 1;\n')).suggested.imports[0].kind,
      'const',
    );
    assert.equal((await testGenerator.execute(SRC)).suggested.imports[0].kind, 'function');
    assert.equal(
      (await testGenerator.execute('export class B {}\n')).suggested.imports[0].kind,
      'class',
    );
  });
  test('no-export → empty imports', async () =>
    assert.equal((await testGenerator.execute('function i(){}')).suggested.imports.length, 0));
  test('source imports not re-imported', async () => {
    const r = await testGenerator.execute("import fs from 'fs';\nexport const x = 1;\n");
    assert.ok(!/from\s+['"]fs['"]/.test(r.output));
    assert.ok(r.suggested.imports.some((i) => i.name === 'x'));
  });
});

describe('test-generator — output structure', () => {
  test('shape + JSDoc + node:test', async () => {
    const r = await testGenerator.execute(SRC);
    assert.equal(typeof r.output, 'string');
    assert.ok(r.output.startsWith('/**'));
    assert.ok(r.output.includes("from 'node:test'"));
    assert.ok(r.output.includes("from 'node:assert/strict'"));
  });
  test('default minCases=5 + stats.cases', async () => {
    const r = await testGenerator.execute(SRC);
    assert.ok(calls(r.output) >= 5);
    assert.equal(r.stats.cases, calls(r.output));
  });
  test('includeNegative default', async () =>
    assert.ok(
      ((await testGenerator.execute(SRC)).output.match(/throws\s+TypeError/g) || []).length >= 1,
    ));
  test('minCases=8 override', async () =>
    assert.ok(calls((await testGenerator.execute(SRC, { options: { minCases: 8 } })).output) >= 8));
});

describe('test-generator — module option', () => {
  test('cjs → require()', async () => {
    const r = await testGenerator.execute(SRC, { options: { module: 'cjs' } });
    assert.ok(/require\(['"]node:test['"]\)/.test(r.output));
    assert.ok(/require\(['"]node:assert\/strict['"]\)/.test(r.output));
    assert.equal(r.suggested.module, 'cjs');
  });
  test('esm default → ESM imports', async () => {
    const r = await testGenerator.execute(SRC);
    assert.ok(/import\s*\{\s*test,\s*describe\s*\}\s*from\s+['"]node:test['"]/.test(r.output));
    assert.equal(r.suggested.module, 'esm');
  });
});

describe('test-generator — context + robustness', () => {
  test('sourceContent wins', async () =>
    assert.ok(
      /from\s+['"]\.\/add\.js['"]/.test(
        (await testGenerator.execute('ignored.js', { sourceContent: SRC })).output,
      ),
    ));
  test('sourcePath when input is content', async () =>
    assert.ok(
      (await testGenerator.execute(SRC, { sourcePath: 'lib/util.js' })).suggested.testPath.includes(
        'util.test.js',
      ),
    ));
  test('10k-line source no crash', async () => {
    const r = await testGenerator.execute(
      'export const big = 1;\n' + '// padding\n'.repeat(10_000),
    );
    assert.equal(typeof r.output, 'string');
    assert.equal(r.suggested.imports[0].name, 'big');
  });
});
