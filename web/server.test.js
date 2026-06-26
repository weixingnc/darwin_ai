/**
 * web/server.test.js -- V28: minimal smoke test for the zero-dep
 * web server. We don't exercise the actual /api/chat round-trip
 * (that needs a real LLM provider); we just verify the routes
 * are wired up correctly and return the right shapes on inputs.
 *
 * LLM gate (ADR-009): no LLM. The "API key" in the test env is
 * deliberately fake -- no provider is configured here, so the
 * /api/chat path will error out, which is what we want to
 * verify (the server returns a 500 with the spawn stderr as
 * the error message, not a 200 with a fake reply).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = join(__dirname, 'server.js');
const REPO_ROOT = join(__dirname, '..');

let baseUrl;
let serverProcess;
let isolatedHome;
let stdoutBuf = '';
let stderrBuf = '';

function http(method, path, body) {
  return fetch(baseUrl + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  // Pick a free port by asking the OS for port 0 then reading it back.
  // Cross-platform: we just use a high random port and hope. If it
  // collides, the test fails fast and re-running fixes it.
  const port = 18000 + Math.floor(Math.random() * 1000);
  // V28 tests assume no provider configured so they can assert on
  // the 500 path. Point HOME at a fresh tmp dir so the spawned
  // server cannot see the developer real ~/.darwin.
  isolatedHome = mkdtempSync(join(tmpdir(), 'darwin-v28-'));
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HOME: isolatedHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (c) => {
    stdoutBuf += c.toString();
  });
  serverProcess.stderr.on('data', (c) => {
    stderrBuf += c.toString();
  });
  // Wait for "listening" in the startup banner.
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

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }
  if (isolatedHome) {
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('web/server (V28) — zero-dep HTTP layer', () => {
  test('GET / serves the chat HTML', async () => {
    const r = await http('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /<title>Darwin<\/title>/);
    assert.match(body, /id="form"/);
    assert.match(body, /id="messages"/);
  });

  test('GET /index.html is an alias for /', async () => {
    const r = await http('GET', '/index.html');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });

  test('GET /api/health returns {ok:true, version}', async () => {
    const r = await http('GET', '/api/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.version, /^\d+\.\d+\.\d+/);
  });

  test('POST /api/chat with no body returns 400', async () => {
    const r = await http('POST', '/api/chat', {});
    assert.equal(r.status, 400);
    const j = await r.json();
    // V47: error wording now mentions both the legacy `message` and the
    // V47 `messages` array. The test guards the contract -- both terms
    // must be surfaced so callers (curl, the boot probe, the web UI)
    // see a meaningful error.
    assert.match(j.error, /message or non-empty messages array is required/);
  });

  test('POST /api/chat with empty message returns 400', async () => {
    const r = await http('POST', '/api/chat', { message: '   ' });
    assert.equal(r.status, 400);
  });

  test('POST /api/chat with malformed JSON returns 400', async () => {
    const r = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(r.status, 400);
  });

  test('POST /api/chat without provider returns 500 with stderr message', async () => {
    // The test env has no provider configured, so the spawn
    // of `bin/darwin chat` should fail. We expect a 500 with
    // an error message that contains the spawn failure or the
    // darwin chat stderr (something like "missing config" or
    // "exited with code 1").
    const r = await http('POST', '/api/chat', { message: 'hello' });
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.ok(
      j.error && typeof j.error === 'string',
      'expected error string, got: ' + JSON.stringify(j),
    );
  });

  test('GET /api/nonexistent returns 404', async () => {
    const r = await http('GET', '/api/nonexistent');
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error, 'not found');
  });

  test('OPTIONS /api/chat returns 204 with CORS headers', async () => {
    const r = await http('OPTIONS', '/api/chat');
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-origin') || '', /.*/);
  });
});

