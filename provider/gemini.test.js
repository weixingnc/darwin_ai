/**
 * Gemini provider tests — V3+ P1 catalogue (cycle 9, 5/6 closure).
 * Fetch-spy pattern. Validates: A-3 inline protocol seam, A-4 no process.env,
 * Gemini wire: contents[].role=model|user, system → top-level systemInstruction,
 * auth = ?key= query (NOT Bearer), functionCall parts → toolCalls[].
 * LLM gate: fetch is mocked; no real LLM calls.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { GeminiProvider } from './gemini.js';

let origFetch, calls;
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
const FX = {
  chat: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
  },
  tool: {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'sf' } } }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
  err: { error: { message: 'api key invalid', code: 401 } },
};
const mk = (o = {}) => {
  const bus = new EventBus();
  const p = new GeminiProvider({
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'gem-test-key-123',
    defaultModel: 'gemini-2.0-flash',
    eventBus: bus,
    ...o,
  });
  return { bus, p };
};
const hooks = () => {
  before(() => {
    origFetch = globalThis.fetch;
  });
  after(() => restore());
};

describe('GeminiProvider — construction + A-3/A-4', () => {
  hooks();
  test('name + capabilities + eventBus required + default model', () => {
    const { p } = mk();
    assert.equal(p.name, 'gemini');
    assert.deepEqual(p.capabilities, ['chat', 'tool-call', 'list-models']);
    assert.equal(p._defaultModel, 'gemini-2.0-flash');
    assert.throws(
      () => new GeminiProvider({ baseUrl: 'x', apiKey: 'y', defaultModel: 'z' }),
      /eventBus/,
    );
  });
  test('A-4 no process.env reads + A-3 inline protocol seam', () => {
    const src = readFileSync(join(import.meta.dirname, 'gemini.js'), 'utf8');
    assert.equal(/process\.env\.[A-Z_]+/.test(src), false, 'A-4 严守');
    const { p } = mk();
    assert.equal(typeof p._geminiProtocol.buildRequest, 'function');
    assert.equal(typeof p._geminiProtocol.parseResponse, 'function');
  });
});

describe('GeminiProvider — chat() wire format', () => {
  hooks();
  test('happy: ?key= query, no Authorization, contents[] + usage', async () => {
    const { p } = mk();
    install(() => ok(FX.chat));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'hi');
    assert.deepEqual(r.value.toolCalls, []);
    assert.equal(r.value.usage.prompt_tokens, 5);
    assert.equal(r.value.usage.completion_tokens, 7);
    assert.equal(r.value.usage.total_tokens, 12);
    const [url, init] = calls[0];
    assert.match(url, /models\/gemini-2\.0-flash:generateContent\?key=gem-test-key-123$/);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
    assert.equal(body.systemInstruction, undefined);
  });
  test('system → top-level systemInstruction (NOT in contents)', async () => {
    const { p } = mk();
    install(() => ok(FX.chat));
    await p.chat([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    const body = JSON.parse(calls[0][1].body);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be brief' }] });
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  });
  test('assistant → model role; multi-turn contents[]', async () => {
    const { p } = mk();
    install(() => ok(FX.chat));
    await p.chat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how r u?' },
    ]);
    const body = JSON.parse(calls[0][1].body);
    assert.deepEqual(body.contents, [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ text: 'how r u?' }] },
    ]);
  });
  test('response functionCall → toolCalls[]', async () => {
    const { p } = mk();
    install(() => ok(FX.tool));
    const r = await p.chat([{ role: 'user', content: 'weather?' }]);
    assert.equal(r.value.toolCalls.length, 1);
    assert.equal(r.value.toolCalls[0].name, 'get_weather');
    assert.deepEqual(r.value.toolCalls[0].args, { city: 'sf' });
  });
  test('HTTP 4xx → error wraps status + gemini msg + PROVIDER_CALL_ERROR', async () => {
    const { bus, p } = mk();
    install(() => httpErr(401, FX.err));
    let n = 0;
    bus.on(EVENTS.PROVIDER_CALL_ERROR, () => n++);
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    // ErrorHandler normalizes to { message, name, stack, raw }; the original
    // HTTP error (with .status) is preserved under .raw.
    assert.equal(r.error.raw.status, 401);
    assert.match(r.error.message, /401/);
    assert.match(r.error.message, /api key invalid/);
    assert.equal(n, 1);
  });
});

describe('GeminiProvider — listModels + embed + fromConfig', () => {
  hooks();
  test('listModels: static Google AI catalogue', async () => {
    const { p } = mk();
    const r = await p.listModels();
    assert.deepEqual(r.value, ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']);
  });
  test('embed: NOT_IMPLEMENTED', async () => {
    const { p } = mk();
    const r = await p.embed('hi');
    assert.equal(r.ok, false);
    assert.match(r.error.message, /NOT_IMPLEMENTED/);
  });
  test('fromConfig: reads provider-gemini via codePath, throws no eventBus', () => {
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), 'gem-'));
    // ConfigResolver reads `${codePath}/${moduleName}.yaml`; place a temp
    // file there and point codePath at the temp dir.
    const cfgPath = join(dir, 'provider-gemini.yaml');
    writeFileSync(
      cfgPath,
      ['api_key: gem-cfg-xyz', 'default_model: gemini-1.5-pro', 'timeout_ms: 9000'].join('\n'),
    );
    const resolver = new ConfigResolver({ codePath: dir });
    const p = GeminiProvider.fromConfig({ eventBus: bus, resolver });
    assert.equal(p._baseUrl, 'https://generativelanguage.googleapis.com');
    assert.equal(p._apiKey, 'gem-cfg-xyz');
    assert.equal(p._defaultModel, 'gemini-1.5-pro');
    assert.equal(p._timeoutMs, 9000);
    assert.throws(() => GeminiProvider.fromConfig({}), /eventBus/);
  });
});
