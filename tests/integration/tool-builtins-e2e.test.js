/**
 * V4 cycle 2 (2026-06-19) — head/tail/wc Darwin self-evolution e2e.
 *
 * Closes the loop on the V3_ROADMAP P1 builtin tools: head, tail, wc
 * are already individually covered by their own .test.js files (17
 * cases each), but there is no end-to-end test that proves Darwin
 * itself can drive them against a real file tree. This file fills
 * that gap: a single tmpdir tree of 3 fixture files, exercised by
 * all three tools in turn, plus a no-throw error-path case.
 *
 * The e2e is intentionally short (5 cases) — the goal is closure
 * ("Darwin CAN use these tools on real files"), not feature
 * coverage. Feature coverage lives in tool/builtins/*.test.js.
 *
 * After the assertions pass, the test calls addToCatalogue() to
 * mark the closure in the evolution audit log. The call is
 * sandboxed (isolated overlay file + explicit production logFile)
 * so it does not pollute the shared evolution/catalogue.json that
 * the w3-2 / w4-2 integration self-evolution tests rely on.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';

import { head } from '../../tool/builtins/head.js';
import { tail } from '../../tool/builtins/tail.js';
import { wc } from '../../tool/builtins/wc.js';

let tmp;

function writeLines(filePath, count) {
  // GNU semantics: file with N lines of content + trailing \n.
  // wc counts newlines; head/tail pop the trailing '' from split.
  const content = Array.from({ length: count }, (_, i) => `line-${i}`).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf8');
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'c4-head-tail-wc-'));
  writeLines(join(tmp, 'a.txt'), 100);
  writeLines(join(tmp, 'b.txt'), 50);
  writeLines(join(tmp, 'c.txt'), 200);
});

after(() => {
  // Files are in os.tmpdir; OS reclaims. No explicit cleanup needed.
});

describe('head/tail/wc — Darwin self-evolution e2e (V4 cycle 2)', () => {
  test('1. head: n=5 returns first 5 lines of each file, sorted', async () => {
    const r = await head.execute({ cwd: tmp, n: 5 });
    assert.equal(r.files.length, 3);
    // Sorted alphabetically: a.txt, b.txt, c.txt
    assert.equal(r.files[0].file, 'a.txt');
    assert.equal(r.files[0].lines.length, 5);
    assert.equal(r.files[0].lines[0], 'line-0');
    assert.equal(r.files[0].lines[4], 'line-4');
    // b.txt: 50 lines, head(5) → first 5
    assert.equal(r.files[1].file, 'b.txt');
    assert.equal(r.files[1].lines.length, 5);
    // c.txt: 200 lines, head(5) → first 5
    assert.equal(r.files[2].file, 'c.txt');
    assert.equal(r.files[2].lines.length, 5);
  });

  test('2. tail: n=10 returns last 10 lines of a.txt (100 lines)', async () => {
    const r = await tail.execute({ cwd: tmp, n: 10 });
    const a = r.files.find((f) => f.file === 'a.txt');
    assert.ok(a, 'a.txt must be in tail results');
    assert.equal(a.lines.length, 10);
    assert.equal(a.lines[0], 'line-90');
    assert.equal(a.lines[9], 'line-99');
  });

  test('3. wc: aggregates lines/words/bytes/files across 3 files', async () => {
    const r = await wc.execute({ cwd: tmp });
    assert.equal(r.files, 3);
    assert.equal(r.lines, 100 + 50 + 200);
    // words = 100 + 50 + 200 = 350 (each line is a single word "line-N")
    assert.equal(r.words, 100 + 50 + 200);
    // bytes > 0; exact value depends on line-0..line-199 strings.
    assert.ok(r.bytes > 0, 'bytes should be > 0');
  });

  test('4. error path: non-existent cwd → head/tail/wc return empty/zero, never throw', async () => {
    const bad = join(tmpdir(), 'definitely-not-here-' + Date.now());
    const h = await head.execute({ cwd: bad, n: 5 });
    assert.deepEqual(h.files, []);
    const t = await tail.execute({ cwd: bad, n: 5 });
    assert.deepEqual(t.files, []);
    const w = await wc.execute({ cwd: bad });
    assert.equal(w.lines, 0);
    assert.equal(w.words, 0);
    assert.equal(w.bytes, 0);
    assert.equal(w.files, 0);
  });

  test('5. catalogue closure: addToCatalogue records the e2e marker in evolution/catalogue.log', () => {
    // Sandboxed overlay so we don't mutate the shared
    // evolution/catalogue.json (which the w3-2 / w4-2 integration
    // self-evolution tests assert to be a fresh overlay). The audit
    // entry, however, MUST land in the production evolution/catalogue.log
    // — that's the V4 cycle 2 "收口" evidence the PM asks for.
    const isolatedFile = join(tmp, 'catalogue-c4-closure.json');
    const ok = addToCatalogue('tools', 'head-tail-wc-e2e', {
      reason:
        'V4 cycle 2 Darwin self-evolution e2e closure: head/tail/wc drive a real tmpdir tree end-to-end',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(ok, true, 'addToCatalogue must return true on first add');
    // Idempotency: second call with the same name returns false.
    const second = addToCatalogue('tools', 'head-tail-wc-e2e', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(second, false, 'addToCatalogue must be idempotent');
  });
});
