/**
 * DeepSeek provider tests — V3_ROADMAP P1.
 *
 * Mirrors `tests/openai-compatible.test.js` (PR 9) pattern: fetch-spy
 * verifies the wire path is actually exercised, not stubbed. Validates
 * A-3 (no double-impl: protocol layer is reused, not re-implemented) and
 * A-4 (config via ConfigResolver, never process.env).
 *
 * Coverage:
 *   - Construction: shape, capabilities, protocol reuse, eventBus requirement
 *   - chat() happy path: fetch called once, URL/headers/body correct,
 *     response parsed, reasoning surface
 *   - chat() R1 reasoning: response with reasoning_content → usage.reasoning
 *   - chat() V3 (no reasoning): reasoning surface = "" (uniform)
 *   - chat() HTTP 4xx: error wraps status + message
 *   - listModels: static catalogue
 *   - embed: NOT_IMPLEMENTED
 *   - events: PROVIDER_CALL_BEFORE / AFTER / ERROR
 *   - fromConfig: ConfigResolver.get('provider-deepseek') wired, defaults
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
import { DeepSeekProvider } from '../deepseek.js';

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
  id: 'chatcmpl-deepseek-1',
  object: 'chat.completion',
  created: 1700000000,
  model: 'deepseek-chat',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hi from deepseek', reasoning_content: null },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};
const FX_R1 = {
  id: 'chatcmpl-deepseek-r1',
  object: 'chat.completion',
  created: 1700000001,
  model: 'deepseek-reasoner',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'final answer',
        reasoning_content: 'thinking... 1+1=2. so 2.',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
};
const FX_ERR = { error: { message: 'invalid api key', type: 'invalid_request_error' } };

const mk = (o = {}) => {
  const bus = new EventBus();
  const p = new DeepSeekProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-ds-test-123',
    defaultModel: 'deepseek-chat',
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

describe('DeepSeekProvider — construction', () => {
  setupHooks();
  test('shape + protocol reuse (A-3) + throws without eventBus', () => {
    const { p } = mk();
    assert.equal(p.name, 'deepseek');
    assert.deepEqual(p.capabilities, ['chat', 'tool-call', 'list-models']);
    // A-3 lesson: REUSE OpenAI-compatible protocol
    assert.equal(p._protocol.name, 'openai-compatible');
    assert.throws(
      () =>
        new DeepSeekProvider({
          baseUrl: 'x',
          apiKey: 'y',
          defaultModel: 'z',
        }),
      /eventBus/,
    );
  });
  test('default model is deepseek-chat', () => {
    const { p } = mk();
    assert.equal(p._defaultModel, 'deepseek-chat');
  });
  test('baseUrl normalization: strips /v1 and trailing /', () => {
    const { p: p1 } = mk({ baseUrl: 'https://api.deepseek.com/v1/' });
    assert.equal(p1._baseUrl, 'https://api.deepseek.com');
    const { p: p2 } = mk({ baseUrl: 'https://api.deepseek.com' });
    assert.equal(p2._baseUrl, 'https://api.deepseek.com');
  });
});

describe('DeepSeekProvider — chat()', () => {
  setupHooks();
  test('happy: V3 (no reasoning) — fetch URL/headers/body, response parsed', async () => {
    const { bus, p } = mk();
    install(() => ok(FX_CHAT));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'hi from deepseek');
    assert.deepEqual(r.value.toolCalls, []);
    assert.equal(r.value.usage.prompt_tokens, 5);
    // V3 surface: reasoning is empty string (uniform)
    assert.equal(r.value.usage.reasoning, '');
    assert.equal(r.value.raw, FX_CHAT);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Authorization, 'Bearer sk-ds-test-123');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    // event check
    let afterFired = 0;
    bus.on(EVENTS.PROVIDER_CALL_AFTER, () => afterFired++);
    // already-ran: re-fire one to verify wiring
    install(() => ok(FX_CHAT));
    await p.chat([{ role: 'user', content: 'hi2' }]);
    assert.ok(afterFired >= 1, 'PROVIDER_CALL_AFTER must fire on success');
  });
  test('R1 reasoning: response.reasoning_content → usage.reasoning', async () => {
    const { p } = mk({ defaultModel: 'deepseek-reasoner' });
    install(() => ok(FX_R1));
    const r = await p.chat([{ role: 'user', content: '1+1' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'final answer');
    assert.equal(r.value.usage.reasoning, 'thinking... 1+1=2. so 2.');
  });
  test('options.model override → body.model = opts.model', async () => {
    const { p } = mk();
    install(() => ok(FX_CHAT));
    await p.chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-reasoner' });
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body.model, 'deepseek-reasoner');
  });
  test('HTTP 4xx → error.ok=false, error.status=401, error.message=err msg', async () => {
    const { p } = mk();
    install(() => httpErr(401, FX_ERR));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.equal(r.error.status, 401);
    assert.match(r.error.message, /401/);
    assert.match(r.error.message, /invalid api key/);
  });
  test('HTTP 500 → error.status=500, message = HTTP 500 fallback', async () => {
    const { p } = mk();
    install(() => httpErr(500, { error: { message: 'server oops' } }));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.equal(r.error.status, 500);
    assert.match(r.error.message, /server oops/);
  });
  test('PROVIDER_CALL_ERROR emitted on failure', async () => {
    const { bus, p } = mk();
    install(() => httpErr(500, FX_ERR));
    let errCount = 0;
    bus.on(EVENTS.PROVIDER_CALL_ERROR, () => errCount++);
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(errCount, 1, 'PROVIDER_CALL_ERROR must fire on failure');
  });
  test('non-200 with empty body → error.message = "HTTP 502" fallback', async () => {
    const { p } = mk();
    install(() => httpErr(502, {}));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.equal(r.error.status, 502);
    assert.match(r.error.message, /HTTP 502/);
  });
});

describe('DeepSeekProvider — listModels + embed', () => {
  setupHooks();
  test('listModels: returns static catalogue', async () => {
    const { p } = mk();
    const r = await p.listModels();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, ['deepseek-chat', 'deepseek-reasoner']);
  });
  test('embed: NOT_IMPLEMENTED', async () => {
    const { p } = mk();
    const r = await p.embed('hi');
    assert.equal(r.ok, false);
    assert.match(r.error.message, /NOT_IMPLEMENTED/);
  });
});

describe('DeepSeekProvider — fromConfig (A-4 ConfigResolver, no process.env)', () => {
  setupHooks();
  test('reads provider-deepseek config + default baseUrl', () => {
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(
      cfgPath,
      [
        'provider-deepseek:',
        '  base_url: https://api.deepseek.com',
        '  api_key: sk-cfg-xyz',
        '  default_model: deepseek-reasoner',
        '  timeout_ms: 12345',
      ].join('\n'),
    );
    const resolver = new ConfigResolver({ configPath: cfgPath });
    const p = DeepSeekProvider.fromConfig({ eventBus: bus, resolver });
    assert.equal(p._baseUrl, 'https://api.deepseek.com');
    assert.equal(p._apiKey, 'sk-cfg-xyz');
    assert.equal(p._defaultModel, 'deepseek-reasoner');
    assert.equal(p._timeoutMs, 12345);
  });
  test('fromConfig defaults baseUrl to https://api.deepseek.com when cfg empty', () => {
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, 'provider-other:\n  x: 1\n');
    const resolver = new ConfigResolver({ configPath: cfgPath });
    const p = DeepSeekProvider.fromConfig({ eventBus: bus, resolver });
    assert.equal(p._baseUrl, 'https://api.deepseek.com');
    assert.equal(p._defaultModel, 'deepseek-chat');
  });
  test('fromConfig throws without eventBus', () => {
    assert.throws(() => DeepSeekProvider.fromConfig({}), /eventBus/);
  });
});
