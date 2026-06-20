/**
 * core/audit-reader tests (V17).
 *
 * Covers: parseAuditLine, matchesFilters, readAuditEntries (with
 * rotated archives). Uses a tmp dir; no production logs touched.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAuditLine,
  matchesFilters,
  iterateAuditFile,
  readAuditEntries,
} from '../../core/audit-reader.js';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'darwin-audit-reader-'));
});
after(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(topic, payload, recordedAt) {
  return { topic, payload, recordedAt };
}

describe('audit-reader -- parseAuditLine', () => {
  test('parses valid JSONL', () => {
    const e = parseAuditLine('{"topic":"x","payload":{},"recordedAt":"2026-06-20T00:00:00Z"}');
    assert.equal(e.topic, 'x');
  });

  test('returns null for empty / whitespace lines', () => {
    assert.equal(parseAuditLine(''), null);
    assert.equal(parseAuditLine('   '), null);
    assert.equal(parseAuditLine('\n'), null);
  });

  test('returns null for malformed JSON', () => {
    assert.equal(parseAuditLine('{not valid json'), null);
  });

  test('returns null for non-object (string / array / number)', () => {
    assert.equal(parseAuditLine('"hello"'), null);
    assert.equal(parseAuditLine('42'), null);
    assert.equal(parseAuditLine('[1,2,3]'), null);
  });
});

describe('audit-reader -- matchesFilters', () => {
  test('no filters -> match everything', () => {
    assert.equal(matchesFilters(entry('a', {}), undefined), true);
    assert.equal(matchesFilters(entry('a', {}), {}), true);
  });

  test('topic exact match', () => {
    assert.equal(matchesFilters(entry('evolution:audit', {}), { topic: 'evolution:audit' }), true);
    assert.equal(
      matchesFilters(entry('evolution:apply:after', {}), { topic: 'evolution:audit' }),
      false,
    );
  });

  test('proposal + outcome + action from payload', () => {
    const e = entry('evolution:audit', { proposal_id: 'p-1', action: 'apply', outcome: 'ok' });
    assert.equal(matchesFilters(e, { proposal: 'p-1' }), true);
    assert.equal(matchesFilters(e, { proposal: 'p-2' }), false);
    assert.equal(matchesFilters(e, { outcome: 'ok' }), true);
    assert.equal(matchesFilters(e, { outcome: 'warn' }), false);
    assert.equal(matchesFilters(e, { action: 'apply' }), true);
    assert.equal(matchesFilters(e, { action: 'rollback' }), false);
  });

  test('since / until timestamp window', () => {
    const e = entry('x', {}, '2026-06-20T10:00:00.000Z');
    assert.equal(matchesFilters(e, { since: '2026-06-20T09:00:00Z' }), true);
    assert.equal(matchesFilters(e, { since: '2026-06-20T11:00:00Z' }), false);
    assert.equal(matchesFilters(e, { until: '2026-06-20T11:00:00Z' }), true);
    assert.equal(matchesFilters(e, { until: '2026-06-20T09:00:00Z' }), false);
  });

  test('multiple filters AND together', () => {
    const e = entry('evolution:audit', { proposal_id: 'p-1', outcome: 'ok' });
    assert.equal(matchesFilters(e, { proposal: 'p-1', outcome: 'ok' }), true);
    assert.equal(matchesFilters(e, { proposal: 'p-1', outcome: 'warn' }), false);
  });

  test('missing payload fields -> filter fails safely', () => {
    const e = entry('x', null);
    assert.equal(matchesFilters(e, { proposal: 'p-1' }), false);
    assert.equal(matchesFilters(e, { outcome: 'ok' }), false);
  });
});

describe('audit-reader -- iterateAuditFile', () => {
  test('yields one parsed entry per non-empty line', async () => {
    const p = join(dir, 'iter.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({
          topic: 'a',
          payload: { proposal_id: 'p1' },
          recordedAt: '2026-06-20T00:00:00Z',
        }),
        '',
        '# this is a comment-like line that is NOT valid JSON',
        JSON.stringify({ topic: 'b', payload: {}, recordedAt: '2026-06-20T01:00:00Z' }),
      ].join('\n'),
    );
    const out = [];
    for await (const e of iterateAuditFile(p)) {
      out.push(e);
    }
    assert.equal(out.length, 2);
    assert.equal(out[0].topic, 'a');
    assert.equal(out[1].topic, 'b');
  });
});

describe('audit-reader -- readAuditEntries', () => {
  test('missing baseDir throws TypeError', async () => {
    await assert.rejects(() => readAuditEntries({}), /baseDir/);
  });

  test('empty baseDir returns empty result, no throw', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'darwin-audit-empty-'));
    try {
      const r = await readAuditEntries({ baseDir: emptyDir });
      assert.equal(r.entries.length, 0);
      assert.equal(r.scanned, 0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('reads main file + filters by topic', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'darwin-audit-mt-'));
    try {
      const lines = [
        entry(
          'evolution:audit',
          { proposal_id: 'p1', action: 'apply', outcome: 'ok' },
          '2026-06-20T10:00:00Z',
        ),
        entry('evolution:apply:after', { proposal_id: 'p1' }, '2026-06-20T10:00:01Z'),
        entry('evolution:audit', { proposal_id: 'p2', outcome: 'warn' }, '2026-06-20T10:00:02Z'),
      ].map((e) => JSON.stringify(e));
      writeFileSync(join(baseDir, 'audit.jsonl'), lines.join('\n') + '\n');
      const r = await readAuditEntries({ baseDir, filters: { topic: 'evolution:audit' } });
      assert.equal(r.matched, 2);
      assert.equal(r.entries.length, 2);
      assert.equal(r.entries[0].payload.proposal_id, 'p2'); // newest-first: p2 is later in the file
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('limit caps result count', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'darwin-audit-lim-'));
    try {
      const lines = [];
      for (let i = 0; i < 50; i += 1) {
        lines.push(
          JSON.stringify(
            entry(
              'evolution:audit',
              { proposal_id: `p${i}`, outcome: 'ok' },
              `2026-06-20T10:00:${String(i).padStart(2, '0')}Z`,
            ),
          ),
        );
      }
      writeFileSync(join(baseDir, 'audit.jsonl'), lines.join('\n') + '\n');
      const r = await readAuditEntries({ baseDir, limit: 5 });
      assert.equal(r.entries.length, 5);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('reads main + rotated archives (newest first)', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'darwin-audit-rot-'));
    try {
      // main file: 2 newer entries
      writeFileSync(
        join(baseDir, 'audit.jsonl'),
        [
          JSON.stringify(
            entry('evolution:audit', { proposal_id: 'main1' }, '2026-06-20T12:00:00Z'),
          ),
          JSON.stringify(
            entry('evolution:audit', { proposal_id: 'main2' }, '2026-06-20T12:00:01Z'),
          ),
        ].join('\n') + '\n',
      );
      // rotated archive: 2 older entries
      const archiveName = 'audit.jsonl.2026-06-20T10-00-00.rotated';
      writeFileSync(
        join(baseDir, archiveName),
        [
          JSON.stringify(entry('evolution:audit', { proposal_id: 'old1' }, '2026-06-20T10:00:00Z')),
          JSON.stringify(entry('evolution:audit', { proposal_id: 'old2' }, '2026-06-20T10:00:01Z')),
        ].join('\n') + '\n',
      );
      // The listArchives helper uses mtime to sort. Set explicit mtime
      // so the archive is older than the main file.
      const { utimesSync } = await import('node:fs');
      utimesSync(
        join(baseDir, archiveName),
        new Date('2026-06-20T10:00:00Z'),
        new Date('2026-06-20T10:00:00Z'),
      );
      utimesSync(
        join(baseDir, 'audit.jsonl'),
        new Date('2026-06-20T12:00:00Z'),
        new Date('2026-06-20T12:00:00Z'),
      );

      const r = await readAuditEntries({ baseDir, limit: 100 });
      assert.equal(r.matched, 4);
      // Newest-first: main2, main1, old2, old1
      const proposals = r.entries.map((e) => e.payload.proposal_id);
      assert.deepEqual(proposals, ['main2', 'main1', 'old2', 'old1']);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
