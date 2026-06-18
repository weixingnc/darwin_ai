// P2c-3 driver — runs inside the tmpdir worktree (cwd=worktree) so Node.js
// ESM imports resolve to the worktree's local modules. Without this, the
// parent test (which imports from /home/weixing/darwin/evolution/...)
// would always load the real v2 diagnose.js and never see catalogue
// overrides committed to the worktree.
//
// Used as: node p2c3-driver.mjs <command> [args...]
// Commands:
//   diagnose                  → prints JSON report to stdout
//   propose <report.json>     → prints JSON {proposals: [...]}
//   apply <proposal.json>     → prints JSON apply result

import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve paths RELATIVE TO the worktree root passed as $1, not the test
// process's cwd. The driver is also materialized into the worktree via
// materializeDriver() below, so the same file is used regardless of where
// it's invoked from.
const worktree = process.env.P2C3_WORKTREE;
if (!worktree) {
  throw new Error('P2C3_WORKTREE env var required (set by runDriver)');
}

const { diagnose } = await import(`${worktree}/evolution/diagnose.js`);
const { propose } = await import(`${worktree}/evolution/propose.js`);
const { apply } = await import(`${worktree}/evolution/apply.js`);

const [, , cmd, ...rest] = process.argv;

const autoApprover = {
  classify() {
    return { tier: 'green', reason: 'p2c3-driver' };
  },
};

async function main() {
  if (cmd === 'diagnose') {
    const r = await diagnose();
    process.stdout.write(JSON.stringify(r));
    return;
  }
  if (cmd === 'propose') {
    const reportPath = rest[0];
    const proposalsDir = rest[1];
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const r = await propose(report, { proposalsDir });
    process.stdout.write(JSON.stringify(r));
    return;
  }
  if (cmd === 'apply') {
    const proposalPath = rest[0];
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
    const r = await apply(proposal, { cwd: worktree, approver: autoApprover });
    process.stdout.write(JSON.stringify(r));
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`p2c3-driver error: ${err.stack || err.message}\n`);
  process.exit(1);
});
