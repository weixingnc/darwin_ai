/** OpenAI-compatible provider (non-streaming) tests — PR 9.
 * Wires protocol layer (PR 8) into ProviderBase (PR 6) with real fetch() calls.
 * Coverage: chat success/failure (network + 4xx/5xx), listModels, stream/embed
 * NOT_IMPLEMENTED, events (BEFORE/AFTER/ERROR), config via ConfigResolver (NOT process.env). */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { OpenAICompatibleProvider } from '../provider/openai-compatible.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = {
  chat: JSON.parse(readFileSync(resolve(__dirname, '../provider/__fixtures__/openai-chat-response.json'), 'utf8')),
  models: JSON.parse(readFileSync(resolve(__dirname, '../provider/__fixtures__/openai-models-response.json'), 'utf8')),
  err: JSON.parse(readFileSync(resolve(__dirname, '../provider/__fixtures__/openai-error-response.json'), 'utf8')),
};
// fetch spy — verifies the wire path is actually exercised (not stubbed)
let fetchSpy, origFetch;
const installFetch = (impl) => { fetchSpy = (...a) => { fetchSpy.calls.push(a); return Promise.resolve(impl(...a)); }; fetchSpy.calls = []; globalThis.fetch = fetchSpy; };
const restoreFetch = () => { globalThis.fetch = origFetch; };
const ok = (b) => ({ ok: true, status: 200, statusText: 'OK', json: async () => b, text: async () => JSON.stringify(b) });
const httpErr = (s, b) => ({ ok: false, status: s, statusText: 'E', json: async () => b, text: async () => JSON.stringify(b) });
const setup = () => { origFetch = globalThis.fetch; };
const teardown = () => restoreFetch();
const make = (opts = {}) => {
  const bus = new EventBus();
  const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com', apiKey: 'sk-test-123', defaultModel: 'gpt-4o-mini', eventBus: bus, ...opts });
  return { bus, p };
};
describe('OpenAICompatibleProvider — construction', () => {
  beforeEach(setup); afterEach(teardown);
  test('shape + protocol', () => {
    const { p } = make();
    assert.equal(p.name, 'openai-compatible');
    assert.deepEqual(p.capabilities, ['chat', 'tool-call', 'stream', 'embed', 'list-models']);
    assert.equal(p._protocol.name, 'openai-compatible');
  });
  test('throws without eventBus', () => {
    assert.throws(() => new OpenAICompatibleProvider({ baseUrl: 'x', apiKey: 'y', defaultModel: 'z' }), /eventBus/);
  });
});
describe('OpenAICompatibleProvider — chat()', () => {
  let bus, p;
  beforeEach(() => { setup(); ({ bus, p } = make()); installFetch(async () => ok(FX.chat)); });
  afterEach(teardown);
  test('happy: fetch called once; URL/headers/body correct; returns {content, toolCalls, usage, raw}', async () => {
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, FX.chat.choices[0].message.content);
    assert.deepEqual(r.value.toolCalls, []);
    assert.deepEqual(r.value.usage, FX.chat.usage);
    assert.equal(r.value.raw, FX.chat);
    assert.equal(fetchSpy.calls.length, 1, 'fetch must be called exactly once');
    const [url, init] = fetchSpy.calls[0];
    assert.equal(url, 'https://api.example.com/v1/chat/completions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Authorization, 'Bearer sk-test-123');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });
  test('options + tools: temperature/max_tokens in body, tools wrapped to OpenAI', async () => {
    await p.chat([{ role: 'user', content: 'hi' }], { temperature: 0.3, max_tokens: 64, tools: [{ name: 's', description: 'd', parameters: { type: 'object' } }] });
    const body = JSON.parse(fetchSpy.calls[0][1].body);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 64);
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 's');
  });
  test('response tool_calls → result.toolCalls', async () => {
    const tc = { id: 'call_xyz', type: 'function', function: { name: 's', arguments: '{}' } };
    installFetch(async () => ok({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [tc] } }], usage: {} }));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(r.value.toolCalls, [tc]);
  });
  test('fetch throw → ok:false + emits ERROR + never throws', async () => {
    installFetch(async () => { throw new TypeError('fetch failed'); });
    const errs = []; bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => errs.push(e));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /fetch failed/);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].phase, 'chat');
  });
  test('HTTP 400 → ERROR carries upstream error.message', async () => {
    installFetch(async () => httpErr(400, FX.err));
    const errs = []; bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => errs.push(e));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.match(errs[0].error.message, /API key/);
  });
  test('HTTP 500 → ok:false + never throws', async () => {
    installFetch(async () => httpErr(500, { error: { message: 'upstream' } }));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /upstream/);
  });
});
describe('OpenAICompatibleProvider — listModels()', () => {
  let bus, p;
  beforeEach(() => { setup(); ({ bus, p } = make()); });
  afterEach(teardown);
  test('GET /v1/models → data[].id', async () => {
    installFetch(async () => ok(FX.models));
    const r = await p.listModels();
    assert.equal(r.ok, true);
    assert.equal(fetchSpy.calls[0][0], 'https://api.example.com/v1/models');
    assert.equal(fetchSpy.calls[0][1].method, 'GET');
    assert.deepEqual(r.value, ['gpt-4o-mini', 'gpt-4o', 'deepseek-chat', 'qwen-plus']);
  });
  test('fetch throw → ok:false + emits ERROR', async () => {
    installFetch(async () => { throw new Error('dns-down'); });
    const errs = []; bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => errs.push(e));
    const r = await p.listModels();
    assert.equal(r.ok, false);
    assert.match(r.error.message, /dns-down/);
    assert.equal(errs.length, 1);
  });
});
describe('OpenAICompatibleProvider — stream()/embed() NOT_IMPLEMENTED', () => {
  let p;
  beforeEach(() => { setup(); ({ p } = make()); });
  afterEach(teardown);
  test('stream()', async () => {
    const r = await p.stream([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /NOT_IMPLEMENTED|not implemented/i);
  });
  test('embed()', async () => {
    const r = await p.embed('hi');
    assert.equal(r.ok, false);
    assert.match(r.error.message, /NOT_IMPLEMENTED|not implemented/i);
  });
});
describe('OpenAICompatibleProvider — event sequence (provider-level only)', () => {
  let bus, p;
  beforeEach(() => { setup(); ({ bus, p } = make()); });
  afterEach(teardown);
  // Filter to provider events; protocol layer also emits with e.protocol set
  const collect = () => {
    const ev = []; const traces = [];
    const f = (e, k) => { if (e.provider === 'openai-compatible') {ev.push(k); traces.push(e.traceId);} };
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, (e) => f(e, 'B'));
    bus.on(EVENTS.PROVIDER_CALL_AFTER, (e) => f(e, 'A'));
    bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => f(e, 'E'));
    return { ev, traces };
  };
  test('success: BEFORE → AFTER with matching traceId', async () => {
    installFetch(async () => ok(FX.chat));
    const { ev, traces } = collect();
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(ev, ['B', 'A']);
    assert.equal(traces[0], traces[1]);
  });
  test('failure: BEFORE → ERROR, no AFTER', async () => {
    installFetch(async () => { throw new Error('boom'); });
    const { ev } = collect();
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(ev, ['B', 'E']);
  });
});
describe('OpenAICompatibleProvider — config injection (NOT process.env)', () => {
  beforeEach(setup); afterEach(teardown);
  test('fromConfig reads via ConfigResolver; env vars IGNORED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'darwin-cfg-'));
    const codePath = join(dir, 'code'); mkdirSync(codePath, { recursive: true });
    writeFileSync(join(codePath, 'provider-openai.yaml'), 'base_url: https://config.example\napi_key: sk-from-config\ndefault_model: cfg-model\ntimeout_ms: 5000\n');
    const resolver = new ConfigResolver({ codePath, userPath: join(dir, 'user'), credPath: join(dir, '.env') });
    const origKey = process.env.OPENAI_API_KEY; const origBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'sk-leaked'; process.env.OPENAI_BASE_URL = 'https://leaked.example';
    try {
      const p = OpenAICompatibleProvider.fromConfig({ eventBus: new EventBus(), resolver });
      assert.equal(p._baseUrl, 'https://config.example');
      assert.equal(p._apiKey, 'sk-from-config');
      assert.equal(p._defaultModel, 'cfg-model');
    } finally {
      if (origKey === undefined) {delete process.env.OPENAI_API_KEY;} else {process.env.OPENAI_API_KEY = origKey;}
      if (origBase === undefined) {delete process.env.OPENAI_BASE_URL;} else {process.env.OPENAI_BASE_URL = origBase;}
    }
  });
  test('apiKey flows to Authorization header (env leak ignored)', async () => {
    installFetch(async () => ok(FX.chat));
    const origKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'sk-leaked';
    try {
      const { p } = make({ apiKey: 'sk-direct' });
      await p.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(fetchSpy.calls[0][1].headers.Authorization, 'Bearer sk-direct');
    } finally { if (origKey === undefined) {delete process.env.OPENAI_API_KEY;} else {process.env.OPENAI_API_KEY = origKey;} }
  });
  test('trailing slash on baseUrl is stripped', async () => {
    installFetch(async () => ok(FX.chat));
    const { p } = make({ baseUrl: 'https://x.example/' });
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(fetchSpy.calls[0][0], 'https://x.example/v1/chat/completions');
  });
});
