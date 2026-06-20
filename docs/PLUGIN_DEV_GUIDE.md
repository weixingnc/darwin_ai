# Darwin Plugin Development Guide

**Audience:** developers writing their own Darwin plugins (e.g. a
custom audit sink, a Slack notifier, a rate limiter).
**Status:** v0.1.0 contract -- the plugin surface is stable across
the v0.x line. Breaking changes only land in v1.0+.

## What is a plugin?

A plugin is a JavaScript module that:

1. Subscribes to Darwin events on the **EventBus**
2. Implements the **5-stage lifecycle** (load -> init -> enable ->
   disable -> unload)
3. Has a manifest (name, version, capabilities, permissions) so the
   loader can validate it before activation

Plugins can be loaded from:

- The `plugin/` directory (production plugins)
- `plugin/__example__/` (template -- copy + rename)
- Any custom path passed to `PluginLoader.discover()`

## The minimum viable plugin

```js
// my-plugin.js
export default {
  name: 'my-plugin', // required, lowercase, non-empty
  version: '0.1.0', // required, semver
  capabilities: ['tool'], // required, see Capability matrix
  permissions: ['bus:on', 'log:info'], // required, see Permission matrix

  init(ctx) {
    this._bus = ctx.eventBus;
    this._bus.on('evolution:audit', (entry) => {
      // do something with the audit event
    });
  },

  enable() {
    this._enabled = true;
  },

  disable() {
    this._enabled = false;
  },

  destroy() {
    this._bus = null;
  },
};
```

That's it. The loader handles state-machine transitions and
emits the appropriate `plugin:*` events on the bus. You only need
to implement the 4 lifecycle hooks you actually use.

## The 5-stage lifecycle

| Stage     | State transition       | Your hook   | What you do                                                        |
| --------- | ---------------------- | ----------- | ------------------------------------------------------------------ |
| `load`    | UNLOADED -> LOADED     | (none)      | Module loaded; module.exports validated; IPlugin.validate() called |
| `init`    | LOADED -> INITIALIZED  | `init(ctx)` | Subscribe to events; allocate resources; idempotent                |
| `enable`  | INITIALIZED -> ENABLED | `enable()`  | "Warm up" -- start emitting, opening connections                   |
| `disable` | ENABLED -> DISABLED    | `disable()` | "Cool down" -- stop emitting, flush buffers                        |
| `destroy` | any -> UNLOADED        | `destroy()` | Final cleanup; unsubscribe all; close handles                      |

**State machine invariants** (enforced by `plugin/loader.js`):

- Calling `init` twice without `disable` -> error + `PLUGIN_INIT_ERROR` event
- Calling `enable` before `init` -> error
- Calling `unload` is allowed from any state (recovery path)
- All hook failures emit `plugin:*_ERROR` and return `{ ok: false }`; they
  do NOT throw across the module boundary (per ADR `A-5`)

## The init(ctx) context object

The loader passes this to your `init()` hook:

```ts
{
  eventBus: EventBus,           // subscribe via .on(topic, handler)
  config: object,              // resolved from ConfigResolver
                               // (e.g. config['plugin-my-plugin'])
}
```

The config object is per-plugin. The config-key naming convention is
`plugin-<plugin-name>` (dash-separated, lowercase).

## Capability matrix

`capabilities` is an array of strings from this set. The loader
validates that you only emit events within your declared capabilities.

| Capability       | What you can do                                               |
| ---------------- | ------------------------------------------------------------- |
| `'tool'`         | You implement tool-shaped operations (callable from agents)   |
| `'adapter'`      | You connect Darwin to an external system (feishu, slack, ...) |
| `'provider'`     | You wrap an external LLM API (deepseek, anthropic, ...)       |
| `'audit'`        | You consume the audit stream and persist it                   |
| `'rate-limiter'` | You throttle downstream operations                            |
| `'cron'`         | You schedule periodic work (cron-audit pattern)               |

If you need a new capability, open a PR adding it to
`plugin/interface.js#PLUGIN_CAPABILITIES`. Capabilities are
**additive** -- no breaking change.

## Permission matrix

`permissions` is an array of strings. The loader uses these to gate
runtime access. Sandbox (when enabled via `loader({ enableSandbox:
true })`) blocks any permission NOT in your list.

| Permission    | What it allows                         |
| ------------- | -------------------------------------- |
| `'bus:on'`    | Subscribe to events via `bus.on()`     |
| `'bus:emit'`  | Emit events via `bus.emit()`           |
| `'log:info'`  | `console.log` (info-level)             |
| `'log:warn'`  | `console.warn`                         |
| `'log:error'` | `console.error`                        |
| `'fs:read'`   | Read files (`fs.readFile`, etc.)       |
| `'fs:append'` | Append to files (`fs.appendFile`)      |
| `'fs:write'`  | Write/overwrite files (`fs.writeFile`) |
| `'net:http'`  | Make outbound HTTP requests            |
| `'env:read'`  | Read `process.env`                     |

