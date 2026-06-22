# Darwin

> **A self-evolving digital life.** v0.1.0 skeleton; flesh grown by Darwin itself.

## TL;DR

Darwin is an agent OS that **evolves its own capability surface at runtime**.
Plug in a missing skill, a new provider, or a tool — Darwin proposes the
change, applies it to its own repo, verifies, and rolls back if the build
breaks. The whole loop is auditable, revertible, and human-approved by default.

```bash
# One-line install (Linux / macOS)
curl -fsSL https://raw.githubusercontent.com/weixing/darwin/main/install.sh | bash

# One-line install (Windows PowerShell)
# iwr -useb https://raw.githubusercontent.com/weixing/darwin/main/install.ps1 | iex

# Or from a local clone (dev workflow):
git clone <darwin> ~/darwin && cd ~/darwin
npm install && chmod +x bin/darwin
npm test                       # 1255/1255 pass (V23 baseline)
./bin/darwin --version         # verify install (V23+ adds this)
./bin/darwin help              # see all sub-commands
./bin/darwin self-evolution diagnose     # scan current capability surface
./bin/darwin self-evolution audit-query --topic evolution:audit --format json  # V17.1

# Uninstall (any OS):
# Linux/macOS:  bash uninstall.sh | bash
# Windows:      iwr -useb .../uninstall.ps1 | iex

# From a pre-built tarball (V25+, no git required):
# Linux/macOS:
#   curl -fsSL https://raw.githubusercontent.com/weixing/darwin/main/install.sh \
#     | bash -s -- --from-tarball https://github.com/weixing/darwin/releases/download/v0.1.0/darwin-v0.1.0.tar.gz
# Windows (V25.1+):
#   iwr -useb .../install.ps1 | iex; Install-Darwin -FromTarball <url>

# Or two-step (more inspectable):
#   curl -fsLO <tarball-url>
#   tar -xzf darwin-v0.1.0.tar.gz
#   cd darwin-v0.1.0
#   bash install.sh --from-tarball-installed

# Run the local web UI (V28, zero-dep http + chat):
#   node web/server.js
#   # Open http://localhost:8080 in a browser
#   # Configure provider first: darwin config add anthropic <key>
```

## Examples & developer docs

Working code you can copy-paste-run:

- [`examples/basic-chat/`](examples/basic-chat/) — 60-line script:
  load a provider, send a prompt, read the reply, exit. Shows
  Darwin-as-a-library.
- [`examples/custom-skill/`](examples/custom-skill/) — 30-line skill +
  4-line smoke test. The minimum viable `IPlugin` contract.
- [`examples/audit-query/`](examples/audit-query/) — query
  `core/audit-reader.js` from a Node script. Mirrors the
  `darwin self-evolution audit-query` CLI (V17.1).

Documentation:

- [`docs/PLUGIN_DEV_GUIDE.md`](docs/PLUGIN_DEV_GUIDE.md) — full plugin
  development guide: IPlugin contract, 5-stage lifecycle, capability
  matrix, permission matrix, 12 evolution events, worked Slack-notifier
  example, testing patterns, anti-patterns.
- [`docs/skill-contract.md`](docs/skill-contract.md) — the
  `{ output: string }` execute() shape, locked by 8 contract tests.
- [`docs/TAG_POLICY.md`](docs/TAG_POLICY.md) — which git tags Darwin
  keeps vs prunes, and why (40x redundancy cleanup V10.8).
- [`CHANGELOG.md`](CHANGELOG.md) — release notes (Keep a Changelog format).

## What "self-evolving" means in practice
