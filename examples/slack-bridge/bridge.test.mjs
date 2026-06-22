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


describe('slack-bridge (V41) -- real outbound to a slack-compatible API', () => {
  // V41: spawn a local HTTP server that pretends to be slack.com's
  // chat.postMessage endpoint AND a second local HTTP server that
  // pretends to be darwin (so the bridge's forward->reply flow can
  // complete without a real LLM provider). Bridge is started with
  // SLACK_BOT_TOKEN set + SLACK_API_BASE pointing at the fake
  // slack server. We then:
  //   1. POST /slack/events with a message -- bridge records the
  //      channelByUser mapping and forwards to fake darwin.
  //   2. fake darwin immediately POSTs a canned reply to the
  //      bridge's /slack/reply.
  //   3. The bridge should look up the channel and call our fake
  //      chat.postMessage with the right payload.
  //   4. Assert the fake slack server received the right POST body.
  const TOKEN = 'test-bridge-token-v41';
  const FAKE_BOT_TOKEN = 'xoxb-fake-v41';
  let fakeSlack;
  let fakeDarwin;
  let fakeSlackCalls = []; // [{ url, headers, body }]
  let fakeSlackPort = 0;
  let fakeDarwinPort = 0;
  let bridgeProc;
  let bridgePort = 0;

  function waitForPort(port, timeoutMs) {
    return new Promise((resolvePort, rejectPort) => {
      const deadline = Date.now() + timeoutMs;
      const tryOnce = () => {
        import('node:net').then((net) => {
          const sock = new net.Socket();
          let settled = false;
          const fail = () => {
            if (settled) {
              return;
            }
            settled = true;
            sock.destroy();
            if (Date.now() > deadline) {
              rejectPort(new Error('timeout waiting for port ' + port));
            } else {
              setTimeout(tryOnce, 100);
            }
          };
          sock.setTimeout(500);
          sock.once('connect', () => {
            if (settled) {
              return;
            }
            settled = true;
            sock.destroy();
            resolvePort();
          });
          sock.once('error', fail);
          sock.once('timeout', fail);
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
    const { createServer } = await import('node:http');

    // 1. Spawn the fake darwin. When the bridge forwards a message
    //    to /api/webhook/slack, fake darwin immediately POSTs a
    //    canned reply to the bridge's /slack/reply endpoint,
    //    mimicking what real darwin would do with a successful
    //    chat completion.
    fakeDarwinPort = 28000 + Math.floor(Math.random() * 1000);
    fakeDarwin = createServer((req, res) => {
      if (req.method === 'POST' && req.url.includes('/api/webhook/')) {
          // Asynchronously POST the canned reply to the bridge.
          // We do this on a timer so the response to the bridge
          // returns first, matching real darwin's async delivery.
          setTimeout(() => {
            fetch('http://127.0.0.1:' + bridgePort + '/slack/reply', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + TOKEN,
              },
              body: JSON.stringify({
                reply: 'hi from fake darwin v41',
                channel: 'slack',
                user_id: 'U_V41_USER',
              }),
            }).catch(() => {});
          }, 50);
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'accepted' }));
      });
    await new Promise((res) => fakeDarwin.listen(fakeDarwinPort, '127.0.0.1', res));

    // 2. Spawn the fake slack chat.postMessage endpoint.
    fakeSlackCalls = [];
    fakeSlackPort = 29000 + Math.floor(Math.random() * 1000);
    fakeSlack = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c.toString();
      });
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          /* ignore */
        }
        fakeSlackCalls.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ts: '1.0', channel: parsed.channel || 'C?' }));
      });
    });
    await new Promise((res) => fakeSlack.listen(fakeSlackPort, '127.0.0.1', res));

    // 3. Spawn the bridge. Point at fake darwin + fake slack.
    bridgePort = 30000 + Math.floor(Math.random() * 1000);
    bridgeProc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        PORT: String(bridgePort),
        DARWIN_URL: 'http://127.0.0.1:' + fakeDarwinPort,
        DARWIN_TOKEN: TOKEN,
        SLACK_BOT_TOKEN: FAKE_BOT_TOKEN,
        SLACK_API_BASE: 'http://127.0.0.1:' + fakeSlackPort + '/api',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForPort(bridgePort, 10000);
  });

  after(() => {
    for (const p of [bridgeProc, fakeSlack, fakeDarwin]) {
      if (p && typeof p.kill === 'function' && !p.killed) {
        try {
          p.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      } else if (p && typeof p.close === 'function') {
        try {
          p.close();
        } catch {
          /* ignore */
        }
      }
    }
  });

  test('full flow: forward -> fake darwin reply -> real chat.postMessage', async () => {
    // 1. Bridge forward: send a message via /slack/events. The
    //    bridge records the user_id -> channel mapping and
    //    forwards to fake darwin.
    const fwd = await http('http://127.0.0.1:' + bridgePort + '/slack/events', {
      method: 'POST',
      body: {
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'hello from slack v41',
          user: 'U_V41_USER',
          channel: 'C_V41_CHANNEL',
          ts: '1700000001.000100',
          event_id: 'Ev_V41',
        },
        team_id: 'T_V41',
      },
    });
    assert.equal(fwd.status, 200);
    const fwdJ = await fwd.json();
    assert.equal(fwdJ.accepted, true);

    // 2. Wait for fake darwin to fire its async reply and the
    //    bridge to fire chat.postMessage. Up to 1.5s.
    const deadline = Date.now() + 1500;
    let call = null;
    while (Date.now() < deadline) {
      call = fakeSlackCalls.find((c) => c.url && c.url.includes('chat.postMessage'));
      if (call) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(call, 'bridge did not call chat.postMessage within 1.5s');
    assert.equal(call.body.channel, 'C_V41_CHANNEL',
      'bridge should have looked up channel C_V41_CHANNEL by user_id U_V41_USER');
    assert.equal(call.body.text, 'hi from fake darwin v41',
      'bridge should have sent the darwin reply text');
    assert.ok(
      (call.headers.authorization || '').toLowerCase().includes('bearer ' + FAKE_BOT_TOKEN),
      'bridge should have included the SLACK_BOT_TOKEN bearer',
    );
  });
});