The current set is in `plugin/interface.js#PLUGIN_PERMISSIONS`. If
you need `net:https` or another, add it to that list AND
`PLUGIN_DENIED` must NOT list it.

## The 12 evolution events (full list)

Plugins that declare `'audit'` capability can subscribe to any of these:

```
evolution:diagnose:before
evolution:diagnose:after
evolution:propose:before
evolution:propose:after
evolution:approve
evolution:reject
evolution:apply:before
evolution:apply:after
evolution:verify
evolution:rollback
evolution:audit
evolution:learn
```

The `* :before` events fire BEFORE the step runs (cancelable by
returning `{ ok: false }` from a subscriber -- not currently wired
but the convention is in place). The `* :after` events fire AFTER.

The `evolution:audit` event has a rich payload
(`proposal_id`, `action`, `outcome`, `files_changed`, `diff_stat`,
`duration_ms`). Use this for the V17.1 audit-query CLI and any custom
audit sinks you write.

## A worked example: slack-notifier

```js
// plugin/slack-notifier.js
export default {
  name: 'slack-notifier',
  version: '0.1.0',
  capabilities: ['adapter'],
  permissions: ['bus:on', 'log:info', 'net:http'],

  init(ctx) {
    this._bus = ctx.eventBus;
    this._config = ctx.config;
    this._bus.on('evolution:apply:after', (entry) => {
      if (entry.payload?.outcome === 'ok') {
        this._sendSlack(`Darwin applied ${entry.payload.proposal_id}`);
      }
    });
  },

  enable() {
    this._enabled = true;
  },
  disable() {
    this._enabled = false;
  },
  destroy() {
    this._bus = null;
  },

  async _sendSlack(text) {
    if (!this._enabled) return;
    const webhook = this._config?.webhook_url;
    if (!webhook) return;
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error('[slack-notifier] send failed:', err.message);
    }
  },
};
```

Config (in `~/.darwin/plugin-slack-notifier.yaml`):

```yaml
webhook_url: https://hooks.slack.com/services/T00/B00/XXXX
```

## Testing your plugin

Two patterns:

**1. Unit test the lifecycle hooks directly** (no Darwin runtime):

```js
// tests/plugin/slack-notifier.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import slackNotifier from '../../plugin/slack-notifier.js';

describe('slack-notifier lifecycle', () => {
  test('init subscribes to evolution:apply:after', () => {
    const events = [];
    const bus = { on: (topic, handler) => events.push({ topic, handler }) };
    slackNotifier.init({ eventBus: bus, config: { webhook_url: 'x' } });
    assert.equal(events.length, 1);
    assert.equal(events[0].topic, 'evolution:apply:after');
  });

  test('_sendSlack is a no-op when disabled', async () => {
    slackNotifier._enabled = false;
    await slackNotifier._sendSlack('hi'); // should not throw
  });
});
```

**2. Integration test via the loader** (with the full Darwin state machine):

```js
const loader = createPluginLoader({ eventBus: new EventBus(), registry: new PluginRegistry({ eventBus }) });
const r = await loader.load('./plugin/slack-notifier.js');
assert.equal(r.ok, true);
await loader.init('slack-notifier');
// emit a test event
bus.emit('evolution:apply:after', { topic: 'evolution:apply:after', payload: { outcome: 'ok', proposal_id: 'p-1' } });
// assert side effects
```

## What you should NOT do

- **Don't** call `process.exit()` from a plugin. The loader may have
  other plugins in mid-init. Use `throw` and let the loader's
  `ErrorHandler.wrapAsync` catch it.
- **Don't** block in `init()`. The loader is sequential; a slow
  init blocks every other plugin. Use `enable()` for expensive
  warmup.
- **Don't** store the `ctx.eventBus` in a global. Plugins are
  re-loadable; a stale bus reference causes event loss.
- **Don't** emit events from a `disable()` callback. The plugin
  is being torn down; downstream plugins may not be listening.

## Where to look in the codebase

| File                           | What it shows                                                       |
| ------------------------------ | ------------------------------------------------------------------- |
| `plugin/interface.js`          | `IPlugin.validate()` + `PLUGIN_CAPABILITIES` + `PLUGIN_PERMISSIONS` |
| `plugin/loader.js`             | 5-stage state machine + sandbox + `run()` async wrapper             |
| `plugin/registry.js`           | How plugins are registered / looked up                              |
| `plugin/audit.js`              | Working example: subscribes to all 12 events (V10.1)                |
| `plugin/cron-audit.js`         | Working example: scheduled heartbeat (cron + audit)                 |
| `plugin/sandbox.js`            | How `enableSandbox` blocks denied methods                           |
| `plugin/__example__/logger.js` | Smallest possible plugin (template)                                 |

## Versioning your plugin

Plugin versions are independent of Darwin's version. Use
[SemVer](https://semver.org/):

- `0.x.y` -- pre-1.0; breaking changes allowed between minor versions
- `1.0.0+` -- stable; breaking changes require a major bump

The loader doesn't enforce SemVer today (only that the version is a
non-empty string), but downstream tooling (e.g. plugin update notifiers)
will eventually.
