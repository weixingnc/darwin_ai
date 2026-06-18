# Evolution Rules (2026-06-18)

Lessons learned across the v3+ P2 → W7 evolution cycles. Each
rule was a real failure that cost a cycle to fix. Recording
them here so future PM-direct-write cycles don't repeat.

## R-1: Module-scope singletons need nullish-safe destroy()

A plugin's `destroy()` is called by `plugin/loader.js` whenever
the host tears the plugin down. But the loader may also call
`destroy()` on a plugin that was never `init()`'d (e.g. a
malformed plugin file). Make `destroy()` nullish-safe:

```js
destroy() {
  if (this._state) {        // ← the guard
    this._state.clear();
  }
  this._recording = false;
}
```

Without the guard, the first `destroy()` after import throws
"Cannot read properties of undefined (reading 'clear')".
**Real failure: W6-1 (2026-06-18), rate-limiter v0.1.0
destroy() ate 4 tests in the rate-limit suite.**

## R-2: `for (...)` without braces fails ESLint curly

ESLint config enforces the `curly` rule on `for`/`if`/`while`
bodies. Even one-liners need braces:

```js
// ❌ fails lint
for (let i = 0; i < N; i++) doSomething(i);

// ✅ passes
for (let i = 0; i < N; i += 1) {
  doSomething(i);
}
```

Also use `i += 1` not `i++` (matches `.prettierrc` style).
**Real failure: W6-2 (2026-06-18), llm-cache.test.js line 223
broke the verify gate, rolled back 5 cycles' worth of e2e.**

## R-3: commitlint subject is strict lower-case

`feat: LRU+TTL` fails with `subject must be lower-case`. Use
`feat: lru+ttl` (acronyms OK in body, strict in subject). The
pre-commit hook will block the commit otherwise.

```bash
# Check before committing
git log -1 --pretty=%s | grep -E '^[a-z]+(\([^)]+\))?!?: [a-z]'
# Better: lint via `npx commitlint --from HEAD~1 --to HEAD`
```

**Real failure: W6-2, second commit attempt rejected by
commitlint. Lost ~30s on re-edit.**

## R-4: Cross-worktree e2e tests don't see uncommitted files

`git worktree add --detach <root> HEAD` only checks out HEAD's
tree. Any file in the working tree that has not been committed
appears "missing" in the worktree. The Darwin self-evolve e2e
test (`tests/integration/w3-2-cli-evolve-e2e.test.js`,
`tests/integration/w4-2-rate-limiter-evolve.test.js`,
`tests/evolution/p2c3-end-to-end.test.js`) creates a worktree
and runs Darwin in it. If you write a new `plugin/<name>.js`
in the working tree but forget to commit, the worktree's
diagnose will report it as missing.

**Fix**: copy uncommitted `plugin/*.js` from REPO_ROOT into
the worktree after `git worktree add`. W6-2 e2e harness fix.

```js
const srcPlugin = path.join(REPO_ROOT, 'plugin');
const dstPlugin = path.join(root, 'plugin');
for (const f of fs.readdirSync(srcPlugin)) {
  const src = path.join(srcPlugin, f);
  const dst = path.join(dstPlugin, f);
  if (fs.statSync(src).isFile() && !fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
  }
}
```

**Real failure: W6-2, all 3 e2e tests failed with "7 !== 5
missing plugins" because llm-cache.js was uncommitted.**

## R-5: ErrorHandler.norm() drops custom Error fields

`ErrorHandler.wrapAsync()` normalises caught errors via
`norm(err)` which only preserves `message/name/stack/raw`.
If you throw a structured error with `err.code = 'RATE_LIMITED'`,
`err.scope`, `err.stats` — they all get dropped at the
ProviderBase.\_wrap boundary. The host sees `{ok:false, error: {message}}`
with no way to inspect the structured fields.

**Fix**: extend `norm()` to copy any extra own properties of
the Error instance:

```js
function norm(err) {
  if (err instanceof Error) {
    const out = { message: err.message, name: err.name, stack: err.stack, raw: err };
    for (const k of Object.keys(err)) {
      if (k !== 'message' && k !== 'name' && k !== 'stack' && k !== 'cause') {
        out[k] = err[k];
      }
    }
    return out;
  }
  // ...
}
```

**Real failure: W6-1, all rate-limit assertions on
`r.error.code === 'RATE_LIMITED'` failed silently because
`code` was dropped at the boundary. Lost ~10 min on diagnosis.**

## R-6: `diagnose` filters must extend when adding helpers

W2-1 added `*.test.js` filter to `listJsStems` because
co-located test files were leaking into the catalogue as
fake plugins. W6-2 added `*-key.js` filter for the same
reason (plugin/llm-cache-key.js is a helper, not a plugin).

**Rule**: any new file pattern in `plugin/`, `provider/`,
`core/`, etc. that is NOT a primary capability surface
must be added to the corresponding `listJsStems` filter
in `evolution/diagnose.js`. The same applies to `memory/`
(`*-backend.js` filter), `tool/builtins/`, and `skill/examples/`.

**Real failure: W6-2, catalogue reported 7 plugins (5
catalogue + llm-cache + llm-cache-key) instead of 5.**

## R-7: Perf thresholds need machine-aware headroom

The matcher-v2 e2e test (test 6 in
`tests/integration/openclaw-skill-e2e.test.js`) hard-gated
`elapsed < 50ms`. On the dev machine, perf was 25-35ms.
But CI / older runners (Codex report, 2026-06-18) hit
51.49ms — failing the gate.

**Fix**: relax threshold to 80ms (2x headroom), add a
separate `tests/perf/matcher-v2.bench.js` for distribution
view, and document the dev/CI history in a comment near
the assertion.

**Rule**: any single-machine perf threshold must come with:

- 2x headroom over observed worst-case
- a separate `tests/perf/` bench for distribution
- a `npm run test:perf` script (T3 added this)
- a comment explaining the threshold origin

**Real failure: Codex P0-3 (2026-06-18) flagged this; fixed
in T3 with 80ms threshold + bench file.**

## R-8: ADR Status moves Proposed → Accepted after P0/P1/P2 cycle

ADRs written in the early design phase (v3 launch) all
shipped as `Status: Proposed`. After the P0/P1/P2 cycle
sha (P0=initial skeleton, P1=core plugins, P2=full plugin
evolution system) all pass, the ADRs should be promoted to
`Status: Accepted` with a 3-5 line Acceptance note pointing
at the cycle SHAs that exercised the contract.

**Rule**: ADR Status is only "Accepted" when at least one
real implementation cycle has run that exercises the ADR's
promise. ADR-005 (boundary), ADR-006 (gate), ADR-007
(rollback), ADR-008 (audit), ADR-009 (no LLM) all became
Accepted in T2 (2026-06-18) after 30+ cycles of evidence.

## R-9: The 4-step verify gate is sacred

Every cycle must pass:

1. `npm test` (all tests)
2. `npm run lint` (0 errors)
3. `npm run size-check` (all files < 1000 lines)
4. `./bin/darwin self-evolution diagnose` (catalogue closure)

If any one fails, **do not commit**. Roll back, fix, retry.
The verify gate has caught every regression in 30+ cycles.

## R-10: F-8 self-check after every commit

After `git commit`, immediately run:

```bash
git log --all --oneline | grep $(git rev-parse --short HEAD)
git status -s
```

The grep proves the SHA actually exists in the reflog
(subagents have been caught reporting fake SHAs). The
status-s proves the working tree is clean. Both must be
true before reporting the cycle as DONE.
