/**
 * P2c-3 end-to-end test — Darwin self-evolution closed loop (2026-06-18).
 *
 * This is the "自指" half of Darwin's plugin evolution story. Where P2c-2
 * had PM write plugin/audit.js + grow PLUGIN_CATALOGUE manually, P2c-3
 * lets Darwin do it all itself:
 *
 *   1. PM extends PLUGIN_CATALOGUE in a tmpdir worktree (one small edit)
 *   2. diagnose() sees missing_plugins=['session-trace']
 *   3. propose() generates a proposal for plugin/session-trace.js
 *   4. apply() writes the plugin file + creates an evolution-pre-* git tag
 *   5. re-diagnose() shows missing_plugins=[]
 *
 * The tmpdir is a real `git worktree add` of the v2 checkout (PR-S2 pattern),
 * so all of Darwin's filesystem + git commands work natively — no monkey-
 * patching, no module mocking. We clean up the worktree at the end.
 *
 * PM-direct-write scope: this test file is the only deliverable for P2c-3.
 * No production code changes (P2c-2 already shipped audit + the manifest
 * template; P2c-3 just verifies that wiring closes the loop).
 *
 * node:test + node:assert/strict. Pattern modeled after apply.test.js
 * makeTmpRepo() + autoApprover stub.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const V2_ROOT = '/home/weixing/darwin';
const MISSING_PLUGIN = 'session-trace';
const MISSING_PLUGIN_PATH = `plugin/${MISSING_PLUGIN}.js`;

/**
 * Create a detached git worktree off v2 HEAD so Darwin can run unmodified
 * against an isolated working tree. Configures a test git user so commits
 * and tags work. Also materializes the p2c3 driver script into the worktree
 * because worktrees only see tracked files.
 */
function makeWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2c3-wt-'));
  childProcess.execFileSync('git', ['worktree', 'add', '--detach', root, 'HEAD'], {
    cwd: V2_ROOT,
    stdio: 'pipe',
  });
  childProcess.execFileSync('git', ['config', 'user.email', 'p2c3-test@local'], {
    cwd: root,
    stdio: 'pipe',
  });
  childProcess.execFileSync('git', ['config', 'user.name', 'p2c3-test'], {
    cwd: root,
    stdio: 'pipe',
  });
  // Copy the driver script into the worktree (untracked file, not in git).
  // The driver uses dynamic import(absolute path) so it lives anywhere;
  // we put it in tests/evolution/ for symmetry with apply.test.js.
  const driverSrc = fs.readFileSync(path.join(__dirname, 'p2c3-driver.mjs'), 'utf8');
  const driverDst = path.join(root, 'tests/evolution/p2c3-driver.mjs');
  fs.mkdirSync(path.dirname(driverDst), { recursive: true });
  fs.writeFileSync(driverDst, driverSrc);
  // W6-2: copy uncommitted plugin/ files from V2_ROOT into the
  // worktree so the worktree's plugin/ matches the working tree.
  // Without this, plugin files added in W6+ working tree but not
  // yet in HEAD appear "missing" to diagnose in the worktree.
  const srcPlugin = path.join(V2_ROOT, 'plugin');
  const dstPlugin = path.join(root, 'plugin');
  for (const f of fs.readdirSync(srcPlugin)) {
    const src = path.join(srcPlugin, f);
    const dst = path.join(dstPlugin, f);
    if (fs.statSync(src).isFile() && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
  return root;
}

/**
 * Tear down a worktree + prune the worktree ref so subsequent runs are clean.
 */
function cleanupWorktree(worktree) {
  try {
    childProcess.execFileSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: V2_ROOT,
      stdio: 'pipe',
    });
  } catch (_) {
    // already gone — fall through to fs.rmSync
  }
  childProcess.execFileSync('git', ['worktree', 'prune'], {
    cwd: V2_ROOT,
    stdio: 'pipe',
  });
  try {
    fs.rmSync(worktree, { recursive: true, force: true });
  } catch (_) {
    // best-effort
  }
}

/**
 /**
  * Override PLUGIN_CATALOGUE in the worktree via catalogue.json overlay
  * (P2g, 2026-06-18). Before P2g, this function patched the
  * PLUGIN_CATALOGUE literal in evolution/diagnose.js — that literal
  * no longer exists (diagnose.js now sources catalogues from
  * evolution/catalogue.js). We now write evolution/catalogue.json
  * with the new plugin overlay and commit.
  *
  * Returns { catalogue, previousCatalogue } so tests can assert the diff.
  */
