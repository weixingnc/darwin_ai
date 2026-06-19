/**
 * Qwen (DashScope) provider tests — V3_ROADMAP P1.
 *
 * Mirrors `tests/openai-compatible.test.js` (PR 9) pattern. Validates A-3
 * (protocol reuse), A-4 (ConfigResolver), and the DashScope-specific URL
 * path (`/compatible-mode/v1/chat/completions`).
 *
 * Coverage:
 *   - Construction: shape, protocol reuse, baseUrl normalization
 *     (strips /compatible-mode/v1, /v1, trailing /)
 *   - chat() happy path: URL/headers/body correct, response parsed
 *   - chat() HTTP 4xx / 5xx
 *   - listModels: static catalogue (qwen-turbo/plus/max)
 *   - embed: NOT_IMPLEMENTED
 *   - fromConfig: defaults baseUrl to https://dashscope.aliyuncs.com
 *
 * LLM gate (ADR-009): no LLM calls (fetch is mocked).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { QwenProvider } from './qwen.js';

let origFetch;
let calls;
const install = (impl) => {
  calls = [];
  globalThis.fetch = (...a) => {
    calls.push(a);
    return Promise.resolve(impl(...a));
  };
};
const restore = () => {
  globalThis.fetch = origFetch;
};
const ok = (b) => ({
  ok: true,
  status: 200,
  json: async () => b,
  text: async () => JSON.stringify(b),
});
const httpErr = (s, b) => ({
  ok: false,
  status: s,
  json: async () => b,
  text: async () => JSON.stringify(b),
});

const FX_CHAT = {
  id: 'chatcmpl-qwen-1',
  object: 'chat.completion',
  created: 1700000000,
  model: 'qwen-turbo',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hi from qwen' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 },
};
const FX_ERR = { error: { message: 'invalid api key', type: 'invalid_request_error' } };

// V8 cycle 1 P1: R1 reasoning fixtures (Qwen3 / QwQ with enable_thinking=true).
// DashScope OpenAI-compatible-mode exposes `choices[0].message.reasoning_content`
// parallel to deepseek-reasoner V4 closure.
const FX_QWEN_R1 = {
  id: 'chatcmpl-qwen-r1',
  object: 'chat.completion',
  created: 1700000001,
  model: 'qwen3-max',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '4',
        reasoning_content: 'thinking: 2+2=4. so 4.',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
};
const FX_QWEN_V3 = {
  id: 'chatcmpl-qwen-v3',
  object: 'chat.completion',
  created: 1700000002,
  model: 'qwen-turbo',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hi from qwen-turbo', reasoning_content: null },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};

const mk = (o = {}) => {
  const bus = new EventBus();
  const p = new QwenProvider({
    baseUrl: 'https://dashscope.aliyuncs.com',
    apiKey: 'sk-qw-test-123',
    defaultModel: 'qwen-turbo',
    eventBus: bus,
    ...o,
  });
  return { bus, p };
};

const setupHooks = () => {
  before(() => {
    origFetch = globalThis.fetch;
  });
  after(() => restore());
};

describe('QwenProvider — construction', () => {
  setupHooks();
  test('shape + protocol reuse (A-3) + throws without eventBus', () => {
    const { p } = mk();
    assert.equal(p.name, 'qwen');
    assert.deepEqual(p.capabilities, ['chat', 'tool-call', 'list-models']);
    assert.equal(p._protocol.name, 'openai-compatible');
    assert.throws(
      () => new QwenProvider({ baseUrl: 'x', apiKey: 'y', defaultModel: 'z' }),
      /eventBus/,
    );
  });
  test('default model is qwen-turbo', () => {
    const { p } = mk();
    assert.equal(p._defaultModel, 'qwen-turbo');
  });
  test('baseUrl normalization: strips /compatible-mode/v1, /v1, trailing /', () => {
    const { p: p1 } = mk({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    assert.equal(p1._baseUrl, 'https://dashscope.aliyuncs.com');
    const { p: p2 } = mk({ baseUrl: 'https://dashscope.aliyuncs.com/v1/' });
    assert.equal(p2._baseUrl, 'https://dashscope.aliyuncs.com');
    const { p: p3 } = mk({ baseUrl: 'https://dashscope.aliyuncs.com/' });
    assert.equal(p3._baseUrl, 'https://dashscope.aliyuncs.com');
  });
});

describe('QwenProvider — chat()', () => {
  setupHooks();
  test('happy: URL=/compatible-mode/v1/chat/completions, body.model, response parsed', async () => {
    const { bus, p } = mk();
    install(() => ok(FX_CHAT));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'hi from qwen');
    assert.deepEqual(r.value.toolCalls, []);
    assert.equal(r.value.usage.total_tokens, 17);
    assert.equal(r.value.raw, FX_CHAT);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    // critical: DashScope-specific path includes /compatible-mode/v1
    assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer sk-qw-test-123');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'qwen-turbo');
    assert.equal(body.stream, false);
    // event check
    let afterFired = 0;
    bus.on(EVENTS.PROVIDER_CALL_AFTER, () => afterFired++);
    install(() => ok(FX_CHAT));
    await p.chat([{ role: 'user', content: 'hi2' }]);
    assert.ok(afterFired >= 1, 'PROVIDER_CALL_AFTER must fire on success');
  });
  test('options.model override', async () => {
    const { p } = mk();
    install(() => ok(FX_CHAT));
    await p.chat([{ role: 'user', content: 'hi' }], { model: 'qwen-max' });
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body.model, 'qwen-max');
  });
  test('HTTP 4xx → error with status + message', async () => {
    const { p } = mk();
    install(() => httpErr(403, FX_ERR));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.equal(r.error.status, 403);
    assert.match(r.error.message, /invalid api key/);
  });
  test('HTTP 500 fallback', async () => {
    const { p } = mk();
    install(() => httpErr(500, {}));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /HTTP 500/);
  });
  test('PROVIDER_CALL_ERROR emitted on failure', async () => {
    const { bus, p } = mk();
    install(() => httpErr(500, FX_ERR));
    let errCount = 0;
    bus.on(EVENTS.PROVIDER_CALL_ERROR, () => errCount++);
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(errCount, 1);
  });
});

describe('QwenProvider — V8.1 R1 reasoning surface', () => {
  setupHooks();
  test('R1 reasoning: response.reasoning_content → usage.reasoning', async () => {
    const { p } = mk({ defaultModel: 'qwen3-max' });
    install(() => ok(FX_QWEN_R1));
    const r = await p.chat([{ role: 'user', content: '2+2' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, '4');
    assert.equal(r.value.usage.reasoning, 'thinking: 2+2=4. so 4.');
    // raw wire shape preserved
    assert.equal(r.value.raw.choices[0].message.reasoning_content, 'thinking: 2+2=4. so 4.');
  });
  test('V3 (qwen-turbo): reasoning_content null → usage.reasoning null', async () => {
    const { p } = mk({ defaultModel: 'qwen-turbo' });
    install(() => ok(FX_QWEN_V3));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'hi from qwen-turbo');
    // V3 explicitly emits null (DashScope wire shape) — we surface as null,
    // not '', so callers can distinguish "not invoked" from "empty text".
    assert.equal(r.value.usage.reasoning, null);
  });
  test('R1 reasoning edge: choices[0] has no message → usage.reasoning null (no throw)', async () => {
    const { p } = mk();
    const FX_NO_MSG = {
      id: 'no-msg',
      model: 'qwen3-max',
      choices: [{ index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    install(() => ok(FX_NO_MSG));
    const r = await p.chat([{ role: 'user', content: 'x' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.usage.reasoning, null);
  });
  test('R1 reasoning edge: reasoning_content is not a string → null (no throw)', async () => {
    const { p } = mk();
    const FX_NONSTR = {
      id: 'nonstr',
      model: 'qwen3-max',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok', reasoning_content: 12345 },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    install(() => ok(FX_NONSTR));
    const r = await p.chat([{ role: 'user', content: 'x' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.usage.reasoning, null);
  });
  test('R1 reasoning edge: reasoning_content is empty string → usage.reasoning "" (no throw)', async () => {
    const { p } = mk();
    const FX_EMPTY = {
      id: 'empty',
      model: 'qwen3-max',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'answer', reasoning_content: '' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    install(() => ok(FX_EMPTY));
    const r = await p.chat([{ role: 'user', content: 'x' }]);
    assert.equal(r.ok, true);
    // Empty string is a valid string → surfaced as-is (distinct from V3 null).
    assert.equal(r.value.usage.reasoning, '');
  });
});

describe('QwenProvider — listModels + embed', () => {
  setupHooks();
  test('listModels: returns static catalogue', async () => {
    const { p } = mk();
    const r = await p.listModels();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, ['qwen-turbo', 'qwen-plus', 'qwen-max']);
  });
  test('embed: NOT_IMPLEMENTED', async () => {
    const { p } = mk();
    const r = await p.embed('hi');
    assert.equal(r.ok, false);
    assert.match(r.error.message, /NOT_IMPLEMENTED/);
  });
});

// V9.1 housekeeping note:
// The 'reads provider-qwen config + default baseUrl to dashscope' test
// in this describe block has a pre-existing failure (V3 P1 era infra gap,
// NOT introduced by V8.1). ConfigResolver doesn't parse YAML — it only
// understands JSON. The test writes a YAML file then constructs
// `new ConfigResolver({ configPath })` and expects the resolver to read
// `provider-qwen.base_url` / `api_key` / `default_model` / `timeout_ms`,
// but YAML syntax means the resolver sees no `provider-qwen` key.
//
// V9.1 doesn't fix this — V9.1 is housekeeping, not infra. The fix
// (ConfigResolver YAML support) is a separate cycle. The TODO stays
// here so future readers don't think V8.1 introduced the failure.
describe('QwenProvider — fromConfig (A-4 ConfigResolver)', () => {
  setupHooks();
  test('reads provider-qwen config + default baseUrl to dashscope', () => {
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), 'qw-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(
      cfgPath,
      [
        'provider-qwen:',
        '  base_url: https://dashscope.aliyuncs.com',
        '  api_key: sk-qw-cfg-xyz',
        '  default_model: qwen-max',
        '  timeout_ms: 22222',
      ].join('\n'),
    );
    const resolver = new ConfigResolver({ configPath: cfgPath });
    const p = QwenProvider.fromConfig({ eventBus: bus, resolver });
    assert.equal(p._baseUrl, 'https://dashscope.aliyuncs.com');
    assert.equal(p._apiKey, 'sk-qw-cfg-xyz');
    assert.equal(p._defaultModel, 'qwen-max');
    assert.equal(p._timeoutMs, 22222);
  });
  test('fromConfig defaults baseUrl to https://dashscope.aliyuncs.com when cfg empty', () => {
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), 'qw-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, 'unrelated:\n  x: 1\n');
    const resolver = new ConfigResolver({ configPath: cfgPath });
    const p = QwenProvider.fromConfig({ eventBus: bus, resolver });
    assert.equal(p._baseUrl, 'https://dashscope.aliyuncs.com');
    assert.equal(p._defaultModel, 'qwen-turbo');
  });
  test('fromConfig throws without eventBus', () => {
    assert.throws(() => QwenProvider.fromConfig({}), /eventBus/);
  });
});
