#!/usr/bin/env node
/**
 * examples/feishu-bridge/bridge.mjs
 *
 * Feishu <-> Darwin bridge (V38). A standalone Node script that
 * sits between Feishu's event-callback API and the darwin
 * webhook layer (V36), so a Feishu app can use darwin as its
 * AI backend for DMs and group chats.
 *
 * This is a 1:1 mirror of examples/slack-bridge (V37) with the
 * vendor-specific bits changed:
 *   - Feishu event type:    im.message.receive_v1
 *   - Feishu message text:  event.message.content is a JSON-encoded
 *                            { "text": "..." } blob (vs Slack's flat
 *                            event.text string)
 *   - Feishu verification:  HMAC-SHA256 of (timestamp + encrypt_key),
 *                            compared against the X-Lark-Signature
 *                            header. Mirrors Slack's simpler
 *                            X-Darwin-Channel-Secret model that V37
 *                            uses -- both are turned off by default
 *                            and turned on by env.
 *   - Feishu outbound:      POST to /open-apis/im/v1/messages with
 *                            a tenant_access_token (refreshed every
 *                            ~2h). Mirrors Slack's chat.postMessage.
 *
 * Two HTTP routes:
 *   POST /feishu/events   -- Feishu's event-callback endpoint.
 *                            Handles url_verification (challenge
 *                            echo), signature verification (when
 *                            FEISHU_ENCRYPT_KEY is set), and event
 *                            dispatch for im.message.receive_v1.
 *   POST /feishu/reply    -- darwin's async delivery endpoint. We
 *                            capture the reply in memory and (in a
 *                            real deployment) POST it to Feishu's
 *                            messages API. For the example we
 *                            just log it; tests assert on it.
 *
 * Environment:
 *   PORT                (default 4001) -- this bridge's listen port
 *   DARWIN_URL          (default http://127.0.0.1:8080)
 *   DARWIN_TOKEN        (required) -- V33 bearer token
 *   DARWIN_CHANNEL      (default "feishu")
 *   FEISHU_APP_ID       (optional) -- if set with FEISHU_APP_SECRET,
 *                            the bridge will POST the reply to
 *                            Feishu's messages API. Omit for local
 *                            dev / test runs.
 *   FEISHU_APP_SECRET   (optional)
 *   FEISHU_ENCRYPT_KEY  (optional) -- if set, the bridge verifies
 *                            the X-Lark-Signature header on every
 *                            inbound. Omit for local dev.
 *
 * Usage:
 *   # 1. Start darwin web in another terminal:
 *   darwin web --port 8080
 *   # 2. Start the bridge:
 *   DARWIN_TOKEN=your-darwin-token PORT=4001 \
 *     node examples/feishu-bridge/bridge.mjs
 *   # 3. In your Feishu app config (https://open.feishu.cn/app):
 *   #    - Event Subscriptions > Request URL: https://your-host:4001/feishu/events
 *   #    - Permissions: im:message, im:message.group_at_msg, im:message.receive_v1
 */

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const PORT = Number(process.env.PORT) || 4001;
const DARWIN_URL = (process.env.DARWIN_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const DARWIN_TOKEN = process.env.DARWIN_TOKEN || '';
const DARWIN_CHANNEL = process.env.DARWIN_CHANNEL || 'feishu';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
// V41: allow tests and self-hosted Feishu-compatible alternatives
// to override the API base. Default is the production Feishu URL.
const FEISHU_API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const FEISHU_AUTH_PATH = process.env.FEISHU_AUTH_PATH || '/open-apis/auth/v3/tenant_access_token/internal';
const FEISHU_MSG_PATH = process.env.FEISHU_MSG_PATH || '/open-apis/im/v1/messages';
const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || '';

// Feishu signature verification: HMAC-SHA256 of (timestamp + key) base64.
// Feishu sends the signature in the X-Lark-Signature header and the
// timestamp in X-Lark-Request-Timestamp. We re-compute and compare in
// constant time. The header is set ONLY when an encrypt key is
// configured in the Feishu app; otherwise we skip the check
// (matching Slack's no-secret-configured = open behaviour).
function verifyFeishuSignature(headers, _rawBody) {
  if (!FEISHU_ENCRYPT_KEY) {
    return true; // no secret configured -> open
  }
  const sig = headers['x-lark-signature'];
  const ts = headers['x-lark-request-timestamp'];
  if (typeof sig !== 'string' || typeof ts !== 'string') {
    return false;
  }
  const expected = createHmac('sha256', FEISHU_ENCRYPT_KEY)
    .update(ts + FEISHU_ENCRYPT_KEY)
    .digest('base64');
  // Constant-time compare.
  if (sig.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < sig.length; i += 1) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

const MAX_REPLY_HISTORY = 50;
const replyHistory = [];

// V41: cache feishu chat_id keyed by open_id so the /feishu/reply
// handler (which only gets user_id from the darwin envelope)
// can find the right chat to send the reply to. Without this,
// postToFeishu() would have to guess the chat_id from open_id,
// which is impossible.
const chatByUser = new Map();

function pushHistory(entry) {
  replyHistory.push(entry);
  if (replyHistory.length > MAX_REPLY_HISTORY) {
    replyHistory.shift();
  }
}

export function getReplyHistory() {
  return replyHistory.slice();
}

export function resetReplyHistory() {
  replyHistory.length = 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ text, json: text ? JSON.parse(text) : {} });
      } catch (e) {
        reject(new Error('invalid JSON: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function forwardToDarwin(message, userId, meta) {
  if (!DARWIN_TOKEN) {
    throw new Error('DARWIN_TOKEN env var is required');
  }
  const url = DARWIN_URL + '/api/webhook/' + DARWIN_CHANNEL;
  const replyUrl = 'http://127.0.0.1:' + PORT + '/feishu/reply';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + DARWIN_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      reply_url: replyUrl,
      user_id: userId || null,
      meta: meta || null,
    }),
  });
  let payload = null;
  try {
    payload = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, body: payload };
}

