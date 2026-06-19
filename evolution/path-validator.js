/**
 * Evolution Path Validator — PR for apply.js / propose.js defense in depth.
 *
 * Bug story (2026-06-18): a ghost directory `./--version/_/` appeared at the
 * repo root. Root cause: somewhere in the evolution pipeline (likely a
 * malformed proposal or a worktree-mkdir race), `path.dirname()` /
 * `fs.mkdirSync(..., {recursive:true})` was called with a path whose first
 * component started with `--`. `mkdirSync` happily created `./--version/`
 * and `./--version/_/`. No Darwin code had a guard for this.
 *
 * This module provides a single source of truth for "what counts as a
 * valid evolution write target path". Both `evolution/apply.js` (which
 * does the actual fs.writeFileSync) and `evolution/propose.js` (which
 * generates the paths from templates) MUST consult it before producing
 * a `files_added[].path`.
 *
 * Rejected patterns:
 *   - non-string / empty path
 *   - absolute path (path.isAbsolute)
 *   - any path component that is `.` or `..` (path traversal)
 *   - any path component that starts with `-` (the --version bug)
 *   - any path component that starts with `.` (hidden file / .git / .env)
 *
 * Note: the leading `.` rule is intentionally broad. Darwin never writes
 * to hidden files. If a future legitimate need arises, add an explicit
 * allowlist (e.g. `.well-known/`) here rather than relaxing the rule.
 *
 * LLM gate (ADR-009): pure string inspection, no LLM.
 */

import path from 'node:path';

const MAX_PATH_LEN = 512;

export function validateProposalPath(p) {
  if (typeof p !== 'string') {
    return { ok: false, reason: `path must be a string (got ${typeof p})` };
  }
  if (p.length === 0) {
    return { ok: false, reason: 'path must be non-empty string' };
  }
  if (p.length > MAX_PATH_LEN) {
    return { ok: false, reason: `path length ${p.length} > ${MAX_PATH_LEN}` };
  }
  if (path.isAbsolute(p)) {
    return { ok: false, reason: `absolute path not allowed: ${p}` };
  }
  // Hard reject `..` in the ORIGINAL path (before normalize). Even when
  // `path.normalize` would resolve the traversal to a safe-looking path
  // (e.g. `foo/../bar/baz.js` → `bar/baz.js`), allowing `..` in input
  // opens path-traversal attack vectors and confuses reviewers. Reject
  // the whole class of input up front.
  for (const orig of p.split(/[\\/]+/)) {
    if (orig === '..') {
      return { ok: false, reason: `path traversal ('..') not allowed: ${p}` };
    }
  }
  // Normalize first so the component check works on the resolved shape
  // (catches sneaky `foo/./bar`, `foo//bar` etc).
  let normalized;
  try {
    normalized = path.normalize(p);
  } catch (e) {
    return { ok: false, reason: `path.normalize threw: ${e.message}` };
  }
  if (path.isAbsolute(normalized)) {
    // path.normalize can flip `..` chains into absolute on POSIX; catch it.
    return { ok: false, reason: `normalized path is absolute (traversal?): ${p}` };
  }
  const parts = normalized.split(/[\\/]+/);
  for (const part of parts) {
    if (part === '' || part === '.') {
      return { ok: false, reason: `empty or '.' path component in: ${p}` };
    }
    // (part === '..' is unreachable — the original-path scan above
    // rejected any input containing '..' before we got here.)
    if (part.startsWith('-')) {
      return {
        ok: false,
        reason: `path component starts with '-' (the --version bug class): ${p} (component: "${part}")`,
      };
    }
    if (part.startsWith('.')) {
      return {
        ok: false,
        reason: `path component starts with '.' (hidden file not allowed): ${p} (component: "${part}")`,
      };
    }
  }
  return { ok: true, normalized };
}

/**
 * Validate every path in a `files_added[]` array. Returns the first
 * failure (short-circuit) or { ok: true, normalized: string[] }.
 *
 * @param {Array<{path: string}>} filesAdded
 */
export function validateProposalPaths(filesAdded) {
  if (!Array.isArray(filesAdded)) {
    return { ok: false, reason: 'filesAdded must be an array' };
  }
  const normalized = [];
  for (let i = 0; i < filesAdded.length; i += 1) {
    const f = filesAdded[i];
    if (!f || typeof f.path !== 'string') {
      return { ok: false, reason: `filesAdded[${i}].path must be a string` };
    }
    const v = validateProposalPath(f.path);
    if (!v.ok) {
      return { ok: false, reason: `filesAdded[${i}]: ${v.reason}` };
    }
    normalized.push(v.normalized);
  }
  return { ok: true, normalized };
}
