// P2f driver — runs inside the tmpdir worktree (cwd=worktree) so Node.js
// ESM imports resolve to the worktree's local modules. Without this, the
// parent test (which imports from /home/weixing/darwin/evolution/...) would
// always load the REAL v2 self-evolve.js (and its module-scope dependencies
// like PLUGIN_CATALOGUE in diagnose.js, TARGET_TEMPLATES in propose.js) and
// never see catalogue overrides committed to the worktree.
//
// P2c-3 used the same pattern (p2c3-driver.mjs) for diagnose/propose/apply.
// P2f adds a fourth command: runSelfEvolve, which chains all three through
// the orchestrator.
//
// Used as: node p2f-driver.mjs <command> [args...]
// Commands:
//   runSelfEvolve            → runs runSelfEvolve({confirm:true}) in worktree,
//                               prints JSON {evolved, ...} to stdout
//
// Env:
//   P2F_WORKTREE — absolute path to the worktree. Required.

const worktree = process.env.P2F_WORKTREE;
if (!worktree) {
  throw new Error('P2F_WORKTREE env var required (set by runDriver)');
}

// Dynamic import — resolves relative to the worktree, NOT the test process's cwd.
// This is the entire reason this driver exists: it lets Node.js load the
// worktree's own copy of evolution/diagnose.js (with overridden PLUGIN_CATALOGUE),
// evolution/propose.js (with same module-scope TARGET_TEMPLATES), etc.
//
// Uses pathToFileURL() so Node treats the absolute path as a file URL,
// avoiding ERR_MODULE_NOT_FOUND when the worktree doesn't have the file
// yet (e.g. when self-evolve.js is still uncommitted in real v2 — worktrees
// only see TRACKED files). The driver is materialized into the worktree
// by runDriver() in the parent test before invoking us.
import { pathToFileURL } from 'node:url';
const selfEvolveUrl = pathToFileURL(`${worktree}/evolution/self-evolve.js`).href;
const { runSelfEvolve } = await import(selfEvolveUrl);

const [, , cmd] = process.argv;

async function main() {
  if (cmd === 'runSelfEvolve') {
    const r = await runSelfEvolve({ confirm: true });
    process.stdout.write(JSON.stringify(r));
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`p2f-driver error: ${err.stack || err.message}\n`);
  process.exit(1);
});