function overrideCatalogue(worktree, newCatalogue) {
  const filePath = path.join(worktree, 'evolution/catalogue.json');
  const before = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{}';
  const parsed = JSON.parse(before || '{}');
  // Compute the previous catalogue (whatever was committed before this test
  // ran; could be empty `{}` if no overlay was committed yet).
  const previous = parsed.plugins || [];
  parsed.plugins = newCatalogue;
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  childProcess.execFileSync('git', ['add', 'evolution/catalogue.json'], {
    cwd: worktree,
    stdio: 'pipe',
  });
  childProcess.execFileSync(
    'git',
    ['commit', '--quiet', '-m', `p2c3: extend catalogue with ${MISSING_PLUGIN}`, '--no-verify'],
    { cwd: worktree, stdio: 'pipe' },
  );
  return { previousCatalogue: previous, newCatalogue };
}

describe('P2c-3 end-to-end — Darwin self-evolution closed loop', () => {
  let worktree;
  before(() => {
    worktree = makeWorktree();
  });
  after(() => {
    if (worktree) {
      cleanupWorktree(worktree);
    }
  });

  test('catalogue override commits cleanly (tmpdir setup smoke)', () => {
    const { previousCatalogue, newCatalogue } = overrideCatalogue(worktree, [
      'logger',
      'audit',
      MISSING_PLUGIN,
    ]);
    // P2g: previous catalogue is the JSON overlay (array, not a string
    // literal). Pre-P2g this was a regex match against the stringified
    // const PLUGIN_CATALOGUE = ['logger', 'audit'].map(...) literal.
    assert.ok(Array.isArray(previousCatalogue), 'previous catalogue is an array');
    assert.deepEqual(previousCatalogue, []);
    assert.equal(newCatalogue.length, 3);
    assert.ok(newCatalogue.includes(MISSING_PLUGIN));
  });

  test('diagnose (via worktree subprocess) sees the extended catalogue and reports the missing plugin', () => {
    // We can't import diagnose from /home/weixing/darwin/evolution/diagnose.js
    // directly because that path resolves to the REAL v2 module (with
    // PLUGIN_CATALOGUE = ['logger', 'audit']) regardless of what's in the
    // worktree's evolution/diagnose.js. P2c-3's value is verifying Darwin's
    // OWN code reacts to a catalogue extension — so we run a small driver
    // script *inside* the worktree, where Node.js ESM resolves to the
    // worktree's local module (with the override PLUGIN_CATALOGUE).
    const report = runDriver(worktree, 'diagnose');
    assert.deepEqual(report.missing_plugins, [MISSING_PLUGIN]);
    assert.ok(report.current.plugins.includes('logger'));
    assert.ok(report.current.plugins.includes('audit'));
    assert.ok(!report.current.plugins.includes(MISSING_PLUGIN));
  });

  test('propose (via worktree subprocess) generates a proposal for the missing plugin', () => {
    const report = runDriver(worktree, 'diagnose');
    const proposalsDir = path.join(worktree, 'memory-bank/cycles/proposals');
    fs.mkdirSync(proposalsDir, { recursive: true });
    const reportPath = path.join(worktree, 'memory-bank/cycles/_p2c3_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const result = runDriver(worktree, 'propose', reportPath, proposalsDir);
    assert.ok(Array.isArray(result), 'propose should return an array directly');
    assert.equal(result.length, 1, 'exactly one proposal for the missing plugin');
    const proposal = result[0];
    assert.equal(proposal.action, 'add');
    assert.equal(proposal.target.type, 'plugin');
    assert.equal(proposal.target.path, MISSING_PLUGIN_PATH);
    assert.equal(proposal.files_added.length, 1);
    assert.equal(proposal.files_added[0].path, MISSING_PLUGIN_PATH);
    // The P2c-1 manifest stub template: {name, version, capabilities, permissions,
    // init throws 'not implemented'}.
    assert.match(proposal.files_added[0].content, /name:\s*'session-trace'/);
    assert.match(proposal.files_added[0].content, /version:\s*'0\.1\.0'/);
    assert.match(proposal.files_added[0].content, /not implemented/);
  });

  test('apply (via worktree subprocess) writes the plugin file + creates evolution-pre-* git tag', () => {
    const report = runDriver(worktree, 'diagnose');
    const proposalsDir = path.join(worktree, 'memory-bank/cycles/proposals');
    const reportPath = path.join(worktree, 'memory-bank/cycles/_p2c3_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const proposeRes = runDriver(worktree, 'propose', reportPath, proposalsDir);
    const proposal = proposeRes[0];

    const proposalPath = path.join(proposalsDir, `${proposal.proposal_id}.json`);
    fs.writeFileSync(proposalPath, JSON.stringify(proposal));

    const applyRes = runDriver(worktree, 'apply', proposalPath);
    assert.equal(applyRes.applied, true, applyRes.reason || 'apply should succeed');
    assert.match(applyRes.tag, new RegExp(`^evolution-pre-${proposal.proposal_id}-\\d+$`));
    assert.match(applyRes.tag_sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(applyRes.files_written, [MISSING_PLUGIN_PATH]);

    const pluginAbs = path.join(worktree, MISSING_PLUGIN_PATH);
    assert.ok(fs.existsSync(pluginAbs), 'plugin file must exist on disk');
    const written = fs.readFileSync(pluginAbs, 'utf8');
    assert.match(written, /name:\s*'session-trace'/);
  });

  test('re-diagnose after apply shows missing_plugins=[] (closed loop)', () => {
    const report = runDriver(worktree, 'diagnose');
    assert.deepEqual(
      report.missing_plugins,
      [],
      'catalogue closure confirmed after Darwin applied its own proposal',
    );
    assert.ok(report.current.plugins.includes(MISSING_PLUGIN));
    // W5-1 (2026-06-18): baseline plugin catalogue is now 4
    // (logger + audit + metrics + rate-limiter), not 3. The
    // MISSING_PLUGIN itself was just grown, so total = 5.
    // (catalogue 4 → 5)
    // W6-2 (2026-06-18): llm-cache joined the baseline — 5 in
    // DEFAULTS, plus the MISSING_PLUGIN grown in this test, so
    // total = 6.
    // V6-1 (2026-06-19): feishu-notify joined the baseline — 6 in
    // DEFAULTS, plus the MISSING_PLUGIN grown in this test, so
    // total = 7.
    // V7-2 (2026-06-19): cron-audit joined the baseline — 7 in
    // DEFAULTS, plus the MISSING_PLUGIN grown in this test, so
    // total = 8.
    // V11 (2026-06-21): plugin-watcher joined the baseline — 8 in
    // DEFAULTS, plus the MISSING_PLUGIN grown in this test, so
    // total = 9.
    assert.equal(report.current.plugins.length, 9);
  });

  test('git tag is reachable in the worktree + matches the rollback anchor for the apply', () => {
    const tagsOut = childProcess
      .execFileSync('git', ['tag', '--list', 'evolution-pre-*'], {
        cwd: worktree,
        stdio: 'pipe',
      })
      .toString();
    assert.match(tagsOut, /evolution-pre-/);
  });

  test('audit plugin subscribes to the same evolution events Darwin emits (wire contract)', async () => {
    // We already proved in P2c-3's apply test that EVOLUTION_APPLY_AFTER
    // fires (audit plugin would receive it). Here we verify the static
    // contract: audit.js's subscription mechanism derives from the same
    // EVENTS const Darwin emits, so any change to a topic string in
    // core/events.js automatically propagates to audit (V10.1 refactor:
    // dynamic subscription via Object.values(EVENTS).startsWith('evolution:')
    // instead of a hand-maintained 2-entry _handlers literal).
    const eventsModule = await import('../../core/events.js');
    assert.equal(eventsModule.EVENTS.EVOLUTION_PROPOSE_AFTER, 'evolution:propose:after');
    assert.equal(eventsModule.EVENTS.EVOLUTION_APPLY_AFTER, 'evolution:apply:after');
    const auditSource = fs.readFileSync(path.join(V2_ROOT, 'plugin/audit.js'), 'utf8');
    // V10.1: audit.js now imports EVENTS and filters by 'evolution:' prefix,
    // not by hardcoded topic literals. The wire contract is now enforced
    // by construction: any evolution:* topic added to EVENTS is auto-subscribed.
    assert.match(auditSource, /import .*EVENTS.* from .*core\/events\.js/);
    assert.match(auditSource, /startsWith\(['"]evolution:/);
    // Sanity: the 12-event shape (V10.1) -- all 4 evolution phases (before/after/etc.)
    // are reachable via EVENTS, so the dynamic subscription covers them.
    const evoKeys = Object.keys(eventsModule.EVENTS).filter((k) => k.startsWith('EVOLUTION_'));
    assert.equal(
      evoKeys.length,
      12,
      'EVENTS must define 12 evolution events for V10.1 wire contract',
    );
  });
});

/**
 * Run the p2c3 driver inside the worktree and return parsed JSON stdout.
 * The driver uses dynamic import(absolute worktree path) so Darwin's own
 * modules load with PLUGIN_CATALOGUE / catalogues as defined in the
 * worktree (i.e. after overrideCatalogue committed its edit).
 */
function runDriver(worktree, cmd, ...args) {
  const out = childProcess
    .execFileSync('node', ['tests/evolution/p2c3-driver.mjs', cmd, ...args], {
      cwd: worktree,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, P2C3_WORKTREE: worktree },
    })
    .toString();
  return JSON.parse(out);
}
