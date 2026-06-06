/** Full-stack integration — PR 15. Real: EventBus/Feishu/Filesystem/Anthropic/logger. Mocked: fetch+http. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
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

const RESP = { id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'end_turn',
  model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'text', text: 'hi from claude' }] };

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-pr15-'));
  mkdirSync(join(dir, 'code'), { recursive: true });
  writeFileSync(join(dir, 'code', 'adapter-feishu.yaml'),
    'app_id: ${FEISHU_APP_ID}\nwebhook_url: ${FEISHU_WEBHOOK_URL}\n');
  writeFileSync(join(dir, 'code', 'memory-default.yaml'),
    `backend: filesystem\npath: ${join(dir, 'mem')}\n`);
  process.env.FEISHU_APP_ID ||= 'mock_app_id';
  process.env.FEISHU_WEBHOOK_URL ||= 'http://127.0.0.1:0/webhook/feishu';
  return { dir, cfg: new ConfigResolver({ codePath: join(dir, 'code'), userPath: join(dir, 'user'), credPath: join(dir, '.env') }) };
}

describe('full-stack', () => {
  let bus, cfg, dir, adapter, memory, provider, loader, webhookServer, origFetch, fetchCalls;

  before(async () => {
    ({ dir, cfg } = makeCfg());
    bus = new EventBus();
    adapter = FeishuAdapter();
    memory = FilesystemBackend();
    await adapter.init({ eventBus: bus, config: cfg });
    await memory.init({ eventBus: bus, config: cfg, container: null });
    await memory.set('ctx:u1', { history: [] });
    provider = new AnthropicProvider({
      baseUrl: 'https://api.example.com', apiKey: 'mock-key-1234',
      defaultModel: 'claude-3-5-sonnet-20241022', eventBus: bus });
    webhookServer = createServer((_q, r) => { r.statusCode = 200; r.end('ok'); });
    await new Promise((r) => webhookServer.listen(0, '127.0.0.1', r));
    origFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: init?.body });
      if (String(url).includes('api.example.com')) {
        return { ok: true, status: 200, json: async () => RESP, text: async () => JSON.stringify(RESP) };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    loader = createPluginLoader({ eventBus: bus, registry: new PluginRegistry({ eventBus: bus }) });
    await loader.load('./plugin/__example__/logger.js');
    await loader.init('logger');
    await loader.enable('logger');
  });

  after(async () => {
    globalThis.fetch = origFetch;
    if (webhookServer) {await new Promise((r) => webhookServer.close(() => r()));}
    bus.clear();
    if (dir) {rmSync(dir, { recursive: true, force: true });}
  });

  test('hygiene: no real app_id / api_key in this test file', () => {
    const src = readFileSync(new URL('./full-stack.test.js', import.meta.url), 'utf8');
    assert.ok(!/cli_[a-z0-9]{16,}/i.test(src));
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src));
  });

  test('end-to-end: MESSAGE_IN → memory get → provider chat → MESSAGE_OUT', async () => {
    const ctxSeen = new Promise((rp) => { bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, async (p) => {
      rp({ p, ctx: (await memory.get('ctx:u1')) || {} });
    }); });
    const outSeen = new Promise((rp) => { bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, async (p) => {
      const entry = await provider.chat({ model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: p.text }] });
      bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, { text: entry.value.content, userId: p.user });
      rp(entry);
    }); });
    bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, (pl) => adapter.sendTextMessage(pl?.text, pl?.userId));
    bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, { user: 'u1', text: 'hello darwin', messageId: 'm1' });
    const [{ p, ctx }, entry] = await Promise.all([ctxSeen, outSeen]);
    assert.equal(p.text, 'hello darwin');
    assert.deepEqual(ctx, { history: [] });
    assert.equal(entry.value.content, 'hi from claude');
    for (let i = 0; i < 20 && !fetchCalls.find((c) => c.url.includes('open.feishu.cn')); i++) {
      await new Promise((rs) => setTimeout(rs, 25));
    }
    const fc = fetchCalls.find((c) => c.url.includes('open.feishu.cn'));
    assert.ok(fc, 'feishu outbound fetch called');
    assert.equal(JSON.parse(fc.body).receive_id, 'u1');
  });

  test('error isolation: async handler throw does not break sibling handlers', async () => {
    let good = false;
    bus.on('it:err', async () => { throw new Error('boom'); });
    bus.on('it:err', async () => { good = true; });
    bus.emit('it:err', {});
    await new Promise((r) => setImmediate(r));
    assert.equal(good, true);
  });
});
