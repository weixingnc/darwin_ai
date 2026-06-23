# Darwin

> **A self-evolving digital life.** v0.1.0 skeleton; flesh grown by Darwin itself.

## TL;DR

Darwin is an agent OS that **evolves its own capability surface at runtime**.
Plug in a missing skill, a new provider, or a tool — Darwin proposes the
change, applies it to its own repo, verifies, and rolls back if the build
breaks. The whole loop is auditable, revertible, and human-approved by default.

```bash
# One-line install (Linux / macOS)
curl -fsSL https://raw.githubusercontent.com/weixingnc/darwin_ai/main/install.sh | bash

# One-line install (Windows PowerShell)
# iwr -useb https://raw.githubusercontent.com/weixingnc/darwin_ai/main/install.ps1 | iex

# Or from a local clone (dev workflow):
git clone <darwin> ~/darwin && cd ~/darwin
npm install && chmod +x bin/darwin
npm test                       # 1320/1320 pass (V41 baseline)
./bin/darwin --version         # verify install (V23+ adds this)
./bin/darwin help              # see all sub-commands
./bin/darwin self-evolution diagnose     # scan current capability surface
./bin/darwin self-evolution audit-query --topic evolution:audit --format json  # V17.1

# Uninstall (any OS):
# Linux/macOS:  bash uninstall.sh | bash
# Windows:      iwr -useb .../uninstall.ps1 | iex

# From a pre-built tarball (V25+, no git required):
# Linux/macOS:
#   curl -fsSL https://raw.githubusercontent.com/weixingnc/darwin_ai/main/install.sh \
#     | bash -s -- --from-tarball https://github.com/weixingnc/darwin_ai/releases/download/v0.1.0/darwin-v0.1.0.tar.gz
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

# Or via the CLI wrapper (V29-actual):
#   darwin web                       # foreground, Ctrl+C to stop
#   darwin web --port 9000 --host 0.0.0.0
#   darwin web --detach              # background, write pidfile, exit
#   darwin web stop                  # SIGTERM -> SIGKILL after 2s
#   darwin web status                # pid, url, uptime, masked auth token

# Server-Sent Events (V31): POST /api/chat with
# `Accept: text/event-stream` streams provider chunks as
#   data: {"type":"chunk","text":"..."}\n\n
#   data: {"type":"done"}\n\n
#   data: {"type":"error","error":"..."}\n\n
# The web UI (V32) uses EventSource-style fetch() to render
# the assistant's reply token-by-token with a blinking caret.

# Bearer-token auth (V33): the CLI generates a 64-char hex token at
# ~/.darwin/web.token (mode 0o600) on first launch and forwards
# it to the child via WEB_AUTH_TOKEN. Send it as either
#   Authorization: Bearer <token>
#   X-Darwin-Token: <token>
#   ?token=<token>            (one-shot link, captured by the V34 UI)
# `darwin web status` prints a masked preview + the full path.
# /api/health stays open (and reports auth_required: true) so a
# load balancer can probe without holding the secret.

# Browser login (V34): on first open, the page shows a "Sign in"
# card asking for the token. After paste, the token is stored in
# localStorage and reused silently. A one-shot link like
#   http://localhost:8080/?token=<token>
# is auto-adopted and the query string is stripped from the URL
# so the secret does not leak via browser history or referer.
# A "Sign out" button in the header clears the token.

# Channel webhook (V36): any HTTP-receiving platform can talk to
# darwin with three lines of code:
#   fetch('http://localhost:8080/api/webhook/slack', {
#     method: 'POST',
#     headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
#     body: JSON.stringify({ message: userText, reply_url: 'https://myapp.com/reply' }),
#   });
# darwin runs the chat, POSTs {reply, channel, user_id, meta}
# back to reply_url, and returns 200 to the webhook caller
# immediately. V33 bearer token still gates the route; a
# per-channel WEBHOOK_SECRET_<CHAN> env (when set) provides a
# second factor for untrusted networks.

# Working vendor adapters (V37, V38): copy-paste-runnable bridges
# for Slack and Feishu, each ~300 lines, zero new dependencies.
# See examples/slack-bridge/ and examples/feishu-bridge/. To add
# a new vendor (Telegram, Discord, MS Teams, etc.), copy either
# directory and change 3-4 vendor-specific things: event type,
# content parsing, signature check, outbound API call. The
# darwin webhook contract is unchanged.
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
