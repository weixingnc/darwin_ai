# Example: Feishu <-> Darwin bridge (V38)

A 300-line Node script that wires [Feishu's event-callback
API](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview)
to the darwin webhook layer (V36), so a Feishu app can use
darwin as its AI backend for DMs and group chats.

## What you learn

- How the **V37 -> V38 pattern** works: copy one vendor
  adapter, change 3-4 vendor-specific things, ship. The
  darwin webhook contract is unchanged.
- How Feishu's **HMAC-SHA256 signature verification** maps
  to the same "X-Darwin-Channel-Secret" slot that V37 left
  for Slack.
- How to handle Feishu's **JSON-encoded content** payload
  (`event.message.content` is a string like
  `'{"text":"@_user_1 hello"}'`, not a flat `event.text`).

## Run it

```bash
# 1. Start darwin web in another terminal
darwin web --port 8080

# 2. Start the bridge
DARWIN_TOKEN=<your-darwin-token> \
  FEISHU_APP_ID=cli_xxx \
  FEISHU_APP_SECRET=xxx \
  FEISHU_ENCRYPT_KEY=xxx \
  PORT=4001 \
  node examples/feishu-bridge/bridge.mjs

# 3. In your Feishu app config (https://open.feishu.cn/app):
#    - Event Subscriptions > Request URL: https://your-host:4001/feishu/events
#    - Permissions: im:message, im:message.group_at_msg, im:message.receive_v1
#    - Verification Token / Encrypt Key: same value as FEISHU_ENCRYPT_KEY above
```

## How it differs from V37 (Slack)

| Concept            | V37 Slack                       | V38 Feishu                                  |
| ------------------ | ------------------------------- | ------------------------------------------- |
| Event type         | `message`                       | `im.message.receive_v1`                     |
| Message text       | `event.text` (flat)             | `JSON.parse(event.message.content).text`    |
| Vendor signature   | `X-Darwin-Channel-Secret` (V36) | `X-Lark-Signature` (Feishu HMAC)            |
| Verification token | env `WEBHOOK_SECRET_*`          | env `FEISHU_ENCRYPT_KEY`                    |
| Outbound API       | `chat.postMessage`              | `im/v1/messages` with `tenant_access_token` |
| Default PORT       | 4000                            | 4001                                        |

Everything else -- the darwin call, the fire-and-forget forward,
the async delivery, the no-deps philosophy -- is identical.

## Files

- `bridge.mjs` -- the standalone bridge (~290 lines)
- `bridge.test.mjs` -- 5 integration tests (spawn bridge + darwin,
  walk a realistic Feishu event-callback flow including the
  signature check)
- `README.md` -- this file
