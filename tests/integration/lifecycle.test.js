/** Lifecycle cross-module — PR 15. bootstrap emits phases, shutdown cleans up. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../core/event-bus.js';
import { ConfigResolver } from '../../core/config-resolver.js';
import { Container } from '../../core/container.js';
import { ErrorHandler } from '../../core/error-handler.js';
import { EVENTS } from '../../core/events.js';
import { bootstrap } from '../../lifecycle/bootstrap.js';
import { shutdown } from '../../lifecycle/shutdown.js';
import { FeishuAdapter } from '../../adapter/feishu.js';
import { FilesystemBackend } from '../../memory/filesystem-backend.js';
import { AnthropicProvider } from '../../provider/anthropic.js';

function mkContainer(cfg = { get: () => ({}), invalidate: () => undefined }) {
  const c = new Container();
  const bus = new EventBus();
  c.register('eventBus', () => bus);
  c.register('configResolver', () => cfg);
  c.register('errorHandler', () => ErrorHandler);
  return { c, bus };
}
function mkCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-pr15-lc-'));
  mkdirSync(join(dir, 'code'), { recursive: true });
  writeFileSync(join(dir, 'code', 'adapter-feishu.yaml'), 'app_id: ${FEISHU_APP_ID}\nwebhook_url: ${FEISHU_WEBHOOK_URL}\n');
  writeFileSync(join(dir, 'code', 'memory-default.yaml'), `backend: filesystem\npath: ${join(dir, 'mem')}\n`);
  process.env.FEISHU_APP_ID ||= 'mock_app_id'; process.env.FEISHU_WEBHOOK_URL ||= 'http://127.0.0.1:0/webhook/feishu';
  return { dir, cfg: new ConfigResolver({ codePath: join(dir, 'code'), userPath: join(dir, 'user'), credPath: join(dir, '.env') }) };
}

describe('lifecycle cross-module', () => {
  test('bootstrap: START → 5 phases → DONE → CORE_READY in order', () => {
    const { c, bus } = mkContainer();
    const order = [EVENTS.LIFECYCLE_BOOTSTRAP_START, 'lifecycle:bootstrap:init', 'lifecycle:bootstrap:config', 'lifecycle:bootstrap:container', 'lifecycle:bootstrap:registry', 'lifecycle:bootstrap:ready', EVENTS.LIFECYCLE_BOOTSTRAP_DONE, EVENTS.CORE_READY];
    const seen = [];
    for (const e of order) bus.on(e, () => seen.push(e));
    assert.equal(bootstrap({ container: c }), c);
    assert.deepEqual(seen, order);
  });

  test('bootstrap → wire 4 modules → shutdown cleans up listeners + files', async () => {
    const { dir, cfg } = mkCfg();
    const { c, bus } = mkContainer(cfg);
    bootstrap({ container: c });
    const adapter = FeishuAdapter(); const memory = FilesystemBackend();
    await adapter.init({ eventBus: bus, config: cfg });
    await memory.init({ eventBus: bus, config: cfg, container: null });
    await memory.set('persist:key', { v: 1 });
    new AnthropicProvider({ baseUrl: 'https://api.example.com', apiKey: 'mock-key-1234', defaultModel: 'claude-3-5-sonnet-20241022', eventBus: bus });
    assert.ok(bus.listenerCount(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT) > 0, 'adapter subscribed');
    const memDir = join(dir, 'mem');
    assert.ok(existsSync(memDir) && readdirSync(memDir).length > 0, 'memory file written');
    shutdown({ container: c });
    assert.equal(bus.eventNames().length, 0, 'all listeners cleared');
    assert.equal(c.size(), 0, 'container cleared');
    rmSync(dir, { recursive: true, force: true });
  });

  test('shutdown idempotency: calling twice does not throw', () => {
    const { c, bus } = mkContainer();
    bootstrap({ container: c });
    const seen = [];
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_START, () => seen.push('start'));
    bus.on(EVENTS.LIFECYCLE_SHUTDOWN_DONE, () => seen.push('done'));
    shutdown({ container: c });
    assert.deepEqual(seen, ['start', 'done']);
    shutdown({ container: c });
  });

  test('bootstrap error isolation: a phase throwing → CORE_ERROR fired, others continue', () => {
    const { c, bus } = mkContainer({ get: () => { throw new Error('boom'); }, invalidate: () => undefined });
    const errors = []; const phases = [];
    bus.on(EVENTS.CORE_ERROR, (e) => errors.push(e));
    for (const p of ['init', 'config', 'container', 'registry', 'ready']) bus.on(`lifecycle:bootstrap:${p}`, () => phases.push(p));
    bootstrap({ container: c });
    assert.deepEqual(phases, ['init', 'config', 'container', 'registry', 'ready']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.message, 'boom');
  });

  test('shutdown with no container does not throw', () => {
    assert.doesNotThrow(() => shutdown());
    assert.doesNotThrow(() => shutdown({}));
  });
});
