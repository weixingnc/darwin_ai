/**
 * examples/feishu-bridge/bridge.test.mjs
 *
 * V38 integration test for the Feishu <-> Darwin bridge. Mirrors
 * the structure of examples/slack-bridge/bridge.test.mjs (V37) with
 * the Feishu-specific bits changed: Feishu event type
 * `im.message.receive_v1`, content as JSON-encoded blob, and
 * X-Lark-Signature verification (when configured).
 *
 * Uses waitForPort() (see V37 PM note) to dodge Node's --test
 * runner stdio capture that breaks 'data' event listeners.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const BRIDGE = join(__dirname, 'bridge.mjs');
const DARWIN_SERVER = join(REPO_ROOT, 'web', 'server.js');

const TOKEN = 'test-bridge-token-v38';
const ENCRYPT_KEY = 'test-feishu-encrypt-key-v38';
let bridgeProc;
let darwinProc;
let bridgePort = 0;
let darwinPort = 0;

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
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
}

function feishuSignatureHeaders(encryptKey, _rawBody) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', encryptKey).update(ts + encryptKey).digest('base64');
  return {
    'X-Lark-Request-Timestamp': ts,
    'X-Lark-Signature': sig,
  };
}

before(async () => {
  darwinPort = 22000 + Math.floor(Math.random() * 1000);
  darwinProc = spawn(process.execPath, [DARWIN_SERVER], {
    env: {
      ...process.env,
      PORT: String(darwinPort),
      HOST: '127.0.0.1',
      WEB_AUTH_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForPort(darwinPort, 10000);

  bridgePort = 23000 + Math.floor(Math.random() * 1000);
  bridgeProc = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      PORT: String(bridgePort),
      DARWIN_URL: 'http://127.0.0.1:' + darwinPort,
      DARWIN_TOKEN: TOKEN,
      DARWIN_CHANNEL: 'feishu',
      FEISHU_ENCRYPT_KEY: ENCRYPT_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForPort(bridgePort, 10000);
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

describe('feishu-bridge (V38) -- Feishu <-> Darwin integration', () => {
  test('GET /health reports darwin URL, channel, signature check', async () => {
    const r = await http('http://127.0.0.1:' + bridgePort + '/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.bridge, 'darwin-feishu-bridge');
    assert.equal(j.darwin_url, 'http://127.0.0.1:' + darwinPort);
    assert.equal(j.darwin_channel, 'feishu');
    assert.equal(j.feishu_signature_check, true);
  });

  test('POST /feishu/events handles url_verification by echoing the challenge', async () => {
    // url_verification payloads come from Feishu and ARE signed when
    // an encrypt key is configured. We sign with the same key the
    // bridge was started with.
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'feishu-challenge-abc' });
    const sigHeaders = feishuSignatureHeaders(ENCRYPT_KEY, raw);
    const r = await http('http://127.0.0.1:' + bridgePort + '/feishu/events', {
      method: 'POST',
      headers: sigHeaders,
      body: raw,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.challenge, 'feishu-challenge-abc');
  });

  test('POST /feishu/events rejects bad signature with 401', async () => {
    const r = await http('http://127.0.0.1:' + bridgePort + '/feishu/events', {
      method: 'POST',
      headers: { 'X-Lark-Signature': 'wrong-sig', 'X-Lark-Request-Timestamp': '1700000000' },
      body: { type: 'url_verification', challenge: 'x' },
    });
    assert.equal(r.status, 401);
  });

  test('POST /feishu/events accepts a signed user message and forwards to darwin', async () => {
    const payload = {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', app_id: 'cli_test', tenant_key: 'tk_test' },
      type: 'event_callback',
      event: {
        sender: { sender_id: { open_id: 'ou_test_user' } },
        message: {
          message_id: 'om_test_1',
          chat_id: 'oc_test_chat',
          chat_type: 'p2p',
          content: JSON.stringify({ text: 'hello from feishu' }),
          create_time: '1700000000000',
        },
      },
    };
    const raw = JSON.stringify(payload);
    const sigHeaders = feishuSignatureHeaders(ENCRYPT_KEY, raw);
    const r = await http('http://127.0.0.1:' + bridgePort + '/feishu/events', {
      method: 'POST',
      headers: sigHeaders,
      body: raw,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.accepted, true);
  });

  test('POST /feishu/events ignores bot messages (bot_id present)', async () => {
    const payload = {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', app_id: 'cli_test' },
      type: 'event_callback',
      event: {
        sender: { sender_id: { open_id: 'ou_bot' } },
        message: {
          message_id: 'om_bot_1',
          chat_id: 'oc_test',
          chat_type: 'p2p',
          content: JSON.stringify({ text: 'bot echo' }),
          bot_id: 'cli_bot',
        },
      },
    };
    const raw = JSON.stringify(payload);
    const sigHeaders = feishuSignatureHeaders(ENCRYPT_KEY, raw);
    const r = await http('http://127.0.0.1:' + bridgePort + '/feishu/events', {
      method: 'POST',
      headers: sigHeaders,
      body: raw,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ignored, true);
  });
});