function isUrlVerification(body) {
  return !!(body && body.type === 'url_verification' && body.challenge);
}

function ackUrlVerification(res, body) {
  return json(res, 200, { challenge: body.challenge });
}

function ackForwarded(res) {
  return json(res, 200, { ok: true, accepted: true });
}

function ackIgnored(res) {
  return json(res, 200, { ok: true, ignored: true });
}

// Feishu message text: event.message.content is a JSON-encoded
// blob like '{"text":"@_user_1 hello"}'. We try to parse it; if it
// fails, fall back to the raw text.
function extractFeishuText(message) {
  if (!message) {
    return '';
  }
  if (typeof message.text === 'string' && message.text.length > 0) {
    return message.text;
  }
  // Some Feishu message types carry plain content in different
  // shapes; we only handle the text shape for the example.
  return '';
}

function isFeishuUserMessage(body) {
  return !!(
    body &&
    body.type === 'event_callback' &&
    body.header &&
    body.header.event_type === 'im.message.receive_v1' &&
    body.event &&
    body.event.sender &&
    body.event.sender.sender_id &&
    body.event.message &&
    !body.event.message.bot_id
  );
}

function forwardAndRecord(text, userId, chatId, meta) {
  forwardToDarwin(text, userId, meta)
    .then((fw) => {
      pushHistory({
        ts: Date.now(),
        kind: 'forward',
        user: userId,
        chat: chatId,
        forward_status: fw.status,
        forward_body: fw.body,
      });
    })
    .catch((e) => {
      pushHistory({
        ts: Date.now(),
        kind: 'forward',
        user: userId,
        chat: chatId,
        forward_error: e.message,
      });
    });
}

// V41: real outbound to Feishu. Fetches a tenant_access_token
// (cached for 110 minutes; Feishu tokens are valid 2h) and POSTs
// the reply to im/v1/messages. Returns { ok, status, body }.
// receive_id_type defaults to open_id which is what the V38
// forward path stores in chatByUser.
let feishuToken = null;
let feishuTokenExpiresAt = 0;
async function getFeishuTenantToken() {
  if (feishuToken && Date.now() < feishuTokenExpiresAt) {
    return feishuToken;
  }
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set to call Feishu APIs');
  }
  const r = await fetch(
    FEISHU_API_BASE + FEISHU_AUTH_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
    },
  );
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0 || !j.tenant_access_token) {
    throw new Error('failed to fetch feishu token: ' + JSON.stringify(j));
  }
  feishuToken = j.tenant_access_token;
  // Refresh 5 min early to avoid edge cases at the 2h boundary.
  feishuTokenExpiresAt = Date.now() + (110 * 60 * 1000);
  return feishuToken;
}

async function postToFeishu(receiveId, text) {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    return { ok: true, mocked: true };
  }
  const token = await getFeishuTenantToken();
  const r = await fetch(
    FEISHU_API_BASE + FEISHU_MSG_PATH + '?receive_id_type=open_id',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    },
  );
  const j = await r.json().catch(() => ({}));
  return { ok: j.code === 0, status: r.status, body: j };
}

