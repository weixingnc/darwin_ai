# Example 3: Query the audit log

Shows how to use Darwin's **`core/audit-reader.js`** directly from a
Node script -- the same primitive that powers
`darwin self-evolution audit-query` (V17.1).

## What you learn

- That Darwin persists every evolution event to
  `<baseDir>/audit.jsonl` (default `<cwd>/memory/audit`)
- That **V14 log rotation** transparently handles multi-file queries
  -- you do not need to manage archives yourself
- The filter shape: `topic` (exact), `proposal` (exact on
  `payload.proposal_id`), `outcome`, `action`, `since`/`until` (ISO
  timestamp window), `limit`
- That the read path is **newest-first** (most recent entry first)

## Run it

```bash
# Show the 10 most recent entries, table format
node examples/audit-query/query.mjs --format table --limit 10

# All evolution:audit events (the most common filter)
node examples/audit-query/query.mjs --topic evolution:audit --format json

# Everything that happened to a specific proposal
node examples/audit-query/query.mjs --proposal prop-add-metrics --format table

# The last hour
node examples/audit-query/query.mjs --since 2026-06-20T15:00:00Z --format table
```

## Output

JSON output includes both the matched entries and metadata
(`scanned`, `matched`, `filesScanned`, `filters`) so you can pipe
into `jq` for post-processing:

```bash
node examples/audit-query/query.mjs --topic evolution:audit --format json \\
  | jq '.entries | map({ts: .recordedAt, proposal: .payload.proposal_id, action: .payload.action})'
```

## Files

- `query.mjs` -- 80-line query script
- `README.md` -- this file
