# Example 1: Basic chat from a Node script

Shows the smallest possible Darwin integration: load one provider,
send one prompt, read the reply, exit. ~60 lines, no daemon, no
self-evolution loop.

## What you learn

- How Darwin's **provider loader** works in 3 stages (`load` -> `init`
  -> `enable`)
- How to wire the **EventBus** if you want to observe evolution events
- How to call `provider.chat({ prompt })` and read the reply
- That Darwin is **usable as a library** -- you do not have to use the
  full `darwin self-evolution` orchestrator

## Run it

```bash
# 1. Install Darwin (from repo root)
npm install

# 2. Set your API key (deepseek is used in this example; swap for any
#    other provider by changing the loader.load() call)
export DEEPSEEK_API_KEY=sk-...

# 3. Run
node examples/basic-chat/basic-chat.mjs "Explain EventBus in 3 sentences"
```

You should see:

```
> Explain EventBus in 3 sentences

<the model's reply>
[event] evolution:audit proposal=-
```

(The audit event fires because the provider emits `evolution:audit`
on every chat call -- Darwin's audit plugin subscribes to all 12
events and persists them to `<baseDir>/audit.jsonl`.)

## Swap providers

Replace `'deepseek'` with any other provider from `provider/`:
`openai`, `anthropic`, `qwen`, etc. Same loader API.

## Files

- `basic-chat.mjs` -- the 60-line example
- `README.md` -- this file
