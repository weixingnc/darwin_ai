# Example 2: Write a custom skill in 30 lines

Shows the **minimum viable skill** for Darwin: a name, a description,
and an `async execute(input, context) -> { output: string }` function.
That's it -- everything else is optional.

## What you learn

- The exact **IPlugin skill contract** (single-key `{ output }` return,
  per `docs/skill-contract.md` V8.2)
- How to **test the contract** without booting the whole Darwin
  runtime (the bottom of `random-quote.mjs` has a 4-line smoke test)
- That skills are **plain ES modules** -- no special runtime required
  to test them in isolation

## Run the smoke test

```bash
node examples/custom-skill/random-quote.mjs
```

You should see:

```
OK: <some random quote>
```

## Load it via Darwin

Once your skill is in a `*.js` file under `skill/examples/` (or any
directory the loader scans), Darwin's `core/skill-loader.js` will
discover it automatically. Then:

```bash
# Verify the skill is registered
node bin/darwin memory set last-skill random-quote
```

For end-to-end LLM-triggered use, drop the file into `skill/examples/`
and Darwin's chat flow will pick it up via the trigger-word match.

## What's the contract?

Per `docs/skill-contract.md`, a skill's `execute()` MUST return:

```js
{
  output: string;
} // single-key, non-empty
```

The 8 contract tests in `tests/skill-contract.test.js` lock this for
every skill. If you accidentally return a multi-key shape (like the
V7.1 `feishu-card` did), the test will fail and tell you to add the
`buildCard()` programmatic entry point instead.

## Files

- `random-quote.mjs` -- 30-line skill + 4-line smoke test
- `README.md` -- this file
