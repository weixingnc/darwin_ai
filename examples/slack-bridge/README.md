# Example: Slack <-> Darwin bridge (V37)

A 250-line Node script that wires [Slack's Events
API](https://api.slack.com/events) to the darwin webhook layer
(V36), so a Slack workspace can use darwin as its AI backend
for DMs and channels.

## What you learn

- How darwin's **V36 channel webhook** (`/api/webhook/<channel>`)
  is enough to integrate with any HTTP-receiving platform --
  no per-vendor adapter is needed in darwin itself.
- How the **async delivery** contract works: the bridge fires a
  POST to darwin, gets 200 immediately, and darwin POSTs the
  reply back to the bridge's `/slack/reply` endpoint a few
  seconds later.
- How to use darwin from a **standalone Node script** (the
  bridge is not a darwin plugin -- it's a normal HTTP server
  that talks to darwin's webhook over the network).

## Run it

```bash
# 1. Install Darwin (from repo root)
npm install

# 2. Configure a provider
darwin config add provider-anthropic
# (paste your key when prompted)

# 3. Start darwin web in another terminal
darwin web --port 8080
# (note the auth token it prints)

# 4. Start the bridge
DARWIN_TOKEN=<your-darwin-token> \
  SLACK_BOT_TOKEN=<your-slack-bot-token> \
  PORT=4000 \
  node examples/slack-bridge/bridge.mjs

# 5. In your Slack app config (https://api.slack.com/apps):
#    - Event Subscriptions > Request URL: https://your-host:4000/slack/events
#    - Subscribe to bot events: message.im, message.channels
#    - Bot Token Scopes: chat:write
```

Now any message sent to your bot (in a DM or a channel the bot
is invited to) gets forwarded to darwin; the reply comes back
through darwin's async delivery endpoint and is posted to Slack
via `chat.postMessage`.

## How it works

```
   Slack                   Bridge (this)                  Darwin
    |                           |                            |
    |--POST /slack/events------>|                            |
    |<--200 {accepted}----------|  (within 3s, Slack's ack)  |
    |                           |--POST /api/webhook/slack-->|
    |                           |                            |--- darwin chat --->
    |                           |                            |<-- {reply} ---
    |                           |<--POST /slack/reply--------|  (async)
    |--chat.postMessage-------->|  (mocked if no bot token)  |
    |                           |                            |
```

Two design choices worth noting:

1. **Fire-and-forget forward.** The bridge does NOT wait for
   darwin's reply before acking Slack. Slack's Events API has a
   3-second response budget and a darwin chat can take 5-30s,
   so we ack immediately and let darwin POST back when done.
2. **No Slack SDK.** The bridge uses Node's global `fetch` for
   both directions (Slack -> bridge, bridge -> darwin, darwin ->
   bridge). 250 lines, no dependencies, easy to read end-to-end.

## Files

- `bridge.mjs` -- the standalone bridge (~250 lines)
- `bridge.test.mjs` -- integration tests (spawn bridge + darwin,
  walk a realistic Slack Events flow)
- `README.md` -- this file
