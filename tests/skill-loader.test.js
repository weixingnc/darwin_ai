/**
 * SkillLoader tests — TDD red→green for PR 16b.
 * 5-stage lifecycle (discover→load→validate→register→unload),
 * error isolation, event emission, multi-tenant / idempotent.
 * Style parity with tests/plugin-loader.test.js.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../core/event-bus.js';
import { SkillRegistry } from '../skill/registry.js';
import { EVENTS } from '../core/events.js';

let discoverSkills;
const DIR = mkdtempSync(join(tmpdir(), 'darwin-skill-loader-'));
const ctx = () => ({
  eventBus: new EventBus(),
  registry: new SkillRegistry({ eventBus: new EventBus() }),
});
const on = (bus, ev) => {
  const a = [];
  bus.on(ev, (_p) => a.push(_p));
  return a;
};
const valid = (n) =>
  `export default { name: '${n}', version: '0.1.0', capabilities: ['x'], validate() { return true; } };`;
const invalid = (n) =>
  `export default { name: '${n}', version: '0.1.0', capabilities: ['x'], validate() { return false; } };`;
const mk = (sub) => {
  const d = join(DIR, sub);
  mkdirSync(d);
  return d;
};

before(async () => ({ discoverSkills } = await import('../skill/loader.js')));
after(() => rmSync(DIR, { recursive: true, force: true }));

describe('loader — discoverSkills (5-stage)', () => {
  test('loads valid skill + emits SKILL_LOAD + registry has it', async () => {
    const d = mk('t1');
    writeFileSync(join(d, 'v.js'), valid('v'));
    const c = ctx();
    const ev = on(c.eventBus, EVENTS.SKILL_LOAD);
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r.length, 1);
    assert.equal(r[0].status, 'loaded');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].name, 'v');
    assert.ok(c.registry.has('v'));
  });
  test('validate() returns false → SKILL_LOAD_ERROR + status=error (no throw)', async () => {
    const d = mk('t2');
    writeFileSync(join(d, 'i.js'), invalid('i'));
    const c = ctx();
    const errs = on(c.eventBus, EVENTS.SKILL_LOAD_ERROR);
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r[0].status, 'error');
    assert.match(r[0].error, /validate/);
    assert.equal(errs.length, 1);
    assert.ok(!c.registry.has('i'));
  });
  test('duplicate name → SKILL_LOAD_ERROR + defensive (no throw)', async () => {
    const d = mk('t3');
    writeFileSync(join(d, 'a.js'), valid('dup'));
    writeFileSync(join(d, 'b.js'), valid('dup'));
    const c = ctx();
    const errs = on(c.eventBus, EVENTS.SKILL_LOAD_ERROR);
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r.filter((x) => x.status === 'loaded').length, 1);
    assert.equal(r.filter((x) => x.status === 'error').length, 1);
    assert.equal(errs.length, 1);
    assert.match(errs[0].reason, /already registered/);
  });
  test('syntax error in module → SKILL_LOAD_ERROR + status=error', async () => {
    const d = mk('t4');
    writeFileSync(join(d, 'bad.js'), 'export default { name: ;;;;');
    const c = ctx();
    const errs = on(c.eventBus, EVENTS.SKILL_LOAD_ERROR);
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r[0].status, 'error');
    assert.equal(errs.length, 1);
  });
  test('empty dir → returns []', async () => {
    const c = ctx();
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: mk('t5') });
    assert.deepEqual(r, []);
  });
  test('non-existent dir → returns [] (no throw)', async () => {
    const c = ctx();
    const r = await discoverSkills({
      eventBus: c.eventBus,
      registry: c.registry,
      dir: join(DIR, 'nope-999'),
    });
    assert.deepEqual(r, []);
  });
  test('non-.js files skipped (only .js loaded)', async () => {
    const d = mk('t6');
    writeFileSync(join(d, 'ok.js'), valid('ok'));
    writeFileSync(join(d, 'readme.md'), '# not a skill');
    writeFileSync(join(d, 'data.json'), '{}');
    const c = ctx();
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'ok');
  });
  test('multi-skill: 3 skills all load + 3 SKILL_LOAD events', async () => {
    const d = mk('t7');
    for (const n of ['m1', 'm2', 'm3']) {
      writeFileSync(join(d, `${n}.js`), valid(n));
    }
    const c = ctx();
    const ev = on(c.eventBus, EVENTS.SKILL_LOAD);
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r.filter((x) => x.status === 'loaded').length, 3);
    assert.equal(ev.length, 3);
    for (const n of ['m1', 'm2', 'm3']) {
      assert.ok(c.registry.has(n));
    }
  });
  test('idempotent: same dir twice → 2nd pass all error (no throw)', async () => {
    const d = mk('t8');
    writeFileSync(join(d, 'k.js'), valid('k'));
    const c = ctx();
    const r1 = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r1[0].status, 'loaded');
    const r2 = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r2[0].status, 'error');
    assert.match(r2[0].error, /already registered/);
  });
  test('destroy() preserved on loaded skill (lifecycle hook intact)', async () => {
    const d = mk('t9');
    writeFileSync(
      join(d, 'd.js'),
      `export default { name: 'd', version: '0.1.0', capabilities: ['x'], validate() { return true; }, destroy() {} };`,
    );
    const c = ctx();
    await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    const s = c.registry.get('d');
    assert.equal(typeof s.destroy, 'function');
  });
  test('DI surface: loaded skill is registered object (intact shape)', async () => {
    const d = mk('t10');
    writeFileSync(join(d, 'c.js'), valid('c'));
    const c = ctx();
    const r = await discoverSkills({ eventBus: c.eventBus, registry: c.registry, dir: d });
    assert.equal(r[0].status, 'loaded');
    const s = c.registry.get('c');
    assert.equal(s.name, 'c');
    assert.equal(s.version, '0.1.0');
    assert.ok(Array.isArray(s.capabilities));
    assert.equal(typeof s.validate, 'function');
  });
});
