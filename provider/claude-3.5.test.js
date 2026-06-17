/**
 * claude-3.5 provider tests — V3_ROADMAP P1 catalogue (cycle 10, 6/6 closure).
 * Mirrors `provider/gemini.test.js` (cycle 9) fetch-spy pattern. Validates:
 * A-3 protocol reuse (no double-impl), A-4 ConfigResolver, B-2 IProvider
 * contract. Parallel-provider simplification vs anthropic: same wire format,
 * distinct name + 7 capabilities (incl. vision/computer-use/prompt-cache).
 * LLM gate (ADR-009): no LLM calls (fetch is mocked).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';
import { ConfigResolver } from '../core/config-resolver.js';
import { Claude35Provider } from './claude-3.5.js';

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
const hooks = () => {
  before(() => {
    origFetch = globalThis.fetch;
  });
  after(() => restore());
};

const FX_CHAT = {
  id: 'msg_c35_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet-20241022',
  content: [{ type: 'text', text: 'hi from claude 3.5' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 8, output_tokens: 9 },
};
const FX_ERR = { error: { message: 'invalid x-api-key', type: 'authentication_error' } };
const mk = (o = {}) => {
  const bus = new EventBus();
  const p = new Claude35Provider({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-c35-test-123',
    defaultModel: 'claude-3-5-sonnet-20241022',
    eventBus: bus,
    ...o,
  });
  return { bus, p };
};

describe('Claude35Provider — construction + A-3/A-4', () => {
  hooks();
  test('name + 7 capabilities + eventBus required + A-3 protocol reuse', () => {
    const { p } = mk();
    assert.equal(p.name, 'claude-3.5');
    assert.deepEqual(p.capabilities, [
      'chat',
      'stream',
      'tool-call',
      'vision',
      'computer-use',
      'prompt-cache',
      'listModels',
    ]);
    assert.equal(p._defaultModel, 'claude-3-5-sonnet-20241022');
    assert.equal(p._protocol.name, 'anthropic');
    assert.equal(typeof p._protocol.buildRequest, 'function');
    assert.equal(p._streamProtocol.name, 'anthropic-stream');
    assert.throws(
      () => new Claude35Provider({ baseUrl: 'x', apiKey: 'y', defaultModel: 'z' }),
      /eventBus/,
    );
  });
  test('A-4: no process.env reads + baseUrl trailing slash stripped', () => {
    const src = readFileSync(join(import.meta.dirname, 'claude-3.5.js'), 'utf8');
    assert.equal(/process\.env\.[A-Z_]+/.test(src), false, 'A-4 严守');
    const { p } = mk({ baseUrl: 'https://api.anthropic.com/' });
    assert.equal(p._baseUrl, 'https://api.anthropic.com');
  });
});

describe('Claude35Provider — chat() wire format', () => {
  hooks();
  test('happy: /v1/messages, x-api-key + anthropic-version, body.model, parsed', async () => {
    const { bus, p } = mk();
    install(() => ok(FX_CHAT));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'hi from claude 3.5');
    assert.deepEqual(r.value.toolCalls, []);
    assert.equal(r.value.usage.input_tokens, 8);
    assert.equal(r.value.raw, FX_CHAT);
    const [url, init] = calls[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-api-key'], 'sk-c35-test-123');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-3-5-sonnet-20241022');
    assert.equal(body.stream, false);
    let afterFired = 0;
    bus.on(EVENTS.PROVIDER_CALL_AFTER, () => afterFired++);
    install(() => ok(FX_CHAT));
    await p.chat([{ role: 'user', content: 'hi2' }]);
    assert.ok(afterFired >= 1);
  });
  test('options.model override', async () => {
    const { p } = mk();
    install(() => ok(FX_CHAT));
    await p.chat([{ role: 'user', content: 'hi' }], { model: 'claude-3-5-haiku-20241022' });
    assert.equal(JSON.parse(calls[0][1].body).model, 'claude-3-5-haiku-20241022');
  });
  test('HTTP 4xx → error wraps status + msg + PROVIDER_CALL_ERROR emitted', async () => {
    const { bus, p } = mk();
    install(() => httpErr(401, FX_ERR));
    let errCount = 0;
    bus.on(EVENTS.PROVIDER_CALL_ERROR, () => errCount++);
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.equal(r.error.raw.status, 401);
    assert.match(r.error.message, /401/);
    assert.match(r.error.message, /invalid x-api-key/);
    assert.equal(errCount, 1);
  });
  test('HTTP 500 fallback', async () => {
    const { p } = mk();
    install(() => httpErr(500, {}));
    const r = await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /HTTP 500/);
  });
});

describe('Claude35Provider — listModels + embed + fromConfig', () => {
  hooks();
  test('listModels: static 3.5 catalogue', async () => {
    const { p } = mk();
    const r = await p.listModels();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ]);
  });
  test('embed: NOT_IMPLEMENTED', async () => {
    const { p } = mk();
    const r = await p.embed('hi');
    assert.equal(r.ok, false);
    assert.match(r.error.message, /NOT_IMPLEMENTED/);
  });
  test('fromConfig: reads provider-claude-3.5 + defaults baseUrl when empty', () => {
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), 'c35-'));
    const cfgPath = join(dir, 'provider-claude-3.5.yaml');
    writeFileSync(
      cfgPath,
      [
        'api_key: sk-c35-cfg-xyz',
        'base_url: https://api.anthropic.com',
        'default_model: claude-3-5-haiku-20241022',
        'timeout_ms: 11000',
      ].join('\n'),
    );
    const resolver = new ConfigResolver({ codePath: dir });
    const p = Claude35Provider.fromConfig({ eventBus: bus, resolver });
    assert.equal(p._baseUrl, 'https://api.anthropic.com');
    assert.equal(p._apiKey, 'sk-c35-cfg-xyz');
    assert.equal(p._defaultModel, 'claude-3-5-haiku-20241022');
    assert.equal(p._timeoutMs, 11000);
    assert.throws(() => Claude35Provider.fromConfig({}), /eventBus/);
    // empty config path
    const dir2 = mkdtempSync(join(tmpdir(), 'c35-'));
    const cfgPath2 = join(dir2, 'provider-claude-3.5.yaml');
    writeFileSync(cfgPath2, 'unrelated:\n  x: 1\n');
    const p2 = Claude35Provider.fromConfig({
      eventBus: bus,
      resolver: new ConfigResolver({ codePath: dir2 }),
    });
    assert.equal(p2._baseUrl, 'https://api.anthropic.com');
    assert.equal(p2._defaultModel, 'claude-3-5-sonnet-20241022');
  });
});
