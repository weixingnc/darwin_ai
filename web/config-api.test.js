/**
 * web/config-api.test.js -- V43 tests for the /api/config/* routes.
 *
 * Strategy: start the web server with a custom DARWIN_USER_DIR
 * env var (or override the manager factory), then exercise every
 * route over HTTP. Tests are isolated via per-test tmp dir.
 *
 * LLM gate (ADR-009): no real LLM. The "test connection" handler
 * is mocked at the fetch level by the test "probe" override.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = join(__dirname, 'server.js');

let baseUrl;
let serverProcess;
let stdoutBuf = '';
let stderrBuf = '';
let userDir;

function http(method, path, body, extraHeaders) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  Object.assign(headers, extraHeaders || {});
  return fetch(baseUrl + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  // Per-suite tmp dir so we never touch ~/.darwin
  userDir = mkdtempSync(join(tmpdir(), 'darwin-configapi-'));
  const port = 19000 + Math.floor(Math.random() * 1000);
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Point ConfigManager at our tmp dir so writes go there
      DARWIN_USER_DIR: userDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (c) => {
    stdoutBuf += c.toString();
  });
  serverProcess.stderr.on('data', (c) => {
    stderrBuf += c.toString();
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    const t = setTimeout(
      () =>
        rejectReady(
          new Error('server start timeout: stdout=' + stdoutBuf + ' stderr=' + stderrBuf),
        ),
      5000,
    );
    const onData = () => {
      if (stdoutBuf.includes('listening on')) {
        clearTimeout(t);
        serverProcess.stdout.off('data', onData);
        resolveReady();
      }
    };
    serverProcess.stdout.on('data', onData);
    onData();
  });
  await ready;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    const t = setTimeout(() => {
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }, 200);
    t.unref();
  }
  if (userDir) {
    setTimeout(() => {
      try {
        rmSync(userDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 100);
  }
});

describe('config-api (V43) -- schema', () => {
  test('GET /api/config/schema returns 7 vendors', async () => {
    const r = await http('GET', '/api/config/schema');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.vendors.length, 7);
    const ids = j.vendors.map((v) => v.id);
    assert.ok(ids.includes('openai'));
    assert.ok(ids.includes('anthropic'));
    assert.ok(ids.includes('deepseek'));
    assert.ok(ids.includes('qwen'));
  });
});

describe('config-api (V43) -- providers CRUD', () => {
  test('GET providers on empty dir returns []', async () => {
    const r = await http('GET', '/api/config/providers');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.providers, []);
  });

  test('POST providers: add openai, list shows it redacted', async () => {
    const r = await http('POST', '/api/config/providers', {
      id: 'openai',
      data: {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-supersecret-1234567890',
        default_model: 'gpt-4o-mini',
      },
      reveal: true,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.id, 'openai');
    // On disk: real key in .env, placeholder in yaml
    assert.ok(existsSync(join(userDir, 'provider-openai.yaml')));
    const yaml = readFileSync(join(userDir, 'provider-openai.yaml'), 'utf8');
    assert.match(yaml, /api_key: \$\{DARWIN_PROVIDER_OPENAI_API_KEY\}/);
    const env = readFileSync(join(userDir, '.env'), 'utf8');
    assert.match(env, /DARWIN_PROVIDER_OPENAI_API_KEY=sk-supersecret-1234567890/);

    // GET /api/config/providers redacts the key
    const r2 = await http('GET', '/api/config/providers');
    const j2 = await r2.json();
    assert.equal(j2.providers.length, 1);
    assert.equal(j2.providers[0].id, 'openai');
    assert.equal(j2.providers[0].api_key, 'sk-s****');
    assert.equal(j2.providers[0].kind, 'openai');
  });

  test('POST providers: missing id or data returns 400', async () => {
    const r = await http('POST', '/api/config/providers', { data: {} });
    assert.equal(r.status, 400);
    const r2 = await http('POST', '/api/config/providers', { id: 'x' });
    assert.equal(r2.status, 400);
  });

  test('POST providers: invalid id returns 400', async () => {
    const r = await http('POST', '/api/config/providers', {
      id: '../etc',
      data: { base_url: 'x' },
    });
    assert.equal(r.status, 400);
  });

  test('PUT providers/<id>: update existing', async () => {
    const r = await http('PUT', '/api/config/providers/openai', {
      data: {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-newsecret-9999',
        default_model: 'gpt-4o',
      },
      reveal: true,
    });
    assert.equal(r.status, 200);
    // Verify the change on disk
    const env = readFileSync(join(userDir, '.env'), 'utf8');
    assert.match(env, /DARWIN_PROVIDER_OPENAI_API_KEY=sk-newsecret-9999/);
  });

  test('PUT providers/<id>: malformed body returns 400', async () => {
    const r = await http('PUT', '/api/config/providers/openai', { notdata: 'x' });
    assert.equal(r.status, 400);
  });

  test('POST providers/<id>/test: 404 for unknown id', async () => {
    const r = await http('POST', '/api/config/providers/nonexistent/test');
    assert.equal(r.status, 404);
  });

  test('POST providers/<id>/test: returns probe result (we mock via a local server)', async () => {
    // Start a tiny local server that pretends to be OpenAI.
    // This test is end-to-end: real HTTP through the bridge.
    const probePort = 19500 + Math.floor(Math.random() * 500);
    const { createServer } = await import('node:http');
    let lastAuth = null;
    const fakeOpenAI = createServer((req, res) => {
      lastAuth = req.headers.authorization;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }));
    });
    await new Promise((r) => fakeOpenAI.listen(probePort, '127.0.0.1', r));

    // Update openai to point at our local probe
    const upd = await http('PUT', '/api/config/providers/openai', {
      data: {
        base_url: 'http://127.0.0.1:' + probePort,
        api_key: 'sk-test-v43',
        default_model: 'gpt-4o-mini',
      },
      reveal: true,
    });
    assert.equal(upd.status, 200);

    const t = await http('POST', '/api/config/providers/openai/test');
    assert.equal(t.status, 200);
    const tj = await t.json();
    assert.equal(tj.ok, true);
    assert.equal(tj.status, 200);
    assert.ok(typeof tj.latencyMs === 'number' && tj.latencyMs >= 0);
    assert.equal(lastAuth, 'Bearer sk-test-v43');

    fakeOpenAI.close();
  });

  test('POST providers/<id>/test: 401 from upstream means ok=false', async () => {
    const probePort = 19500 + Math.floor(Math.random() * 500);
    const { createServer } = await import('node:http');
    const fakeUnauthorized = createServer((req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise((r) => fakeUnauthorized.listen(probePort, '127.0.0.1', r));

    await http('PUT', '/api/config/providers/openai', {
      data: {
        base_url: 'http://127.0.0.1:' + probePort,
        api_key: 'sk-bad',
        default_model: 'm',
      },
      reveal: true,
    });

    const t = await http('POST', '/api/config/providers/openai/test');
    const tj = await t.json();
    assert.equal(tj.ok, false);
    assert.equal(tj.status, 401);
    assert.match(tj.hint, /auth rejected/);

    fakeUnauthorized.close();
  });

  test('DELETE providers/<id>: removes the provider', async () => {
    const r = await http('DELETE', '/api/config/providers/openai');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.deleted, true);
    const list = await (await http('GET', '/api/config/providers')).json();
    assert.equal(list.providers.length, 0);
  });

  test('DELETE providers/<id>: 404 for unknown', async () => {
    const r = await http('DELETE', '/api/config/providers/nope');
    assert.equal(r.status, 404);
  });
});

describe('config-api (V43) -- active provider', () => {
  // Re-add a provider we can activate
  beforeEach(async () => {
    await http('POST', '/api/config/providers', {
      id: 'openai',
      data: {
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-x',
        default_model: 'gpt-4o-mini',
      },
      reveal: true,
    });
  });

  test('GET /active returns null when not set', async () => {
    const r = await http('GET', '/api/config/active');
    const j = await r.json();
    assert.equal(j.provider, null);
  });

  test('PUT /active: set openai, then GET returns it', async () => {
    const r = await http('PUT', '/api/config/active', { provider: 'openai' });
    assert.equal(r.status, 200);
    const r2 = await http('GET', '/api/config/active');
    const j2 = await r2.json();
    assert.equal(j2.provider, 'openai');
    assert.equal(j2.model, 'gpt-4o-mini');
  });

  test('PUT /active: explicit model wins', async () => {
    const r = await http('PUT', '/api/config/active', {
      provider: 'openai',
      model: 'gpt-4o',
    });
    const j = await r.json();
    assert.equal(j.model, 'gpt-4o');
  });

  test('PUT /active: rejects unknown provider', async () => {
    const r = await http('PUT', '/api/config/active', { provider: 'nope' });
    assert.equal(r.status, 400);
  });

  test('PUT /active: missing provider returns 400', async () => {
    const r = await http('PUT', '/api/config/active', { model: 'x' });
    assert.equal(r.status, 400);
  });
});
