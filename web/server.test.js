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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = join(__dirname, 'server.js');

let baseUrl;
let serverProcess;
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
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
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
    // Give it a moment to exit cleanly.
    await new Promise((r) => setTimeout(r, 200));
    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL');
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
    assert.match(j.error, /message is required/);
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

describe('web/index.html (V32) — streaming chat UI', () => {
  test('GET / serves the chat HTML with V32 streaming markers', async () => {
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
    // V32 visual
    assert.ok(html.includes('caret'), 'index.html should show a blinking caret while streaming');
  });
});
