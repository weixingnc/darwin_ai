/**
 * V8 cycle 1 (2026-06-19) — qwen R1 reasoning surface Darwin self-evolution e2e.
 *
 * Closes the V8.1 P1 surface (Qwen3 / QwQ reasoning_content via DashScope
 * OpenAI-compatible-mode) into a Darwin-self-evolution e2e, parallel to
 * deepseek-reasoner V4 cycle 3 closure. Real EventBus + ProviderRegistry +
 * mock fetch → R1 `reasoning_content` surfaces as `usage.reasoning`.
 * V3 (qwen-turbo / qwen-plus / qwen-max by default) is also covered so the
 * closure is uniform (V3 explicitly emits `reasoning_content: null`,
 * surfaced as null — NOT empty string, to distinguish "not invoked" from
 * "empty reasoning").
 *
 * LLM gate (ADR-009): fetch mocked. Catalogue closure (case 5) is
 * sandboxed — isolated overlay + explicit logFile=LOG_FILE, so the
 * audit entry lands in production evolution/catalogue.log without
 * polluting evolution/catalogue.json (which w3-2 / w4-2 assert fresh).
 *
 * A-3 lesson: protocol logic delegated to `createOpenAICompatibleProtocol`
 *   (no second copy of `buildRequest` / `parseResponse` here).
 * A-4 lesson: config via ConfigResolver.get('provider-qwen'), never
 *   process.env reads.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventBus } from '../../core/event-bus.js';
import { EVENTS } from '../../core/events.js';
import { ProviderRegistry } from '../../provider/registry.js';
import { QwenProvider } from '../../provider/qwen.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';

let origFetch;
let fetchCalls;
let tmp;

const ok = (b) => ({
  ok: true,
  status: 200,
  json: async () => b,
  text: async () => JSON.stringify(b),
});
const installFetch = (impl) => {
  fetchCalls = [];
  globalThis.fetch = (...a) => {
    fetchCalls.push(a);
    return Promise.resolve(impl(...a));
  };
};
const restoreFetch = () => {
  globalThis.fetch = origFetch;
};

// R1 fixture (Qwen3 / QwQ with enable_thinking=true) — reasoning_content populated.
const FX_QWEN_R1 = {
  id: 'qwen-r1',
  object: 'chat.completion',
  model: 'qwen3-max',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '4',
        reasoning_content: 'thinking: 2+2 is 4. so 4.',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
};
// V3 fixture (qwen-turbo / qwen-plus / qwen-max by default) — reasoning_content null.
const FX_QWEN_V3 = {
  id: 'qwen-v3',
  object: 'chat.completion',
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

const mkProvider = (bus, model = 'qwen3-max') =>
  new QwenProvider({
    eventBus: bus,
    baseUrl: 'https://dashscope.aliyuncs.com',
    apiKey: 'sk-qwen-e2e-mock',
    defaultModel: model,
  });

before(() => {
  origFetch = globalThis.fetch;
  tmp = mkdtempSync(join(tmpdir(), 'c1-qwen-r1-'));
});

after(() => restoreFetch());

describe('qwen R1 — Darwin self-evolution e2e (V8 cycle 1)', () => {
  test('1. register: ProviderRegistry accepts QwenProvider + emits PROVIDER_REGISTER', () => {
    const bus = new EventBus();
    const reg = new ProviderRegistry({ eventBus: bus });
    const p = mkProvider(bus);
    let registered = null;
    bus.on(EVENTS.PROVIDER_REGISTER, (e) => (registered = e));
    reg.register(p);
    assert.equal(registered && registered.name, 'qwen');
    assert.equal(reg.has('qwen'), true);
    assert.equal(reg.list().length, 1);
  });

  test('2. chat R1: reasoning_content → usage.reasoning (mock fetch wire verified)', async () => {
    const bus = new EventBus();
    const reg = new ProviderRegistry({ eventBus: bus });
    reg.register(mkProvider(bus));
    installFetch(() => ok(FX_QWEN_R1));
    try {
      const r = await reg.get('qwen').chat([{ role: 'user', content: '2+2' }]);
      assert.equal(r.ok, true);
      assert.equal(r.value.content, '4');
      assert.ok(
        r.value.usage.reasoning.includes('2+2 is 4'),
        'R1 reasoning must surface (qwen3-max thinking chain)',
      );
      // raw wire shape preserved
      assert.equal(r.value.raw.choices[0].message.reasoning_content, 'thinking: 2+2 is 4. so 4.');
      // wire verification: URL contains the DashScope-specific /compatible-mode/v1 path
      assert.equal(fetchCalls.length, 1);
      const [url, init] = fetchCalls[0];
      assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer sk-qwen-e2e-mock');
      assert.equal(JSON.parse(init.body).model, 'qwen3-max');
    } finally {
      restoreFetch();
    }
  });

  test('3. chat V3: reasoning_content null → usage.reasoning null (NOT "")', async () => {
    const bus = new EventBus();
    installFetch(() => ok(FX_QWEN_V3));
    try {
      const r = await mkProvider(bus, 'qwen-turbo').chat([{ role: 'user', content: 'hi' }]);
      assert.equal(r.ok, true);
      assert.equal(r.value.content, 'hi from qwen-turbo');
      // V3 explicitly emits null (DashScope wire shape) — we surface as null,
      // not '', so callers can distinguish "not invoked" from "empty text".
      assert.equal(r.value.usage.reasoning, null);
    } finally {
      restoreFetch();
    }
  });

  test('4. events: PROVIDER_CALL_BEFORE/AFTER round-trip across chat + buildRequest + parseResponse', async () => {
    const bus = new EventBus();
    const p = mkProvider(bus);
    const before = Object.create(null);
    const after = Object.create(null);
    const usage = [];
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, (e) => {
      before[e.phase] = (before[e.phase] || 0) + 1;
    });
    bus.on(EVENTS.PROVIDER_CALL_AFTER, (e) => {
      after[e.phase] = (after[e.phase] || 0) + 1;
      if (e.usage) {
        usage.push(e.usage);
      }
    });
    installFetch(() => ok(FX_QWEN_R1));
    try {
      await p.chat([{ role: 'user', content: '2+2' }]);
    } finally {
      restoreFetch();
    }
    // ProviderBase._wrap fires per phase. chat drives 3 phases.
    for (const phase of ['chat', 'buildRequest', 'parseResponse']) {
      assert.equal(before[phase], 1, `BEFORE phase=${phase}`);
      assert.equal(after[phase], 1, `AFTER phase=${phase}`);
    }
    // R1 reasoning must propagate through at least one AFTER.usage.
    assert.ok(
      usage.some((u) => typeof u.reasoning === 'string' && u.reasoning.includes('2+2 is 4')),
      'AFTER.usage.reasoning must carry R1 chain-of-thought',
    );
  });

  test('5. catalogue closure: addToCatalogue records the e2e marker (sandboxed overlay)', () => {
    // Sandboxed overlay (tmpdir) + explicit logFile=LOG_FILE so the
    // production evolution/catalogue.log gets the audit entry (PM hard
    // step #4) without polluting evolution/catalogue.json (w3-2/w4-2
    // integration tests assert a fresh overlay).
    const isolatedFile = join(tmp, 'catalogue-c1-qwen-r1.json');
    const a = addToCatalogue('providers', 'qwen-r1-e2e', {
      reason: 'V8 cycle 1 P1: qwen R1 reasoning surface e2e closure',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(a, true, 'first add must return true');
    const b = addToCatalogue('providers', 'qwen-r1-e2e', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(b, false, 'duplicate add must return false (idempotent)');
  });

  test('6. listModels: static catalogue contains qwen-turbo/plus/max (V3 baseline)', async () => {
    const bus = new EventBus();
    const p = mkProvider(bus, 'qwen-turbo');
    const r = await p.listModels();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, ['qwen-turbo', 'qwen-plus', 'qwen-max']);
  });
});
