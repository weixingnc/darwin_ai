# Darwin

> **A self-evolving digital life.** v2 skeleton; flesh grown by Darwin itself.

## TL;DR

Darwin is an agent OS that **evolves its own capability surface at runtime**.
Plug in a missing skill, a new provider, or a tool — Darwin proposes the
change, applies it to its own repo, verifies, and rolls back if the build
breaks. The whole loop is auditable, revertible, and human-approved by default.

```bash
git clone <darwin> ~/darwin && cd ~/darwin
npm install && chmod +x bin/darwin
npm test           # 1247/1247 pass
./bin/darwin self-evolution diagnose   # scan current capability surface
./bin/darwin self-evolution evolve --confirm   # run one self-evolve cycle
```

## What "self-evolving" means in practice

Darwin maintains a **catalogue** of expected capabilities (providers, tools,
skills, memory backends, platforms, plugins). When the actual code drifts from
the catalogue, Darwin:

1. **diagnose** — scans the current capability surface and reports missing items
2. **propose** — generates a structured change proposal (JSON)
3. **apply** — writes the file + creates a pre-apply git tag (human approval gate)
4. **verify** — runs `npm test` + `npm run lint` + `npm run size-check`
5. **rollback** — `git reset --hard` to the pre-apply tag if verify fails
6. **audit** — append-only log of every step (`<baseDir>/audit.jsonl`)
7. **learn** — appends a `- <date>: <rule>` line to `evolution-rules.md`

The whole pipeline is **mechanical — no LLM in the loop** (ADR-009). The
human decides _what_ to evolve; Darwin handles _how_.

## Status (2026-06-20)

| Dimension | Catalogue | Coverage |
| --------- | --------- | -------- |
| Providers | 12/12     | 100%     |
| Tools     | 9/9       | 100%     |
| Skills    | 7/7       | 100%     |
| Memory    | 3/3       | 100%     |
| Platforms | 1/1       | 100%     |
| Plugins   | 7/7       | 100%     |

- **Tests:** 1199/1199 pass · **Lint:** 0 errors · **Size:** 168 files, all < 1000 lines
- **Coverage:** maintained at 91%+ (V10.1 audit plugin refactor preserves)
- **HEAD:** `c01b44d` (V14-V17.1 productization: log rotate + audit query CLI + skill-contract sync + 1247 tests)
- **Production plugins:** 7 — `logger` (example) · `audit` (P2c-2 + P2j, v10.1 all-12-events) · `metrics` (W4-1) · `rate-limiter` (W5-1) · `llm-cache` (W6-2) · `feishu-notify` (V6.1) · `cron-audit` (V7.2)
- **Provider count** grew from 6 to 12 in V4-V8: `claude-3.5`, `deepseek` (R1), `gemini`, `openai` (native), `openai-compatible` (shared by qwen/deepseek), `qwen` (R1), plus the anthropic family. V10.2 extracted 6 shared HTTP helpers into `provider/protocol/_shared.js`.
- **Skill count** grew from 6 to 7 with V7.1's `feishu-card` (interactive card shape) plus 6 sibling skills (hello-world, summarizer, translator, commit-message, test-generator, code-review). V8.2 normalised `feishu-card.execute()` to single-key `{output:string}` contract.

## Self-evolution roadmap (delivered in 2026-06)

