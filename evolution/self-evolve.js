/**
 * Evolution Self-Evolve orchestrator — P2f (2026-06-18).
 *
 * Closes Darwin's "self-evolution closed loop" by chaining diagnose → propose
 * → apply → verify → re-diagnose into a single entry point. P2c-3 proved
 * the loop works when a human drives each step (write catalogue, run
 * subprocess, observe). P2f proves the loop works when ONE function drives
 * it end-to-end — the last mile between "Darwin has the capability" and
 * "Darwin actually uses the capability".
 *
 * Safety invariants (P2f design constraints):
 *
 *   1. **Explicit confirm required**: `runSelfEvolve({ confirm: true })`.
 *      Defaults to false → throws. This is the explicit opt-in: a caller
 *      that didn't ask for self-evolution cannot accidentally trigger it.
 *      Real-world callers (Darwin's own cron, an admin CLI) must set the
 *      flag deliberately. Mirrors the safety pattern of `apply()` which
 *      uses approval tiers — auto-approve green is opt-in per proposal.
 *
 *   2. **Sandbox only on plugin runtime (P2e integration point)**: The
 *      P2e runtime sandbox (`plugin/sandbox.js`) monkey-patches fs.* /
 *      child_process.* / process.exit to block plugins from doing damage.
 *      But it has no caller awareness — it would ALSO block Darwin's own
 *      evolution code (propose.js writes proposal JSON via fs.writeFileSync;
 *      apply.js does the same for the plugin file). Self-evolve MUST NOT
 *      activate the sandbox during propose/apply, because that would be
 *      Darwin trapping Darwin.
 *
 *      P2f defers sandbox activation to the plugin load step (a future
 *      P2g would add explicit plugin load to the orchestrator; P2f stops
 *      at "write file + verify build", which is what P2c-3 also stopped
 *      at). The sandbox test in tests/evolution/self-evolve.test.js
 *      asserts the inverse: runSelfEvolve does NOT activate the global
 *      sandbox, so a later plugin-load step in P2g starts from a clean
 *      state.
 *
 *   3. **Verify before re-diagnose**: After apply, run `verify()` (npm
 *      test + lint + size-check). If verify fails, **rollback** via
 *      `rollback.js` to the pre-apply git tag, then surface the verify
 *      failure in the returned report. Darwin must NOT report success
 *      when the build is broken.
 *
 *   4. **One proposal per cycle (by design)**: P2f runs ONE missing
 *      plugin per invocation. Growing PLUGIN_CATALOGUE from 1 → N is a
 *      deliberate, human-paced process (each new plugin is a design
 *      decision, see P2g W2). Auto-growing the catalogue by N at once
 *      would skip the "do we actually need this plugin?" checkpoint.
 *      Missing items from other catalogues (providers, tools, skills,
 *      memory, platforms) are reported but NOT auto-evolved — those
 *      are catalogue-wide decisions that need PM sign-off.
 *
 *   5. **Audit plugin observes the loop**: The whole pipeline emits
 *      evolution:diagnose:after, evolution:propose:after, evolution:apply:after.
 *      If the audit plugin is loaded (P2c-2), it will record the entire
 *      self-evolve run in its in-memory log. Darwin's self-evolution is
 *      observable by Darwin itself — the seed of "self-awareness" that
 *      motivated this whole P2 series.
 *
 * LLM gate (ADR-009): self-evolve orchestrator does NOT call an LLM. It
 * chains mechanical operations. P2g (catalogue growth strategy, W2)
 * adds the "should we add this plugin?" reasoning layer; P2f just
 * executes when the human/caller has already decided.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';
import { diagnose } from './diagnose.js';
import { propose } from './propose.js';
import { apply } from './apply.js';
import { verify } from './verify.js';
import { rollback } from './rollback.js';
import { createSandbox } from '../plugin/sandbox.js';

export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Auto-approve green tier — self-evolve is opt-in via confirm flag,
 *  not via per-proposal approval classification. */
const selfEvolveApprover = {
  classify() {
    return { tier: 'green', reason: 'p2f-self-evolve-opt-in' };
  },
};

/**
 * Run one self-evolve cycle against `cwd` (default: real v2 repo).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.confirm=false] MUST be true to execute. Default false
 *   throws — this is the explicit opt-in safety pattern.
 * @param {string} [opts.cwd=REPO_ROOT] repo / worktree root to evolve.
 * @param {string} [opts.proposalsDir] directory for proposal JSON files
 *   (propose() persists proposals here). Defaults to
 *   `<cwd>/memory-bank/cycles/proposals/`.
 * @returns {Promise<{
 *   evolved: boolean,
 *   reason?: string,
 *   initial_missing_plugins: string[],
 *   proposal?: object,
 *   apply_result?: object,
 *   verify_result?: object,
 *   rolled_back?: boolean,
 *   final_missing_plugins: string[],
 *   duration_ms: number,
 *   events_emitted: string[],
 * }>}
 */
