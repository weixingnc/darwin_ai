/**
 * V4 cycle 4 (2026-06-19) — openai-compatible embed() + vector backend DI e2e.
 * Closes P1-B2: protocol.embed (mock /v1/embeddings) → DI seam → search().
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventBus } from '../../core/event-bus.js';
import { createOpenAICompatibleProtocol } from '../../provider/protocol/openai-compatible.js';
import { VectorBackend } from '../../memory/vector-backend.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';

let origFetch;
let fetchCalls;
let tmp;
const DIM = 8; // VectorBackend.VECTOR_DIM contract (cycle 1)
const okRes = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// Deterministic 8-dim: hello-prefix texts collide in cosine (bump[0]).
function fakeEmbedding(text) {
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % DIM] += text.charCodeAt(i);
  }
  if (text.toLowerCase().startsWith('hello')) {
    v[0] += 100;
  }
  let mag = 0;
  for (const x of v) {
    mag += x * x;
  }
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < DIM; i++) {
    v[i] /= mag;
  }
  return v;
}

const embedMock = () => (_u, init) => {
  const body = JSON.parse(init.body);
  return Promise.resolve(
    okRes({
      data: body.input.map((t, i) => ({ index: i, embedding: fakeEmbedding(t) })),
      model: body.model,
    }),
  );
};
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

before(() => {
  origFetch = globalThis.fetch;
  tmp = mkdtempSync(join(tmpdir(), 'c4-embed-'));
});

after(() => restoreFetch());

describe('openai-compatible embed → vector backend (V4 cycle 4 P1-B2)', () => {
  test('1. embed() over real wire: URL/method/Authorization + data[].embedding parse', async () => {
    const bus = new EventBus();
    const protocol = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test',
    });
    installFetch(embedMock());
    try {
      const r = await protocol.embed(['hello world', 'goodbye world']);
      assert.equal(r.ok, true);
      assert.equal(r.value.length, 2);
      for (const v of r.value) {
        assert.equal(v.length, DIM);
      }
      const [url, init] = fetchCalls[0];
      assert.equal(url, 'https://api.openai.com/v1/embeddings');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer sk-test');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.input, ['hello world', 'goodbye world']);
      assert.equal(body.model, 'text-embedding-3-small');
    } finally {
      restoreFetch();
    }
  });

  test('2. multi-text round-trip: provider.embed returns flat number[][]', async () => {
    const bus = new EventBus();
    const protocol = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-multi',
    });
    installFetch(embedMock());
    try {
      const r = await protocol.embed(['alpha', 'beta', 'gamma']);
      assert.equal(r.ok, true);
      assert.deepEqual(
        r.value.map((v) => v.length),
        [DIM, DIM, DIM],
      );
      assert.notDeepEqual(r.value[0], r.value[1]);
      assert.notDeepEqual(r.value[1], r.value[2]);
    } finally {
      restoreFetch();
    }
  });

  test('3. vector backend DI: provider.embed → store() → search() hits same doc', async () => {
    const bus = new EventBus();
    const protocol = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-di',
    });
    installFetch(embedMock());
    // DI seam: protocol.embed wraps a single-text query.
    const providerEmbed = (text) => protocol.embed([text]).then((r) => (r.ok ? r.value[0] : null));
    const vec = VectorBackend();
    await vec.init({ eventBus: bus, embedder: providerEmbed });
    try {
      const docEmbedding = fakeEmbedding('hello world');
      const storeRes = await vec.store('doc1', docEmbedding, { source: 'unit' });
      assert.equal(storeRes.ok, true);
      // Search by TEXT goes through provider.embed → mock returns
      // fakeEmbedding('hello world!') → collides on hello bump → cos≈1.
      const hits = await vec.search('hello world!', { topK: 3 });
      assert.ok(Array.isArray(hits) && hits.length >= 1, 'must find at least 1 hit');
      assert.equal(hits[0].id, 'doc1');
      assert.ok(hits[0].score > 0.99, `cosine must be ~1.0 (got ${hits[0].score})`);
    } finally {
      restoreFetch();
    }
  });

  test('4. error isolation: 401 → ok:false; vector store stays usable (raw-vector path)', async () => {
    const bus = new EventBus();
    const protocol = createOpenAICompatibleProtocol({
      eventBus: bus,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-fail',
    });
    installFetch(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Bad Request',
        json: async () => ({}),
        text: async () => '{"error":{"message":"invalid api key"}}',
      }),
    );
    try {
      const r = await protocol.embed(['hi']);
      assert.equal(r.ok, false);
      assert.match(r.error.message, /HTTP 401/);

      // Throwing embedder must not crash the backend.
      const vec = VectorBackend();
      await vec.init({
        eventBus: bus,
        embedder: () => {
          throw new Error('provider offline');
        },
      });
      const e = await vec.embed('will fail');
      assert.equal(e.ok, false);
      const s = await vec.search('text query');
      assert.equal(s.ok, false);
      // Raw-vector path stays green even when embedder is broken.
      const docEmbedding = fakeEmbedding('unrelated doc');
      await vec.store('doc2', docEmbedding);
      const rawHits = await vec.search(docEmbedding, { topK: 1 });
      assert.ok(Array.isArray(rawHits) && rawHits.length === 1);
      assert.equal(rawHits[0].id, 'doc2');
    } finally {
      restoreFetch();
    }
  });

  test('5. catalogue closure: addToCatalogue records the e2e marker (sandboxed)', () => {
    // Isolated overlay (tmpdir) + explicit logFile=LOG_FILE so the
    // production evolution/catalogue.log gets the audit entry without
    // polluting evolution/catalogue.json (w3-2/w4-2 assert fresh).
    const isolatedFile = join(tmp, 'catalogue-c4.json');
    const a = addToCatalogue('memory_backends', 'provider-embed-integration', {
      reason:
        'V4 cycle 4 P1-B2: openai-compatible embed() + vector end-to-end (provider wire → DI seam → search)',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(a, true, 'first add must return true');
    const b = addToCatalogue('memory_backends', 'provider-embed-integration', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(b, false, 'duplicate add must return false (idempotent)');
  });
});
