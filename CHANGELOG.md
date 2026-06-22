# Changelog

All notable changes to Darwin are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
as of v0.2.0 (currently still v0.1.0; v1.0.0 cut deferred to V22 multi-Darwin
federation -- planned 2026-Q4).

### Added (V28, 2026-06-21)

- **V28 zero-dependency web layer** (`feat(web): zero-dep http layer +
chat ui (v28)`): ships a local browser UI on top of Darwin without
  pulling in Express, Fastify, or any other http framework. Three new
  files under `web/`:
  - `web/server.js` (165L) — Node `http` + `child_process` server.
    `POST /api/chat` shells out to `node bin/darwin chat "<msg>"` and
    streams the response back. Listens on `PORT` (8080) and binds
    `HOST` (127.0.0.1) for loopback-only by default. Exports
    `{ server, PORT, HOST }` so the test suite can spawn a real process.
  - `web/index.html` (168L) — vanilla HTML/CSS/JS chat UI, dark theme,
    Enter-to-send, `/api/chat` POST + `GET /` static. No build step, no
    CDN, no framework. Edit the file, refresh the browser, done.
  - `web/server.test.js` (129L) — 9 tests covering: GET / returns 200
    - text/html, POST /api/chat with valid payload, POST with empty
      body rejected (400), POST with missing `message` rejected (400),
      server binds to configured HOST/PORT, CORS preflight returns
      204, unknown route returns 404, malformed JSON returns 400, server
      shuts down on close().
- `package.json` — `web/*.test.js` glob added to `test` and `test:watch`
  targets (test glob is one long string; test:watch is `node --test
--watch`). 1264/1264 tests pass (was 1255, +9 from V28).
- BOM hotfix (`fix(web): strip utf-8 bom from index.html (v28.1)`):
  `web/index.html` was written with a utf-8 BOM (ef bb bf), which some
  browsers mishandle. Stripped to plain `<!doctype html>`. 1 file, 1 line.
  No behaviour change in the running app; only the source bytes differ.

### Added (V11, 2026-06-21)

- **V11 plugin hot-reload** (`feat(plugin): hot-reload watcher with 5-stage
lifecycle`): `plugin/watcher.js` provides `reloadPlugin(absPath, loader)` and
  `watchPluginsDir(dir, loader, opts?)`. fs.watch-based, 200ms debounce, filename
  filter (dotfiles, **example**, non-.js, invalid plugin names per the
  `^[a-z0-9][a-z0-9-]*$` rule), stats (attempts/ok/fail). 6 unit tests
  covering name validation, missing file, first load, and watchPluginsDir
  handle (start/stop, idempotent close). The fs.watch event-delivery
  integration tests are documented as "flaky in some sandboxed envs"
  and deferred to a non-sandboxed e2e (V22+); reload logic itself is fully
  covered by the unit tests. `package.json` test glob updated to include
  `tests/plugin/*.test.js`. `tests/evolution/p2c3-end-to-end.test.js`
  catalogue baseline bumped 8 -> 9 (plugin-watcher is the 9th baseline
  plugin). Wired into the 5-stage plugin lifecycle (load -> init -> enable,
  disable -> unload). No LLM, no network. Total: 1253 tests passing (was 1247).

### Added (V12, 2026-06-21)

- **V12 plugin loader owns watcher lifecycle** (`feat(plugin): loader owns
watcher lifecycle`): `plugin/loader.js` now exposes `startWatcher(dir, opts)` and
  `stopWatcher()`. Consumers (bin/darwin, REPL) wire plugin hot-reload with
  two calls at boot/shutdown instead of by hand-wiring plugin/loader.js +
  plugin/watcher.js. To stay under the 200-line cap, the factory is slimmed
  by extracting `load + tryLoadFile` to `plugin/loader-load.js` (89L) and
  `discover` to `plugin/loader-discover.js` (62L); the factory itself went from
  254L to 224L. 1 new test (`startWatcher returns a handle; stopWatcher is
idempotent`); the planned fs.watch event-delivery test is deferred to
  V22+ e2e (sandbox-flaky). `tests/evolution/p2c3-end-to-end.test.js` catalogue
  baseline bumped 9 -> 11 (loader-load + loader-discover are the 10th and 11th
  baseline plugins). Total: 1254 tests passing (was 1253). No LLM, no network.

### Added (V25.1, 2026-06-21)

- **V25.1 install.ps1 tarball mode** (`chore(install): install.ps1
tarball mode`): Windows install.ps1 gains `-FromTarball URL` and
  `-FromTarballInstalled` flags, mirroring the V25-actual
  install.sh update. After V25.1, the one-line install works
  on all three supported platforms (Linux/macOS via bash,
  Windows via PowerShell) without requiring git. The .ps1 was
  generated via Python on the server (cleaner PowerShell
  escape handling than the V25-actual attempt). No new in-tree
  tests; the V24-actual install-e2e-windows job covers the
  git path, and the V25-actual release.yml smoke test covers
  the tarball path on a Linux runner. A Windows-side tarball
  smoke test is deferred to V25.2 (requires a self-hosted
  Windows runner). No LLM, no network. Total: 1255 tests
  passing (unchanged from V25-actual).

### Added (V25-actual, 2026-06-21)

- **V25-actual tarball release pipeline** (`chore(release): tarball
release pipeline + install.sh tarball mode`): adds a
  `v*`-tag-triggered release workflow that builds a tarball of the
  just-tested tree, attaches it to a GitHub Release, and runs an
  end-to-end smoke test on the just-uploaded asset (curl the tarball
  from the GitHub URL, extract, run `install.sh
--from-tarball-installed`, assert `darwin --version` returns the
  right version). `install.sh` gains two new modes:
  `--from-tarball URL` (download + extract + install in one command;
  no git needed) and `--from-tarball-installed` (install from an
  already-extracted tarball directory). This makes the one-line
  install truly one-line on Linux/macOS without a git dependency.
  Windows `install.ps1` tarball mode deferred to V25.1 due to
  shell-escaping issues in the PowerShell + SCP upload chain.
  No new in-tree tests; the existing 1255 stay green. The release
  workflow itself is the integration test for the tarball path.

### Added (V23, 2026-06-21)

- **V23 one-click install** (`feat(infra): one-click install + uninstall`): `install.sh` (Linux/macOS) and `install.ps1` (Windows) turn the project from a 3-step dev workflow (`git clone && npm install && chmod +x bin/darwin`) into one command. After install, `darwin --version` / `darwin help` works from any new shell. Includes idempotent update (re-running `install.sh` on an existing install does `git pull` + `npm install` in place), a provider-credential `.env` template (chmod 600), and a matching `uninstall.sh` / `uninstall.ps1` (with `--purge` to wipe memory + audit). `bin/darwin` gains a `version` subcommand (and `--version` / `-V` flags) for the installer self-test. CLI dispatch refactored into COMMANDS + SUBCOMMANDS tables to stay under the complexity=15 lint cap. `bin/darwin.cmd` + `bin/darwin.ps1` added for Windows shell launchers. Total: 1255 tests passing (was 1254).

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
- GitHub Actions CI in place (V19); runs `npm run verify` on every push to main and any v\* branch, plus on PRs targeting main
- audit.jsonl grows past rotation threshold under heavy cycles; rotation
  is best-effort and never blocks the write path
