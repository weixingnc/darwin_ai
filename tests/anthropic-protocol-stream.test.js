/** Anthropic protocol streaming tests — PR 14a2. Parallel to PR 14a1 (non-stream) + PR 8 (openai stream).
 *  Coverage: 6-stage SSE, input_json_delta→JSON, tool_call, error events, stop_reason mapping,
 *  PR 14a1 consistency, hygiene + A-4. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EventBus } from '../core/event-bus.js';
import {
  AnthropicProtocolStream,
  createAnthropicProtocolStream,
} from '../provider/anthropic-protocol-stream.js';
import { AnthropicProtocol } from '../provider/anthropic-protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = resolve(__dirname, '../provider/__fixtures__/anthropic-stream-events.jsonl');
const SE = 'provider:stream:error';
const load = () =>
  readFileSync(FX, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map(JSON.parse);
const newProto = () => new AnthropicProtocolStream({ eventBus: new EventBus() });
const make = () => {
  const b = new EventBus();
  return { b, p: createAnthropicProtocolStream({ eventBus: b }) };
};
const lastChunk = (evs) => [...evs].reverse().find((e) => e.type !== 'done' && e.type !== 'error');

function sseResp(events, chunkSize = 0) {
  const enc = new TextEncoder();
  const body = events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
  const buf = enc.encode(body);
  const chunks =
    chunkSize > 0
      ? Array.from({ length: Math.ceil(buf.length / chunkSize) }, (_, i) =>
          buf.slice(i * chunkSize, (i + 1) * chunkSize),
        )
      : [buf];
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream({
      start(c) {
        for (const x of chunks) {
          c.enqueue(x);
        }
        c.close();
      },
    }),
  };
}

const drain = async (p, evs) => {
  const out = [];
  for await (const e of p.parseStream(sseResp(evs))) {
    out.push(e);
  }
  return out;
};

describe('module shape', () => {
  test('class + factory; name=anthropic-stream; eventBus required', () => {
    const p = newProto();
    assert.equal(p.name, 'anthropic-stream');
    assert.equal(typeof p.parseStream, 'function');
    assert.equal(typeof p.buildStreamRequest, 'function');
    assert.throws(() => new AnthropicProtocolStream({}), /eventBus/);
  });
});

describe('parseStream — text stream (6-stage SSE)', () => {
  test('drives accumulator; final content + finishReason=end_turn', async () => {
    const evs = await drain(newProto(), load().slice(0, 8));
    assert.equal(evs.at(-1).type, 'done');
    assert.ok(evs.find((e) => e.content === 'Hello! How can I help?'));
    assert.equal(lastChunk(evs).finishReason, 'end_turn');
  });
  test('SSE split across byte chunks → no data loss', async () => {
    const out = [];
    for await (const e of newProto().parseStream(sseResp(load().slice(0, 8), 16))) {
      out.push(e);
    }
    assert.equal(out.at(-1).type, 'done');
    assert.ok(out.find((e) => e.content === 'Hello! How can I help?'));
  });
});

describe('parseStream — tool_use accumulation (PR 7b reuse)', () => {
  test('input_json_delta → JSON.parse → v2 tool_call on block_stop', async () => {
    const tc = lastChunk(await drain(newProto(), load().slice(8))).toolCalls[0];
    assert.equal(tc.id, 'toolu_01ABC123');
    assert.equal(tc.function.name, 'get_weather');
    assert.deepEqual(JSON.parse(tc.function.arguments), { city: 'Beijing' });
  });
});

describe('parseStream — stop_reason + usage', () => {
  test('tool stream: finishReason=tool_use + usage.output_tokens=24', async () => {
    const c = lastChunk(await drain(newProto(), load().slice(8)));
    assert.equal(c.finishReason, 'tool_use');
    assert.equal(c.raw.usage.output_tokens, 24);
  });
  test('stop_reason mapping: end_turn/max_tokens/tool_use/stop_sequence preserved', async () => {
    for (const reason of ['end_turn', 'max_tokens', 'tool_use', 'stop_sequence']) {
      const out = await drain(newProto(), [
        { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: reason, stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ]);
      assert.equal(lastChunk(out).finishReason, reason);
    }
  });
});

describe('parseStream — error handling (never throws)', () => {
  test('anthropic error event → emit + yield {type:"error"} + no throw', async () => {
    const { b, p } = make();
    const errs = [];
    b.on(SE, (q) => errs.push(q));
    let threw = null;
    try {
      for await (const _ of p.parseStream(
        sseResp([
          { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 1 } } },
          { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        ]),
      )) {
        void _;
      }
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].provider, 'anthropic');
  });
  test('malformed JSON → yield {type:"error"} + done, no throw', async () => {
    const enc = new TextEncoder();
    const bad =
      'event: message_start\ndata: {not-json}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const resp = {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(bad));
          c.close();
        },
      }),
    };
    const evs = [];
    let threw = null;
    try {
      for await (const e of newProto().parseStream(resp)) {
        evs.push(e);
      }
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null);
    assert.equal(evs.at(-1).type, 'done');
    assert.ok(evs.find((e) => e.type === 'error'));
  });
  test('empty body → {type:"done"}; async handler throw isolated (PR 2)', async () => {
    const evs = [];
    for await (const e of newProto().parseStream({ body: null })) {
      evs.push(e);
    }
    assert.equal(evs[0].type, 'done');
    const { b, p } = make();
    const a = [],
      c = [];
    b.on(SE, async () => {
      throw new Error('handler-boom');
    });
    b.on(SE, (q) => a.push(q));
    b.on(SE, (q) => c.push(q));
    for await (const _ of p.parseStream(
      sseResp([{ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }]),
    )) {
      void _;
    }
    assert.equal(a.length, 1);
    assert.equal(c.length, 1);
  });
});

describe('PR 14a1 consistency (stream ↔ non-stream equivalence)', () => {
  test('tool stream reassembled + parsed by PR 14a1 → same content/tool/finish_reason', async () => {
    const c = lastChunk(await drain(newProto(), load().slice(8)));
    const entry = await new AnthropicProtocol({ eventBus: new EventBus() }).parseResponse({
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      content: [
        { type: 'text', text: c.content },
        {
          type: 'tool_use',
          id: c.toolCalls[0].id,
          name: c.toolCalls[0].function.name,
          input: JSON.parse(c.toolCalls[0].function.arguments),
        },
      ],
      stop_reason: c.finishReason,
      stop_sequence: null,
      usage: c.raw.usage || { input_tokens: 42, output_tokens: 24 },
    });
    assert.equal(entry.ok, true);
    assert.equal(entry.value.content, c.content);
    assert.equal(entry.value.tool_calls[0].id, c.toolCalls[0].id);
    assert.equal(entry.value.finish_reason, c.finishReason);
  });
});

describe('buildStreamRequest — PR 14a1 reuse', () => {
  test('delegates to PR 14a1 buildRequest + flips stream:true + system hoisted', async () => {
    const entry = await make().p.buildStreamRequest(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      {},
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(entry.ok, true);
    assert.equal(entry.value.stream, true);
    assert.equal(entry.value.system, 'sys');
  });
});

describe('A-4 lesson + hygiene red-line (PM hard checks)', () => {
  test('impl source: no api_key/Bearer; imports PR 7b + PR 14a1; no runtime process.env', () => {
    const src = readFileSync(
      resolve(__dirname, '../provider/anthropic-protocol-stream.js'),
      'utf8',
    );
    assert.equal(/sk-[A-Za-z0-9_-]{10,}/.test(src), false);
    assert.equal(/sk-ant-[A-Za-z0-9_-]{10,}/.test(src), false);
    assert.equal(/Bearer\s+[A-Za-z0-9_-]{20,}/.test(src), false);
    const codeOnly = src.replace(/^\/\*\*[\s\S]*?\*\//, '');
    assert.equal(/process\.env/.test(codeOnly), false, 'A-4');
    assert.ok(/from\s+['"]\.\/protocol\/tool-call\.js['"]/.test(src));
    assert.ok(/parseAssistantToolCalls/.test(src));
    assert.ok(/from\s+['"]\.\/anthropic-protocol\.js['"]/.test(src));
  });
  test('fixture: no api_key / Bearer literals', () => {
    const raw = readFileSync(FX, 'utf8');
    assert.equal(/sk-[A-Za-z0-9_-]{10,}/.test(raw), false);
    assert.equal(/sk-ant-[A-Za-z0-9_-]{10,}/.test(raw), false);
    assert.equal(/Bearer\s+[A-Za-z0-9_-]{20,}/.test(raw), false);
  });
});
