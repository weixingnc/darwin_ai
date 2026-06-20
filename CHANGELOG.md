# Changelog

All notable changes to Darwin are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
as of v0.2.0 (currently still v0.1.0; v1.0.0 cut deferred to V22 multi-Darwin
federation -- planned 2026-Q4).

## [Unreleased]

### Added (V14-V17.1, 2026-06-20)

- **V14 log rotate policy** (`chore(repo): v14 log rotate policy`): `core/log-rotate.js`
  caps `evolution/catalogue.log` and `plugin/audit.js` `audit.jsonl` at
  512 KB / 10 archives. Wired into the two writers; rotated history is
  queryable via V17. See `docs/TAG_POLICY.md` for the analogous tag-pruning
  policy (2674 -> 1694 tags; 17 feat/wt branches deleted).
- **V15 catalogue-all-events coverage** (already landed, documented here):
  the audit plugin now subscribes to all 12 evolution events
  (`plugin/audit.js` v0.3.0), not just 2/12. Closes the silent-loss
  regression where 10 of 12 events were never recorded to disk.
- **V16 provider shared helpers** (already landed): `provider/protocol/_shared.js`
  unifies 6 cross-provider helpers (normalizeBaseUrl, bearerAuthHeader,
  fetchWithTimeout, extractErrorMessage, wrapHttpError, makeExtractReasoning,
  joinChatUrl). Eliminates the `extractQwenReasoningContent` /
  `extractDeepSeekReasoningContent` 95% duplication.
- **V17 audit query primitive** (`feat(core): audit-reader for cross-file
audit query`): `core/audit-reader.js` reads across main + rotated
  archives, with filter support (topic, proposal, outcome, action, since,
  until) and limit cap. Backed by 16 unit tests.
- **V17.1 audit query CLI** (`feat(cli): darwin self-evolution audit-query
subcommand`): `bin/lib/audit-query.js` exposes the V17 reader to operators.
  Usage: `darwin self-evolution audit-query --topic evolution:audit
--since 2026-06-20T00:00:00Z --format json | jq`. Default baseDir is
  `<cwd>/memory/audit` (matches plugin/audit.js).

### Added (V10.5-V10.8, 2026-06-20)

- **V10.5 skill contract sync** (`docs(skill): sync contract to 6 sibling
skills`): 8 tests in `tests/skill-contract.test.js` lock the execute()
  return shape of every skill. Fixes two stale entries in
  `docs/skill-contract.md` (commit-message and test-generator return
  `{output, suggested, stats}`, not the previously documented shapes).
- **V10.6 feishu-card builder extract** (`refactor(skill): extract
feishu-card builder logic to lib`): 258L `skill/examples/feishu-card.js`
  -> 51L wrapper + 221L `skill/examples/lib/feishu-card-builder.js`.
  8 new lib tests. `plugin/feishu-notify.js` import path unchanged.
- **V10.7 configPath option** (`feat(core): configresolver configpath
option`): `ConfigResolver({ configPath })` now reads a single-file
  YAML config (top-level keys are module names). Closes the V3 P1
  infra gap: 2 pre-existing test failures (qwen + deepseek fromConfig
  tests) now pass.
- **V10.8 history cleanup** (`chore(repo): prune v2/v3-era branches and
catalogue-pre tag pollution`): 17 feat/wt branches deleted (all merged
  into main), 1135 redundant catalogue-pre-\* tags pruned (40x redundancy).
  Added `docs/TAG_POLICY.md` codifying the policy going forward.

## [0.1.0] - 2026-06-19

First public-facing release. Skeleton-only v2 with flesh grown by Darwin
itself through ~60+ evolution cycles. The pre-1.0 "catalogue" gate was
100% closed at this point:

- Providers: 12/12 (100%)
- Tools: 9/9 (100%)
- Skills: 7/7 (100%)
- Memory: 3/3 (100%)
- Platforms: 1/1 (100%)
- Plugins: 7/7 (100%)

Test count: 1162/1162 (V9.2 reviewer housekeeping baseline).

### Architecture highlights

- 12 evolution events, 6 plugin lifecycle events (see `core/events.js`)
- 5 ADRs (005-009) defining boundaries: white/black lists, approval tiers,
  git tag rollback, audit log, no LLM in loop
- 5-stage plugin lifecycle (load -> init -> enable -> disable -> unload)
  with state machine enforced in `plugin/loader.js`
- Cross-file rotation (V14) and cross-file audit query (V17)

### Known limitations (V0.1.0)

- No remote git config; tag policy is local-only (`git tag -d`, not push)
- No GitHub Actions CI yet (V18 in Phase 2)
- No plugin hot-reload yet (V11 in Phase 2)
- audit.jsonl grows past rotation threshold under heavy cycles; rotation
  is best-effort and never blocks the write path