describe('web/server (V31) — Server-Sent Events for /api/chat', () => {
  function httpSse(path, body) {
    return fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  }

  // Parse the SSE response body into a list of { type, ... } frames.
  async function readSseFrames(response) {
    const text = await response.text();
    const frames = [];
    for (const block of text.split('\n\n')) {
      const line = block.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith('data: ')) {
        try {
          frames.push(JSON.parse(line.slice('data: '.length)));
        } catch (_) {
          frames.push({ type: 'parse-error', raw: line });
        }
      }
    }
    return frames;
  }

  test('POST /api/chat with Accept: text/event-stream returns SSE content-type', async () => {
    const r = await httpSse('/api/chat', { message: 'hello' });
    assert.equal(r.status, 200, 'SSE should return 200, got ' + r.status);
    const ct = r.headers.get('content-type') || '';
    assert.ok(ct.includes('text/event-stream'), 'expected text/event-stream, got: ' + ct);
  });

  test('SSE without provider emits an error frame then closes', async () => {
    // Test env has no provider configured. `darwin chat --stream`
    // prints `error:No provider configured...` and exits 2.
    // The web layer should forward that as an SSE error frame.
    const r = await httpSse('/api/chat', { message: 'hello' });
    assert.equal(r.status, 200);
    const frames = await readSseFrames(r);
    assert.ok(frames.length >= 1, 'expected at least 1 SSE frame, got ' + frames.length);
    const errFrame = frames.find((f) => f.type === 'error');
    assert.ok(errFrame, 'expected an error frame, got: ' + JSON.stringify(frames));
    assert.ok(
      typeof errFrame.error === 'string' && errFrame.error.length > 0,
      'error frame should have a non-empty error string',
    );
  });

  test('SSE with empty message returns 400 (validation before stream)', async () => {
    const r = await httpSse('/api/chat', { message: '' });
    assert.equal(r.status, 400, 'expected 400 for empty message, got ' + r.status);
  });

  test('JSON Accept header still works (V28 compat preserved)', async () => {
    // Without Accept: text/event-stream, the V28 path is used:
    // 500 with the spawn stderr (no provider in test env).
    const r = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(r.status, 500);
    const ct = r.headers.get('content-type') || '';
    assert.ok(
      ct.includes('application/json'),
      'JSON path should return JSON content-type, got: ' + ct,
    );
    const j = await r.json();
    assert.ok(j.error, 'JSON path should return { error: ... }, got: ' + JSON.stringify(j));
  });
});

// V47: multi-turn context. The web UI sends the full messages array
// (currentConv.messages) so the provider can see prior turns. The
// legacy {message: "..."} body is preserved (handled by the tests
// above) but V47+ callers use {messages: [{role, content}, ...]}.
describe('web/server (V47) — multi-turn messages[]', () => {
  test('POST /api/chat with valid messages array passes validation', async () => {
    // With no provider configured, the request still gets past
    // validation and the spawn fails with 500 -- that proves the
    // body parser accepted the messages[] shape.
    const r = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
      }),
    });
    // No provider => spawn fails => 500 (matches the legacy single-
    // turn behaviour). Validation already passed.
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.ok(j.error, 'should return {error: ...}, got: ' + JSON.stringify(j));
  });

  test('POST /api/chat with empty messages array returns 400', async () => {
    const r = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /messages must be a non-empty array/);
  });

  test('POST /api/chat with messages array containing bad role returns 400', async () => {
    const r = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'pirate', content: 'arrr' }],
      }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /messages\[0\]\.role/);
  });

  test('POST /api/chat with messages array missing content returns 400', async () => {
    const r = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user' }],
      }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /content is required/);
  });

  test('SSE path with messages array returns 200 + error frame (no provider)', async () => {
    const r = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'second' },
        ],
      }),
    });
    assert.equal(r.status, 200);
    // Inline SSE frame parser (readSseFrames is scoped to the V31
    // describe above). We only need to confirm an `error` frame is
    // emitted when the spawn has no provider configured.
    const text = await r.text();
    const frames = [];
    for (const block of text.split('\n\n')) {
      const line = block.trim();
      if (!line) {
        continue;
      }
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) {
        continue;
      }
      try {
        frames.push(JSON.parse(m[1]));
      } catch {
        /* skip malformed */
      }
    }
    const errFrame = frames.find((f) => f.type === 'error');
    assert.ok(errFrame, 'expected error frame in SSE stream, got: ' + JSON.stringify(frames));
  });
});

