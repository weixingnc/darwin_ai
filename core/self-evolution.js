/**
 * SelfEvolution — Darwin's "鸡" (PR-S1 / v3+ P0).
 *
 * 7 APIs (V3_ROADMAP §"🔴 P0 SelfEvolution"):
 *   diagnose()  — read current Darwin state                     (REAL)
 *   propose()   — generate structured change proposals          (REAL)
 *   apply(p)    — apply a proposal (write files)                (PR-S2 stub)
 *   verify(p)   — run npm test / lint / size-check              (PR-S2 stub)
 *   rollback(p) — git reset --hard to pre-apply tag             (PR-S2 stub)
 *   audit(a, d) — write audit log entry                         (REAL → tmp/audit/)
 *   learn(i)    — append learning to evolution-rules.md         (PR-S2 stub)
 *
 * PR-S1 surface contract (this file):
 *   - diagnose/propose: wired to evolution/diagnose.js + evolution/propose.js
 *   - apply/verify/rollback/learn: throw NotImplementedError so callers get
 *     a loud, deterministic error rather than silent no-op
 *   - audit: REAL — writes JSON to `tmp/audit/<ts>-<action>.json` (PR-S2 moves
 *     this to `memory/audit/YYYY-MM-DD-<proposal_id>.json` per ADR-008)
 *
 * DI shape: SelfEvolution is constructed with 4 injected helpers so tests
 * (and future PR-S2 wiring) can override any of them without monkey-patching
 * the module. Defaults are the v3+ PR-S1 behaviour; PR-S2 will replace the
 * stubs with real `evolution/{apply,verify,rollback,learn}.js` calls.
 *
 * LLM gate (ADR-009): apply/verify/rollback/audit/learn are mechanical; the
 * only LLM-bearing step is propose, and that is in 🔴 mode — not in this file.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose } from '../evolution/diagnose.js';
import { propose } from '../evolution/propose.js';
import { apply as applyImpl } from '../evolution/apply.js';
import { verify as verifyImpl } from '../evolution/verify.js';
import { rollback as rollbackImpl, _resetSessionCounter } from '../evolution/rollback.js';
import { writeAuditLog as auditImpl } from '../evolution/audit.js';
import { learn as learnImpl } from '../evolution/learn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(REPO_ROOT, 'tmp', 'audit');

class NotImplementedError extends Error {
  constructor(api) {
    super(`[SelfEvolution] ${api} not implemented in PR-S1; see V3_ROADMAP.md`);
    this.name = 'NotImplementedError';
    this.code = 'PR_S2_PENDING';
  }
}

/** Boundary check (ADR-005): classify a list of file paths.
 *  PR-S1 returns the deterministic classification; PR-S2 hooks this into
 *  evolution/apply.js for hard abort on blacklist hit. */
