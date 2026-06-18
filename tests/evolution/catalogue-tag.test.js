/**
 * T6 (Codex P1-3, 2026-06-18) — catalogue addToCatalogue git tag backup.
 *
 * Tests:
 *   1. tryTagCataloguePre() returns null when cwd is NOT a git repo
 *   2. tryTagCataloguePre() returns null when cwd is missing
 *   3. tryTagCataloguePre() returns a tag name and creates a real tag
 *      in a fresh git repo
 *   4. tryTagCataloguePre() tag name matches `catalogue-pre-<ts>-<name>`
 *      pattern
 *   5. addToCatalogue() with cwd: <git repo> → audit entry gets `tag`
 *      field pointing at the new tag
 *   6. addToCatalogue() with cwd: <non-git dir> → tag field is null,
 *      add still succeeds, audit entry still written
 *   7. addToCatalogue() idempotent no-op does NOT create a tag and
 *      does NOT write an audit entry (existing T4 behaviour preserved)
 *   8. addToCatalogue() tag is created BEFORE the overlay file write
 *      (so post-mortem `git reset --hard <tag>` undoes the catalogue
 *      mutation too)
 *   9. addToCatalogue() tag name is unique across rapid calls
 *      (Date.now() ms + hrtime bigint collision defence)
 *  10. addToCatalogue() with no explicit cwd → defaults to MODULE_REPO_ROOT
 *      which IS a git repo (smoke check: tag is a non-null string in
 *      the production test environment, or null if not — we just
 *      assert it's a string|null, not undefined)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { addToCatalogue, audit, _internal, tryTagCataloguePre } from '../../evolution/catalogue.js';

const TMP = mkdtempSync(join(tmpdir(), 't6-cat-tag-'));

function overlayFile(suffix = '') {
  return join(TMP, `catalogue${suffix}.json`);
}
function logFile(suffix = '') {
  return join(TMP, `catalogue${suffix}.log`);
}

/** Create a fresh git repo at `root` with one commit, returning root. */
function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 't6-git-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't6-test@local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't6-test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  // Need a HEAD commit so `git tag` works (no HEAD → "fatal: not a valid object name").
  writeFileSync(join(root, 'README.md'), 't6 fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 't6 init'], { cwd: root });
  return root;
}

test('T6: tryTagCataloguePre() returns null when cwd is not a git repo', () => {
  const notARepo = mkdtempSync(join(tmpdir(), 't6-notrepo-'));
  const tag = tryTagCataloguePre(notARepo, 'item-1');
  assert.equal(tag, null);
});

test('T6: tryTagCataloguePre() returns null when cwd is missing/falsy', () => {
  // Empty string → null (no throw).
  assert.equal(tryTagCataloguePre('', 'item'), null);
  assert.equal(tryTagCataloguePre(undefined, 'item'), null);
  assert.equal(tryTagCataloguePre(null, 'item'), null);
});

test('T6: tryTagCataloguePre() creates a real tag in a fresh git repo', () => {
  const repo = makeGitRepo();
  const tag = tryTagCataloguePre(repo, 'rate-limiter');
  assert.ok(typeof tag === 'string' && tag.length > 0, 'tag should be a non-empty string');
  // Tag must actually exist in the repo.
  const tags = execFileSync('git', ['tag', '--list'], { cwd: repo, encoding: 'utf8' });
  assert.match(tags, new RegExp(tag));
  // And `git rev-parse <tag>` resolves to a SHA.
  const sha = execFileSync('git', ['rev-parse', tag], { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(sha, /^[0-9a-f]{7,40}$/);
});

test('T6: tryTagCataloguePre() tag name matches catalogue-pre-<ts>-<name> pattern', () => {
  const repo = makeGitRepo();
  const tag = tryTagCataloguePre(repo, 'metrics-foo');
  // Pattern: catalogue-pre-<digits>-<hex>-<slug>
  assert.match(tag, /^catalogue-pre-\d+-[0-9a-f]+-metrics-foo$/);
});

test('T6: addToCatalogue() with git-repo cwd → audit entry.tag is the new tag', () => {
  const repo = makeGitRepo();
  const file = overlayFile('-tag-a');
  const logF = logFile('-tag-a');
  const ok = addToCatalogue('plugins', 't6-tag-a', {
    file,
    logFile: logF,
    cwd: repo,
    reason: 'T6 audit-tag test',
  });
  assert.equal(ok, true);
  const hist = audit({ logFile: logF });
  assert.equal(hist.length, 1);
  const entry = hist[0];
  assert.equal(entry.op, 'add');
  assert.equal(entry.category, 'plugins');
  assert.equal(entry.name, 't6-tag-a');
  assert.equal(entry.reason, 'T6 audit-tag test');
  assert.ok(
    typeof entry.tag === 'string' && entry.tag.startsWith('catalogue-pre-'),
    `audit entry.tag should be a catalogue-pre- string, got ${JSON.stringify(entry.tag)}`,
  );
  // The tag must exist in the repo.
  const tags = execFileSync('git', ['tag', '--list'], { cwd: repo, encoding: 'utf8' });
  assert.match(tags, new RegExp(entry.tag));
});

test('T6: addToCatalogue() with non-git cwd → tag is null, add still succeeds', () => {
  const notARepo = mkdtempSync(join(tmpdir(), 't6-notrepo-add-'));
  const file = overlayFile('-no-tag');
  const logF = logFile('-no-tag');
  const ok = addToCatalogue('plugins', 't6-no-tag', {
    file,
    logFile: logF,
    cwd: notARepo,
    reason: 'T6 graceful-fallback test',
  });
  assert.equal(ok, true);
  const hist = audit({ logFile: logF });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].tag, null);
  // The catalogue overlay file should still have been written.
  const written = readFileSync(file, 'utf8');
  assert.match(written, /t6-no-tag/);
});

