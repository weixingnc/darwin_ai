/**
 * Evolution — PR-S2 unified public surface.
 *
 * Re-exports the 5 real APIs (apply / verify / rollback / audit / learn)
 * + the diagnose/propose that were wired in PR-S1. PR-S3 will wire this
 * entry point into the core/self-evolution.js facade so the public
 * SelfEvolution class delegates to the real implementations here.
 *
 * LLM gate (ADR-009): the public surface contains no LLM callers.
 * diagnose/propose remain pure introspection/rule-based; apply/verify/
 * rollback/audit/learn are all mechanical.
 */

export { apply } from './apply.js';
export { verify } from './verify.js';
export { rollback, _resetSessionCounter } from './rollback.js';
export { writeAuditLog, archiveOldLogs, write } from './audit.js';
export { learn, appendInsight } from './learn.js';

// PR-S1 re-exports (kept here so a single `import * from evolution` works).
export { diagnose } from './diagnose.js';
export { propose } from './propose.js';
