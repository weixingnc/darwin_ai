# Security

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security
vulnerabilities.

Email: `weixingnc@gmail.com`
Subject prefix: `[darwin-security]`

We will:

- Acknowledge within 48 hours.
- Provide an initial assessment within 7 days.
- Coordinate disclosure timing with the reporter.

## Scope

In scope (anything that processes user data or executes code):

- `core/*` -- event bus, container, error handler, skill loader.
- `provider/*` -- LLM provider adapters (Anthropic, OpenAI,
  DeepSeek, Qwen, GLM, Moonshot, MiniMax, ...).
- `web/*` -- HTTP server, SSE stream forwarder, browser chat UI.
- `evolution/*` -- SelfEvolution apply/verify/rollback pipeline.
- `plugin/*` -- plugin loader, sandbox, audit plugin.

Out of scope:

- `examples/*` -- demo code (Slack / Feishu bridges). Users run
  these at their own risk; we document the channels but do not
  audit them line-by-line.
- Typos, missing tests, and pure documentation issues -- file
  a regular PR for these.

## Hardened paths

These paths are on the V3+ autonomous boundary list. Darwin's
`SelfEvolution` does NOT touch them at runtime, even when a
proposal nominally affects them:

- `core/{event-bus,config-resolver,error-handler,events}.js`
- `package.json` (dependency lock)
- `docs/ANTI_PATTERNS.md` (community-curated failure catalogue)
- `docs/ADR/*` (architecture decision records)

A human review is required for any change to these files.

## Runtime protections in place

- Bearer-token auth on every non-health web route
  (`web/server.js`, V33). Tokens are generated via
  `crypto.randomBytes(32)` and stored mode `0o600` in
  `~/.darwin/web.token`.
- Constant-time token compare (`safeEqual`) to avoid timing leaks.
- Plugin sandbox (`plugin/sandbox.js`) denies dangerous monkey
  patches by default; runtime overrides require an explicit opt-in.
- Evolution apply writes a `git tag evolution-pre-<id>-<ts>`
  before touching the tree so `git reset --hard` recovers any
  failed self-modification.
- Audit log under `memory/audit/YYYY-MM-DD-<proposal_id>.json`
  captures every apply + verify result (success or failure).

## Supported versions

| Version        | Supported |
| -------------- | --------- |
| `main` branch  | yes       |
| Latest release | yes       |
| Older tags     | no        |
