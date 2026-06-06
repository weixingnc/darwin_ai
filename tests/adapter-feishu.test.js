/**
 * FeishuAdapter tests — TDD red→green for PR 12b.
 * Covers: IAdapter contract; init via ConfigResolver (A-4: no process.env);
 * http webhook (url_verification / event.message / unknown); outbound
 * (MESSAGE_OUT → fetch, error path); stop idempotency; destroy cleanup;
 * error isolation; hygiene (no real secrets in source).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { AdapterRegistry } from '../adapter/registry.js';
import { IAdapter } from '../adapter/interface.js';
import { FeishuAdapter } from '../adapter/feishu.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* Fresh ConfigResolver in a tmpdir (hermetic; mirrors config/darwin.example.yaml's block). */
function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-feishu-cfg-'));
  mkdirSync(join(dir, 'code'), { recursive: true });
  writeFileSync(
    join(dir, 'code', 'adapter-feishu.yaml'),
    [
      'app_id: ${FEISHU_APP_ID}',
      'app_secret: ${FEISHU_APP_SECRET}',
      'verification_token: ${FEISHU_VERIFICATION_TOKEN}',
      'encrypt_key: ${FEISHU_ENCRYPT_KEY}',
      'webhook_url: ${FEISHU_WEBHOOK_URL}',
      '',
    ].join('\n'),
  );
  return new ConfigResolver({
    codePath: join(dir, 'code'),
    userPath: join(dir, 'user'),
    credPath: join(dir, '.env'),
  });
}

