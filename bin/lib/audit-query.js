/**
 * darwin self-evolution audit-query -- V17.1 CLI handler.
 *
 * Cross-file audit query backed by core/audit-reader.js. Reads
 * <baseDir>/audit.jsonl (main + rotated archives) and applies
 * --topic / --proposal / --outcome / --action / --since / --until
 * / --limit filters. Output --format json (default) or table.
 *
 * Filter semantics match core/audit-reader.matchesFilters() exactly
 * (see that module's docstring for the per-filter rules).
 *
 * Usage:
 *   darwin self-evolution audit-query [--topic X] [--proposal P]
 *                                   [--outcome ok|warn|error]
 *                                   [--action apply|rollback|...]
 *                                   [--since ISO] [--until ISO]
 *                                   [--limit N] [--format json|table]
 *                                   [--base-dir <path>]
 *
 * Default baseDir: <cwd>/memory/audit (matches plugin/audit.js).
 */

import { readAuditEntries } from '../../core/audit-reader.js';

const DEFAULTS = {
  limit: 100,
  format: 'json',
  baseDir: null, // resolved in handleAuditQuery via process.cwd()/env
};

/**
 * Parse the V17.1 audit-query flags. Accepts both `--key value` and
 * `--key=value` forms. Reuses the bin/lib/self-evolution.js parseFlags
 * style (positionals are passed through, only flags are extracted).
 *
 * @param {string[]} rest  argv tail
 * @returns {object} filters + opts
 */
function parseAuditQueryFlags(rest) {
  const filters = {};
  const opts = { ...DEFAULTS };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (typeof a !== 'string') {
      continue;
    }
    const eq = a.indexOf('=');
    let key;
    let val;
    if (eq > 0) {
      key = a.slice(0, eq);
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a;
      val = rest[i + 1];
      i += 1;
    } else {
      continue;
    }
    applyAuditFlag(key, val, filters, opts);
  }
  return { filters, opts };
}
function applyAuditFlag(key, val, filters, opts) {
  if (key === '--topic') {
    filters.topic = val;
    return;
  }
  if (key === '--proposal') {
    filters.proposal = val;
    return;
  }
  if (key === '--outcome') {
    filters.outcome = val;
    return;
  }
  if (key === '--action') {
    filters.action = val;
    return;
  }
  if (key === '--since') {
    filters.since = val;
    return;
  }
  if (key === '--until') {
    filters.until = val;
    return;
  }
  if (key === '--limit') {
    opts.limit = parseInt(val, 10) || DEFAULTS.limit;
    return;
  }
  if (key === '--format') {
    opts.format = val === 'table' ? 'table' : 'json';
    return;
  }
  if (key === '--base-dir') {
    opts.baseDir = val;
    return;
  }
}

/**
 * Render entries as a fixed-width table. Used when --format table.
 * Columns: time, topic, proposal, action, outcome. Truncates long
 * strings at 60 chars with trailing '...'.
 *
 * @param {object[]} entries
 * @returns {string}
 */
function renderTable(entries) {
  if (entries.length === 0) {
    return '(no matching audit entries)';
  }
  const colTime = 'time';
  const colTopic = 'topic';
  const colProposal = 'proposal';
  const colAction = 'action';
  const colOutcome = 'outcome';
  const truncate = (s, n) => {
    s = String(s === null || s === undefined ? '-' : s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  };
  const rows = entries.map((e) => {
    const p = e.payload || {};
    return [
      truncate(e.recordedAt || '-', 24),
      truncate(e.topic || '-', 28),
      truncate(p.proposal_id || '-', 24),
      truncate(p.action || '-', 10),
      truncate(p.outcome || '-', 10),
    ];
  });
  const headers = [colTime, colTopic, colProposal, colAction, colOutcome];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map((r) => fmt(r))].join('\n');
}

/**
 * Entry point. Called by bin/lib/self-evolution.js as
 * selfEvolutionDispatch('audit-query', rest). `rest` is the argv tail
 * after `audit-query`.
 *
 * @param {string[]} positional
 * @param {object} flags   parsed by bin/lib/self-evolution.js parseFlags
 * @returns {Promise<{ok: true, count: number, filters: object}>}
 */
export async function handleAuditQuery(positional, flags) {
  // merge self-evolution.js parseFlags output (top-level flags like --cwd)
  // with our own audit-query flag parsing (filters + opts)
  const { filters: ourFilters, opts: ourOpts } = parseAuditQueryFlags(positional);
  const baseDir =
    ourOpts.baseDir ||
    (flags && flags.cwd ? `${flags.cwd}/memory/audit` : `${process.cwd()}/memory/audit`);

  const result = await readAuditEntries({
    baseDir,
    filters: ourFilters,
    limit: ourOpts.limit,
  });
  const fmt = ourOpts.format;
  if (fmt === 'table') {
    console.log(renderTable(result.entries));
  } else {
    // json: include both entries + metadata so callers can post-process
    console.log(
      JSON.stringify(
        {
          ok: true,
          baseDir,
          count: result.entries.length,
          scanned: result.scanned,
          matched: result.matched,
          filesScanned: result.filesScanned,
          filters: ourFilters,
          entries: result.entries,
        },
        null,
        2,
      ),
    );
  }
  return { ok: true, count: result.entries.length, filters: ourFilters };
}
