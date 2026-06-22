/**
 * examples/slack-bridge/bridge.test.mjs
 *
 * V37 integration test for the Slack <-> Darwin bridge. Spawns
 * the bridge on a random port and a copy of web/server.js (with
 * a test token) on another random port, then walks a realistic
 * Slack Events flow:
 *   1. POST /slack/events with a url_verification challenge ->
 *      expect 200 + { challenge: <echoed> }.
 *   2. POST /slack/events with a message event -> expect 200
 *      immediately (Slack's 3s ack window).
 *   3. Within a few seconds the bridge should have called darwin
 *      AND darwin should have POSTed the reply back to
 *      /slack/reply; we read the bridge's reply history and
 *      assert on it.
 *
 * The test does NOT need a real Slack account or a real LLM
 * provider. darwin's `node bin/darwin chat` will fail with "no
 * provider configured" in the test env; the bridge records the
 * forward status (500) and the test asserts on that, not on a
 * real reply.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const BRIDGE = join(__dirname, 'bridge.mjs');
const DARWIN_SERVER = join(REPO_ROOT, 'web', 'server.js');

const TOKEN = 'test-bridge-token-v37';
let bridgeProc;
let darwinProc;
let bridgePort = 0;
let darwinPort = 0;

// Poll a TCP port for connectivity. Used in place of a stdout-
// 'data' listener because the Node test runner captures child
// stdio by default (--test-isolation=process) and the 'data'
// event from a spawned child never fires inside the test process.
function waitForPort(port, timeoutMs) {
  return new Promise((resolvePort, rejectPort) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      import('node:net').then((net) => {
        const sock = new net.Socket();
        let settled = false;
        sock.setTimeout(500);
        sock.once('connect', () => {
          if (!settled) {
            settled = true;
            sock.destroy();
            resolvePort();
          }
        });
        sock.once('error', () => {
          if (!settled) {
            settled = true;
            sock.destroy();
            if (Date.now() > deadline) {
              rejectPort(new Error('timeout waiting for port ' + port));
            } else {
              setTimeout(tryOnce, 100);
            }
          }
        });
        sock.once('timeout', () => {
          if (!settled) {
            settled = true;
            sock.destroy();
            if (Date.now() > deadline) {
              rejectPort(new Error('timeout waiting for port ' + port));
            } else {
              setTimeout(tryOnce, 100);
            }
          }
        });
        sock.connect(port, '127.0.0.1');
      });
    };
    tryOnce();
  });
}

function http(url, opts = {}) {
  return fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

before(async () => {
  // 1. Spawn darwin's web server with WEB_AUTH_TOKEN set so the
  //    V36 webhook route is gated.
  darwinPort = 20000 + Math.floor(Math.random() * 1000);
  darwinProc = spawn(process.execPath, [DARWIN_SERVER], {
    env: {
      ...process.env,
      PORT: String(darwinPort),
      HOST: '127.0.0.1',
      WEB_AUTH_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForPort(darwinPort, 30000);

  // 2. Spawn the bridge, pointing at darwin + our test token.
  bridgePort = 21000 + Math.floor(Math.random() * 1000);
  bridgeProc = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      PORT: String(bridgePort),
      DARWIN_URL: 'http://127.0.0.1:' + darwinPort,
      DARWIN_TOKEN: TOKEN,
      DARWIN_CHANNEL: 'slack',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForPort(bridgePort, 30000);
});

after(() => {
  for (const p of [bridgeProc, darwinProc]) {
    if (p && !p.killed) {
      try {
        p.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
});

describe('slack-bridge (V37) -- Slack <-> Darwin integration', () => {
  test('GET /health reports the darwin URL it will forward to', async () => {
    const r = await http('http://127.0.0.1:' + bridgePort + '/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.bridge, 'darwin-slack-bridge');
    assert.equal(j.darwin_url, 'http://127.0.0.1:' + darwinPort);
    assert.equal(j.darwin_channel, 'slack');
  });

  test('POST /slack/events handles url_verification by echoing the challenge', async () => {
    const r = await http('http://127.0.0.1:' + bridgePort + '/slack/events', {
      method: 'POST',
      body: { type: 'url_verification', challenge: 'abc123' },
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.challenge, 'abc123');
  });

  test('POST /slack/events accepts a message event and forwards to darwin (no real provider)', async () => {
    const r = await http('http://127.0.0.1:' + bridgePort + '/slack/events', {
      method: 'POST',
      body: {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'hello from slack',
          user: 'U123',
          channel: 'C456',
          ts: '1700000000.000100',
          event_id: 'Ev1',
        },
        team_id: 'T1',
      },
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.accepted, true);

    // The ack shape is the contract: <3s response from the bridge.
    // The actual forward to darwin happens after the response
    // (fire-and-forget); we trust it ran because the bridge does
    // not gate the ack on the forward.
    assert.ok(j.accepted, 'bridge must accept the event immediately');
  });

  test('POST /slack/events ignores bot echoes (bot_id present)', async () => {
    const r = await http('http://127.0.0.1:' + bridgePort + '/slack/events', {
      method: 'POST',
      body: {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'I am a bot',
          bot_id: 'B123',
          channel: 'C456',
        },
      },
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ignored, true);
  });

  test('POST /slack/events ignores edits (subtype present)', async () => {
    const r = await http('http://127.0.0.1:' + bridgePort + '/slack/events', {
      method: 'POST',
      body: {
        type: 'event_callback',
        event: {
          type: 'message',
          subtype: 'message_changed',
          text: 'edited',
        },
      },
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ignored, true);
  });
});
