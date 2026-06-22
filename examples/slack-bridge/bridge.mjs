#!/usr/bin/env node
/**
 * examples/slack-bridge/bridge.mjs
 *
 * Slack <-> Darwin bridge (V37). A standalone Node script that
 * sits between Slack's Events API and the darwin webhook layer
 * (V36), so a Slack workspace can use darwin as its AI backend.
 *
 * Two HTTP routes:
 *   POST /slack/events   -- Slack's Events API endpoint. Handles
 *                           url_verification (challenge echo) and
 *                           event_callback (message events only).
 *                           Forwards the message text to darwin
 *                           via /api/webhook/slack with reply_url
 *                           pointing at this same server.
 *   POST /slack/reply    -- darwin's async delivery endpoint. We
 *                           capture the reply in memory and (in a
 *                           real deployment) POST it to Slack's
 *                           chat.postMessage API. For the example
 *                           we just log it; tests assert on it.
 *
 * Environment:
 *   PORT              (default 4000) -- this bridge's listen port
 *   DARWIN_URL        (default http://127.0.0.1:8080) -- darwin
 *                       web server base URL
 *   DARWIN_TOKEN      (required) -- V33 bearer token darwin expects
 *                       on the Authorization header
 *   DARWIN_CHANNEL    (default "slack") -- used in the V36 webhook
 *                       path. Path is built as
 *                       ${DARWIN_URL}/api/webhook/${DARWIN_CHANNEL}.
 *   SLACK_BOT_TOKEN   (optional) -- if set, the bridge will POST
 *                       the reply to Slack's chat.postMessage API
 *                       instead of just logging it. Omit for
 *                       local dev / test runs.
 *
 * Usage:
 *   # 1. Start darwin web (in another terminal):
 *   darwin web --port 8080
 *   # 2. Start the bridge:
 *   DARWIN_TOKEN=your-darwin-token PORT=4000 \
 *     node examples/slack-bridge/bridge.mjs
 *   # 3. Point your Slack app's Events Request URL at
 *   #    http://your-host:4000/slack/events
 *
 * The bridge is intentionally tiny (no framework, no Slack SDK)
 * so you can read it end-to-end in a few minutes and adapt it
 * to your own deployment.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 4000;
const DARWIN_URL = (process.env.DARWIN_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const DARWIN_TOKEN = process.env.DARWIN_TOKEN || '';
const DARWIN_CHANNEL = process.env.DARWIN_CHANNEL || 'slack';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

// In-memory record of the last N replies the bridge has handled.
// Used by tests; harmless in production (memory is bounded by
// MAX_REPLY_HISTORY, oldest entries fall off the front).
const MAX_REPLY_HISTORY = 50;
const replyHistory = [];

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
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
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
  const replyUrl = 'http://127.0.0.1:' + PORT + '/slack/reply';
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

async function postToSlack(channel, text) {
  if (!SLACK_BOT_TOKEN) {
    // Local dev / test path: just log.
    return { ok: true, mocked: true };
  }
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SLACK_BOT_TOKEN,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: j.ok === true, slack: j };
}

function isUrlVerification(body) {
  return !!(body && body.type === 'url_verification' && body.challenge);
}

function isUserMessage(body) {
  return !!(
    body &&
    body.type === 'event_callback' &&
    body.event &&
    body.event.type === 'message' &&
    !body.event.bot_id &&
    !body.event.subtype
  );
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

function forwardAndRecord(text, userId, channel, meta) {
  forwardToDarwin(text, userId, meta)
    .then((fw) => {
      pushHistory({
        ts: Date.now(),
        user: userId,
        channel,
        forward_status: fw.status,
        forward_body: fw.body,
      });
    })
    .catch((e) => {
      pushHistory({
        ts: Date.now(),
        user: userId,
        channel,
        forward_error: e.message,
      });
    });
}

async function handleSlackEvents(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  if (isUrlVerification(body)) {
    return ackUrlVerification(res, body);
  }
  if (isUserMessage(body)) {
    const text = String(body.event.text || '').trim();
    if (!text) {
      return json(res, 200, { ok: true, skipped: 'empty' });
    }
    const userId = body.event.user || null;
    const channel = body.event.channel || null;
    const meta = {
      team: body.team_id || null,
      event_id: body.event.event_id || null,
      ts: body.event.ts || null,
    };
    // Fire-and-forget: ack Slack immediately, let darwin POST back
    // to /slack/reply when the chat is done.
    forwardAndRecord(text, userId, channel, meta);
    return ackForwarded(res);
  }
  return ackIgnored(res);
}

async function handleSlackReply(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const text = body && body.reply;
  const channel = body && body.user_id;
  pushHistory({
    ts: Date.now(),
    kind: 'reply',
    user: channel,
    text,
    forward: await postToSlack(channel, text).catch((e) => ({ ok: false, error: e.message })),
  });
  return json(res, 200, { ok: true });
}

function handleHealth(_req, res) {
  return json(res, 200, {
    ok: true,
    bridge: 'darwin-slack-bridge',
    version: '0.1.0',
    darwin_url: DARWIN_URL,
    darwin_channel: DARWIN_CHANNEL,
    slack_bot_configured: !!SLACK_BOT_TOKEN,
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/slack/events') {
    return handleSlackEvents(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/slack/reply') {
    return handleSlackReply(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return handleHealth(req, res);
  }
  json(res, 404, { error: 'not found' });
});

export { server };

// Auto-start when run as a script (not when imported by tests).
if (import.meta.url === 'file://' + process.argv[1]) {
  server.listen(PORT, () => {
    process.stdout.write(
      'slack-bridge listening on http://127.0.0.1:' + PORT + '\n' +
        '  POST /slack/events   -- Slack Events API endpoint\n' +
        '  POST /slack/reply    -- darwin delivery endpoint\n' +
        '  GET  /health         -- bridge health\n' +
        'forwarding to darwin at ' + DARWIN_URL + '/api/webhook/' + DARWIN_CHANNEL + '\n' +
        'slack chat.postMessage: ' + (SLACK_BOT_TOKEN ? 'enabled' : 'mocked (set SLACK_BOT_TOKEN to enable)') + '\n',
    );
  });
}
