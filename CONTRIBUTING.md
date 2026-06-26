# Contributing to Darwin

Thanks for your interest. Darwin is an open-source self-evolving
agent OS. Darwin itself grows new skills, providers, and memory
backends via its `SelfEvolution` loop -- so when you contribute
new code, you are contributing to a system that can adopt your
work at runtime.

## Setup

- Node >= 20
- `npm install`
- `npm test` to verify (1381/1381 tests should pass)

## Workflow

1. Fork the repo, branch off `main` (one feature per branch).
2. `npm test` + `npm run lint` + `npm run size-check` must all pass.
3. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `chore(docs):`, `refactor:` ...). The repo runs
   commitlint via husky pre-commit; non-conforming messages are
   rejected.
   - Subject line lowercase, <= 100 chars (commitlint cap; README
     recommends <= 72).
   - Body wrapped at 200 chars / line.
4. Open a PR against `main`. The PR template checks
   `npm run lint` + `npm test` + matching tests for new code.
5. The V43 web UI is in scope; the V46 reasoning panel and V45.1
   clean-stream fixes are stable. New web features usually pair a
   `web/*` change with a matching test under `web/*.test.js`.

## What to contribute

- New `examples/*` (vendor bridges: Telegram, Discord, MS Teams --
  copy `examples/slack-bridge/` as a starting point).
- New `provider/*` adapters (follow `provider/interface.js` and the
  OpenAI-compatible protocol in `provider/protocol/openai-compatible.js`).
- New ADR (`.github/ADR/NNN-*.md`) for boundary / contract changes.
- Bug reports via GitHub Issues (use the bug template).
- **NOT** `core/*` business logic without prior discussion -- it is
  on the V3+ autonomous boundary list and Darwin owns it. If you
  think you need to touch it, open an Issue first.

## Testing

- `npm test` runs unit + integration + end-to-end (88 test files,
  1381 cases as of V46).
- New code should ship with a matching test. One test file per
  source file by convention (e.g. `web/storage.js` ->
  `web/storage.test.js`).
- `npm run size-check` enforces a 1000-line cap per source file. The
  heuristic soft cap is 510 lines; soft-overs are fine if the commit
  body justifies them.

## Style

- `npm run format` (Prettier) + `npm run lint:fix` (ESLint) before
  committing. Husky pre-commit hook auto-runs both on staged files.
- ESLint enforces `complexity <= 15`. If your function overflows,
  split it; do not silence the rule.
- commitlint enforces `subject-case: lower-case`. Sentence-case
  commit messages are rejected.

## What Darwin will do with your code

After you open a PR, Darwin's SelfEvolution loop can read the merged
diff as a `proposal` and replicate the pattern into other parts of
the project at runtime. The merged code therefore does double duty:
it ships as a feature for end users, and it seeds Darwin's next
evolution cycle.
