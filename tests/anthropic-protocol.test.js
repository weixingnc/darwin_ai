/**
 * Anthropic protocol (non-streaming) tests — PR 14a1.
 *
 * Coverage:
 *  - module shape (class + factory + IProtocol.validate)
 *  - buildRequest: openai messages → anthropic shape
 *    (system → top-level, content string → array, tool calls → tool_use blocks,
 *     tool results → tool_result user messages, max_tokens default, anthropic-version)
 *  - parseResponse: text / tool_use / stop_reason mapping / usage extraction
 *  - error response (type:error) → throws ProviderError
 *  - tool-call.js PR 7b reuse: formatToolCalls is referenced
 *  - never throws at boundary (ProtocolBase wraps)
 *  - PROVIDER_CALL_BEFORE/AFTER/ERROR events
 *  - config not directly read from process.env (A-4 lesson)
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EventBus } from '../core/event-bus.js';
import { IProtocol } from '../provider/protocol/interface.js';
import { AnthropicProtocol, createAnthropicProtocol } from '../provider/anthropic-protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const textFixture = JSON.parse(
  readFileSync(resolve(__dirname, '../provider/__fixtures__/anthropic-text-response.json'), 'utf8'),
);
const toolFixture = JSON.parse(
  readFileSync(resolve(__dirname, '../provider/__fixtures__/anthropic-tool-response.json'), 'utf8'),
);
const errFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../provider/__fixtures__/anthropic-error-response.json'),
    'utf8',
  ),
);
const make = () => {
  const b = new EventBus();
  return { b, p: createAnthropicProtocol({ eventBus: b }) };
};

describe('module shape', () => {
  test('class + factory exported; name=anthropic; 5 IProtocol methods present; IProtocol.validate ok', () => {
    const inst = new AnthropicProtocol({ eventBus: new EventBus() });
    const p = createAnthropicProtocol({ eventBus: new EventBus() });
    assert.equal(inst.name, 'anthropic');
    assert.equal(p.name, 'anthropic');
    for (const m of [
      'buildRequest',
      'parseResponse',
      'parseStreamChunk',
      'buildToolCallMessage',
      'parseToolCallDelta',
    ]) {
      assert.equal(typeof p[m], 'function', `missing ${m}`);
    }
    assert.deepEqual(IProtocol.validate(p), { ok: true });
  });
});

describe('buildRequest — openai → anthropic format conversion', () => {
  test('system message is hoisted to top-level; absent from messages array', async () => {
    const { p } = make();
    const e = await p.buildRequest(
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
      {},
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(e.ok, true);
    assert.equal(e.value.system, 'You are helpful.');
    assert.equal(
      e.value.messages.find((m) => m.role === 'system'),
      undefined,
    );
  });

  test('user string content → content array with single text block', async () => {
    const { p } = make();
    const e = await p.buildRequest(
      [{ role: 'user', content: 'hello world' }],
      {},
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(e.ok, true);
    assert.equal(e.value.messages[0].role, 'user');
    assert.deepEqual(e.value.messages[0].content, [{ type: 'text', text: 'hello world' }]);
  });

  test('assistant tool_calls → assistant content array with tool_use blocks', async () => {
    const { p } = make();
    const e = await p.buildRequest(
      [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'toolu_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
            },
          ],
        },
      ],
      {},
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(e.ok, true);
    const tu = e.value.messages[1].content.find((b) => b.type === 'tool_use');
    assert.ok(tu);
    assert.equal(tu.id, 'toolu_abc');
    assert.equal(tu.name, 'get_weather');
    assert.deepEqual(tu.input, { city: 'Beijing' });
  });

  test('tool message → user content array with tool_result block (tool_call_id → tool_use_id)', async () => {
    const { p } = make();
    const e = await p.buildRequest(
      [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'toolu_01', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_01', content: '{"temp":30}' },
      ],
      {},
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(e.ok, true);
    const tr = e.value.messages[1].content.find((b) => b.type === 'tool_result');
    assert.equal(tr.tool_use_id, 'toolu_01');
    assert.equal(tr.content, '{"temp":30}');
  });

  test('adds max_tokens default 1024 + anthropic_version 2023-06-01 + model + stream:false', async () => {
    const { p } = make();
    const e = await p.buildRequest(
      [{ role: 'user', content: 'hi' }],
      {},
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(e.value.max_tokens, 1024);
    assert.equal(e.value.anthropic_version, '2023-06-01');
    assert.equal(e.value.model, 'claude-3-5-sonnet-20241022');
    assert.equal(e.value.stream, false);
  });

  test('caller-supplied max_tokens wins; tools converted to anthropic tools shape', async () => {
    const { p } = make();
    const e = await p.buildRequest(
      [{ role: 'user', content: 'x' }],
      {
        max_tokens: 256,
        temperature: 0.5,
        tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
      },
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(e.value.max_tokens, 256);
    assert.equal(e.value.temperature, 0.5);
    assert.equal(e.value.tools[0].name, 'f');
    assert.equal(e.value.tools[0].description, 'd');
  });

  test('malformed options (throwing getter) → error entry, never throws', async () => {
    const { p } = make();
    const bad = {};
    Object.defineProperty(bad, 'temperature', {
      get() {
        throw new Error('boom');
      },
    });
    const e = await p.buildRequest([{ role: 'user', content: 'x' }], bad, 'm');
    assert.equal(e.ok, false);
    assert.match(e.error.message, /boom/);
  });
});

describe('parseResponse — anthropic → v2 normalized', () => {
  test('text response: text block → content; stop_reason end_turn preserved', async () => {
    const { p } = make();
    const e = await p.parseResponse(textFixture);
    assert.equal(e.ok, true);
    assert.equal(e.value.content, 'Hello! How can I help you today?');
    assert.equal(e.value.finish_reason, 'end_turn');
    assert.deepEqual(e.value.tool_calls, []);
    assert.equal(e.value.usage.input_tokens, 12);
    assert.equal(e.value.usage.output_tokens, 8);
  });

  test('tool_use response: tool_use block → v2 tool_call (id+name+JSON args)', async () => {
    const { p } = make();
    const e = await p.parseResponse(toolFixture);
    assert.equal(e.ok, true);
    assert.equal(e.value.finish_reason, 'tool_use');
    assert.equal(e.value.content, "I'll check the weather for you.");
    assert.equal(e.value.tool_calls.length, 1);
    const tc = e.value.tool_calls[0];
    assert.equal(tc.id, 'toolu_01ABC123');
    // v2 normalized shape (parallel to PR 8): function.name, function.arguments
    assert.equal(tc.function.name, 'get_weather');
    assert.equal(typeof tc.function.arguments, 'string');
    assert.deepEqual(JSON.parse(tc.function.arguments), { city: 'Beijing' });
  });

  test('stop_reason mapping: end_turn / max_tokens / tool_use / stop_sequence preserved', async () => {
    const { p } = make();
    for (const reason of ['end_turn', 'max_tokens', 'tool_use', 'stop_sequence']) {
      const e = await p.parseResponse({
        content: [{ type: 'text', text: 'x' }],
        stop_reason: reason,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      assert.equal(e.value.finish_reason, reason);
    }
  });

  test('error response (type:error) → throws ProviderError-shaped error entry', async () => {
    const { p } = make();
    const e = await p.parseResponse(errFixture);
    assert.equal(e.ok, false);
    assert.match(e.error.message, /invalid x-api-key/);
  });
});

describe('v1 fix coverage: never throws; event emission', () => {
  test('all 5 methods return ErrorHandler-shaped entries; never throw on hostile input', async () => {
    const { p } = make();
    const entries = await Promise.all([
      p.buildRequest([], {}, 'm'),
      p.parseResponse({ content: [] }),
      p.parseStreamChunk('data: x'),
      p.buildToolCallMessage({ id: 'c', name: 'n', arguments: '{}' }, 'r'),
      p.parseToolCallDelta({}),
    ]);
    for (const e of entries) {
      assert.equal(typeof e.ok, 'boolean');
      assert.ok('error' in e && 'value' in e);
      assert.equal(typeof e.timestamp, 'number');
    }
    const fns = [
      'buildRequest',
      'parseResponse',
      'parseStreamChunk',
      'buildToolCallMessage',
      'parseToolCallDelta',
    ];
    for (const bad of [null, undefined, '', [], {}]) {
      const p2 = createAnthropicProtocol({ eventBus: new EventBus() });
      for (const fn of fns) {
        const r = await p2[fn](bad, bad, 'm').catch((err) => ({ threw: err }));
        assert.equal(r.threw, undefined, `${fn} threw on ${String(bad)}`);
      }
    }
  });

  test('buildRequest emits BEFORE+AFTER; error path emits ERROR (phase=parseResponse)', async () => {
    const { b, p } = make();
    const ev = [];
    b.on('provider:call:before', (q) => ev.push({ t: 'before', p: q }));
    b.on('provider:call:after', (q) => ev.push({ t: 'after', p: q }));
    b.on('provider:call:error', (q) => ev.push({ t: 'error', p: q }));
    await p.buildRequest([{ role: 'user', content: 'x' }], {}, 'm');
    await p.parseResponse(errFixture);
    assert.equal(ev.length, 4);
    assert.equal(ev[0].p.protocol, 'anthropic');
    assert.equal(ev[1].t, 'after');
    assert.equal(ev[3].t, 'error');
    assert.ok(ev[3].p.error);
  });
});

describe('A-4 lesson + hygiene red-line + PR 7b reuse (PM hard checks)', () => {
  let origEnv;
  beforeEach(() => {
    origEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = origEnv;
    }
  });

  test('buildRequest does NOT embed any api_key / Bearer token in request body', async () => {
    const { p } = make();
    const e = await p.buildRequest(
      [{ role: 'user', content: 'x' }],
      {},
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(e.ok, true);
    assert.equal('api_key' in (e.value || {}), false);
    const json = JSON.stringify(e.value);
    assert.equal(/sk-[A-Za-z0-9_-]{10,}/.test(json), false, 'no sk-* key in body');
    assert.equal(/Bearer\s+[A-Za-z0-9_-]{20,}/.test(json), false, 'no Bearer <token> in body');
  });

  test('anthropic-protocol source: no real api_key / token literals (hygiene) + uses PR 7b formatToolCalls', () => {
    const src = readFileSync(resolve(__dirname, '../provider/anthropic-protocol.js'), 'utf8');
    assert.equal(/sk-[A-Za-z0-9_-]{10,}/.test(src), false);
    assert.equal(/sk-ant-[A-Za-z0-9_-]{10,}/.test(src), false);
    assert.equal(/Bearer\s+[A-Za-z0-9_-]{20,}/.test(src), false);
    assert.ok(/from\s+['"]\.\/protocol\/tool-call\.js['"]/.test(src), 'must import PR 7b');
    assert.ok(/formatToolCalls/.test(src), 'must reference formatToolCalls');
  });

  test('darwin.example.yaml unchanged: provider-anthropic still has ${ANTHROPIC_API_KEY}', () => {
    const yml = readFileSync(resolve(__dirname, '../config/darwin.example.yaml'), 'utf8');
    assert.ok(yml.includes('${ANTHROPIC_API_KEY}'), 'placeholder must remain');
    assert.equal(/sk-[A-Za-z0-9_-]{10,}/.test(yml), false);
  });
});