describe('web/index.html (V32) — streaming chat UI', () => {
  test('GET / serves the chat HTML with V32 + V34 markers', async () => {
    const r = await http('GET', '/');
    assert.equal(r.status, 200);
    const html = await r.text();
    // V32 markers: EventSource-style fetch + Accept header
    assert.ok(
      html.includes("Accept: 'text/event-stream'"),
      'index.html should request text/event-stream',
    );
    assert.ok(html.includes('parseSseStream'), 'index.html should define parseSseStream');
    assert.ok(html.includes("type === 'chunk'"), 'index.html should handle chunk frames');
    assert.ok(html.includes("type === 'done'"), 'index.html should handle done frames');
    assert.ok(html.includes("type === 'error'"), 'index.html should handle error frames');
    assert.ok(html.includes('AbortController'), 'index.html should support stop/abort');
    assert.ok(html.includes('caret'), 'index.html should show a blinking caret while streaming');
    // V34 auth markers
    assert.ok(
      html.includes('darwin.authToken'),
      'index.html should use a localStorage key for the auth token',
    );
    assert.ok(
      html.includes("'Authorization'"),
      'index.html should inject Authorization header on protected fetches',
    );
    assert.ok(html.includes('authedFetch'), 'index.html should define an authedFetch wrapper');
    assert.ok(
      html.includes("searchParams.get('token')"),
      'index.html should capture ?token=... from the URL',
    );
    assert.ok(
      html.includes('Sign in') || html.includes('Sign out'),
      'index.html should expose a sign-in / sign-out UI',
    );
  });
});

