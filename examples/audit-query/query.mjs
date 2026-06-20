#!/usr/bin/env node
/**
 * query.mjs -- Example 3: query Darwin's audit log from a Node script.
 *
 * Shows:
 *   1. How to call the core/audit-reader module directly
 *   2. How to apply filters (topic, proposal, outcome, since, until)
 *   3. How to print results as JSON or as a fixed-width table
 *
 * The audit log is Darwin's source of truth for "what just happened":
 *   - Every evolution event (propose, apply, verify, audit, learn...)
 *   - Every plugin lifecycle (load, init, enable, disable, unload)
 *   - Persisted to <baseDir>/audit.jsonl (default: <cwd>/memory/audit)
 *   - V14 rotates the file at 512KB / 10 archives; core/audit-reader
 *     transparently reads across the main file + all rotated archives
 *
 * Usage:
 *   # Show all evolution:audit events in JSON
 *   node examples/audit-query/query.mjs --topic evolution:audit --format json
 *
 *   # Show everything from the last hour
 *   node examples/audit-query/query.mjs --since 2026-06-20T15:00:00Z
 *
 *   # Filter to a specific proposal
 *   node examples/audit-query/query.mjs --proposal prop-add-metrics --format table
 */

import path from 'node:path';
import process from 'node:process';
import { readAuditEntries } from '../../core/audit-reader.js';

function parseFlags(argv) {
  const filters = {};
  const opts = { format: 'json', limit: 50, baseDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.indexOf('=');
    let key;
    let val;
    if (eq > 0) {
      key = a.slice(0, eq);
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a;
      val = argv[i + 1];
      i += 1;
    } else {
      continue;
    }
    switch (key) {
      case '--topic': filters.topic = val; break;
      case '--proposal': filters.proposal = val; break;
      case '--outcome': filters.outcome = val; break;
      case '--action': filters.action = val; break;
      case '--since': filters.since = val; break;
      case '--until': filters.until = val; break;
      case '--limit': opts.limit = parseInt(val, 10) || 50; break;
      case '--format': opts.format = val === 'table' ? 'table' : 'json'; break;
      case '--base-dir': opts.baseDir = val; break;
      default: break;
    }
  }
  return { filters, opts };
}

function renderTable(entries) {
  if (entries.length === 0) return '(no matching entries)';
  const truncate = (s, n) => {
    s = String(s == null || s === undefined ? '-' : s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  };
  const headers = ['time', 'topic', 'proposal', 'action', 'outcome'];
  const rows = entries.map((e) => {
    const p = e.payload || {};
    return [
      truncate(e.recordedAt, 24),
      truncate(e.topic, 28),
      truncate(p.proposal_id, 24),
      truncate(p.action, 10),
      truncate(p.outcome, 10),
    ];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmt(headers), ...rows.map((r) => fmt(r))].join('\n');
}

const { filters, opts } = parseFlags(process.argv.slice(2));
const baseDir = opts.baseDir || path.join(process.cwd(), 'memory', 'audit');

try {
  const result = await readAuditEntries({ baseDir, filters, limit: opts.limit });
  if (opts.format === 'table') {
    console.log(renderTable(result.entries));
  } else {
    console.log(JSON.stringify({
      ok: true,
      baseDir,
      count: result.entries.length,
      scanned: result.scanned,
      matched: result.matched,
      filesScanned: result.filesScanned,
      filters,
      entries: result.entries,
    }, null, 2));
  }
  console.error(`(scanned ${result.scanned} lines, matched ${result.matched}, files ${result.filesScanned.length})`);
} catch (err) {
  console.error('query failed:', err.message);
  process.exit(1);
}