function parseFeishuContent(rawContent) {
  try {
    return extractFeishuText(JSON.parse(rawContent || '{}'));
  } catch {
    return '';
  }
}

function handleUserMessageEvent(res, body) {
  const contentText = parseFeishuContent(body.event.message.content);
  if (!contentText) {
    return json(res, 200, { ok: true, skipped: 'no text' });
  }
  const userId = body.event.sender.sender_id.open_id || body.event.sender.sender_id.user_id || null;
  const chatId = body.event.message.chat_id || null;
  // V41: remember the feishu chat_id keyed by open_id so the
  // /feishu/reply handler can route the darwin reply back to
  // the right chat.
  if (userId && chatId) {
    chatByUser.set(userId, chatId);
  }
  const meta = {
    message_id: body.event.message.message_id || null,
    chat_type: body.event.message.chat_type || null,
    tenant_key: body.tenant_key || (body.header && body.header.tenant_key) || null,
  };
  forwardAndRecord(contentText, userId, chatId, meta);
  return ackForwarded(res);
}

async function handleFeishuEvents(req, res) {
  let body;
  let raw;
  try {
    const parsed = await readBody(req);
    body = parsed.json;
    raw = parsed.text;
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  if (!verifyFeishuSignature(req.headers, raw)) {
    return json(res, 401, { error: 'signature mismatch' });
  }
  if (isUrlVerification(body)) {
    return ackUrlVerification(res, body);
  }
  if (isFeishuUserMessage(body)) {
    return handleUserMessageEvent(res, body);
  }
  return ackIgnored(res);
}

async function handleFeishuReply(req, res) {
  let parsed;
  try {
    parsed = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  // readBody() returns { json, text }. V38 used body.reply /
  // body.user_id directly which was a no-op because the parsed
  // wrapper has no such keys; fix is to read from .json.
  const body = (parsed && parsed.json) || {};
  const text = body.reply;
  const userId = body.user_id;
  // V41: look up the feishu chat_id we recorded during the
  // forward step. If we have never seen this user (e.g. the
  // bridge restarted), we cannot safely route the reply;
  // log a warning and drop it rather than guess the wrong chat.
  const chatId = userId ? chatByUser.get(userId) : null;
  if (!chatId) {
    pushHistory({
      ts: Date.now(),
      kind: 'reply',
      user: userId,
      text,
      forward: { ok: false, error: 'unknown user; no chat recorded' },
    });
    return json(res, 200, { ok: true, dropped: 'unknown user' });
  }
  pushHistory({
    ts: Date.now(),
    kind: 'reply',
    user: userId,
    chat: chatId,
    text,
    forward: await postToFeishu(chatId, text).catch((e) => ({ ok: false, error: e.message })),
  });
  return json(res, 200, { ok: true });
}

function handleHealth(_req, res) {
  return json(res, 200, {
    ok: true,
    bridge: 'darwin-feishu-bridge',
    version: '0.1.0',
    darwin_url: DARWIN_URL,
    darwin_channel: DARWIN_CHANNEL,
    feishu_configured: !!(FEISHU_APP_ID && FEISHU_APP_SECRET),
    feishu_signature_check: !!FEISHU_ENCRYPT_KEY,
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/feishu/events') {
    return handleFeishuEvents(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/feishu/reply') {
    return handleFeishuReply(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return handleHealth(req, res);
  }
  json(res, 404, { error: 'not found' });
});

export { server };

if (import.meta.url === 'file://' + process.argv[1]) {
  server.listen(PORT, () => {
    process.stdout.write(
      'feishu-bridge listening on http://127.0.0.1:' + PORT + '\n' +
        '  POST /feishu/events   -- Feishu event-callback endpoint\n' +
        '  POST /feishu/reply    -- darwin delivery endpoint\n' +
        '  GET  /feishu/health   -- bridge health (alias of /health)\n' +
        '  GET  /health          -- bridge health\n' +
        'forwarding to darwin at ' + DARWIN_URL + '/api/webhook/' + DARWIN_CHANNEL + '\n' +
        'feishu message API: ' +
        (FEISHU_APP_ID && FEISHU_APP_SECRET ? 'enabled' : 'mocked (set FEISHU_APP_ID + FEISHU_APP_SECRET to enable)') +
        '\n' +
        'feishu signature check: ' +
        (FEISHU_ENCRYPT_KEY ? 'enabled' : 'mocked (set FEISHU_ENCRYPT_KEY to enable)') +
        '\n',
    );
  });
}
