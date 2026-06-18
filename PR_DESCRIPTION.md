# Darwin V3+ Plugin Evolution & Self-Growth — 22 commits

> Branch: `main` · Base: `1c78d86` (P2c-1) · Head: `19c2296` (W6-5/6)
> Tests: 970/970 · Lint: 0 · Coverage: 91.04% · Plugins: 5/5
> Author: PM-direct-write + 2 darwin-coder dispatches (W2-1, W3-2)

## Summary

This PR delivers **Darwin's self-evolution capability end-to-end**:
Darwin can now diagnose its own surface gaps, propose plugin
manifests, apply them to disk, verify the build, and roll back on
failure — all under a `--confirm` gate. It also grew itself two
production plugins (`rate-limiter` v0.2.0, `llm-cache` v0.1.0)
from a manifest stub, closing the loop on "Darwin installs its
own organs".

## What ships

### 5 production plugins in `plugin/`

| Plugin         | SHA                   | Role                                                       | Status     |
| -------------- | --------------------- | ---------------------------------------------------------- | ---------- |
| `logger`       | P2d                   | example/reference                                          | ✅ shipped |
| `audit`        | `1d4275e`             | WHAT happened (JSONL persistence)                          | ✅ shipped |
| `metrics`      | `cc1931e`             | HOW MUCH/FAST (observability)                              | ✅ shipped |
| `rate-limiter` | `5648477` + `19d9d93` | sliding window rate limit, per-scope, anthropic integrated | ✅ shipped |
| `llm-cache`    | `3f8bad2`             | LRU+TTL LLM response cache                                 | ✅ shipped |

### P2 plugin self-evolution (17 commits, P2a–P2j + P3a–P3c)

- **P2d** plugin manifest security contract (deny-by-default)
- **P2c-1/2/3** evolution emits plugin stub → real impl → end-to-end loop
- **P2e/i** plugin runtime sandbox (monkey-patch + loader integration)
- **P2f** self-evolve orchestrator (closed loop)
- **P2g** catalogue persistence + growth strategy
- **P2j** audit plugin v0.2.0 on-disk persistence (JSONL)
- **P3a** `darwin self-evolution evolve --confirm` CLI entry
- **P3b** c8 coverage baseline 90.3%
- **P3c** `README.md` GitHub entry point

### W-cycles (cleanup + self-growth proof)

- **W2-1** `diagnose` filters `*.test.js` fixtures (was leaking)
- **W2-2** husky v9 shim removal + repair `core.hooksPath` config
- **W3-1/2/3/4** end-to-end CLI worktree e2e + V3_ROADMAP
- **W4-1/2** `metrics` plugin + Darwin self-grows `rate-limiter` via CLI
- **W5-1/2/3/4** `rate-limiter` real impl + e2e regression + README
- **W6-1** rate-limiter per-scope + anthropic.js real integration
- **W6-2** `llm-cache` LRU+TTL + catalogue 5/5 closure
- **W6-5/6** `diagnose` filters `*-key.js` helpers + coverage push

## What it proves

- ✅ Darwin can **diagnose** itself (catalogue closure invariant)
- ✅ Darwin can **propose** a plugin manifest (P2c-1)
- ✅ Darwin can **apply** a proposal to disk (with `evolution-pre-*` git tag as rollback anchor)
- ✅ Darwin can **verify** the build (test + lint + size-check)
- ✅ Darwin can **rollback** on verify failure (with selfcheck + pause on 3 consecutive failures)
- ✅ Darwin can **self-grow** a plugin: W4-2 proved rate-limiter, W6-2 grew llm-cache

## What's NOT in this PR

- ❌ No remote/CI changes (local-only Darwin)
- ❌ No `weixingnc/darwin_ai` push (this PR is the _intent_ to push)
- ❌ No full P2e sandbox enforcement (P2e implements the API; production
  enforcement via `enableSandbox: true` is opt-in, see P2i)

## Test breakdown (970/970)

- Plugin tests: 60+ (audit, metrics, rate-limiter, llm-cache, interface, registry, loader, sandbox, security)
- Provider tests: 130+ (anthropic + 8 others, with rate-limit integration)
- Evolution tests: 90+ (catalogue, propose, apply, verify, rollback, self-evolve, diagnose, learn)
- Integration tests: 30+ (e2e self-evolution, CLI e2e, Darwin self-grows plugin)
- Core tests: 80+ (event-bus, error-handler, config-resolver, skill-loader, etc.)
- Smoke / shutdown / bootstrap: ~20

## Critical files to review

- `evolution/catalogue.js` — single source of truth for plugin surface
- `evolution/self-evolve.js` — the orchestrator (closed loop)
- `evolution/diagnose.js` — closure invariant guard
- `evolution/propose.js` — manifest stub generator (P2c-1)
- `evolution/apply.js` — write files + tag, NO git commit (PM owns commits)
- `plugin/loader.js` — plugin loading + sandbox activation
- `plugin/interface.js` — IPlugin contract (deny-by-default)
- `plugin/llm-cache.js` + `plugin/llm-cache-key.js` — newest production plugin
- `provider/anthropic.js` — rate-limit integration example for other providers

## Lessons baked in (F-32/F-33 cluster)

- **Module-scope singletons are dangerous for testability.** Every plugin
  test must `destroy() + init()` in `beforeEach`. `destroy()` is
  nullish-safe.
- **Cross-worktree file visibility is a hidden gotcha.** `git worktree
add` only checks out HEAD's tree — uncommitted plugin files appear
  "missing" to diagnose. The W6-2 fix: copy `plugin/` from REPO_ROOT
  into the worktree after worktree creation.
- **ErrorHandler strips custom fields.** If you throw `err.code = ...`,
  it gets dropped at the `wrapAsync` boundary unless you patch
  `core/error-handler.js`'s `norm()` to preserve them.
- **commitlint subject-case: all-lowercase.** "feat: LRU+TTL" fails.
- **lint curly rule:** always use braces in `for` loops.

## Open follow-ups (out of scope for this PR)

- W6-7: install `gh` CLI or set up `git push` remote (requires user action)
- Future: hook rate-limiter + llm-cache into `provider/openai-compatible.js`
  (currently only anthropic is integrated; same pattern applies)
- Future: `plugin/tracer` (deferred — Darwin LLM calls are independent,
  not part of a trace tree)
