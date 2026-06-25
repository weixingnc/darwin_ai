/**
 * OpenAI-compatible protocol (non-streaming) tests — PR 8.
 * Covers v1 飞书 bug 6 root causes (ANTI_PATTERNS.md D-1/2/3 + 3 derivatives):
 *  #1 tool_calls format (no per-toolCall push) — buildToolCallMessage tests
 *  #2 tool_call_id not echoed back              — buildToolCallMessage tests
 *  #3 no MAX_TOOL_ROUNDS=5 limit                — MAX_TOOL_ROUNDS test
 *  #4 tool throws break round                   — "never throws" tests
 *  #5 no finish_reason log                      — console.log spy tests
 *  #6 no stop_reason log                        — _anthropicMode test
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MAX_TOOL_ROUNDS, buildToolResultMessage } from '../provider/protocol/tool-call.js';
import { EventBus } from '../core/event-bus.js';
import {
  OpenAICompatibleProtocol,
  createOpenAICompatibleProtocol,
} from '../provider/protocol/openai-compatible.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../provider/__fixtures__/openai-chat-response.json'), 'utf8'),
);
const make = () => {
  const b = new EventBus();
  return { b, p: createOpenAICompatibleProtocol({ eventBus: b }) };
};
describe('module shape', () => {
  test('class + factory exported; name=openai-compatible; 5 methods present', () => {
    const i = new OpenAICompatibleProtocol({ eventBus: new EventBus() });
    const p = createOpenAICompatibleProtocol({ eventBus: new EventBus() });
    assert.equal(i.name, 'openai-compatible');
    assert.equal(p.name, 'openai-compatible');
    for (const m of [
      'buildRequest',
      'parseResponse',
      'parseStreamChunk',
      'buildToolCallMessage',
      'parseToolCallDelta',
    ]) {
      assert.equal(typeof p[m], 'function');
    }
  });
});
describe('buildRequest', () => {
  test('happy: messages + temperature + max_tokens + model; stream:false', async () => {
    const e = await make().p.buildRequest(
      [
        { role: 'system', content: 'x' },
        { role: 'user', content: 'hi' },
      ],
      { temperature: 0.7, max_tokens: 256 },
      'gpt-4o-mini',
    );
    assert.equal(e.ok, true);
    assert.equal(e.value.stream, false);
    assert.equal(e.value.model, 'gpt-4o-mini');
    assert.equal(e.value.temperature, 0.7);
    assert.equal(e.value.max_tokens, 256);
    assert.equal(e.value.messages.length, 2);
  });
  test('empty messages: ok, empty array preserved', async () => {
    const e = await make().p.buildRequest([], {}, 'm');
    assert.equal(e.ok, true);
    assert.deepEqual(e.value.messages, []);
  });
  test('tools (v2 plain) → OpenAI wrapper; absent/empty → no tools key', async () => {
    const { p } = make();
    const tools = [{ name: 's', description: 'd', parameters: { type: 'object' } }];
    const e1 = await p.buildRequest([{ role: 'user', content: 'x' }], { tools }, 'm');
    assert.equal(e1.value.tools[0].type, 'function');
    assert.deepEqual(e1.value.tools[0].function, tools[0]);
    assert.equal(
      'tools' in (await p.buildRequest([{ role: 'user', content: 'x' }], {}, 'm')).value,
      false,
    );
    assert.equal(
      'tools' in (await p.buildRequest([{ role: 'user', content: 'x' }], { tools: [] }, 'm')).value,
      false,
    );
  });
  test('tools (already OpenAI-shaped) pass through unchanged', async () => {
    const tools = [{ type: 'function', function: { name: 'a', description: 'd', parameters: {} } }];
    const e = await make().p.buildRequest([{ role: 'user', content: 'x' }], { tools }, 'm');
    assert.deepEqual(e.value.tools, tools);
  });
  test('tool_choice string / object pass through; absent → no key', async () => {
    const { p } = make();
    assert.equal(
      (
        await p.buildRequest(
          [{ role: 'user', content: 'x' }],
          { tools: [{ name: 'a' }], tool_choice: 'auto' },
          'm',
        )
      ).value.tool_choice,
      'auto',
    );
    const choice = { type: 'function', function: { name: 'a' } };
    assert.deepEqual(
      (
        await p.buildRequest(
          [{ role: 'user', content: 'x' }],
          { tools: [{ name: 'a' }], tool_choice: choice },
          'm',
        )
      ).value.tool_choice,
      choice,
    );
    assert.equal(
      'tool_choice' in (await p.buildRequest([{ role: 'user', content: 'x' }], {}, 'm')).value,
      false,
    );
  });
  test('malformed options (throwing getter): error entry, never throws', async () => {
    const bad = {};
    Object.defineProperty(bad, 'temperature', {
      get() {
        throw new Error('boom');
      },
    });
    const e = await make().p.buildRequest([{ role: 'user', content: 'x' }], bad, 'm');
    assert.equal(e.ok, false);
    assert.match(e.error.message, /boom/);
  });
});
describe('parseResponse', () => {
  test('happy: content + usage + finish_reason (fixture)', async () => {
    const e = await make().p.parseResponse(fixture);
    assert.equal(e.ok, true);
    assert.equal(e.value.content, fixture.choices[0].message.content);
    assert.equal(e.value.finish_reason, fixture.choices[0].finish_reason);
    assert.deepEqual(e.value.usage, fixture.usage);
  });
  test('tool_calls pass through + roundtrip; missing tool_calls/usage → safe defaults; empty choices/null → error entries', async () => {
    const { p } = make();
    const tc = {
      id: 'call_xyz_001',
      type: 'function',
      function: { name: 's', arguments: '{"q":"v1 飞书"}' },
    };
    const e1 = await p.parseResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: null, tool_calls: [tc] },
        },
      ],
    });
    assert.deepEqual(e1.value.tool_calls, [tc]);
    const e2 = await p.parseResponse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    });
    assert.deepEqual(e2.value.tool_calls, []);
    assert.deepEqual(e2.value.usage, {});
    assert.equal((await p.parseResponse({ choices: [] })).ok, false);
    assert.equal((await p.parseResponse(null)).ok, false);
  });
  // V45.1: parseResponseBody now strips <think>...</think> blocks via
  // the shared splitThinkBlocks helper (lifted from the stream path).
  // Reasoning models (DeepSeek R1 / Qwen QwQ / GLM Z1 / MiniMax-M3)
  // emit `...` inline; before V45.1, the chat path shipped
  // that raw text into r.value.content, which the web UI then showed
  // to the user. After V45.1, only the visible part is returned.
  test('V45.1: strips <think>...</think> from chat path content (no leakage)', async () => {
    const { p } = make();
    const e = await p.parseResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '<think>chain of thought</think>visible answer',
          },
        },
      ],
    });
    assert.equal(e.ok, true);
    assert.equal(e.value.content, 'visible answer');
  });
  test('V45.1: leaves content untouched when there is no think block', async () => {
    const { p } = make();
    const e = await p.parseResponse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'plain reply' } }],
    });
    assert.equal(e.value.content, 'plain reply');
  });
});
describe('v1 fix #5/#6: finish_reason / stop_reason logs', () => {
  let logs, orig;
  beforeEach(() => {
    // V45.1: logFinishOrStop moved to console.error (stderr) so the
    // chat path's web/server.js#chatOnce (which captures child stdout
    // as the user-visible reply) does not leak the protocol tag into
    // the UI. The semantics of the test (one line containing the
    // finish reason) are unchanged; only the stream we spy on.
    orig = console.error;
    logs = [];
    console.error = (...a) => logs.push(a.join(' '));
  });
  afterEach(() => {
    console.error = orig;
  });
  test('parseResponse emits finish_reason=stop on OpenAI shape', async () => {
    await make().p.parseResponse(fixture);
    assert.ok(
      logs.find((l) => /finish_reason/i.test(l) && l.includes('stop')),
      JSON.stringify(logs),
    );
  });
  test('_anthropicMode=true on class instance emits stop_reason=end_turn', async () => {
    const inst = new OpenAICompatibleProtocol({ eventBus: new EventBus() });
    inst._anthropicMode = true;
    await inst.parseResponse({
      choices: [{ finish_reason: 'end_turn', message: { role: 'assistant', content: 'hi' } }],
    });
    assert.ok(
      logs.find((l) => /stop_reason/i.test(l) && l.includes('end_turn')),
      JSON.stringify(logs),
    );
  });
});
describe('buildToolCallMessage — v1 fix #1/#2', () => {
  test('v1 fix #1: 1 role:tool per call; tool_call_id preserved verbatim', async () => {
    const { p } = make();
    const e1 = await p.buildToolCallMessage(
      { id: 'call_abc', name: 's', arguments: '{}' },
      '{"hits":["a"]}',
    );
    assert.equal(e1.value.role, 'tool');
    assert.equal(e1.value.tool_call_id, 'call_abc');
    assert.equal(e1.value.content, '{"hits":["a"]}');
    // v1 fix #1: each call returns ONE role:tool message; never an assistant.
    const tcs = [
      { id: 'c1', name: 'a', arguments: '{}' },
      { id: 'c2', name: 'b', arguments: '{}' },
    ];
    const msgs = [];
    for (let i = 0; i < 2; i++) {
      msgs.push((await p.buildToolCallMessage(tcs[i], `r${i}`)).value);
    }
    assert.equal(msgs.length, 2);
    assert.ok(msgs.every((m) => m.role === 'tool'));
    // v1 fix #2: tool_call_id preserved verbatim (non-standard formats).
    assert.equal(
      (await p.buildToolCallMessage({ id: 'toolu_01HXYZ', name: 'n', arguments: '{}' }, 'ok')).value
        .tool_call_id,
      'toolu_01HXYZ',
    );
  });
  test('nested cause: JSON-serialized; null → empty string; delegation byte-identical', async () => {
    const { p } = make();
    const e1 = await p.buildToolCallMessage(
      { id: 'c1', name: 'n', arguments: '{}' },
      { ok: false, cause: { source: 'timeout' } },
    );
    assert.equal(typeof e1.value.content, 'string');
    assert.equal(JSON.parse(e1.value.content).cause.source, 'timeout');
    assert.equal(
      (await p.buildToolCallMessage({ id: 'c1', name: 'n', arguments: '{}' }, null)).value.content,
      '',
    );
    const tc = { id: 'c1', name: 'a', arguments: '{"q":1}' };
    assert.deepEqual(
      (await p.buildToolCallMessage(tc, { ok: true, value: 42 })).value,
      buildToolResultMessage(tc, { ok: true, value: 42 }),
    );
  });
});
describe('v1 fix #3: MAX_TOOL_ROUNDS=5 + 1+5 wire shape', () => {
  test('re-imports MAX_TOOL_ROUNDS=5 from tool-call.js', () => {
    assert.equal(MAX_TOOL_ROUNDS, 5);
  });
  test('1 assistant + 5 tool round assembles correctly via protocol', async () => {
    const { p } = make();
    const tcs = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: 'n', arguments: '{}' }));
    const msgs = [
      { role: 'user', content: 'q' },
      { role: 'assistant', tool_calls: tcs },
    ];
    for (let i = 0; i < 5; i++) {
      msgs.push((await p.buildToolCallMessage(tcs[i], `r${i}`)).value);
    }
    assert.equal(msgs.length, 7);
    assert.equal(msgs[1].tool_calls.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(msgs[2 + i].role, 'tool');
    }
  });
});
describe('v1 fix #4: never throws; entries always shaped', () => {
  test('all 5 methods return ErrorHandler-shaped entries; never throw under hostile input', async () => {
    const { p } = make();
    const entries = await Promise.all([
      p.buildRequest([], {}, 'm'),
      p.parseResponse({ choices: [] }),
      p.parseStreamChunk('data: x'),
      p.buildToolCallMessage({ id: 'c', name: 'n', arguments: '{}' }, 'r'),
      p.parseToolCallDelta({}),
    ]);
    for (const e of entries) {
      assert.equal(typeof e.ok, 'boolean');
      assert.ok('error' in e && 'value' in e);
      assert.equal(typeof e.timestamp, 'number');
    }
    const inputs = [null, undefined, 0, '', 's', [], {}];
    for (const bad of inputs) {
      const { p: p2 } = make();
      for (const fn of [
        'buildRequest',
        'parseResponse',
        'parseStreamChunk',
        'buildToolCallMessage',
        'parseToolCallDelta',
      ]) {
        const r = await p2[fn](bad, bad, 'm').catch((err) => ({ threw: err }));
        assert.equal(r.threw, undefined, `${fn} threw on ${String(bad)}`);
      }
    }
  });
});
describe('streaming stubs + event emission (PR 9 / ProtocolBase)', () => {
  test('parseStreamChunk / parseToolCallDelta return safe empty-delta entries', async () => {
    const { p } = make();
    assert.deepEqual((await p.parseStreamChunk('data: {"choices":[]}')).value, {
      content: '',
      tool_calls: [],
    });
    assert.deepEqual((await p.parseToolCallDelta({})).value, { content: '', tool_calls: [] });
  });
  test('buildRequest emits PROVIDER_CALL_BEFORE + AFTER; error path emits ERROR', async () => {
    const { b, p } = make();
    const ev = [];
    b.on('provider:call:before', (q) => ev.push({ t: 'before', p: q }));
    b.on('provider:call:after', (q) => ev.push({ t: 'after', p: q }));
    b.on('provider:call:error', (q) => ev.push({ t: 'error', p: q }));
    await p.buildRequest([{ role: 'user', content: 'x' }], {}, 'm');
    await p.parseResponse(null);
    // buildRequest: before+after (2). parseResponse(null): before+error (2). Total 4.
    assert.equal(ev.length, 4);
    assert.equal(ev[0].p.protocol, 'openai-compatible');
    assert.equal(ev[1].t, 'after');
    assert.equal(ev[3].t, 'error');
    assert.ok(ev[3].p.error);
  });
});

describe('embed() (V4 cycle 4: P1-B2 openai /v1/embeddings wire)', () => {
  let origFetch;
  const ok = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const httpErr = (status, body) => ({
    ok: false,
    status,
    statusText: 'Bad Request',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('happy: real wire (URL/method/Authorization/body) + parses data[i].embedding', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
    });
    const calls = [];
    globalThis.fetch = (...a) => {
      calls.push(a);
      return Promise.resolve(
        ok({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3, 0.4] },
            { object: 'embedding', index: 1, embedding: [0.5, 0.6, 0.7, 0.8] },
          ],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
      );
    };
    const r = await p.embed(['hello', 'world']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, [
      [0.1, 0.2, 0.3, 0.4],
      [0.5, 0.6, 0.7, 0.8],
    ]);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.input, ['hello', 'world']);
    assert.equal(body.model, 'text-embedding-3-small');
  });

  test('custom model + encoding_format pass through to request body', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-x',
      defaultEmbeddingModel: 'text-embedding-3-small',
    });
    let sent;
    globalThis.fetch = (_u, init) => {
      sent = JSON.parse(init.body);
      return Promise.resolve(ok({ data: [{ embedding: [0.1] }] }));
    };
    await p.embed(['hi'], { model: 'text-embedding-3-large', encoding_format: 'float' });
    assert.equal(sent.model, 'text-embedding-3-large');
    assert.equal(sent.encoding_format, 'float');
  });

  test('error isolation: HTTP 400 from server → ok:false, never throws', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-x',
    });
    globalThis.fetch = () => Promise.resolve(httpErr(400, { error: { message: 'invalid input' } }));
    const r = await p.embed(['bad']);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /HTTP 400/);
  });

  test('error isolation: fetch throws → ok:false, never throws', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-x',
    });
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const r = await p.embed(['x']);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /ECONNREFUSED/);
  });

  test('error isolation: malformed response (no data[]) → ok:false, never throws', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-x',
    });
    globalThis.fetch = () => Promise.resolve(ok({ object: 'list' }));
    const r = await p.embed(['x']);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /data is empty/);
  });

  test('missing baseUrl → ok:false, never throws (constructor guard)', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({ eventBus: bus, apiKey: 'sk-x' });
    const r = await p.embed(['x']);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /baseUrl is required/);
  });

  test('empty texts array → ok:false, never throws (validation)', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-x',
    });
    const r = await p.embed([]);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /texts must be non-empty/);
  });

  test('events: PROVIDER_CALL_BEFORE/AFTER fire on embed() (phase=embed)', async () => {
    const bus = new EventBus();
    const p = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-x',
    });
    const ev = [];
    bus.on('provider:call:before', (q) => ev.push({ t: 'before', p: q.phase }));
    bus.on('provider:call:after', (q) => ev.push({ t: 'after', p: q.phase }));
    bus.on('provider:call:error', (q) => ev.push({ t: 'error', p: q.phase }));
    globalThis.fetch = () => Promise.resolve(ok({ data: [{ embedding: [0.1] }] }));
    await p.embed(['x']);
    assert.deepEqual(
      ev.map((e) => `${e.t}:${e.p}`),
      ['before:embed', 'after:embed'],
    );
  });
});
