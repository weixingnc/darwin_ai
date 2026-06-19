/**
 * V4 cycle 3 (2026-06-19) — deepseek provider Darwin self-evolution e2e.
 *
 * Closes the V3_ROADMAP P1 deepseek wire (220+275 lines in production
 * + unit) into a Darwin-self-evolution e2e: real EventBus + ProviderRegistry
 * + mock fetch → R1 `reasoning_content` surfaces as `usage.reasoning`.
 * V3 (deepseek-chat) is also covered so the closure is uniform.
 *
 * LLM gate (ADR-009): fetch mocked. Catalogue closure (case 5) is
 * sandboxed — isolated overlay + explicit logFile=LOG_FILE, so the
 * audit entry lands in production evolution/catalogue.log without
 * polluting evolution/catalogue.json (which w3-2 / w4-2 assert fresh).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventBus } from '../../core/event-bus.js';
import { EVENTS } from '../../core/events.js';
import { ProviderRegistry } from '../../provider/registry.js';
import { DeepSeekProvider } from '../../provider/deepseek.js';
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

const FX_R1 = {
  id: 'r1',
  object: 'chat.completion',
  model: 'deepseek-reasoner',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '4', reasoning_content: '2+2 is 4, so 4.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const FX_V3 = {
  id: 'v3',
  object: 'chat.completion',
  model: 'deepseek-chat',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hi from v3', reasoning_content: null },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const mkProvider = (bus, model = 'deepseek-reasoner') =>
  new DeepSeekProvider({
    eventBus: bus,
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-ds-e2e-mock',
    defaultModel: model,
  });

before(() => {
  origFetch = globalThis.fetch;
  tmp = mkdtempSync(join(tmpdir(), 'c3-deepseek-'));
});

after(() => restoreFetch());

describe('deepseek — Darwin self-evolution e2e (V4 cycle 3)', () => {
  test('1. register: ProviderRegistry accepts DeepSeekProvider + emits PROVIDER_REGISTER', () => {
    const bus = new EventBus();
    const reg = new ProviderRegistry({ eventBus: bus });
    const p = mkProvider(bus);
    let registered = null;
    bus.on(EVENTS.PROVIDER_REGISTER, (e) => (registered = e));
    reg.register(p);
    assert.equal(registered && registered.name, 'deepseek');
    assert.equal(reg.has('deepseek'), true);
    assert.equal(reg.list().length, 1);
  });

  test('2. chat R1: reasoning_content → usage.reasoning (mock fetch wire verified)', async () => {
    const bus = new EventBus();
    const reg = new ProviderRegistry({ eventBus: bus });
    reg.register(mkProvider(bus));
    installFetch(() => ok(FX_R1));
    try {
      const r = await reg.get('deepseek').chat([{ role: 'user', content: '2+2' }]);
      assert.equal(r.ok, true);
      assert.equal(r.value.content, '4');
      assert.ok(r.value.usage.reasoning.includes('2+2 is 4'), 'R1 reasoning must surface');
      assert.equal(r.value.raw.choices[0].message.reasoning_content, '2+2 is 4, so 4.');
      // wire verification: URL, method, Authorization, body.model
      assert.equal(fetchCalls.length, 1);
      const [url, init] = fetchCalls[0];
      assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer sk-ds-e2e-mock');
      assert.equal(JSON.parse(init.body).model, 'deepseek-reasoner');
    } finally {
      restoreFetch();
    }
  });

  test('3. chat V3: no reasoning_content → usage.reasoning is "" (uniform)', async () => {
    const bus = new EventBus();
    installFetch(() => ok(FX_V3));
    try {
      const r = await mkProvider(bus, 'deepseek-chat').chat([{ role: 'user', content: 'hi' }]);
      assert.equal(r.ok, true);
      assert.equal(r.value.content, 'hi from v3');
      assert.equal(r.value.usage.reasoning, '');
    } finally {
      restoreFetch();
    }
  });

  test('4. events: BEFORE/AFTER round-trip across chat + buildRequest + parseResponse', async () => {
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
    installFetch(() => ok(FX_R1));
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
    const isolatedFile = join(tmp, 'catalogue-c3.json');
    const a = addToCatalogue('providers', 'deepseek-e2e', {
      reason: 'V4 cycle 3 deepseek provider Darwin self-evolution e2e closure',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(a, true, 'first add must return true');
    const b = addToCatalogue('providers', 'deepseek-e2e', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(b, false, 'duplicate add must return false (idempotent)');
  });
});
