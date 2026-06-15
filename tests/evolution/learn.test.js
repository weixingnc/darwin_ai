/**
 * Learn unit tests — PR-S2.
 *
 * Exercises evolution/learn.js: appendInsight / learn (alias). Uses tmpdir
 * learnDir so we don't pollute the repo's `memory/learnings/`.
 *
 * node:test + node:assert/strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { learn, appendInsight, _internal } from '../../evolution/learn.js';

test('learn: appends `- <date>: <insight>` line to evolution-rules.md', async () => {
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const r = await learn('first insight', { learnDir });
  assert.match(r.rules_path, /evolution-rules\.md$/);
  assert.ok(fs.existsSync(r.rules_path));
  const content = fs.readFileSync(r.rules_path, 'utf8');
  assert.match(content, /- \d{4}-\d{2}-\d{2}: first insight\n/);
  assert.equal(r.rules_count, 1);
  fs.rmSync(learnDir, { recursive: true, force: true });
});

test('learn: subsequent appends grow rules_count + file accumulates', async () => {
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  await learn('insight A', { learnDir });
  const r2 = await learn('insight B', { learnDir });
  assert.equal(r2.rules_count, 2);
  const content = fs.readFileSync(r2.rules_path, 'utf8');
  assert.match(content, /insight A/);
  assert.match(content, /insight B/);
  fs.rmSync(learnDir, { recursive: true, force: true });
});

test('learn: rejects empty / whitespace-only insight', async () => {
  await assert.rejects(() => learn(''), TypeError);
  await assert.rejects(() => learn('   '), TypeError);
});

test('learn: rejects insight > 2000 chars', async () => {
  await assert.rejects(() => learn('x'.repeat(2001)), TypeError);
});

test('learn: trims leading/trailing whitespace from insight', async () => {
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const r = await learn('  trimmed insight  ', { learnDir });
  const content = fs.readFileSync(r.rules_path, 'utf8');
  assert.match(content, /trimmed insight/);
  // No double space after the colon — implementation: `- ${date}: ${insight.trim()}\n`
  assert.ok(!content.includes(':  trimmed'), 'no double-space after colon');
  fs.rmSync(learnDir, { recursive: true, force: true });
});

test('learn: emits evolution:learn event', async () => {
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const { evolutionBus } = await import('../../evolution/_bus.js');
  const { EVENTS } = await import('../../core/events.js');
  const captured = [];
  const handler = (p) => captured.push(p);
  evolutionBus.on(EVENTS.EVOLUTION_LEARN, handler);
  try {
    await learn('eventful', { learnDir });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].insight, 'eventful');
    assert.equal(captured[0].rules_count, 1);
  } finally {
    evolutionBus.off(EVENTS.EVOLUTION_LEARN, handler);
    fs.rmSync(learnDir, { recursive: true, force: true });
  }
});

test('learn: creates file with markdown header on first write', async () => {
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const r = await learn('headered', { learnDir });
  const content = fs.readFileSync(r.rules_path, 'utf8');
  assert.match(content, /^# Evolution Rules\n/);
  assert.match(content, /Rules learned from rollbacks/);
  fs.rmSync(learnDir, { recursive: true, force: true });
});

test('appendInsight: alias for learn (callable both ways)', async () => {
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const a = await learn('via learn', { learnDir });
  const b = await appendInsight('via appendInsight', { learnDir });
  assert.equal(a.rules_path, b.rules_path);
  assert.equal(b.rules_count, 2);
  fs.rmSync(learnDir, { recursive: true, force: true });
});

test('_internal.countRules: counts only lines starting with `- `', () => {
  const f = path.join(os.tmpdir(), 'cr-' + Date.now() + '.md');
  fs.writeFileSync(f, '# header\n- rule 1\n- rule 2\nnot a rule\n- rule 3\n');
  assert.equal(_internal.countRules(f), 3);
  fs.unlinkSync(f);
});
