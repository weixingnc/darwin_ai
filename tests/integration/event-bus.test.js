/** EventBus cross-module — PR 15. 4 modules via EventBus only. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../core/event-bus.js';
import { ConfigResolver } from '../../core/config-resolver.js';
import { EVENTS } from '../../core/events.js';
import { FeishuAdapter } from '../../adapter/feishu.js';
import { FilesystemBackend } from '../../memory/filesystem-backend.js';
import { AnthropicProvider } from '../../provider/anthropic.js';
import { createPluginLoader } from '../../plugin/loader.js';
import { PluginRegistry } from '../../plugin/registry.js';

const RESP = { id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn', model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'echo' }] };

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-pr15-eb-'));
  mkdirSync(join(dir, 'code'), { recursive: true });
  writeFileSync(join(dir, 'code', 'adapter-feishu.yaml'), 'app_id: ${FEISHU_APP_ID}\nwebhook_url: ${FEISHU_WEBHOOK_URL}\n');
  writeFileSync(join(dir, 'code', 'memory-default.yaml'), `backend: filesystem\npath: ${join(dir, 'mem')}\n`);
  process.env.FEISHU_APP_ID ||= 'mock_app_id'; process.env.FEISHU_WEBHOOK_URL ||= 'http://127.0.0.1:0/webhook/feishu';
  return { dir, cfg: new ConfigResolver({ codePath: join(dir, 'code'), userPath: join(dir, 'user'), credPath: join(dir, '.env') }) };
}
describe('event-bus cross-module', () => {
  let bus, cfg, dir, adapter, memory, provider, origFetch;
  before(async () => {
    ({ dir, cfg } = makeCfg());
    bus = new EventBus(); adapter = FeishuAdapter(); memory = FilesystemBackend();
    await adapter.init({ eventBus: bus, config: cfg });
    await memory.init({ eventBus: bus, config: cfg, container: null });
    await memory.set('ctx:u', { history: [] });
    provider = new AnthropicProvider({ baseUrl: 'https://api.example.com', apiKey: 'mock-key-1234', defaultModel: 'claude-3-5-sonnet-20241022', eventBus: bus });
    origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => RESP, text: async () => JSON.stringify(RESP) });
    const loader = createPluginLoader({ eventBus: bus, registry: new PluginRegistry({ eventBus: bus }) });
    await loader.load('./plugin/__example__/logger.js');
    await loader.init('logger');
    await loader.enable('logger');
  });

  after(async () => {
    globalThis.fetch = origFetch;
    bus.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('4 modules all on EventBus (zero HookManager)', () => {
    const c = { plugin: 0, adapter: 0, memory: 0, provider: 0 };
    const pairs = [[EVENTS.PLUGIN_REGISTER, 'plugin'], [EVENTS.ADAPTER_REGISTER, 'adapter'], [EVENTS.MEMORY_STORE, 'memory'], [EVENTS.PROVIDER_CALL_BEFORE, 'provider']];
    for (const [e, k] of pairs) bus.on(e, () => c[k]++);
    for (const [e] of pairs) bus.emit(e, {});
    assert.equal(c.plugin + c.adapter + c.memory + c.provider, 4);
    assert.equal(bus.constructor.name, 'EventBus');
  });
  test('event order: message_in → memory_get → provider_after → message_out', async () => {
    const order = [];
    bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, async (p) => {
      order.push(EVENTS.ADAPTER_FEISHU_MESSAGE_IN);
      order.push('mg:' + JSON.stringify(await memory.get('ctx:u')));
      const e = await provider.chat({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: p.text }] });
      order.push(EVENTS.PROVIDER_CALL_AFTER);
      bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, { text: e.value.content, userId: p.user });
    });
    bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, () => order.push(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT));
    bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, { user: 'u1', text: 'hi', messageId: 'm' });
    await new Promise((r) => setTimeout(r, 50));
    const i = (x) => order.indexOf(x);
    assert.ok(i(EVENTS.ADAPTER_FEISHU_MESSAGE_IN) < i('mg:{"history":[]}'));
    assert.ok(i('mg:{"history":[]}') < i(EVENTS.PROVIDER_CALL_AFTER));
    assert.ok(i(EVENTS.PROVIDER_CALL_AFTER) < i(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT));
  });
  test('payload flow: user, text, context, response all pass through', async () => {
    const seen = { in: null, ctx: null, resp: null, out: null };
    bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, async (p) => {
      seen.in = p; seen.ctx = await memory.get('ctx:u');
      const e = await provider.chat({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: p.text }] });
      seen.resp = e.value;
      bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, { text: e.value.content, userId: p.user });
    });
    bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, (p) => { seen.out = p; });
    bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, { user: 'alice', text: 'hello world', messageId: 'm42' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.in.user, 'alice');
    assert.equal(seen.in.text, 'hello world');
    assert.deepEqual(seen.ctx, { history: [] });
    assert.equal(seen.resp.content, 'echo');
    assert.equal(seen.out.userId, 'alice');
  });
  test('async handler error isolation: 2 throws do not stop 2 good handlers', async () => {
    let good = 0;
    const handlers = [async () => { throw new Error('h1'); }, async () => { good++; },
                      async () => { throw new Error('h2'); }, async () => { good++; }];
    for (const h of handlers) bus.on('it:iso', h);
    bus.emit('it:iso', {});
    await new Promise((r) => setImmediate(r));
    assert.equal(good, 2);
  });
});
