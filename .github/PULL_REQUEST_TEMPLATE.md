## What does this PR do?

<!-- One-paragraph summary -->

## Why?

<!-- What problem does this solve / what value does it add -->

## How?

<!-- Implementation notes (link design doc / ADR if any) -->

## Boundary check

<!-- Tick exactly one; both apply only for explicit authorization. -->

- [ ] Touches only paths outside the V3+ autonomous boundary
      (`core/*`, `provider/*`, `evolution/*`, `package.json`,
      `docs/ADR/*`).
- [ ] Touches a boundary path AND the commit body justifies why,
      with an Issue or ADR link.

## Verification

- [ ] `npm run lint` passes (0 errors / 0 warnings)
- [ ] `npm test` passes (X / X)
- [ ] `npm run size-check` passes (all files < 1000 lines)
- [ ] New code has matching tests (one test file per source file)
- [ ] `CHANGELOG.md` updated if user-facing

## Self-evolution

<!-- If this PR lands, Darwin can replicate the pattern at runtime
     via evolution:apply. Tick the box that applies, or delete
     the section if not relevant. -->

- [ ] Darwin can adopt this pattern at runtime (no boundary path)
- [ ] This seeds a Darwin SelfEvolution proposal (link the Issue)
- [ ] Pure human-only (UI, install scripts, ADRs)
