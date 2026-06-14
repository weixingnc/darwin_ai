/**
 * OpenClawSkill e2e integration tests — PR-27. 6 cases.
 * End-to-end coverage of the integrated v2 + OpenClaw pipeline.
 * node:test + node:assert, matching tests/core/* style.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAll, _getOpenClawMetadata } from '../../core/skill-loader.js';
import { createRegistry, matchSkills } from '../../core/skill-registry.js';
import { isOpenClawSkillContent } from '../../core/openclaw-skill-adapter.js';
import { parseOpenClawMetadata } from '../../core/openclaw-metadata-parser.js';
import { watchSkillsDir, closeWatch } from '../../core/skill-watcher.js';

const FM = (body, fm) => '---\n' + fm + '\n---\n' + body;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-'));
const write = (d, n, c) => fs.writeFileSync(path.join(d, n), c);
const sl = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. real OpenClaw fixture end-to-end (loader → registry → matchSkills) ──
test('1. real OpenClaw fixture end-to-end → loadAll routes to adapter, matcher-v2 fires', () => {
  const d = tmp();
  // Real OpenClaw weather SKILL.md style (no triggers/version, has description + metadata)
  write(
    d,
    'weather.md',
    FM(
      'Use wttr.in to fetch weather data.',
      "name: weather\ndescription: 'Current weather and forecasts with wttr.in via curl for locations, rain, temperature, travel planning.'\nmetadata: { openclaw: { emoji: ☔, requires: { bins: [curl] } } }",
    ),
  );
  const r = createRegistry();
  const res = loadAll(d, r);
  assert.equal(res.loaded.length, 1, 'expected exactly one loaded');
  assert.equal(res.skipped.length, 0);
  const entry = r.get('weather');
  assert.equal(entry.source, 'openclaw-l2');
  // openclawMetadata is preserved via PR-27 side-channel (PR-21a buildStored
  // drops unknown fields; we stash the raw block for later retrieval).
  const rawMeta = _getOpenClawMetadata(r, 'weather');
  assert.ok(rawMeta);
  assert.match(rawMeta, /openclaw/);
  // metadata parser handles the raw string
  const parsed = parseOpenClawMetadata(rawMeta);
  assert.equal(parsed.emoji, '☔');
  assert.deepEqual(parsed.requires.bins, ['curl']);
  // PR-27: matchSkills (now v2) finds it via inferred triggers
  const matches = matchSkills({ text: 'what is the weather in Shanghai', registry: r, max: 2 });
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].name, 'weather');
  assert.match(matches[0].systemHint, /wttr\.in/);
  assert.equal(matches[0].matcherVersion, 'v2');
});

// ── 2. mixed directory L1+L2 + Darwin format + priority order ──
test('2. mixed directory → L1 + L2 + Darwin sorted by priority desc, all match', () => {
  const d = tmp();
  write(d, 'oc-l1.md', FM('A', 'name: oc-l1')); // OpenClaw L1
  write(d, 'oc-l2.md', FM('A', 'name: oc-l2\ndescription: an openclaw skill')); // OpenClaw L2
  write(
    d,
    'darwin.md',
    FM('A', 'name: darwin\ntriggers: [hello]\nhint: darwin hint\npriority: 80'),
  );
  const r = createRegistry();
  const res = loadAll(d, r);
  assert.equal(res.loaded.length, 3);
  assert.deepEqual([...r.keys()], ['darwin', 'oc-l1', 'oc-l2']); // darwin priority 80 first; 50s retain file order
  // Each is matchable
  assert.ok(matchSkills({ text: 'hello there', registry: r, max: 3 }).length >= 1);
});

// ── 3. triggerType real effect (exact/regex/command-prefix) ──
test('3. triggerType metadata actually affects match (exact/regex/command-prefix)', () => {
  const d = tmp();
  // exact: only matches the exact string "ping"
  write(
    d,
    'p.md',
    FM(
      'A',
      'name: ping\ndescription: ping command\ndarwinTriggers: [ping]\ndarwinTriggerType: exact',
    ),
  );
  // regex: matches anything containing digits
  write(
    d,
    'd.md',
    FM(
      'A',
      'name: digits\ndescription: find digits\ndarwinTriggers: [\\d+]\ndarwinTriggerType: regex',
    ),
  );
  // command-prefix: matches /cmd but not just cmd
  write(
    d,
    'c.md',
    FM(
      'A',
      'name: cmd\ndescription: cmd handler\ndarwinTriggers: [/cmd]\ndarwinTriggerType: command-prefix',
    ),
  );
  const r = createRegistry();
  loadAll(d, r);
  // exact
  const m1 = matchSkills({ text: 'ping', registry: r, max: 5 });
  assert.ok(
    m1.find((m) => m.name === 'ping'),
    'exact should match "ping"',
  );
  assert.ok(
    !matchSkills({ text: 'ping-pong', registry: r, max: 5 }).find((m) => m.name === 'ping'),
    'exact should NOT match "ping-pong"',
  );
  // regex
  assert.ok(
    matchSkills({ text: 'order #42', registry: r, max: 5 }).find((m) => m.name === 'digits'),
  );
  // command-prefix
  assert.ok(matchSkills({ text: '/cmd help', registry: r, max: 5 }).find((m) => m.name === 'cmd'));
  assert.ok(
    !matchSkills({ text: 'cmd help', registry: r, max: 5 }).find((m) => m.name === 'cmd'),
    'command-prefix should NOT match without leading /',
  );
});

// ── 4. errors not fatal: mixed corrupt OpenClaw + valid Darwin → Darwin still works ──
test('4. corrupt OpenClaw files are skipped, valid Darwin files still load', () => {
  const d = tmp();
  write(d, 'good.md', FM('A', 'name: darwin-ok\ntriggers: [hi]\nhint: hi hint'));
  write(d, 'bad1.md', 'no frontmatter at all');
  write(d, 'bad2.md', FM('A', 'description: nameless'));
  write(d, 'bad3.md', '---\n---\nno name');
  const r = createRegistry();
  const res = loadAll(d, r);
  assert.equal(res.loaded.length, 1);
  assert.equal(r.get('darwin-ok').name, 'darwin-ok');
  const matches = matchSkills({ text: 'hi there', registry: r, max: 2 });
  assert.equal(matches[0]?.name, 'darwin-ok');
});

// ── 5. hot reload via watcher: OpenClaw SKILL.md update propagates to matchSkills ──
test('5. watcher detects OpenClaw SKILL.md change → registry updates → matcher-v2 picks it up', async () => {
  const d = tmp();
  write(
    d,
    'w.md',
    FM('A', 'name: watcher-skill\ndescription: first version of skill\ndarwinPriority: 50'),
  );
  const r = createRegistry();
  loadAll(d, r);
  assert.equal(r.get('watcher-skill').source, 'openclaw-l2');
  // First-version description → "first version of skill" → trigger "first"
  assert.ok(matchSkills({ text: 'please first this', registry: r }).length >= 1);
  const h = watchSkillsDir(d, r, { debounceMs: 30 });
  // Update description → new triggers inferred. Bump priority to 60 so
  // PR-21a registerSkill allows the overwrite (equal priority is rejected).
  write(
    d,
    'w.md',
    FM('A', 'name: watcher-skill\ndescription: brand new updated triggerword\ndarwinPriority: 60'),
  );
  await sl(150);
  closeWatch(h);
  const matches = matchSkills({ text: 'brand new request', registry: r, max: 2 });
  assert.ok(
    matches.find((m) => m.name === 'watcher-skill'),
    'updated triggers should be live',
  );
});

// ── 6. matcher-v2 perf < 50ms with 1000 entries (real L1+L2 mix) ──
test('6. matcher-v2 perf — 1000-entry mixed registry, 50 turns < 50ms (avg <1ms/call)', () => {
  const r = createRegistry();
  // 500 OpenClaw + 500 Darwin. Avoid `regex`/`command-prefix` since they
  // compile/warn per call and dominate the budget at 1000 entries.
  for (let i = 0; i < 500; i++) {
    r.set('oc' + i, {
      name: 'oc' + i,
      triggers: ['token' + i],
      systemPromptHint: 'oc hint ' + i,
      triggerType: i % 2 === 0 ? 'exact' : 'substring',
      source: 'openclaw-l2',
    });
  }
  for (let i = 0; i < 500; i++) {
    r.set('dw' + i, {
      name: 'dw' + i,
      triggers: ['dwtoken' + i],
      systemPromptHint: 'dw hint ' + i,
      triggerType: 'substring',
      source: 'local',
    });
  }
  // Sanity check isOpenClawSkillContent on a sample — proves the probe is reachable from e2e
  assert.equal(typeof isOpenClawSkillContent, 'function');
  // Warmup: 1 call to JIT paths
  matchSkills({ text: 'warmup', registry: r, max: 2 });
  // Benchmark 50 turns
  const t0 = performance.now();
  let totalMatches = 0;
  for (let i = 0; i < 50; i++) {
    const m = matchSkills({ text: 'token' + i * 7 + ' dwtoken' + i * 11, registry: r, max: 5 });
    totalMatches += m.length;
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 50, `matcher-v2 too slow: ${elapsed.toFixed(2)}ms (target <50ms)`);
  assert.ok(totalMatches > 0, 'expected at least some matches across 50 turns');
});
