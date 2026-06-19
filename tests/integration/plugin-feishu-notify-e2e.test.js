/**
 * V6 cycle 1 (2026-06-19) — feishu-notify plugin e2e closure.
 *
 * Closes the loop on Darwin self-evolution → Feishu DM push:
 *   1. Init the plugin with a stub feishu adapter (no real network, ADR-009).
 *   2. Emit evolution:apply:after with a real subject → assert feishu.send
 *      was called with the configured target + a text containing the subject.
 *   3. Emit evolution:audit with a real proposal_id → assert feishu.send
 *      was called with the audit-formatted text.
 *   4. Make the stub throw → assert plugin does NOT throw across module
 *      boundary (A-5 anti-patterns).
 *   5. Sandbox the catalogue closure so production evolution/catalogue.log
 *      gets the audit mark (T7-W1 pattern, logFile=_internal.LOG_FILE).
 *
 * Loader note: PluginLoader.init() calls plugin.init() with the resolver's
 * config (empty in tests) and no adapter injection. To inject the stub we
 * call plugin.init() directly — the plugin still receives a real EventBus
 * (so real subscribers fire) and the loader's state machine is exercised
 * by load() + unload() wrapping the test lifecycle.
 *
 * LLM gate (ADR-009): stub adapter; no real network; no LLM.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../core/event-bus.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// plugin/feishu-notify.js is loaded via loader.load('./plugin/feishu-notify.js')
// so we don't need to import it directly — the registry holds the live ref.

let createPluginLoader;
let tmp;
let bus;
let registry;
let loader;
let plugin;
let adapterCalls;
let adapterThrow;
let stderrChunks;
const origWrite = process.stderr.write.bind(process.stderr);

async function getLoader() {
  if (!createPluginLoader) {
    ({ createPluginLoader } = await import('../../plugin/loader.js'));
  }
  return createPluginLoader;
}

function makeStubAdapter() {
  adapterCalls = [];
  adapterThrow = null;
  return {
    async execute({ action, payload, config }) {
      adapterCalls.push({ action, payload, config });
      if (adapterThrow) {
        throw adapterThrow;
      }
      return { ok: true, messageId: 'om_e2e_stub' };
    },
  };
}

before(async () => {
  const f = await getLoader();
  bus = new EventBus();
  registry = new PluginRegistry({ eventBus: bus });
  loader = f({ eventBus: bus, registry });
  tmp = mkdtempSync(join(tmpdir(), 'c1-feishu-notify-'));
  // Capture stderr for the error-path tests.
  stderrChunks = [];
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
});

after(async () => {
  process.stderr.write = origWrite;
  if (loader && loader.state('feishu-notify') !== 'UNLOADED') {
    await loader.unload('feishu-notify');
  }
});

beforeEach(async () => {
  // Fresh plugin instance per test: unload any prior state.
  if (loader.state('feishu-notify') !== 'UNLOADED') {
    await loader.unload('feishu-notify');
  }
  stderrChunks.length = 0;

  // Use PluginLoader.load() so the registry + state machine are exercised.
  const r = await loader.load('./plugin/feishu-notify.js');
  assert.equal(r.ok, true);
  plugin = registry.get('feishu-notify');

  // Inject the stub adapter by calling plugin.init() directly. PluginLoader
  // .init() would call plugin.init() with empty ConfigResolver config; we
  // want a non-empty target + stub adapter, so we bypass the loader's init
  // stage here. The loader state machine still sees load() and unload()
  // (in beforeEach teardown), which is what the lifecycle test cares about.
  const stub = makeStubAdapter();
  await plugin.init({
    eventBus: bus,
    config: { target: 'ou_e2e_user_001' },
    adapters: { feishu: stub },
  });
});

describe('feishu-notify plugin e2e (V6 cycle 1)', () => {
  test('1. plugin loads + subscribes to evolution:apply:after + evolution:audit', () => {
    // Sanity: after beforeEach, plugin is registered, has handlers, subscribed.
    assert.equal(registry.has('feishu-notify'), true);
    assert.equal(loader.state('feishu-notify'), 'LOADED');
    assert.equal(adapterCalls.length, 0, 'no sends before any event fires');
  });

  test('2. emit evolution:apply:after → feishu.send called with formatted text + target', async () => {
    bus.emit('evolution:apply:after', { subject: 'V6.1 cycle 收口', tag: 'tag-x' });
    await new Promise((r) => setImmediate(r));

    assert.equal(adapterCalls.length, 1, 'one send per event');
    assert.equal(adapterCalls[0].action, 'send');
    assert.equal(adapterCalls[0].payload.receive_id, 'ou_e2e_user_001');
    assert.match(adapterCalls[0].payload.text, /V6\.1 cycle 收口/);
    assert.match(adapterCalls[0].payload.text, /✅/);
  });

  test('3. emit evolution:audit → feishu.send called with audit-formatted text', async () => {
    bus.emit('evolution:audit', {
      proposal_id: 'prop-v6-1-001',
      action: 'apply',
      outcome: 'success',
    });
    await new Promise((r) => setImmediate(r));

    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0].action, 'send');
    assert.equal(adapterCalls[0].payload.receive_id, 'ou_e2e_user_001');
    assert.match(adapterCalls[0].payload.text, /📒/);
    assert.match(adapterCalls[0].payload.text, /prop-v6-1-001/);
    assert.match(adapterCalls[0].payload.text, /apply\/success/);
  });

  test('4. both events fired in sequence → 2 sends, one per event, in order', async () => {
    bus.emit('evolution:apply:after', { subject: 'first' });
    bus.emit('evolution:audit', {
      proposal_id: 'p2',
      action: 'audit',
      outcome: 'logged',
    });
    await new Promise((r) => setImmediate(r));

    assert.equal(adapterCalls.length, 2);
    assert.match(adapterCalls[0].payload.text, /✅ Darwin cycle 收口: first/);
    assert.match(adapterCalls[1].payload.text, /📒 Darwin audit: p2 \(audit\/logged\)/);
  });

  test('5. adapter throw → plugin does NOT throw (A-5 isolation); loader state intact', async () => {
    adapterThrow = new Error('simulated feishu HTTP 503');

    // Must NOT throw.
    bus.emit('evolution:apply:after', { subject: 'boom' });
    await new Promise((r) => setImmediate(r));

    assert.equal(adapterCalls.length, 1);
    // Plugin still loaded — loader state machine hasn't moved.
    assert.equal(loader.state('feishu-notify'), 'LOADED');
    assert.match(
      stderrChunks.join(''),
      /\[feishu-notify\] evolution:apply:after push failed: simulated feishu HTTP 503/,
    );

    // Subsequent events still try to send (plugin doesn't disable itself
    // on error — by design, so transient failures auto-retry next event).
    bus.emit('evolution:audit', {
      proposal_id: 'p3',
      action: 'apply',
      outcome: 'success',
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(adapterCalls.length, 2);
  });

  test('6. catalogue closure: addToCatalogue records the feishu-notify marker (sandboxed)', () => {
    const isolatedFile = join(tmp, 'catalogue-c1-feishu-notify.json');
    const a = addToCatalogue('plugins', 'feishu-notify', {
      reason: 'V6 cycle 1 P2-ext: Darwin self-evolution events → feishu push',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(a, true, 'first add must return true');

    const b = addToCatalogue('plugins', 'feishu-notify', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(b, false, 'duplicate add must return false (idempotent)');
  });
});