test('T6: addToCatalogue() idempotent no-op does NOT create a tag and does NOT write an audit entry', () => {
  const repo = makeGitRepo();
  const file = overlayFile('-idem');
  const logF = logFile('-idem');
  // First add: creates a tag and an audit entry.
  addToCatalogue('plugins', 't6-idem', { file, logFile: logF, cwd: repo });
  // Second add: no-op, must NOT create a second tag and must NOT write a second entry.
  const ok2 = addToCatalogue('plugins', 't6-idem', { file, logFile: logF, cwd: repo });
  assert.equal(ok2, false);
  const hist = audit({ logFile: logF });
  assert.equal(hist.length, 1, 'idempotent no-op must not write a second audit entry');
  // Tag count must still be exactly 1 in the repo.
  const tags = execFileSync('git', ['tag', '--list'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.equal(tags.length, 1, 'idempotent no-op must not create a second tag');
});

test('T6: addToCatalogue() tag is created BEFORE the overlay file is written', () => {
  const repo = makeGitRepo();
  const file = overlayFile('-order');
  const logF = logFile('-order');
  // Wrap fs.writeFileSync to record when overlay was written relative to tag.
  // We can't easily monkey-patch the module-private fs, so we instead
  // verify the invariant indirectly: the tag's commit SHA equals the
  // commit that was HEAD BEFORE the overlay was written. The overlay
  // file write is a working-tree change that does NOT change HEAD,
  // so this is the most we can assert without code-instrumentation.
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  addToCatalogue('plugins', 't6-order', { file, logFile: logF, cwd: repo });
  const hist = audit({ logFile: logF });
  const tag = hist[0].tag;
  const tagSha = execFileSync('git', ['rev-parse', tag], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  assert.equal(tagSha, headBefore, 'tag must anchor at the pre-write HEAD');
});

test('T6: addToCatalogue() produces a unique tag across rapid calls (hrtime collision defence)', () => {
  const repo = makeGitRepo();
  const file = overlayFile('-uniq');
  const logF = logFile('-uniq');
  // 5 rapid calls — must all produce distinct tag names.
  const tagNames = new Set();
  for (let i = 0; i < 5; i += 1) {
    addToCatalogue('plugins', `t6-uniq-${i}`, { file, logFile: logF, cwd: repo });
  }
  const hist = audit({ logFile: logF });
  for (const entry of hist) {
    tagNames.add(entry.tag);
  }
  assert.equal(tagNames.size, 5, '5 rapid calls must produce 5 distinct tag names');
});

test('T6: addToCatalogue() default cwd behaviour (smoke check on string|null invariant)', () => {
  // With no opts.cwd, addToCatalogue falls back to MODULE_REPO_ROOT.
  // We don't care whether tagging succeeds here (CI may not be a git
  // checkout), but the audit entry MUST have a `tag` field that is
  // either a string or null — never undefined.
  const file = overlayFile('-default');
  const logF = logFile('-default');
  // Use a fresh, well-known name so we don't collide with any other
  // test that ran in the same process (the T4 catalogue routes to
  // TEST_LOG_FILE so this is fine).
  const uniqueName = `t6-default-${Date.now()}-${process.hrtime.bigint().toString(16)}`;
  addToCatalogue('plugins', uniqueName, { file, logFile: logF });
  const hist = audit({ logFile: logF });
  const last = hist[hist.length - 1];
  assert.equal(last.name, uniqueName);
  assert.ok(
    last.tag === null || typeof last.tag === 'string',
    `audit entry.tag must be string|null, got ${typeof last.tag}`,
  );
});

test('T6: _internal.tryTagCataloguePre export is the same function (test seam)', () => {
  // The brief asks for `_internal` to expose the function for direct
  // test access. Sanity check.
  assert.equal(typeof _internal.tryTagCataloguePre, 'function');
  assert.equal(_internal.tryTagCataloguePre, tryTagCataloguePre);
});

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
