/**
 * Audit unit tests — PR-S2.
 *
 * Exercises evolution/audit.js: writeAuditLog (ADR-008 schema, schema_version
 * = 2), `write` back-compat wrapper, and archiveOldLogs(). Uses tmpdir
 * baseDir to avoid polluting the repo.
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAuditLog, archiveOldLogs, write } from '../../evolution/audit.js';

function validEntry(overrides = {}) {
  return {
    proposal_id: 'audit-test-1',
    action: 'apply',
    apply_author: 'darwin',
    outcome: 'success',
    files_changed: [{ path: 'tool/builtins/x.js', diff_type: '+', lines: 10 }],
    diff_stat: { '+': 10, '-': 0 },
    verify_result: { test: true, lint: true, size_check: true },
    duration_ms: 123,
    session_key: 'agent:test',
    tag_sha: 'abc1234',
    ...overrides,
  };
}

test('writeAuditLog: writes JSON file under <baseDir>/YYYY-MM-DD/<proposal_id>.json', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const res = await writeAuditLog(validEntry(), { baseDir });
  assert.match(res.audit_log_path, /audit-test-1\.json$/);
  assert.ok(fs.existsSync(res.audit_log_path));
  const written = JSON.parse(fs.readFileSync(res.audit_log_path, 'utf8'));
  assert.equal(written.proposal_id, 'audit-test-1');
  assert.equal(written.action, 'apply');
  assert.equal(written.schema_version, 2);
  assert.equal(written.outcome, 'success');
  assert.equal(written.duration_ms, 123);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('writeAuditLog: schema_version=2 written even if entry has lower version', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const res = await writeAuditLog(validEntry({ schema_version: 1 }), { baseDir });
  assert.equal(res.entry.schema_version, 2);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('writeAuditLog: rejects missing required fields', async () => {
  await assert.rejects(() => writeAuditLog({}), TypeError);
  await assert.rejects(() => writeAuditLog({ proposal_id: 'x', action: 'apply' }), TypeError);
  await assert.rejects(
    () =>
      writeAuditLog({
        proposal_id: 'x',
        action: 'apply',
        apply_author: 'darwin',
        outcome: 'success',
        // files_changed missing
        duration_ms: 1,
      }),
    TypeError,
  );
});

test('writeAuditLog: emits evolution:audit event', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const { evolutionBus } = await import('../../evolution/_bus.js');
  const { EVENTS } = await import('../../core/events.js');
  const captured = [];
  const handler = (p) => captured.push(p);
  evolutionBus.on(EVENTS.EVOLUTION_AUDIT, handler);
  try {
    await writeAuditLog(validEntry(), { baseDir });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, 'apply');
    assert.equal(captured[0].schema_version, 2);
  } finally {
    evolutionBus.off(EVENTS.EVOLUTION_AUDIT, handler);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('write (back-compat): constructs entry from (action, data)', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const res = await write('apply', {
    proposal_id: 'compat-1',
    files_changed: [{ path: 'a.js' }],
    duration_ms: 5,
    session_key: 'agent:test',
    tag_sha: 'deadbeef',
    baseDir,
  });
  assert.match(res.audit_log_path, /compat-1\.json$/);
  const written = JSON.parse(fs.readFileSync(res.audit_log_path, 'utf8'));
  assert.equal(written.action, 'apply');
  assert.equal(written.apply_author, 'darwin');
  assert.equal(written.schema_version, 2);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('write (back-compat): rejects empty action', async () => {
  await assert.rejects(() => write('', {}), TypeError);
});

test('archiveOldLogs: moves old date dirs into .archive/YYYY-MM/', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-'));
  // Insert a date dir dated 30 days ago.
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const oldDir = path.join(baseDir, oldDate);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'old.json'), '{"x":1}');
  // Insert a fresh date dir (today).
  const todayDir = path.join(baseDir, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(todayDir, { recursive: true });
  fs.writeFileSync(path.join(todayDir, 'fresh.json'), '{"y":2}');
  const res = await archiveOldLogs({ baseDir, daysOld: 7 });
  assert.equal(res.archived_count, 1);
  assert.equal(res.archived_paths.length, 1);
  // old dir gone, archive has it.
  assert.ok(!fs.existsSync(oldDir));
  const archived = path.join(baseDir, '.archive', oldDate.slice(0, 7), 'old.json');
  assert.ok(fs.existsSync(archived));
  // fresh dir remains.
  assert.ok(fs.existsSync(todayDir));
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('archiveOldLogs: no old dirs → archived_count:0', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-archive-'));
  const res = await archiveOldLogs({ baseDir });
  assert.equal(res.archived_count, 0);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('archiveOldLogs: missing baseDir → no throw, archived_count:0', async () => {
  const res = await archiveOldLogs({
    baseDir: path.join(os.tmpdir(), 'audit-does-not-exist-' + Date.now()),
  });
  assert.equal(res.archived_count, 0);
});
