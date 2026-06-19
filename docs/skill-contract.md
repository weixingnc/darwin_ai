# Darwin Skill Contract — V8.2 execute() / buildCard() Split

**Status:** V8.2 (2026-06-19) — feishu-card shape 收敛.
**Audience:** skill authors + plugin authors who consume skills directly.

## TL;DR

- `skill.execute(input, context)` — **STANDARD** contract, returns `{ output: string }` (single-key).
- `buildCard(input, options?)` — **PROGRAMMATIC** entry point, returns `{ output, card, theme, stats }` (rich shape).
- Most skills expose ONLY `execute()`. `feishu-card` is the exception — it exposes both because `plugin/feishu-notify.js` needs the structured card object (V7.1).

## Why the split exists

Skill `execute()` consumers (LLM-facing call sites, self-evolution proposals) only
need a string. Programmatic consumers (plugins that need to introspect or
post-process the structured result) need the object. Forcing all `execute()`
callers to `JSON.parse` a string is wasteful when the producer already has the
object. So `feishu-card` exposes both:

| Caller                           | Function                                         | Why                                                                                       |
| -------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| LLM / self-evolution prompts     | `execute()` → `{ output: string }`               | String is the universal skill contract. Round-trips through Darwin's LLM tool loop.       |
| `plugin/feishu-notify.js` (V7.1) | `buildCard()` → `{ output, card, theme, stats }` | Plugin needs `.card` to push via `platform/feishu.js send` with `msg_type='interactive'`. |
| Future plugin authors            | `buildCard()`                                    | Same — programmatic card composition without re-parsing.                                  |

## V8.2 decision: align with dominant sibling pattern (single-key)

V7.1 `feishu-card.execute()` returned `{ output, card, theme, stats }` (multi-key).
V8.2 collapses it to `{ output: string }` (single-key) for consistency with the
dominant sibling pattern:

| Skill                    | `execute()` return shape                                      |
| ------------------------ | ------------------------------------------------------------- |
| `hello-world`            | `{ output: string }`                                          |
| `summarizer`             | `{ output: string }`                                          |
| `translator`             | `{ output: string }`                                          |
| **`feishu-card` (V8.2)** | **`{ output: string }`** ← aligned with 4/6                   |
| `commit-message`         | `{ output, suggested, issues }` (multi-key; `output` primary) |
| `test-generator`         | `{ output, suggested }` (multi-key; `output` primary)         |
| `code-review`            | `{ output, summary, issues }` (multi-key; `output` primary)   |

The 3 multi-key siblings keep their richer shape because they expose
programmatic hints (suggested/issue lists) that the LLM consumer may want.
`feishu-card` doesn't need that — the structured card is consumed by a
plugin, not by an LLM, and the plugin imports `buildCard()` directly.

## Migration guide (V7.1 → V8.2)

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
r.output; // JSON.stringify(card) — same as before
// r.card, r.theme, r.stats are gone from execute(). Use buildCard() for those.
```

**For plugin authors** (you are the V7.1 `plugin/feishu-notify` pattern):
keep importing `buildCard()` directly. No change needed.

```js
import { buildCard } from '../skill/examples/feishu-card.js';
const built = buildCard({ topic, payload });
// built.card, built.theme, built.stats all available.
```

## V8.2 test contract

The `provider/qwen.test.js` / `skill/examples/feishu-card.test.js` V8.2
guard test locks the contract:

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

## See also

- `skill/examples/feishu-card.js` — the skill (with the trimmed docstring)
- `plugin/feishu-notify.js` — V7.1 consumer that uses `buildCard()` directly
- `tests/integration/feishu-card-e2e.test.js` — V7.1 e2e closure