function defaultBoundary() {
  return {
    classify(filePath) {
      if (typeof filePath !== 'string' || !filePath) {
        return { status: 'unknown', tier: 'red' };
      }
      const p = filePath.replace(/\\/g, '/');
      // Hard blacklist (ADR-005) — must never be Darwin-modified.
      if (
        /^core\/(event-bus|config-resolver|events|container|error-handler|self-evolution)\.js$/.test(
          p,
        ) ||
        /^lifecycle\//.test(p) ||
        p === 'docs/ANTI_PATTERNS.md' ||
        /(^|\/)(package\.json|\.commitlintrc\.json|\.eslintrc\.json|\.prettierrc)$/.test(p)
      ) {
        return { status: 'blacklisted', tier: 'red' };
      }
      // Whitelist (ADR-005) — Darwin can freely extend.
      if (
        /^provider\//.test(p) ||
        /^tool\/builtins\//.test(p) ||
        /^skill\/examples\//.test(p) ||
        /^memory\/backends\//.test(p) ||
        /^tests\//.test(p) ||
        (/^docs\//.test(p) && p !== 'docs/ANTI_PATTERNS.md')
      ) {
        return { status: 'whitelisted', tier: 'green' };
      }
      return { status: 'unknown', tier: 'red' }; // unknown = default 🔴
    },
    /** Convenience: pure-function wrapper used by tests + future apply gate. */
    boundaryCheck(filePaths) {
      const list = Array.isArray(filePaths) ? filePaths : [filePaths];
      return list.map((f) => ({ path: f, ...this.classify(f) }));
    },
  };
}

/** Approval classification (ADR-006 three-tier).
 *  PR-S1 returns the deterministic tier for a proposal; PR-S2 wires it into
 *  the human-approval / sampling gate. */
function defaultApprover() {
  // Closure-captured boundary so the approver is a pure function (testable
  // in isolation, no `this` binding hazards).
  const boundary = defaultBoundary();
  return {
    classify(proposal) {
      if (!proposal || typeof proposal !== 'object') {
        return { tier: 'red', reason: 'invalid_proposal' };
      }
      const files = Array.isArray(proposal.files_added) ? proposal.files_added : [];
      const tPath = proposal.target && proposal.target.path;
      // 🔴 core / package.json / lifecycle → must-approve
      for (const f of files) {
        const cls = boundary.classify(f.path);
        if (cls.status === 'blacklisted') {
          return { tier: 'red', reason: `blacklisted:${f.path}` };
        }
      }
      if (tPath && /^provider\//.test(tPath)) {
        // PR-S1: any new provider = 🔴 (PR-S2: add > 50 行 threshold).
        return { tier: 'red', reason: 'provider_add' };
      }
      if (tPath && /^tool\/builtins\//.test(tPath)) {
        return { tier: 'yellow', reason: 'builtin_tool_add' }; // 10% sample
      }
      // skill / memory / docs / tests → 🟢 auto
      return { tier: 'green', reason: 'auto' };
    },
  };
}

/** Audit writer (ADR-008 schema).
 *  PR-S1 writes to tmp/audit/ so the data shape can be reviewed before
 *  PR-S2 moves it to the real `memory/audit/` path. Schema fields are
 *  identical to ADR-008 — the only difference is the destination. */

/** Build an ADR-008 entry from the simplified (action, data) shape. */
function buildAuditEntry(action, data) {
  const d = data || {};
  return {
    proposal_id: d.proposal_id || `unknown-${Date.now()}`,
    action,
    apply_author: d.apply_author || 'darwin',
    outcome: d.outcome || 'success',
    files_changed: d.files_changed || [],
    diff_stat: d.diff_stat || { '+': 0, '-': 0 },
    verify_result: d.verify_result || { test: true, lint: true, size_check: true },
    duration_ms: typeof d.duration_ms === 'number' ? d.duration_ms : 0,
    session_key: d.session_key || null,
    tag_sha: d.tag_sha || null,
    rollback_reason: d.rollback_reason ? d.rollback_reason : undefined,
    approver: d.approver ? d.approver : undefined,
  };
}

/** Extract audit impl opts (currently only baseDir). */
function buildAuditOpts(data) {
  return data && data.baseDir ? { baseDir: data.baseDir } : {};
}

function defaultAuditor() {
  return {
    write(action, data) {
      if (typeof action !== 'string' || !action) {
        throw new TypeError('[SelfEvolution.audit] action must be non-empty string');
      }
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      const ts = Date.now();
      const id = data && typeof data.proposal_id === 'string' ? data.proposal_id : randomUUID();
      const entry = {
        proposal_id: id,
        action,
        payload: data || null,
        written_at: new Date(ts).toISOString(),
        // ADR-008 必带字段 (PR-S1: populate only what is meaningful here;
        // PR-S2 will fill files_changed / verify_result / diff_stat etc.).
        schema_version: 1,
        destination: 'tmp/audit/',
      };
      const file = path.join(AUDIT_DIR, `${ts}-${action}-${id}.json`);
      fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n', 'utf8');
      return { ok: true, path: file, entry };
    },
  };
}

/** Tag stub (ADR-007).
 *  PR-S1 returns the deterministic tag name + skips the real `git tag` call.
 *  PR-S2 wires this to evolution/rollback.js. */
function defaultTagger() {
  return {
    tagProposal(proposalId) {
      if (typeof proposalId !== 'string' || !proposalId) {
        throw new TypeError('[SelfEvolution.tagProposal] proposalId must be non-empty string');
      }
      const tag = `evolution-pre-${proposalId}-${Date.now()}`;
      // PR-S1: do NOT run `git tag`. Return the deterministic name only.
      return { ok: false, tag, skipped: 'PR_S1_STUB', note: 'real git tag in PR-S2' };
    },
  };
}

export class SelfEvolution {
  constructor(deps = {}) {
    this.boundary = deps.boundary || defaultBoundary();
    this.approver = deps.approver || defaultApprover();
    this.auditor = deps.auditor || defaultAuditor();
    this.tagger = deps.tagger || defaultTagger();
  }

  /** Scan Darwin's current capability surface. REAL (delegates to diagnose.js). */
  async diagnose() {
    return diagnose();
  }

  /** Generate change proposals from a diagnose report (or run diagnose first).
   *  REAL (delegates to propose.js). P1-B2 fix: accepts `opts` so callers can
   *  pass `{ proposalsDir, persist }` and the facade doesn't bypass any
   *  downstream wiring (PR-S3 future hook). Backward compatible: opts defaults
   *  to {} so the pre-fix `(report)` signature still works. */
  async propose(report, opts = {}) {
    return propose(report, opts);
  }

  /** Apply a proposal (write files). PR-S2 (REAL — delegates to evolution/apply.js). */
  async apply(proposal, opts = {}) {
    return applyImpl(proposal, {
      ...opts,
      boundary: opts.boundary || this.boundary,
      approver: opts.approver || this.approver,
    });
  }

  /** Verify (npm test / lint / size-check). PR-S2 (REAL — delegates to evolution/verify.js). */
  async verify(proposal, opts = {}) {
    return verifyImpl(proposal, opts);
  }

  /** Rollback (git reset --hard). PR-S2 (REAL — delegates to evolution/rollback.js).
   *  Caller passes `tag_sha` via opts.tagSha (we forward to the impl). */
  async rollback(proposal, opts = {}) {
    if (!opts.tagSha && proposal && proposal.tag_sha) {
      opts.tagSha = proposal.tag_sha;
    }
    return rollbackImpl(proposal, opts.tagSha, opts);
  }

  /** Write an audit log entry. REAL (writes memory/audit/<date>/<proposal_id>.json).
   *  Accepts the simplified PR-S1 (action, data) shape OR the full ADR-008 entry.
   *  @param {string|object} action — e.g. 'apply', 'rollback', 'verify'
   *  @param {object} [data] — ADR-008 schema fragment (when action is a string) */
  async audit(action, data) {
    if (typeof action === 'string') {
      const entry = buildAuditEntry(action, data);
      return auditImpl(entry, buildAuditOpts(data));
    }
    // New callers may pass a full ADR-008 entry directly as the first arg.
    return auditImpl(action, data || {});
  }

  /** Append a learning rule. PR-S2 (REAL — delegates to evolution/learn.js). */
  async learn(insight, opts = {}) {
    return learnImpl(insight, opts);
  }
}

/** Shared singleton — matches container pattern (PR 4). */
export const selfEvolution = new SelfEvolution();

// Internal hooks for tests + PR-S2 wiring.
export const _internal = {
  NotImplementedError,
  defaultBoundary,
  defaultApprover,
  defaultAuditor,
  defaultTagger,
  AUDIT_DIR,
  REPO_ROOT,
  // PR-S2: real impl exports + rollback session counter reset helper.
  applyImpl,
  verifyImpl,
  rollbackImpl,
  auditImpl,
  learnImpl,
  _resetSessionCounter,
};
