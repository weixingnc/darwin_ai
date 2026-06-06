/** AnthropicProvider tests — PR 14b. Wires PR 14a1/14a2 into ProviderBase. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { IProvider } from '../provider/interface.js';
import { AnthropicProvider } from '../provider/anthropic.js';

const D = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(D, '../provider/anthropic.js');
const T = JSON.parse(
  readFileSync(resolve(D, '../provider/__fixtures__/anthropic-text-response.json'), 'utf8'),
);
const TL = JSON.parse(
  readFileSync(resolve(D, '../provider/__fixtures__/anthropic-tool-response.json'), 'utf8'),
);
const E = JSON.parse(
  readFileSync(resolve(D, '../provider/__fixtures__/anthropic-error-response.json'), 'utf8'),
);

let orig, calls;
const install = (impl) => {
  calls = [];
  globalThis.fetch = (...a) => {
    calls.push(a);
    return Promise.resolve(impl(...a));
  };
};
const ok = (b) => ({
  ok: true,
  status: 200,
  json: async () => b,
  text: async () => JSON.stringify(b),
});
const he = (s, b) => ({
  ok: false,
  status: s,
  json: async () => b,
  text: async () => JSON.stringify(b),
});
const sse = (evs) => {
  const enc = new TextEncoder();
  const buf = enc.encode(
    evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
  );
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(c) {
        c.enqueue(buf);
        c.close();
      },
    }),
  };
};
const mk = (o = {}) => {
  const bus = new EventBus();
  const p = new AnthropicProvider({
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-ant-test-123',
    defaultModel: 'claude-3-5-sonnet-20241022',
    eventBus: bus,
    ...o,
  });
  return { bus, p };
};
const hooks = () => {
  before(() => {
    orig = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = orig;
  });
};

describe('AnthropicProvider — construction', () => {
  hooks();
  test('shape + IProvider.validate + throws without eventBus', () => {
    const { p } = mk();
    assert.equal(p.name, 'anthropic');
    assert.ok(p.version);
    assert.deepEqual(p.capabilities, ['chat', 'stream', 'tool-call', 'listModels']);
    assert.equal(p._protocol.name, 'anthropic');
    assert.equal(p._streamProtocol.name, 'anthropic-stream');
    assert.deepEqual(IProvider.validate(p), { ok: true });
    assert.throws(
      () => new AnthropicProvider({ baseUrl: 'x', apiKey: 'y', defaultModel: 'z' }),
      /eventBus/,
    );
  });
});

describe('AnthropicProvider — chat()', () => {
  hooks();
  test('happy: URL/headers/body; system→top-level; tool_use→toolCalls (PR 7b path)', async () => {
    install(async () => ok(T));
    const { p } = mk();
    const r = await p.chat([
      { role: 'system', content: 'terse' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, T.content[0].text);
    assert.deepEqual(r.value.toolCalls, []);
    assert.equal(r.value.usage, T.usage);
    const [u, i] = calls[0];
    assert.equal(u, 'https://api.example.com/v1/messages');
    assert.equal(i.headers['x-api-key'], 'sk-ant-test-123');
    assert.equal(i.headers['anthropic-version'], '2023-06-01');
    const b = JSON.parse(i.body);
    assert.equal(b.model, 'claude-3-5-sonnet-20241022');
    assert.equal(b.max_tokens, 1024);
    assert.equal(b.system, 'terse');
    install(async () => ok(TL));
    const r2 = await p.chat([{ role: 'user', content: 'w?' }], {
      tools: [{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }],
    });
    assert.equal(r2.value.toolCalls[0].id, 'toolu_01ABC123');
    assert.equal(r2.value.toolCalls[0].function.name, 'get_weather');
  });
  test('errors: fetch throw + 401 + 500 + anthropic error body → ok:false, emits ERROR', async () => {
    const { p } = mk();
    const errs = [];
    p._bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => errs.push(e));
    install(async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal((await p.chat([{ role: 'user', content: 'hi' }])).ok, false);
    install(async () => he(401, E));
    assert.match(
      (await p.chat([{ role: 'user', content: 'hi' }])).error.message,
      /invalid x-api-key/,
    );
    install(async () => he(500, { type: 'error', error: { message: 'upstream' } }));
    assert.match((await p.chat([{ role: 'user', content: 'hi' }])).error.message, /upstream/);
    install(async () => ok(E));
    assert.match(
      (await p.chat([{ role: 'user', content: 'hi' }])).error.message,
      /authentication_error|invalid x-api-key/,
    );
    assert.ok(errs.length >= 3);
  });
  test('delegation: PR 14a1 buildRequest spy; chatWithTools → chat (A-3)', async () => {
    install(async () => ok(T));
    const { p } = mk();
    const b = [];
    const ob = p._protocol.buildRequest;
    p._protocol.buildRequest = async (...a) => {
      b.push(a[2]);
      return ob(...a);
    };
    await p.chat([{ role: 'user', content: 'x' }]);
    assert.equal(b[0], 'claude-3-5-sonnet-20241022');
    const spy = [];
    p.chat = async (...a) => {
      spy.push(a);
      return { ok: true, value: { content: 'x', toolCalls: [], usage: {}, raw: null } };
    };
    const r = await p.chatWithTools([{ role: 'user', content: 'hi' }], { tools: [] });
    assert.equal(r.ok, true);
    assert.equal(spy.length, 1);
  });
});

describe('AnthropicProvider — stream()', () => {
  hooks();
  test('async iterable + BEFORE/AFTER events + delegates to PR 14a2 parseStream', async () => {
    const { bus, p } = mk();
    const it = p.stream([{ role: 'user', content: 'hi' }]);
    assert.equal(typeof it[Symbol.asyncIterator], 'function');
    const evs = [];
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, (e) => e.provider === 'anthropic' && evs.push('B'));
    bus.on(EVENTS.PROVIDER_CALL_AFTER, (e) => e.provider === 'anthropic' && evs.push('A'));
    const spy = [];
    const origPS = p._streamProtocol.parseStream.bind(p._streamProtocol);
    p._streamProtocol.parseStream = async function* (...a) {
      spy.push(a);
      yield* origPS(...a);
    };
    install(async () => ok(T));
    const out = [];
    for await (const e of p.stream([{ role: 'user', content: 'hi' }])) {
      out.push(e);
    }
    assert.equal(out.at(-1).type, 'done');
    assert.ok(evs.includes('B') && evs.includes('A'));
    assert.equal(spy.length, 1);
  });
  test('SSE deltas accumulate; final done; error event yields {type:"error"} + provider:stream:error', async () => {
    const { bus, p } = mk();
    const deltas = [
      { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    install(async () => sse(deltas));
    const out = [];
    for await (const e of p.stream([{ role: 'user', content: 'hi' }])) {
      out.push(e);
    }
    assert.equal(out.at(-1).type, 'done');
    const snap = [...out].reverse().find((e) => e.type !== 'done' && e.type !== 'error');
    assert.equal(snap.content, 'Hello world');
    const sErr = [];
    bus.on('provider:stream:error', (e) => sErr.push(e));
    install(async () =>
      sse([{ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }]),
    );
    const out2 = [];
    for await (const e of p.stream([{ role: 'user', content: 'hi' }])) {
      out2.push(e);
    }
    assert.ok(out2.some((e) => e.type === 'error'));
    assert.ok(sErr.length >= 1);
  });
});

describe('AnthropicProvider — listModels/embed + _wrap + config (A-4) + hygiene', () => {
  hooks();
  test('listModels static (no fetch); embed NOT_IMPLEMENTED', async () => {
    install(async () => ok({}));
    const { p } = mk();
    const r = await p.listModels();
    assert.equal(r.ok, true);
    assert.ok(r.value.includes('claude-3-5-sonnet-20241022'));
    assert.ok(r.value.includes('claude-3-5-haiku-20241022'));
    assert.ok(r.value.includes('claude-3-opus-20240229'));
    assert.equal(calls.length, 0);
    assert.match((await p.embed('hi')).error.message, /NOT_IMPLEMENTED|not implemented/i);
  });
  test('ProviderBase._wrap: success BEFORE→AFTER matching traceId; failure BEFORE→ERROR (no AFTER)', async () => {
    const { bus, p } = mk();
    const order = [];
    let bT, aT;
    bus.on(
      EVENTS.PROVIDER_CALL_BEFORE,
      (e) => e.provider === 'anthropic' && (order.push('B'), (bT = e.traceId)),
    );
    bus.on(
      EVENTS.PROVIDER_CALL_AFTER,
      (e) => e.provider === 'anthropic' && (order.push('A'), (aT = e.traceId)),
    );
    bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => e.provider === 'anthropic' && order.push('E'));
    install(async () => ok(T));
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(order, ['B', 'A']);
    assert.equal(bT, aT);
    install(async () => {
      throw new Error('boom');
    });
    const o2 = [];
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, (e) => e.provider === 'anthropic' && o2.push('B'));
    bus.on(EVENTS.PROVIDER_CALL_AFTER, (e) => e.provider === 'anthropic' && o2.push('A'));
    bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => e.provider === 'anthropic' && o2.push('E'));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.ok(o2.includes('B') && o2.includes('E') && !o2.includes('A'));
  });
  test('fromConfig: ConfigResolver wins over process.env (A-4); apiKey→x-api-key; trailing slash stripped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'darwin-cfg-ant-'));
    const code = join(dir, 'code');
    mkdirSync(code, { recursive: true });
    writeFileSync(
      join(code, 'provider-anthropic.yaml'),
      'base_url: https://config.example\napi_key: sk-ant-from-config\ndefault_model: cfg-model\ntimeout_ms: 7777\n',
    );
    const r = new ConfigResolver({
      codePath: code,
      userPath: join(dir, 'user'),
      credPath: join(dir, '.env'),
    });
    const oK = process.env.ANTHROPIC_API_KEY,
      oB = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = 'sk-leaked';
    process.env.ANTHROPIC_BASE_URL = 'https://leaked.example';
    try {
      const p = AnthropicProvider.fromConfig({ eventBus: new EventBus(), resolver: r });
      assert.equal(p._baseUrl, 'https://config.example');
      assert.equal(p._apiKey, 'sk-ant-from-config');
      assert.equal(p._defaultModel, 'cfg-model');
      assert.equal(p._timeoutMs, 7777);
    } finally {
      if (oK === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = oK;
      }
      if (oB === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = oB;
      }
    }
    install(async () => ok(T));
    process.env.ANTHROPIC_API_KEY = 'sk-leaked';
    const { p: p2 } = mk({ apiKey: 'sk-direct' });
    await p2.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(calls[0][1].headers['x-api-key'], 'sk-direct');
    if (oK === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const { p: p3 } = mk({ baseUrl: 'https://x.example/' });
    await p3.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(calls[1][0], 'https://x.example/v1/messages');
  });
  test('hygiene: no real api_key in source; darwin.example.yaml unchanged', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.doesNotMatch(src, /sk-ant-api03-/);
    assert.doesNotMatch(src, /sk-ant-[A-Za-z0-9_-]{20,}/);
    const yaml = readFileSync(resolve(D, '../config/darwin.example.yaml'), 'utf8');
    assert.match(yaml, /provider-anthropic:/);
    assert.match(yaml, /\$\{ANTHROPIC_API_KEY\}/);
  });
});
