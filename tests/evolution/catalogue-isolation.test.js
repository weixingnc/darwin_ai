/**
 * Evolution catalogue - V10.1 worktree isolation (2026-06-20).
 *
 * Before V10.1: V4-V9 'darwin self-evolution' worktree cycles
 * polluted the production evolution/catalogue.log (336/342 = 98%
 * of entries were /tmp/ worktree writes). T7-W1 only caught
 * NODE_ENV=test, not worktree cycles.
 *
 * V10.1 fix: resolveLogFile(opts) routes based on file path:
 *   1. explicit opts.logFile -> use it
 *   2. NODE_ENV=test -> TEST_LOG_FILE (T7-W1 contract)
 *   3. file in /tmp/ -> ISOLATED_LOG_FILE (worktree cycles)
 *   4. otherwise -> LOG_FILE (production)
 *
 * This test pins all 4 branches.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addToCatalogue, audit, _internal } from '../../evolution/catalogue.js';

const TMP = mkdtempSync(join(tmpdir(), 'v10-1-cat-isolation-'));

describe('catalogue - V10.1: resolveLogFile routing (4 branches)', () => {
  test('branch 1: explicit opts.logFile overrides everything', () => {
    const explicitLog = join(TMP, 'explicit.log');
    addToCatalogue('plugins', 'explicit-1', {
      reason: 'V10.1 branch 1',
      file: join(TMP, 'cat-1.json'),
      logFile: explicitLog,
    });
    assert.ok(existsSync(explicitLog), 'explicit logFile must be written');
  });

  test('branch 4: production path in NON-test env -> LOG_FILE', () => {
    // V10.1 priority: (1) explicit > (2) /tmp/ > (3) NODE_ENV=test > (4) LOG_FILE.
    // LOG_FILE is reached only when NODE_ENV !== 'test' AND file is not in /tmp/.
    const prev = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      const fakeProdFile = '/home/weixing/darwin/evolution/catalogue.json';
      const resolved = _internal.resolveLogFile({ file: fakeProdFile });
      assert.equal(resolved, _internal.LOG_FILE, 'production path, non-test env -> LOG_FILE');
    } finally {
      if (prev !== undefined) {
        process.env.NODE_ENV = prev;
      }
    }
  });

  test('branch 4 (test mode): production file in NODE_ENV=test -> TEST_LOG_FILE (T7-W1 contract)', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      const resolved = _internal.resolveLogFile({
        file: '/home/weixing/darwin/evolution/catalogue.json',
      });
      assert.equal(
        resolved,
        _internal.TEST_LOG_FILE,
        'test mode + prod file path -> TEST_LOG_FILE',
      );
    } finally {
      if (prev !== undefined) {
        process.env.NODE_ENV = prev;
      }
    }
  });

  test('branch 3: worktree (file in /tmp/) -> ISOLATED_LOG_FILE', () => {
    const worktreeOverlay = '/tmp/some-worktree/catalogue.json';
    const resolved = _internal.resolveLogFile({ file: worktreeOverlay });
    assert.equal(
      resolved,
      _internal.ISOLATED_LOG_FILE,
      'worktree file path must route to ISOLATED_LOG_FILE',
    );
  });

  test('branch 3 (variant): tmpdir() prefix also triggers worktree routing', () => {
    const worktreeFile = join(tmpdir(), 'v10-1-', 'catalogue.json');
    const resolved = _internal.resolveLogFile({ file: worktreeFile });
    assert.equal(resolved, _internal.ISOLATED_LOG_FILE);
  });

  test('branch 2 (V10.1): /tmp/ file wins over NODE_ENV=test, non-/tmp/ file uses TEST_LOG_FILE', () => {
    // V10.1 priority: file in /tmp/ ALWAYS routes to ISOLATED_LOG_FILE,
    // even when NODE_ENV=test is set (file marker > env marker). For
    // non-/tmp/ files in test mode, the legacy T7-W1 contract applies:
    // TEST_LOG_FILE is used. Both behaviors are captured here.
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      // (a) /tmp/ file -> ISOLATED_LOG_FILE (V10.1: file wins)
      const resolvedA = _internal.resolveLogFile({ file: '/tmp/whatever.json' });
      assert.equal(resolvedA, _internal.ISOLATED_LOG_FILE);
      // (b) production-path file in test mode -> TEST_LOG_FILE (T7-W1)
      const resolvedB = _internal.resolveLogFile({
        file: '/home/weixing/darwin/evolution/catalogue.json',
      });
      assert.equal(resolvedB, _internal.TEST_LOG_FILE);
    } finally {
      if (prev === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prev;
      }
    }
  });

  test('end-to-end: worktree addToCatalogue does NOT touch LOG_FILE in production', () => {
    const worktreeOverlay = join(TMP, 'cat-worktree-e2e.json');
    addToCatalogue('plugins', 'worktree-isolation-e2e', {
      reason: 'V10.1 worktree routing e2e',
      file: worktreeOverlay,
    });
    const isolatedEntries = audit({ logFile: _internal.ISOLATED_LOG_FILE });
    const prodEntries = audit({ logFile: _internal.LOG_FILE });
    const myEntry = isolatedEntries.find((e) => e.name === 'worktree-isolation-e2e');
    assert.ok(myEntry, 'worktree entry must be in ISOLATED_LOG_FILE');
    const inProd = prodEntries.find((e) => e.name === 'worktree-isolation-e2e');
    assert.equal(inProd, undefined, 'worktree entry must NOT be in production LOG_FILE (the bug)');
  });
});

describe('catalogue - V10.1: no production log pollution regression', () => {
  test('subsequent worktree calls all stay in ISOLATED_LOG_FILE', () => {
    const prodBefore = existsSync(_internal.LOG_FILE)
      ? readFileSync(_internal.LOG_FILE, 'utf8').split('\n').filter(Boolean).length
      : 0;
    for (let i = 0; i < 5; i += 1) {
      addToCatalogue('plugins', `v10-1-regression-${i}`, {
        reason: `V10.1 no-pollution regression ${i}`,
        file: join(TMP, `cat-reg-${i}.json`),
      });
    }
    const prodAfter = existsSync(_internal.LOG_FILE)
      ? readFileSync(_internal.LOG_FILE, 'utf8').split('\n').filter(Boolean).length
      : 0;
    assert.equal(
      prodAfter,
      prodBefore,
      'production LOG_FILE line count must be unchanged after 5 worktree adds',
    );
  });
});

after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
