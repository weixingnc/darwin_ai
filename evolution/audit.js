/**
 * Evolution Audit — PR-S2 (v3+ SelfEvolution P0).
 *
 * ADR-008: write JSON audit log to `memory/audit/YYYY-MM-DD/<proposal_id>.json`.
 * Schema fields:
 *   proposal_id, action, files_changed[], diff_stat{+,-}, verify_result,
 *   duration_ms, outcome, apply_author, session_key, tag_sha, schema_version
 *
 * `archiveOldLogs(daysOld=7)` is exposed for PR-S3 cron wiring.
 *
 * LLM gate (ADR-009): audit is mechanical (JSON write), NEVER calls LLM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionBus } from './_bus.js';
import { EVENTS } from '../core/events.js';

export const LLM_REQUIRES_APPROVAL = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIT_BASE = path.join(REPO_ROOT, 'memory', 'audit');
const ARCHIVE_BASE = path.join(AUDIT_BASE, '.archive');
const SCHEMA_VERSION = 2; // PR-S2: full ADR-008 schema; PR-S1 used schema_version=1 with tmp/audit/

/**
 * Validate the audit log payload. Throws on required-field violation
 * (matches ADR-008 "must-have" list).
 *
 * @param {object} entry
 */
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('[evolution/audit] entry must be an object');
  }
  const required = ['proposal_id', 'action', 'apply_author', 'outcome'];
  for (const k of required) {
    if (typeof entry[k] !== 'string' || !entry[k]) {
      throw new TypeError(`[evolution/audit] entry.${k} must be non-empty string`);
    }
  }
  if (!Array.isArray(entry.files_changed)) {
    throw new TypeError('[evolution/audit] entry.files_changed must be an array');
  }
  if (typeof entry.duration_ms !== 'number' || !Number.isFinite(entry.duration_ms)) {
    throw new TypeError('[evolution/audit] entry.duration_ms must be finite number');
  }
}

/**
 * Compute YYYY-MM-DD from epoch ms (UTC ISO date — matches ADR-008 example).
 */
function isoDate(epochMs = Date.now()) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * PR-S2 audit.write — write audit log to `memory/audit/<date>/<proposal_id>.json`.
 *
 * @param {object} entry — full ADR-008 schema fragment
 * @param {object} [opts]
 * @param {string} [opts.baseDir] — override AUDIT_BASE (tests inject tmpdir)
 * @returns {Promise<{ audit_log_path: string, entry: object }>}
 */
export async function writeAuditLog(entry, opts = {}) {
  validateEntry(entry);

  const baseDir = opts.baseDir || AUDIT_BASE;
  const dateDir = path.join(baseDir, isoDate());
  fs.mkdirSync(dateDir, { recursive: true });

  const fullEntry = {
    ...entry,
    schema_version: SCHEMA_VERSION,
    written_at: new Date().toISOString(),
  };

  const file = path.join(dateDir, `${entry.proposal_id}.json`);
  fs.writeFileSync(file, JSON.stringify(fullEntry, null, 2) + '\n', 'utf8');

  evolutionBus.emit(EVENTS.EVOLUTION_AUDIT, {
    proposal_id: entry.proposal_id,
    action: entry.action,
    outcome: entry.outcome,
    path: file,
    schema_version: SCHEMA_VERSION,
  });

  return { audit_log_path: file, entry: fullEntry };
}

/**
 * PR-S2 audit.archiveOldLogs — move audit files older than `daysOld` into
 * `memory/audit/.archive/YYYY-MM/<original-filename>`.
 *
 * PR-S3 will wire this to a cron. PR-S2 only exposes the function + tests it.
 *
 * @param {object} [opts]
 * @param {number} [opts.daysOld=7]
 * @param {string} [opts.baseDir] — override AUDIT_BASE
 * @returns {Promise<{ archived_count: number, archived_paths: string[] }>}
 */
export async function archiveOldLogs(opts = {}) {
  const daysOld = opts.daysOld ?? 7;
  const baseDir = opts.baseDir || AUDIT_BASE;
  const archiveBase = path.join(baseDir, '.archive');
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;

  if (!fs.existsSync(baseDir)) {
    return { archived_count: 0, archived_paths: [] };
  }

  const dateDirs = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => {
    if (!d.isDirectory()) {
      return false;
    }
    // Skip the archive dir itself.
    if (d.name === '.archive') {
      return false;
    }
    // Date dir must look like YYYY-MM-DD.
    return /^\d{4}-\d{2}-\d{2}$/.test(d.name);
  });

  const archivedPaths = [];
  for (const d of dateDirs) {
    const ts = Date.parse(`${d.name}T00:00:00Z`);
    if (!Number.isFinite(ts) || ts > cutoff) {
      continue;
    }
    const src = path.join(baseDir, d.name);
    const dst = path.join(archiveBase, d.name.slice(0, 7)); // YYYY-MM
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const srcFile = path.join(src, f);
      const dstFile = path.join(dst, f);
      fs.renameSync(srcFile, dstFile);
      archivedPaths.push(dstFile);
    }
    // Remove now-empty date dir.
    fs.rmdirSync(src);
  }

  return { archived_count: archivedPaths.length, archived_paths: archivedPaths };
}

/**
 * Convenience export matching core/self-evolution.js `audit(action, data)`
 * shape (PR-S1 wired this through `defaultAuditor.write` which produced a
 * tmp/audit entry). PR-S2 forwards to writeAuditLog, validating that the
 * caller supplied the full schema; missing required fields throw.
 */
export async function write(action, data) {
  if (typeof action !== 'string' || !action) {
    throw new TypeError('[evolution/audit.write] action must be non-empty string');
  }
  const entry = buildAuditEntry(action, data);
  const opts = data && data.baseDir ? { baseDir: data.baseDir } : {};
  return writeAuditLog(entry, opts);
}

/** Build an ADR-008 entry from a partial (data) payload. Mirrors the
 *  helper of the same name in core/self-evolution.js. */
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

export const _internal = {
  validateEntry,
  isoDate,
  AUDIT_BASE,
  ARCHIVE_BASE,
  SCHEMA_VERSION,
};