export async function runSelfEvolve(opts = {}) {
  const startedAt = Date.now();
  if (opts.confirm !== true) {
    throw new Error(
      '[evolution/self-evolve] confirm:true is required. Self-evolution is ' +
        'opt-in to prevent accidental triggers. See P2f design notes.',
    );
  }
  const cwd = opts.cwd || REPO_ROOT;
  const proposalsDir = opts.proposalsDir || path.join(cwd, 'memory-bank/cycles/proposals');

  // P2f design #2: do NOT activate the global sandbox here. P2e's
  // sandbox is per-plugin-runtime, not per-evolution-cycle. Activating
  // it would trap Darwin's own propose.js / apply.js (which both write
  // files via fs.writeFileSync). Plugin load — the legitimate target
  // for the sandbox — happens elsewhere (P2g, future) and will manage
  // its own sandbox lifecycle.
  const sandbox = createSandbox({ pluginName: 'self-evolve' });

  const eventsEmitted = [];
  const track = (event) => {
    eventsEmitted.push(event);
  };

  // Subscribe to the events we care about so we can list them in the report.
  evolutionBus.on(EVENTS.EVOLUTION_DIAGNOSE_AFTER, () => track(EVENTS.EVOLUTION_DIAGNOSE_AFTER));
  evolutionBus.on(EVENTS.EVOLUTION_PROPOSE_AFTER, () => track(EVENTS.EVOLUTION_PROPOSE_AFTER));
  evolutionBus.on(EVENTS.EVOLUTION_APPLY_AFTER, () => track(EVENTS.EVOLUTION_APPLY_AFTER));
  evolutionBus.on(EVENTS.EVOLUTION_REJECT, (payload) =>
    track(`${EVENTS.EVOLUTION_REJECT}:${payload.stage || 'unknown'}`),
  );

  let rolledBack = false;
  let applyResult = null;
  let verifyResult = null;
  let proposal = null;

  try {
    // Step 1: Diagnose. We use repoRoot so the worktree's local PLUGIN_CATALOGUE
    // is honored (per P2c-3 pitfall: catalogue is module-scope constant).
    const report = await diagnose({ repoRoot: cwd });
    const initialMissing = Array.isArray(report.missing_plugins) ? [...report.missing_plugins] : [];

    if (initialMissing.length === 0) {
      return {
        evolved: false,
        reason: 'no_missing_plugins',
        initial_missing_plugins: [],
        final_missing_plugins: [],
        duration_ms: Date.now() - startedAt,
        events_emitted: eventsEmitted,
      };
    }

    // Step 2: We only auto-evolve ONE plugin per cycle (P2f design #4).
    // Pick the first missing plugin deterministically.
    const target = initialMissing[0];

    // Build a synthetic report with just the one missing plugin so propose()
    // generates exactly one proposal. propose() respects the full missing_*
    // list, so we can't just hand it `report` directly — that would generate
    // N proposals.
    const focusedReport = {
      ...report,
      missing_plugins: [target],
    };

    fs.mkdirSync(proposalsDir, { recursive: true });
    const proposals = await propose(focusedReport, { proposalsDir });
    if (!Array.isArray(proposals) || proposals.length === 0) {
      return {
        evolved: false,
        reason: 'propose_returned_empty',
        initial_missing_plugins: initialMissing,
        final_missing_plugins: initialMissing,
        duration_ms: Date.now() - startedAt,
        events_emitted: eventsEmitted,
      };
    }
    proposal = proposals[0];

    // Step 3: Apply (writes file + creates evolution-pre-<id> git tag).
    applyResult = await apply(proposal, {
      cwd,
      approver: selfEvolveApprover,
    });
    if (!applyResult.applied) {
      return {
        evolved: false,
        reason: `apply_rejected:${applyResult.reason || 'unknown'}`,
        initial_missing_plugins: initialMissing,
        proposal,
        apply_result: applyResult,
        final_missing_plugins: initialMissing,
        duration_ms: Date.now() - startedAt,
        events_emitted: eventsEmitted,
      };
    }

    // Step 4: Verify (npm test + lint + size-check). If fail → rollback
    // to the pre-apply tag and surface the failure.
    verifyResult = await verify({ cwd });
    // T5 (Codex P1-2, 2026-06-18): dynamic plugin-load smoke test
    // (see tryPluginLoad below). Runs after static verify, before
    // declaring success — catches import-time errors in newly
    // written plugin files that static verify would miss.
    const pluginLoad = await maybePluginLoad(verifyResult, applyResult, cwd);
    const shouldRollback = !verifyResult.pass || pluginLoad.ok === false;
    if (shouldRollback) {
      // Rollback uses the pre-apply tag to revert the file write.
      // rollback.js signature: (proposal, tag_sha, opts) — we pass the
      // proposal object (for audit fields) + the tag_sha (not tag name).
      const rb = await rollback(proposal, applyResult.tag_sha, { cwd });
      rolledBack = rb.rolled_back === true;
      // After rollback, the file is gone — re-diagnose should show missing again.
      const reReport = await diagnose({ repoRoot: cwd });
      return {
        evolved: false,
        reason: 'verify_failed_rolled_back',
        initial_missing_plugins: initialMissing,
        proposal,
        apply_result: applyResult,
        verify_result: verifyResult,
        rolled_back: rolledBack,
        final_missing_plugins: Array.isArray(reReport.missing_plugins)
          ? reReport.missing_plugins
          : [],
        duration_ms: Date.now() - startedAt,
        events_emitted: eventsEmitted,
      };
    }

    // Step 5: Re-diagnose to confirm catalogue closure for the target.
    const finalReport = await diagnose({ repoRoot: cwd });
    const finalMissing = Array.isArray(finalReport.missing_plugins)
      ? [...finalReport.missing_plugins]
      : [];

    return {
      evolved: true,
      initial_missing_plugins: initialMissing,
      proposal,
      apply_result: applyResult,
      verify_result: verifyResult,
      plugin_load: pluginLoad, // T5
      final_missing_plugins: finalMissing,
      duration_ms: Date.now() - startedAt,
      events_emitted: eventsEmitted,
    };
  } finally {
    // P2f design #2 (inverse): if the sandbox were ever activated during
    // self-evolve, deactivate it here. As designed, it's never activated,
    // so this is a no-op safety net. Leaving it in keeps the orchestrator
    // correct if a future P2-series cycle moves sandbox activation INTO
    // self-evolve (e.g. wrapping the plugin load step).
    if (sandbox) {
      sandbox.deactivate();
    }
  }
}