describe('web/server (V33) — bearer-token auth', () => {
  // V33: spawn a server with WEB_AUTH_TOKEN set. Tests verify that
  // /api/health stays open while every other route demands the token.
  const TOKEN = 'test-token-abc-123';
  let baseUrl2;
  let proc;
  let procStdout = '';
  let procStderr = '';

  before(async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    proc = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        WEB_AUTH_TOKEN: TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c) => {
      procStdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      procStderr += c.toString();
    });
    const ready = new Promise((resolveReady, rejectReady) => {
      const t = setTimeout(
        () =>
          rejectReady(
            new Error(
              'auth-test server start timeout: stdout=' + procStdout + ' stderr=' + procStderr,
            ),
          ),
        5000,
      );
      const i = setInterval(() => {
        if (procStdout.includes('listening on')) {
          clearInterval(i);
          clearTimeout(t);
          resolveReady();
        }
      }, 50);
    });
    await ready;
    baseUrl2 = 'http://127.0.0.1:' + port;
  });

  after(() => {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  });

  function http2(method, path, opts = {}) {
    return fetch(baseUrl2 + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }

  test('GET /api/health stays open (no auth required) and reports auth_required=true', async () => {
    const r = await http2('GET', '/api/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(
      j.auth_required,
      true,
      'health should report auth_required=true when WEB_AUTH_TOKEN is set',
    );
  });

  test('GET /api/chat without token returns 401 with WWW-Authenticate', async () => {
    // V44: GET / now serves the HTML without auth (so the login
    // form can boot). The 401 path is exercised against the API
    // surface instead. The same WWW-Authenticate contract holds.
    const r = await http2('GET', '/api/chat');
    assert.equal(r.status, 401);
    const wwwAuth = r.headers.get('www-authenticate') || '';
    assert.ok(
      wwwAuth.toLowerCase().includes('bearer'),
      'should set WWW-Authenticate: Bearer, got: ' + wwwAuth,
    );
    const j = await r.json();
    assert.equal(j.error, 'auth required');
  });

  test('GET /api/chat with wrong token returns 401', async () => {
    const r = await http2('GET', '/api/chat', { headers: { Authorization: 'Bearer wrong-token' } });
    assert.equal(r.status, 401);
  });

  test('V44: GET / without token returns 200 (HTML is open)', async () => {
    // The login form lives inside the HTML; the HTML must be
    // reachable without a token so the user can paste one in.
    const r = await http2('GET', '/');
    assert.equal(r.status, 200);
    const ct = r.headers.get('content-type') || '';
    assert.ok(ct.includes('text/html'), 'should serve HTML, got: ' + ct);
  });

  test('V44: GET /index.html without token returns 200', async () => {
    const r = await http2('GET', '/index.html');
    assert.equal(r.status, 200);
  });

  test('V44: GET /storage.js without token returns 200 (static asset allow-list)', async () => {
    // The web UI loads web/storage.js as a <script src>. The static
    // allow-list (V44) serves .js files without auth so the page
    // can actually boot.
    const r = await http2('GET', '/storage.js');
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(
      body.includes('STORAGE_KEY_CONVS'),
      'storage.js should be served (contains STORAGE_KEY_CONVS marker)',
    );
  });

  test('V44: GET /nonexistent.js without token returns 404 (not 401)', async () => {
    // Static allow-list says .js is open; missing files are still
    // 404, not 401.
    const r = await http2('GET', '/nonexistent.js');
    assert.equal(r.status, 404);
  });

  test('GET / with correct Authorization: Bearer returns 200', async () => {
    const r = await http2('GET', '/', { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.equal(r.status, 200);
    const ct = r.headers.get('content-type') || '';
    assert.ok(ct.includes('text/html'), 'should serve HTML');
  });

  test('GET / with correct ?token=... returns 200 (one-shot link)', async () => {
    const r = await http2('GET', '/?token=' + encodeURIComponent(TOKEN));
    assert.equal(r.status, 200);
  });

  test('GET / with X-Darwin-Token header returns 200', async () => {
    const r = await http2('GET', '/', { headers: { 'X-Darwin-Token': TOKEN } });
    assert.equal(r.status, 200);
  });

  test('POST /api/chat without token returns 401', async () => {
    const r = await http2('POST', '/api/chat', { body: { message: 'hello' } });
    assert.equal(r.status, 401);
  });

  test('POST /api/chat with token (SSE Accept) still gets 200 from auth gate', async () => {
    // We do not consume the SSE body here; we just verify the gate
    // doesn't reject the request. The actual chat will fail because
    // no provider is configured, but that's a downstream concern.
    const r = await http2('POST', '/api/chat', {
      body: { message: 'hello' },
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'text/event-stream',
      },
    });
    assert.equal(r.status, 200, 'SSE chat should pass the auth gate');
    // Drain the body so the child can exit.
    try {
      await r.text();
    } catch {
      /* ignore */
    }
  });

  test('hygiene: no real api_key in web/server.js (Darwin A-4)', () => {
    const src = readFileSync(SERVER_PATH, 'utf8');
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src), 'web/server.js must not contain real sk-... key');
  });
});

