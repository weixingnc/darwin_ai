# Darwin Tag Policy (V10.8)

## Tags we keep

### `v*-final` (release anchors, **permanent**)

- Created manually at the end of each version's final cycle.
- Examples: `v4-final`, `v5-final`, ..., `v9-final`, `v9-c1-final`, `v9-c2-final`.
- Purpose: rollback to a known-good release. Never delete.

### `evolution-pre-*` (per-apply safety, **permanent**)

- Created by `core/self-evolution.js:193` and `evolution/apply.js:174` before
  each `evolution:apply` runs, per ADR-007.
- Pattern: `evolution-pre-${proposalId}-${unix_ts}`.
- Purpose: rollback a single apply without losing the rest of the cycle.
- ADR-007 says "**永久保留**" (permanent). Keep all.

## Tags we prune

### `catalogue-pre-*` (per-cycle snapshot, **PRUNE**)

- Created by `evolution/catalogue.js:443` at the start of each catalogue cycle.
- Pattern: `catalogue-pre-${unix_ts}-${hrt}-${safeName}`.
- Originally meant as a wider rollback anchor than `evolution-pre-*`.
- **Problem**: V3 P1 era ran catalogue cycles non-stop, accumulating 1135 tags
  for only 28 unique commits (~40x redundancy).
- **Decision (V10.8)**: delete all. Information is fully captured by:
  - `v*-final` (release anchors)
  - `evolution-pre-*` (per-apply rollback, ADR-007)
  - the commit log itself (granular history)
- ADR-007 has a 30-day + "audit archived" retention policy for
  `evolution-pre-*`; this same policy could be applied to `catalogue-pre-*`
  if/when the cycle rate accelerates again.

## Branches we prune

### `feat/*` and `wt/*` (PR series + worktree scratch, **DELETE AFTER MERGE**)

- 18 `feat/pr*` branches: V2 era (PR4 through PR19b), all merged into `main`.
- 2 `wt/*` branches: V4-V9 worktree scratch, all merged.
- No protection needed once `git merge-base $b main == $b` (verified V10.8).

## Tag generation going forward

`evolution/catalogue.js` and `core/self-evolution.js` still create
`catalogue-pre-*` and `evolution-pre-*` tags per cycle. No code change needed
for V10.8 -- the policy here is **prune at V10.8** plus a future cron
(planned for V14) to enforce retention on a rolling basis.
