/**
 * core/audit-reader -- cross-file audit query for plugin/audit.js's
 * audit.jsonl (main + rotated archives).
 *
 * V17: `darwin self-evolution audit-query` subcommand. The audit plugin
 * appends one JSON object per line to `<baseDir>/audit.jsonl`. V14
 * rotates the file when it exceeds 512 KB. This module reads the main
 * file + all rotated siblings and applies the requested filters in
 * newest-first order.
 *
 * Pure read-only module. No I/O writes, no EventBus, no LLM.
 *
 * Audit entry shape (one per line in audit.jsonl):
 *   {
 *     topic: 'evolution:audit' | 'evolution:apply:after' | ...,
 *     payload: { proposal_id, action, outcome, ... },
 *     recordedAt: '2026-06-20T10:00:00.000Z'
 *   }
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { listArchives } from './log-rotate.js';

/**
 * Parse one JSONL line defensively. Returns null on parse error (line
 * is silently skipped) or non-object values. We do not throw on
 * malformed lines because a partial / truncated archive is a real
 * failure mode (process killed mid-append).
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseAuditLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return null;
  }
  return obj;
}

/**
 * Iterate audit entries from a single file (main or rotated). Yields
 * one parsed object per non-empty line; skips malformed lines.
 *
 * Async generator: lets us stream large files without loading them
 * whole into memory.
 *
 * @param {string} filePath
 * @returns {AsyncIterable<object>}
 */
export async function* iterateAuditFile(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const obj = parseAuditLine(line);
      if (obj) {
        yield obj;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Check whether a single audit entry matches a set of filter criteria.
 * All specified filters must match (AND). Returns true on no filters.
 *
 * @param {object} entry  parsed audit entry
 * @param {object} filters
 * @param {string} [filters.topic]          exact match on entry.topic
 * @param {string} [filters.proposal]       exact match on entry.payload.proposal_id
 * @param {string} [filters.outcome]        exact match on entry.payload.outcome
 * @param {string} [filters.action]         exact match on entry.payload.action
 * @param {string} [filters.since]          ISO timestamp; entry.recordedAt >= since
 * @param {string} [filters.until]          ISO timestamp; entry.recordedAt <= until
 * @returns {boolean}
 */
function matchField(actual, expected) {
  return expected === undefined || actual === expected;
}
function matchPayload(entry, key, expected) {
  if (expected === undefined) {
    return true;
  }
  const v = entry.payload && entry.payload[key];
  return v === expected;
}
function matchTimestamp(actual, op, expected) {
  if (expected === undefined) {
    return true;
  }
  if (typeof actual !== 'string') {
    return false;
  }
  if (op === 'since') {
    return actual >= expected;
  }
  if (op === 'until') {
    return actual <= expected;
  }
  return true;
}
export function matchesFilters(entry, filters) {
  if (!filters) {
    return true;
  }
  if (!matchField(entry.topic, filters.topic)) {
    return false;
  }
  if (!matchPayload(entry, 'proposal_id', filters.proposal)) {
    return false;
  }
  if (!matchPayload(entry, 'outcome', filters.outcome)) {
    return false;
  }
  if (!matchPayload(entry, 'action', filters.action)) {
    return false;
  }
  if (!matchTimestamp(entry.recordedAt, 'since', filters.since)) {
    return false;
  }
  if (!matchTimestamp(entry.recordedAt, 'until', filters.until)) {
    return false;
  }
  return true;
}

/**
 * Read all audit entries matching `filters` across the main file and
 * its rotated archives, newest-first (rotated mtime desc, then main).
 * Caps the result at `limit` entries (default 100, 0 = unlimited).
 *
 * @param {object} opts
 * @param {string} opts.baseDir   dir containing audit.jsonl
 * @param {object} [opts.filters] see matchesFilters
 * @param {number} [opts.limit=100]
 * @returns {Promise<{entries: object[], scanned: number, matched: number, filesScanned: string[]}>}
 */
export async function readAuditEntries(opts) {
  if (!opts || typeof opts.baseDir !== 'string' || opts.baseDir.length === 0) {
    throw new TypeError('[audit-reader] opts.baseDir is required (string)');
  }
  const filters = opts.filters || {};
  const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : 100;

  const mainPath = join(opts.baseDir, 'audit.jsonl');
  const archives = await listArchives(mainPath);

  // Newest-first: rotated archives (mtime desc) then main file
  // Newest-first: main file first (always most recent), then archives in mtime desc.
  const files = [mainPath, ...archives.map((a) => a.path)];

  const collected = [];
  let scanned = 0;
  for (const f of files) {
    try {
      const fileEntries = [];
      for await (const entry of iterateAuditFile(f)) {
        scanned += 1;
        if (!matchesFilters(entry, filters)) {
          continue;
        }
        fileEntries.push(entry);
      }
      // Reverse each file (within-file order is line-order, oldest first).
      // We want newest overall -> newest file first + within each file, newest first.
      fileEntries.reverse();
      for (const e of fileEntries) {
        collected.push(e);
      }
    } catch {
      /* file unreadable; skip */
    }
  }
  // Final: limit cap.
  const out = limit > 0 ? collected.slice(0, limit) : collected;
  const matched = out.length;
  return { entries: out, scanned, matched, filesScanned: files };
}