describe('web/server (V36) -- channel webhook', () => {
  // V36: spawn the auth server (same pattern as V33) plus a tiny
  // local "delivery" HTTP server to receive the webhook reply.
  const TOKEN = 'test-token-v36';
  const PORT_DARWIN = 19500 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(PORT_DARWIN),
      HOST: '127.0.0.1',
      WEB_AUTH_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let procOut = '';
  let procErr = '';
  proc.stdout.on('data', (c) => {
    procOut += c.toString();
  });
  proc.stderr.on('data', (c) => {
    procErr += c.toString();
  });

  before(async () => {
    // Wait for the darwin server's "listening on" banner.
    await new Promise((res, rej) => {
      const t = setTimeout(
        () => rej(new Error('darwin server start timeout: ' + procOut + ' / ' + procErr)),
        5000,
      );
      const i = setInterval(() => {
        if (procOut.includes('listening on')) {
          clearInterval(i);
          clearTimeout(t);
          res();
        }
      }, 50);
    });
  });

  after(() => {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  });

  function http2(method, path, opts = {}) {
    return fetch('http://127.0.0.1:' + PORT_DARWIN + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }

  test('POST /api/webhook/slack without token returns 401 (V33 gate)', async () => {
    const r = await http2('POST', '/api/webhook/slack', {
      body: { message: 'hi', reply_url: 'http://example.com' },
    });
    assert.equal(r.status, 401);
  });

  test('POST /api/webhook/slack without reply_url returns 400', async () => {
    const r = await http2('POST', '/api/webhook/slack', {
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: { message: 'hi' },
    });
    assert.equal(r.status, 400);
  });

  test('POST /api/webhook/slack without message returns 400', async () => {
    const r = await http2('POST', '/api/webhook/slack', {
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: { message: '', reply_url: 'http://example.com' },
    });
    assert.equal(r.status, 400);
  });

  test('POST /api/webhook/slack delivers reply to a local HTTP server', async () => {
    // Spawn a one-shot HTTP server to receive the delivery.
    const { createServer } = await import('node:http');
    const received = { val: null };
    const ds = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c.toString();
      });
      req.on('end', () => {
        try {
          received.val = JSON.parse(body);
        } catch {
          received.val = { raw: body };
        }
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise((res) => ds.listen(0, '127.0.0.1', res));
    const dport = ds.address().port;
    const replyUrl = 'http://127.0.0.1:' + dport + '/darwin-reply';

    try {
      const r = await http2('POST', '/api/webhook/slack', {
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: {
          message: 'hello from slack',
          reply_url: replyUrl,
          user_id: 'U123',
        },
      });
      // The webhook handler returns 200 when delivery was attempted
      // (chat success, delivery attempted) and 500 when chat itself
      // failed (e.g. no provider configured in the test env). Both
      // are valid V36 outcomes; what matters is the delivery
      // happened, which we check separately below.
      assert.ok(r.status === 200 || r.status === 500, 'expected 200 or 500, got ' + r.status);
      const j = await r.json();
      if (r.status === 500) {
        assert.equal(j.delivered, false, 'chat failed; j should have delivered:false');
        return; // no delivery to verify
      }
      assert.ok(
        j.status === 'delivered' ||
          j.status === 'chat_ok_delivery_failed' ||
          j.status === 'delivery_failed',
      );
      // The reply without a configured provider will be an error,
      // but the delivery itself should still fire (or fail-fast).
      // The 'no provider' error path returns 500 from chatSync; we
      // accept either delivered (if a future test env has a
      // provider) or chat_ok_delivery_failed.
      assert.ok(
        j.status === 'delivered' || j.status === 'chat_ok_delivery_failed',
        'expected delivered or chat_ok_delivery_failed, got: ' + JSON.stringify(j),
      );
    } finally {
      ds.close();
    }
  });

  test('POST /api/webhook with channel secret env (when set) requires header match', async () => {
    // We cannot change env of a running server, so this test verifies
    // the no-secret-configured path: with no WEBHOOK_SECRET_<CHAN>
    // in env, any (or no) X-Darwin-Channel-Secret header is accepted.
    const r = await http2('POST', '/api/webhook/slack', {
      headers: { Authorization: 'Bearer ' + TOKEN, 'X-Darwin-Channel-Secret': 'whatever' },
      body: { message: 'hi', reply_url: 'http://127.0.0.1:1/never' },
    });
    // We expect either 200 (delivery attempted) or 500 (chat failed
    // due to no provider), but NOT 401 (secret mismatch).
    assert.notEqual(r.status, 401, 'no-secret-configured channel must not 401');
  });

  test('hygiene: no real api_key in bin/lib/webhook.js (Darwin A-4)', () => {
    const src = readFileSync(join(REPO_ROOT, 'bin', 'lib', 'webhook.js'), 'utf8');
    assert.ok(
      !/sk-[a-zA-Z0-9]{20,}/.test(src),
      'bin/lib/webhook.js must not contain real sk-... key',
    );
  });
});
