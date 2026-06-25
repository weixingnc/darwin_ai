/** OpenAI-compatible streaming (PR 10) tests — TDD: tests first, impl after red.
 *  Coverage: SSE parse + accumulation, [DONE], edge cases, stream() events,
 *  fetch failure, v1 飞书 1-assistant+N-role:tool invariant, MAX_TOOL_ROUNDS. */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { MAX_TOOL_ROUNDS } from '../provider/protocol/tool-call.js';
import { OpenAICompatibleProvider } from '../provider/openai-compatible.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SSE_FIXTURE = readFileSync(
  resolve(__dirname, '../provider/__fixtures__/openai-stream-chunks.txt'),
  'utf8',
);

/* Build a fetch-Response-shaped object whose body is a real ReadableStream. */
function sseResponse(events) {
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream({
      start(ctl) {
        for (const e of events) {
          ctl.enqueue(enc.encode(e));
        }
        ctl.close();
      },
    }),
  };
}

let origFetch;
const setup = () => {
  origFetch = globalThis.fetch;
};
const teardown = () => {
  globalThis.fetch = origFetch;
};
const installFetch = (impl) => {
  globalThis.fetch = (...a) => Promise.resolve(impl(...a));
};
const makeProvider = () => {
  const bus = new EventBus();
  const p = new OpenAICompatibleProvider({
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    defaultModel: 'gpt-4o-mini',
    eventBus: bus,
  });
  return { bus, p };
};
const loadProto = async () =>
  (await import('../provider/protocol/openai-compatible-stream.js')).OpenAICompatibleStreamProtocol;
const newProto = async () => new (await loadProto())({ eventBus: new EventBus() });

describe('SSE parseStream() — happy path', () => {
  test('parses fixture: 6 data chunks + DONE → 7 yields, accumulates content+tool_calls', async () => {
    const proto = await newProto();
    const evs = [];
    for await (const ev of proto.parseStream(sseResponse([SSE_FIXTURE]))) {
      evs.push(ev);
    }
    assert.equal(evs.length, 7);
    assert.equal(evs[evs.length - 1].type, 'done');
    assert.ok(
      evs.find((e) => e.content === 'Hello'),
      'yield chunk with content="Hello"',
    );
    assert.ok(
      evs.find((e) => e.content === 'Hello world'),
      'accumulate to "Hello world"',
    );
    const final = evs.find((e) => e.finishReason === 'tool_calls');
    assert.ok(final);
    assert.equal(final.toolCalls.length, 1);
    assert.equal(final.toolCalls[0].function.name, 'get_weather');
  });
  test('module shape: class exported, name=openai-compatible-stream', async () => {
    const mod = await import('../provider/protocol/openai-compatible-stream.js');
    assert.equal(typeof mod.OpenAICompatibleStreamProtocol, 'function');
    const proto = await newProto();
    assert.equal(proto.name, 'openai-compatible-stream');
    assert.equal(typeof proto.parseStream, 'function');
    assert.equal(typeof proto.buildStreamRequest, 'function');
  });
});

describe('SSE parseStream() — edge cases', () => {
  test('empty stream → 0 yields, no throws', async () => {
    const proto = await newProto();
    const evs = [];
    for await (const ev of proto.parseStream(sseResponse(['']))) {
      evs.push(ev);
    }
    assert.equal(evs.length, 0);
  });
  test('single chunk finish_reason=stop → 1 yield + done', async () => {
    const proto = await newProto();
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const evs = [];
    for await (const ev of proto.parseStream(sseResponse([sse]))) {
      evs.push(ev);
    }
    assert.equal(evs.length, 2);
    assert.equal(evs[0].content, 'hi');
    assert.equal(evs[0].finishReason, 'stop');
    assert.equal(evs[1].type, 'done');
  });
  test('SSE event split across 3 byte enqueues → still parses', async () => {
    const proto = await newProto();
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const evs = [];
    for await (const ev of proto.parseStream(
      sseResponse([sse.slice(0, 10), sse.slice(10, 40), sse.slice(40)]),
    )) {
      evs.push(ev);
    }
    assert.equal(evs.length, 2);
    assert.equal(evs[0].content, 'x');
  });
  test('malformed JSON → yield {type:"error", error}, then done, no throw', async () => {
    const proto = await newProto();
    const sse = 'data: {not-json}\n\ndata: [DONE]\n\n';
    const evs = [];
    for await (const ev of proto.parseStream(sseResponse([sse]))) {
      evs.push(ev);
    }
    assert.equal(evs.length, 2);
    assert.equal(evs[0].type, 'error');
    assert.equal(evs[1].type, 'done');
  });
});