| Phase      | SHA       | What                                                                     |
| ---------- | --------- | ------------------------------------------------------------------------ |
| P2a        | `a9fd668` | Plugin CLI bug fix (`[object Object]` → `→ logger`)                      |
| P2b        | `694f1ce` | `diagnose` scans plugins + `missing_plugins` field                       |
| P2d        | `f6f3e6d` | Plugin manifest security (deny-by-default + 5 high-risk blocklist)       |
| P2c-1      | `1c78d86` | `evolution/propose` adds `plugins` template + manifest stub              |
| P2c-2      | `71e0ffb` | First production plugin: `plugin/audit.js` (in-memory)                   |
| P2c-3      | `dbd4c9e` | Darwin end-to-end self-evolution via tmpdir worktree + subprocess        |
| P2e        | `52a645b` | Runtime sandbox via monkey-patch (9 high-risk methods gated)             |
| P2f        | `55d90a5` | `runSelfEvolve()` orchestrator (closed loop, `confirm:true` opt-in)      |
| P2g        | `f63c544` | Catalogue persistence + growth strategy (JSON overlay)                   |
| P2i        | `0ade10b` | Plugin loader runtime sandbox integration (load/unload activate)         |
| P2j        | `1d4275e` | Audit plugin on-disk persistence (JSONL append + post-restart replay)    |
| P3a        | `8071460` | `self-evolution evolve` CLI sub-command (--confirm required)             |
| P3b        | `ff373ab` | c8 coverage baseline + npm scripts (`npm run coverage`)                  |
| P3c        | `2d1b2ab` | `README.md` (this file) — first-pass entry point                         |
| W2-1       | `5607a7e` | Fix `diagnose` filtering co-located `*.test.js` (pre-existing leak)      |
| W2-2       | `55e86ab` | husky v9 deprecation cleanup + `.git/config` `core.hooksPath` fix        |
| W3-2       | `d6f7d1a` | CLI end-to-end test (closes the P3a loop) + per-repoRoot catalogue fix   |
| W4-1       | `cc1931e` | Third production plugin: `plugin/metrics.js` (observability)             |
| W4-2       | `459c12d` | Darwin grows `rate-limiter` end-to-end (PM-curated growth target)        |
| W5-1       | `5648477` | `plugin/rate-limiter.js` real implementation (sliding window)            |
| W5-3       | `d7ba361` | W4-2 e2e regression + catalogue 4→5 status sync                          |
| V4 cycle 0 | `a04c3d9` | V4 c0: OpenClaw workspace fix (3 agents pointed at empty side repos)     |
| V4 cycle 1 | `8cf2bf0` | V4 c1: vector memory DI seam — fakeembed default, 1005/1005 tests        |
| V4 cycle 2 | `3e8f8e9` | V4 c2: head/tail/wc e2e — 1000/1000 tests (integer gate milestone)       |
| V4 cycle 3 | `0a73413` | V4 c3: deepseek R1 reasoning e2e — 1005/1005, R1 surface parity          |
| V4 cycle 4 | `242f754` | V4 c4: provider.embed() + vector end-to-end — 1018/1018, P1-B2 milestone |
| V4 cycle 5 | `b6984a7` | V4 c5: 6-skill Darwin self-evolution e2e — 1027/1027                     |
| V5 cycle 1 | `aa0c439` | V5 c1: feishu adapter send (real IM v1 wire + tenant_access_token)       |
| V5 cycle 2 | `9267ff8` | V5 c2: feishu adapter parse + verify round-trip                          |
| V6 cycle 1 | `d260048` | V6 c1: plugin/feishu-notify (Darwin evolution events → feishu push)      |
| V6 cycle 2 | `4a07d1a` | V6 c2: skill: feishu-card (interactive push) + V7 cron scheduler seed    |
| V7 cycle 1 | `23e3446` | V7 c1: feishu-card skill execute shape (single-key `{output:string}`)    |
| V7 cycle 2 | `eb567dc` | V7 c2: cron scheduler + audit heartbeat plugin (cron-tick → audit)       |
| V8 cycle 1 | `aeb755a` | V8 c1: qwen R1 reasoning e2e closure (DashScope OpenAI-compatible)       |
| V8 cycle 2 | `c39b32a` | V8 c2: provider test imports + cron-audit theme + housekeeping doc       |
| V9 cycle 1 | `cf231b3` | V9 c1: docs/memory/2026-06-19 (cross-night delivery)                     |
| V9 cycle 2 | `28552ea` | V9 c2: feishu-notify loader.init() lifecycle e2e (7 case A-G)            |
| V10.1      | `b32e7b7` | V10.1: audit plugin all-12 events + catalogue worktree isolation         |
| V10.2      | `9aa3f72` | V10.2: provider/protocol/\_shared.js (qwen/deepseek/gemini refactor)     |
| V10.3      | `e4a7b42` | V10.3: V9.2 reviewer 4-item housekeeping (feishu-notify e2e tightening)  |

Each row is one commit. See `docs/V3_ROADMAP.md` for the long-form design notes.

## Safety model

- **No LLM in the closed loop** (ADR-009). The dispatcher is mechanical.
- **Human approval gate** (ADR-006). Every `apply` requires a tier classification
  (red/yellow/green). Green can be auto-approved with `--auto-approve` flag.
- **Deny-by-default for plugins** (P2d). Plugin manifest must declare permissions
  in `PLUGIN_PERMISSIONS` whitelist; any intersection with `PLUGIN_DENIED` (e.g.
  `process:exit`, `fs:delete`, `child_process:exec`) rejects the plugin at load.
- **Runtime sandbox opt-in** (P2e). When `loader.load({enableSandbox:true})`,
  Darwin monkey-patches `fs.*` / `child_process.*` / `process.exit` so plugins
  cannot damage Darwin's own state. Default `false` to avoid trapping Darwin
  during evolution.
- **Verify before re-diagnose** (P2f). If `verify` fails, the orchestrator
  rolls back via the pre-apply git tag and surfaces the failure in the report.
- **One proposal per cycle by design** (P2f #4). Growing `PLUGIN_CATALOGUE`
  from 1 → N is a deliberate, human-paced process.

## Architecture

```
darwin/
├── core/          # runtime primitives (event-bus, self-evolution facade)
├── evolution/     # diagnose / propose / apply / verify / rollback / audit
├── plugin/        # plugin system (loader, registry, interface, sandbox)
│   └── __example__/  # logger.js reference plugin
├── tool/          # built-in tools + catalog
├── skill/         # skill loader / matcher-v2 / watcher
├── memory/        # memory backends + audit log + learnings
├── platform/      # platform adapters (feishu, …)
├── provider/      # LLM providers (anthropic, openai, …)
├── bin/           # CLI entry + lib dispatchers
└── docs/          # USAGE, V3_ROADMAP, ADR/, ANTI_PATTERNS
```

See `docs/ADR/` for the design decisions that shaped this layout.

## How to use Darwin

- **First time?** Read [`docs/USAGE.md`](docs/USAGE.md) — 5-minute quick start
  - LLM provider setup + first self-evolve cycle walkthrough.
- **Want to design a plugin?** Read [`docs/V3_ROADMAP.md`](docs/V3_ROADMAP.md)
  P2 series notes + `plugin/__example__/logger.js` (24-line minimal plugin).
- **Want to contribute a catalogue item?** Run `npm run diagnose` to see
  what's missing, then read `evolution/propose.js` to understand the template
  system, then write a one-page proposal in
  [`docs/PR_DESIGN_*.md`](docs/PR_DESIGN_26_OPENCLAW_COMPAT.md) format.

## License

MIT