/**
 * T5 (Codex P1-2, 2026-06-18): wrapper around tryPluginLoad that
 * only runs the dynamic load smoke test when static verify passed.
 * Returns the skipped shape ({ok:null,...}) in all other cases so
 * the caller's shouldRollback logic stays a single expression.
 *
 * T7-W5 (2026-06-19): hoisted ABOVE _internal below. Previously
 * this function was declared after the _internal export that
 * references it; the only reason that worked was function-
 * declaration hoisting. If anyone later refactors to
 * `const maybePluginLoad = async (...) => ...` the module load
 * throws "Cannot access 'maybePluginLoad' before initialization".
 * Same applies to tryPluginLoad.
 */
export async function maybePluginLoad(verifyResult, applyResult, cwd) {
  if (!verifyResult || verifyResult.pass !== true) {
    return { ok: null, error: null, duration_ms: 0 };
  }
  return tryPluginLoad(applyResult, cwd);
}

/**
 * T5 (Codex P1-2, 2026-06-18): dynamic plugin-load smoke test.
 *
 * After apply writes new plugin/*.js files and static verify
 * (npm test + lint + size-check) passes, we still need to know
 * that the new files can actually be `import()`-ed without
 * throwing. A syntactically-valid ES module can still fail at
 * import time if it has broken top-level statements (e.g. a
 * reference to an undefined symbol that lint allows, a missing
 * import in a CJS path, or a JSON parse of a corrupt manifest).
 *
 * This function is intentionally simple: it iterates the files
 * apply wrote, narrows to plugin/*.js, and tries to dynamic-
 * import each. The first import that throws is captured and
 * surfaced via the return shape; the caller (runSelfEvolve)
 * treats pluginLoad.ok === false as a verify-class failure
 * and triggers rollback just like a lint or test failure.
 *
 * Returns:
 *   { ok: true,  error: null, duration_ms }  — all new plugin files import cleanly
 *   { ok: false, error: '...', duration_ms }  — first failed import
 *   { ok: null,  error: null, duration_ms: 0 } — no plugin files were written
 *
 * T7-W5 (2026-06-19): hoisted above _internal for the same reason
 * as maybePluginLoad — to make the _internal reference safe under
 * any future refactor that drops function-declaration hoisting.
 *
 * @param {object|null} applyResult  the apply.js return value
 * @param {string} cwd               the worktree root
 * @returns {Promise<{ok: boolean|null, error: string|null, duration_ms: number}>}
 */
export async function tryPluginLoad(applyResult, cwd) {
  if (
    !applyResult ||
    !Array.isArray(applyResult.files_written) ||
    applyResult.files_written.length === 0
  ) {
    return { ok: null, error: null, duration_ms: 0 };
  }
  const t0 = Date.now();
  const path = await import('node:path');
  for (const f of applyResult.files_written) {
    if (typeof f !== 'string' || !f.startsWith('plugin/') || !f.endsWith('.js')) {
      continue;
    }
    try {
      const abs = path.default.resolve(cwd, f);
      await import(abs);
    } catch (err) {
      return {
        ok: false,
        error: `${f}: ${err.message}`,
        duration_ms: Date.now() - t0,
      };
    }
  }
  return { ok: true, error: null, duration_ms: Date.now() - t0 };
}

export const _internal = {
  selfEvolveApprover,
  REPO_ROOT,
  tryPluginLoad, // T5
  maybePluginLoad, // T5
};
