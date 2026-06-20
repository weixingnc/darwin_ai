# Darwin Skill Contract -- V8.2 execute() / buildCard() Split

**Status:** V10.5 (2026-06-20) -- contract synced across 6 sibling skills.
**Audience:** skill authors + plugin authors who consume skills directly.

## TL;DR

- `skill.execute(input, context)` -- **STANDARD** contract. Most skills return
  `{ output: string }` (single-key). Three richer siblings return multi-key
  shapes for programmatic hints.
- `buildCard(input, options?)` -- **PROGRAMMATIC** entry point (feishu-card
  only), returns `{ output, card, theme, stats }` (rich shape).
- Most skills expose ONLY `execute()`. `feishu-card` is the exception -- it
  exposes both because `plugin/feishu-notify.js` needs the structured card
  object (V7.1).

## Per-skill contract (authoritative shape table)

| Skill                    | `execute()` return shape       | Notes                                                                                                                                  |
| ------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `hello-world`            | `{ output: string }`           | Single-key; standard.                                                                                                                  |
| `summarizer`             | `{ output: string }`           | Single-key; standard.                                                                                                                  |
| `translator`             | `{ output: string }`           | Single-key; standard.                                                                                                                  |
| **`feishu-card` (V8.2)** | **`{ output: string }`**       | Single-key (was multi-key in V7.1). Use `buildCard()` for the rich shape.                                                              |
| `commit-message`         | `{ output, suggested, stats }` | Multi-key; `output` is the LLM-facing string; `suggested` + `stats` are programmatic hints. On `invalid` input, also has `issues: []`. |
| `test-generator`         | `{ output, suggested, stats }` | Multi-key; same pattern as `commit-message`.                                                                                           |
| `code-review`            | `{ output, summary, issues }`  | Multi-key; `output` is the LLM-facing string; `summary` + `issues` are programmatic.                                                   |

Every skill has a guard test in `tests/skill-contract.test.js` that locks its
return shape (V10.5). If a future change adds a new key (or drops one), the
test fails and forces a contract-aware redesign.

## Why the split exists

Skill `execute()` consumers (LLM-facing call sites, self-evolution proposals)
only need a string. Programmatic consumers (plugins that need to introspect
or post-process the structured result) need the object. Forcing all `execute()`
callers to `JSON.parse` a string is wasteful when the producer already has the
object. So `feishu-card` exposes both:

| Caller                           | Function                                          | Why                                                                                       |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| LLM / self-evolution prompts     | `execute()`                                       | String is the universal skill contract. Round-trips through Darwin's LLM tool loop.       |
| `plugin/feishu-notify.js` (V7.1) | `buildCard()` -> `{ output, card, theme, stats }` | Plugin needs `.card` to push via `platform/feishu.js send` with `msg_type='interactive'`. |
| Future plugin authors            | `buildCard()`                                     | Same -- programmatic card composition without re-parsing.                                 |

## V8.2 decision: align `feishu-card` with dominant sibling pattern (single-key)

V7.1 `feishu-card.execute()` returned `{ output, card, theme, stats }` (multi-key).
V8.2 collapsed it to `{ output: string }` (single-key) for consistency with
`hello-world` / `summarizer` / `translator`. The three other multi-key siblings
(`commit-message`, `test-generator`, `code-review`) keep their richer shape
because they expose programmatic hints (suggested / stats / issues / summary)
that the LLM consumer may want.

`feishu-card` does not need that -- the structured card is consumed by a
plugin, not by an LLM, and the plugin imports `buildCard()` directly.

## Migration guide (V7.1 -> V8.2) for `feishu-card`

**Before (V7.1):**

```js
const r = await feishuCard.execute({ topic, payload });
r.card; // structured card object
r.theme; // 'green' | 'blue' | 'orange' | 'red'
r.stats; // { elements, has_header }
r.output; // JSON.stringify(card)
```

**After (V8.2):**

```js
const r = await feishuCard.execute({ topic, payload });
r.output; // JSON.stringify(card) -- same as before
// r.card, r.theme, r.stats are gone from execute(). Use buildCard() for those.
```

**For plugin authors** (you are the V7.1 `plugin/feishu-notify` pattern):
keep importing `buildCard()` directly. No change needed.

```js
import { buildCard } from '../skill/examples/feishu-card.js';
const built = buildCard({ topic, payload });
// built.card, built.theme, built.stats all available.
```

## V8.2 test contract (feishu-card specific)

The `skill/examples/feishu-card.test.js` V8.2 guard test locks the contract:

```js
const r = await feishuCard.execute({ topic, payload });
assert.equal(Object.keys(r).sort(), ['output']); // single-key
assert.equal(typeof r.output, 'string');
const reparsed = JSON.parse(r.output);
assert.deepEqual(reparsed, buildCard({ topic, payload }).card); // round-trip
```

If `execute()` ever regresses to multi-key (e.g. someone re-adds `card` /
`theme` / `stats` to satisfy a reviewer suggestion), this test fails and
forces a V8.2-aware redesign.

## V10.5 cross-skill contract guard

`tests/skill-contract.test.js` (added in V10.5) covers all 6 sibling skills

- `feishu-card` (7 total). Each test imports the skill, runs `execute()` with
  a representative input, and asserts the exact set of return keys matches the
  table above.

A second test in the same file verifies that `output` is always a non-empty
string for every skill (universal `output` invariant).

## See also

- `skill/examples/feishu-card.js` -- the skill (with the trimmed docstring)
- `skill/examples/lib/feishu-card-builder.js` -- v10.6 extracted builder
- `plugin/feishu-notify.js` -- V7.1 consumer that uses `buildCard()` directly
- `tests/integration/feishu-card-e2e.test.js` -- V7.1 e2e closure
- `tests/skill-contract.test.js` -- V10.5 cross-skill shape guard