describe('OpenAICompatibleProvider — stream()', () => {
  beforeEach(setup);
  afterEach(teardown);
  test('returns async iterable; drains ≥6 events from fixture', async () => {
    installFetch(() => sseResponse([SSE_FIXTURE]));
    const { p } = makeProvider();
    const result = p.stream([{ role: 'user', content: 'hi' }]);
    assert.equal(typeof result[Symbol.asyncIterator], 'function');
    const evs = [];
    for await (const e of result) {
      evs.push(e);
    }
    assert.ok(evs.length >= 6, `expected ≥6, got ${evs.length}`);
  });
  test('emits PROVIDER_CALL_BEFORE/AFTER with phase=stream; fetch body has stream:true', async () => {
    installFetch(() => sseResponse([SSE_FIXTURE]));
    const { bus, p } = makeProvider();
    const ev = [];
    bus.on(
      EVENTS.PROVIDER_CALL_BEFORE,
      (e) => e.provider === 'openai-compatible' && ev.push({ k: 'B', phase: e.phase }),
    );
    bus.on(
      EVENTS.PROVIDER_CALL_AFTER,
      (e) => e.provider === 'openai-compatible' && ev.push({ k: 'A', phase: e.phase }),
    );
    let url, init;
    const orig = globalThis.fetch;
    globalThis.fetch = (u, i) => {
      url = u;
      init = i;
      return orig(u, i);
    };
    for await (const _ of p.stream([{ role: 'user', content: 'hi' }])) {
      void _;
    }
    assert.equal(url, 'https://api.example.com/v1/chat/completions');
    assert.equal(JSON.parse(init.body).stream, true);
    assert.deepEqual(ev, [
      { k: 'B', phase: 'stream' },
      { k: 'A', phase: 'stream' },
    ]);
  });
  test('fetch throw → emits PROVIDER_CALL_ERROR + yields {type:"error"}', async () => {
    globalThis.fetch = () => {
      throw new TypeError('stream-conn-down');
    };
    const { bus, p } = makeProvider();
    const errs = [];
    bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => e.provider === 'openai-compatible' && errs.push(e));
    const evs = [];
    for await (const e of p.stream([{ role: 'user', content: 'hi' }])) {
      evs.push(e);
    }
    assert.equal(errs.length, 1);
    assert.equal(errs[0].phase, 'stream');
    assert.equal(evs[0].type, 'error');
    assert.match(evs[0].error.message, /stream-conn-down/);
  });
});

describe('v1 飞书 bug 6 coverage (D-1/2/3 derivatives)', () => {
  test('D-1: buildStreamRequest preserves 1 assistant + N role:tool shape', async () => {
    const proto = await newProto();
    const messages = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":30}' },
    ];
    const entry = await proto.buildStreamRequest(messages, {}, 'gpt-4o-mini');
    assert.equal(entry.ok, true);
    assert.equal(entry.value.stream, true);
    const aMsgs = entry.value.messages.filter((m) => m.role === 'assistant');
    const tMsgs = entry.value.messages.filter((m) => m.role === 'tool');
    assert.equal(aMsgs.length, 1, 'exactly 1 assistant turn (v1 fix #1)');
    assert.equal(tMsgs.length, 1, '1 role:tool per tool_call (v1 fix #2)');
    assert.equal(tMsgs[0].tool_call_id, 'c1');
  });
  test('D-2: MAX_TOOL_ROUNDS=5 still exported (regression guard)', () => {
    assert.equal(MAX_TOOL_ROUNDS, 5);
  });
});
/** V45: reasoning_content capture + <think>...</think> inline block stripping. */
const collect = async (gen) => {
  const out = [];
  for await (const e of gen) {
    out.push(e);
  }
  return out;
};

describe('V45: delta.reasoning_content capture', () => {
  test('reasoning_content field is captured in state.reasoning and yielded', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"let me think"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":" more thoughts","content":"!"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const chunks = evs.filter((e) => e.content !== undefined || e.reasoning !== undefined);
    assert.ok(chunks.length >= 3, 'at least 3 chunk events');
    // Final visible content
    const last = chunks[chunks.length - 1];
    assert.equal(last.content, 'answer!');
    // Final reasoning = "let me think" + " more thoughts"
    assert.equal(last.reasoning, 'let me think more thoughts');
    // done is yielded at the end
    assert.equal(evs[evs.length - 1].type, 'done');
  });

  test('no reasoning_content field → reasoning stays empty', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const last = evs.find((e) => e.content !== undefined);
    assert.equal(last.content, 'hi');
    assert.equal(last.reasoning, '');
  });
});

describe('V45: <think>...</think> inline block stripping', () => {
  test('single complete think block → stripped from content, routed to reasoning', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"<think>"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"thinking hard"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"</think>"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" final answer"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const last = evs.filter((e) => e.content !== undefined).pop();
    assert.equal(last.content, ' final answer', 'visible content has no think block');
    assert.equal(last.reasoning, 'thinking hard', 'think block routed to reasoning');
  });

  test('think block arriving in single chunk → still stripped', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"<think>internal</think>visible"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const last = evs.filter((e) => e.content !== undefined).pop();
    assert.equal(last.content, 'visible');
    assert.equal(last.reasoning, 'internal');
  });

  test('think block split across chunks (open in N, close in N+1) → no leak', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"before <think>think"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" more</think> after"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const last = evs.filter((e) => e.content !== undefined).pop();
    assert.equal(last.content, 'before  after', 'visible content has only non-think text');
    assert.equal(last.reasoning, 'think more', 'reasoning = full think content');
  });

  test('unclosed <think> at end of stream → treated as reasoning (no partial leak)', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok <think>still thinking"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const last = evs.filter((e) => e.content !== undefined).pop();
    assert.equal(last.content, 'ok ', 'visible content has no partial think block');
    assert.equal(last.reasoning, 'still thinking', 'unclosed think routed to reasoning');
  });

  test('no think blocks → content unchanged (regression guard)', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const last = evs.filter((e) => e.content !== undefined).pop();
    assert.equal(last.content, 'Hello world');
    assert.equal(last.reasoning, '');
  });

  test('reasoning_content + inline think + plain content: all paths compose', async () => {
    const proto = await newProto();
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"api-thought "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"<think>inline-think</think>real "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"more-api","content":"answer"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const evs = await collect(proto.parseStream(sseResponse([sse])));
    const last = evs.filter((e) => e.content !== undefined).pop();
    assert.equal(last.content, 'real answer');
    assert.equal(last.reasoning, 'api-thought inline-thinkmore-api');
  });
});