/* fetch spy */
let origFetch, fetchSpy;
const setupFetch = () => {
  origFetch = globalThis.fetch;
  fetchSpy = {
    calls: [],
    impl: () =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  };
  globalThis.fetch = (url, init) => {
    fetchSpy.calls.push([url, init]);
    return Promise.resolve(fetchSpy.impl(url, init));
  };
};
const teardownFetch = () => {
  globalThis.fetch = origFetch;
};
const okResp = (body = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/* POST JSON to a running http server */
function postJson(server, path, payload) {
  const { port } = server.address();
  const data = JSON.stringify(payload);
  return new Promise((resolveP, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolveP({ status: res.statusCode, body: chunks }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
const tick = () => new Promise((r) => setImmediate(r));

/* ── IAdapter contract ─────────────────────────────────────────── */
describe('FeishuAdapter — IAdapter contract', () => {
  test('name=feishu, version=1.0.0, capabilities include message:in/out + webhook + event', () => {
    const a = FeishuAdapter();
    assert.equal(a.name, 'feishu');
    assert.equal(a.version, '1.0.0');
    for (const cap of ['message:in', 'message:out', 'webhook', 'event']) {
      assert.ok(a.capabilities.includes(cap));
    }
  });
  test('exposes init/destroy/start/stop/handleEvent as functions', () => {
    for (const m of ['init', 'destroy', 'start', 'stop', 'handleEvent']) {
      assert.equal(typeof FeishuAdapter()[m], 'function');
    }
  });
  test('IAdapter.validate passes for a fresh factory output', () => {
    assert.equal(IAdapter.validate(FeishuAdapter()).ok, true);
  });
});

/* ── init: ConfigResolver (A-4) ────────────────────────────────── */
describe('FeishuAdapter — init (A-4: ConfigResolver, not process.env)', () => {
  test('init reads config via ConfigResolver.get("adapter-feishu")', () => {
    const cfg = makeCfg();
    const origGet = cfg.get.bind(cfg);
    let gotName = null;
    cfg.get = (m) => {
      gotName = m;
      return origGet(m);
    };
    const adapter = FeishuAdapter();
    adapter.init({ eventBus: new EventBus(), config: cfg, container: null });
    assert.equal(gotName, 'adapter-feishu');
    assert.equal(typeof adapter._resolvedConfig.app_id, 'string');
  });
  test('init does not mutate process.env for feishu vars', () => {
    const cfg = makeCfg();
    const before = {
      A: process.env.FEISHU_APP_ID,
      S: process.env.FEISHU_APP_SECRET,
      T: process.env.FEISHU_VERIFICATION_TOKEN,
    };
    FeishuAdapter().init({ eventBus: new EventBus(), config: cfg, container: null });
    assert.equal(process.env.FEISHU_APP_ID, before.A);
    assert.equal(process.env.FEISHU_APP_SECRET, before.S);
    assert.equal(process.env.FEISHU_VERIFICATION_TOKEN, before.T);
  });
  test('hygiene: source has no real app_id / app_secret / token literals', () => {
    const src = readFileSync(resolve(__dirname, '../adapter/feishu.js'), 'utf8');
    assert.equal(/cli_[A-Za-z0-9]{10,}/.test(src), false);
    const noPlaceholders = src.replace(/\$\{FEISHU_[^}]+\}/g, '');
    assert.equal(/['"][A-Za-z0-9_-]{32,}['"]/.test(noPlaceholders), false);
  });
  test('init never throws (defensive)', () => {
    const cfg = makeCfg();
    assert.doesNotThrow(() =>
      FeishuAdapter().init({ eventBus: new EventBus(), config: cfg, container: null }),
    );
  });
});

/* ── start: http server + url_verification ────────────────────── */
describe('FeishuAdapter — start + url_verification', () => {
  let bus, cfg, adapter;
  beforeEach(async () => {
    setupFetch();
    bus = new EventBus();
    cfg = makeCfg();
    adapter = FeishuAdapter();
    await adapter.init({ eventBus: bus, config: cfg, container: null });
    await adapter.start();
  });
  afterEach(async () => {
    await adapter.stop();
    await adapter.destroy();
    teardownFetch();
  });
  test('start() opens a Node http server on a real port', () => {
    assert.ok(adapter._server);
    const addr = adapter._server.address();
    assert.equal(typeof addr.port, 'number');
    assert.ok(addr.port > 0);
  });
  test('url_verification → echoes challenge as text/plain', async () => {
    const r = await postJson(adapter._server, '/webhook/feishu', {
      type: 'url_verification',
      challenge: 'abc-123',
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /abc-123/);
  });
});

/* ── event.message inbound ─────────────────────────────────────── */
describe('FeishuAdapter — event.message → ADAPTER_FEISHU_MESSAGE_IN', () => {
  let bus, cfg, adapter;
  beforeEach(async () => {
    setupFetch();
    bus = new EventBus();
    cfg = makeCfg();
    adapter = FeishuAdapter();
    await adapter.init({ eventBus: bus, config: cfg, container: null });
    await adapter.start();
  });
  afterEach(async () => {
    await adapter.stop();
    await adapter.destroy();
    teardownFetch();
  });
  test('event.message → emits ADAPTER_FEISHU_MESSAGE_IN with {user,text,messageId}', async () => {
    const got = [];
    bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, (p) => got.push(p));
    const r = await postJson(adapter._server, '/webhook/feishu', {
      type: 'event',
      event: {
        type: 'message',
        message: { message_id: 'om_test_1', content: { text: 'hello darwin' } },
        sender: { sender_id: { open_id: 'ou_user_42' } },
      },
      token: 'vtok_test',
    });
    assert.equal(r.status, 200);
    await tick();
    assert.equal(got.length, 1);
    assert.equal(got[0].user, 'ou_user_42');
    assert.equal(got[0].text, 'hello darwin');
    assert.equal(got[0].messageId, 'om_test_1');
  });
  test('unknown event type → returns 200, no MESSAGE_IN emitted', async () => {
    const got = [];
    bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, (p) => got.push(p));
    const r = await postJson(adapter._server, '/webhook/feishu', {
      type: 'event',
      event: { type: 'some-future-type' },
    });
    assert.equal(r.status, 200);
    await tick();
    assert.equal(got.length, 0);
  });
});

/* ── outbound: MESSAGE_OUT → fetch ─────────────────────────────── */
describe('FeishuAdapter — outbound (MESSAGE_OUT → fetch)', () => {
  let bus, cfg, adapter;
  beforeEach(async () => {
    setupFetch();
    bus = new EventBus();
    cfg = makeCfg();
    adapter = FeishuAdapter();
    await adapter.init({ eventBus: bus, config: cfg, container: null });
    await adapter.start();
    fetchSpy.impl = () =>
      Promise.resolve(okResp({ code: 0, msg: 'success', data: { message_id: 'om_out_1' } }));
  });
  afterEach(async () => {
    await adapter.stop();
    await adapter.destroy();
    teardownFetch();
  });
  test('emitting MESSAGE_OUT triggers fetch to Feishu send-message endpoint', async () => {
    bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, { userId: 'ou_user_42', text: 'hi back' });
    await tick();
    await tick();
    assert.ok(fetchSpy.calls.length >= 1);
    const [url, init] = fetchSpy.calls[0];
    assert.match(String(url), /open-apis\/im\/v1\/messages/);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.receive_id, 'ou_user_42');
    assert.equal(body.msg_type, 'text');
    assert.match(body.content, /hi back/);
  });
  test('fetch throw → emits ADAPTER_FEISHU_ERROR, NEVER throws', async () => {
    fetchSpy.impl = () => {
      throw new TypeError('feishu-api-down');
    };
    const errs = [];
    bus.on(EVENTS.ADAPTER_FEISHU_ERROR, (p) => errs.push(p));
    assert.doesNotThrow(() =>
      bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, { userId: 'ou_x', text: 'x' }),
    );
    await tick();
    await tick();
    assert.equal(errs.length, 1);
    assert.match(errs[0].message || '', /feishu-api-down|send failed|fetch/);
  });
});

/* ── stop / destroy idempotency ──────────────────────────────── */
describe('FeishuAdapter — stop() + destroy()', () => {
  let bus, cfg, adapter;
  beforeEach(() => {
    bus = new EventBus();
    cfg = makeCfg();
    adapter = FeishuAdapter();
  });
  afterEach(async () => {
    try {
      await adapter.stop();
    } catch {
      /* idempotent */
    }
    await adapter.destroy();
  });
  test('stop() called twice does not throw', async () => {
    await adapter.init({ eventBus: bus, config: cfg, container: null });
    await adapter.start();
    await adapter.stop();
    await assert.doesNotReject(adapter.stop());
  });
  test('stop() without start() does not throw', async () => {
    await adapter.init({ eventBus: bus, config: cfg, container: null });
    await assert.doesNotReject(adapter.stop());
  });
  test('destroy() removes the MESSAGE_OUT subscription', async () => {
    setupFetch();
    try {
      await adapter.init({ eventBus: bus, config: cfg, container: null });
      await adapter.start();
      fetchSpy.impl = () => Promise.resolve(okResp({ code: 0 }));
      const calls = [];
      bus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, () => calls.push('ext'));
      bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, { userId: 'ou_x', text: 'x' });
      await tick();
      await tick();
      assert.ok(fetchSpy.calls.length >= 1, 'pre-destroy: internal subscriber triggered fetch');
      assert.equal(calls.length, 1);
      const preCount = fetchSpy.calls.length;
      await adapter.destroy();
      bus.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, { userId: 'ou_y', text: 'y' });
      await tick();
      await tick();
      assert.equal(calls.length, 2, 'external subscriber still fires (sanity)');
      assert.equal(
        fetchSpy.calls.length,
        preCount,
        'post-destroy: no new fetch (internal sub removed)',
      );
    } finally {
      teardownFetch();
    }
  });
});

/* ── error isolation ─────────────────────────────────────────── */
describe('FeishuAdapter — error isolation (loader pattern)', () => {
  test('throwing init() does not break sibling adapters in registry', () => {
    const bus = new EventBus();
    const cfg = makeCfg();
    const reg = new AdapterRegistry({ eventBus: bus });
    reg.register({
      name: 'webhook',
      version: '1.0.0',
      capabilities: ['webhook'],
      init() {},
      destroy() {},
      start() {},
      stop() {},
      handleEvent() {},
    });
    const bad = {
      name: 'bad',
      version: '0.0.1',
      capabilities: ['message:in'],
      init() {
        throw new Error('init kaboom');
      },
      destroy() {},
      start() {},
      stop() {},
      handleEvent() {},
    };
    reg.register(bad);
    const wrapped = (fn) => {
      try {
        fn();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    };
    const r = wrapped(() => bad.init({ eventBus: bus, config: cfg, container: null }));
    assert.equal(r.ok, false);
    assert.match(r.message, /kaboom/);
    assert.equal(reg.has('webhook'), true);
    assert.equal(reg.has('bad'), true);
  });
});
