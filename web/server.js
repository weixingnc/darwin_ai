/**
 * web/server.js -- V28: zero-dependency HTTP server that exposes
 * `darwin chat` over a tiny JSON API. The web UI (web/index.html)
 * POSTs the user's message to /api/chat, and we shell out to
 * `node bin/darwin chat "<message>"` and return the response.
 *
 * Why zero-dep: a fresh `npm install --omit=dev` shouldn't have to
 * drag in express/fastify just to serve a 50-line HTML form. The
 * whole server is ~120 lines of Node stdlib.
 *
 * Why shell out to `bin/darwin` (not import): Darwin's chat flow
 * already handles provider config, env loading, plugin init, etc.
 * Reusing the CLI entrypoint means the web UI inherits everything
 * `darwin chat` already does correctly, with zero duplication.
 *
 * Endpoints:
 *   GET  /              -> serve web/index.html
 *   GET  /api/health    -> { ok: true, version: <package.json> }
 *   POST /api/chat      -> { reply: string }  (V28: default; no
 *                          Accept: text/event-stream header)
 *   POST /api/chat      -> text/event-stream  (V31: client sends
 *                          Accept: text/event-stream; we shell out
 *                          to `node bin/darwin chat --stream` and
 *                          translate its line protocol to SSE frames)
 *
 * V33: all non-health endpoints require a bearer token. The token
 * comes from one of:
 *   - Authorization: Bearer <token>
 *   - X-Darwin-Token: <token>  (fallback for clients that can't set
 *     the Authorization header, e.g. browser EventSource — though
 *     our web UI uses fetch() so this is rarely needed)
 *   - ?token=<token>  (query string, for one-shot links)
 * The token is read once at startup from process.env.WEB_AUTH_TOKEN
 * (set by `darwin web` from ~/.darwin/web.token). If the env var is
 * absent, auth is disabled (V28 compat for direct `node web/server.js`
 * users who didn't go through the CLI).
 *
 * Env:
 *   PORT             default 8080
 *   HOST             default 127.0.0.1
 *   WEB_AUTH_TOKEN   optional; when set, all routes except /api/health
 *                    require the matching bearer token
 *
 * V31 SSE frame shape (one chunk per `chunk:` line from the child):
 *   data: {"type":"chunk","text":"<text>"}\n\n
 *   data: {"type":"done"}\n\n
 *   data: {"type":"error","error":"<msg>"}\n\n
 *
 * Run:
 *   node web/server.js
 *
 * Test:
 *   node --test web/server.test.js
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  isChannelAllowed,
  verifyChannelSecret,
  chatSync,
  deliverReply,
} from '../bin/lib/webhook.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const INDEX_HTML = readFileSync(join(__dirname, 'index.html'), 'utf8');

let VERSION = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  VERSION = pkg.version || VERSION;
} catch {
  /* keep default */
}

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
// V33: when set, every non-/api/health route requires this token.
// Constant-time comparison to avoid timing-side-channel leaks.
const AUTH_TOKEN = process.env.WEB_AUTH_TOKEN || null;
// V33: when AUTH_TOKEN is null/undefined, auth is disabled (V28 compat
// for direct `node web/server.js` users who did not go through the CLI).

// Constant-time string comparison. Returns true if both are equal.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// V33: extract a candidate token from headers or query string.
function extractToken(req, url) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xTok = req.headers['x-darwin-token'];
  if (typeof xTok === 'string' && xTok.length > 0) {
    return xTok.trim();
  }
  const qTok = url.searchParams.get('token');
  if (qTok && qTok.length > 0) {
    return qTok;
  }
  return null;
}

// V33: 401 response with a clear JSON body + a WWW-Authenticate hint.
function deny(res) {
  setCors(res);
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Bearer realm="darwin-web", charset="utf-8"');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      error: 'auth required',
      hint: 'Set Authorization: Bearer <token>, or ?token=<token> in the URL',
    }),
  );
}

// V33: gate everything except /api/health.
function requireAuth(req, res, url) {
  if (!AUTH_TOKEN) {
    return true; // auth disabled
  }
  if (url.pathname === '/api/health') {
    return true;
  }
  const candidate = extractToken(req, url);
  if (candidate && safeEqual(candidate, AUTH_TOKEN)) {
    return true;
  }
  deny(res);
  return false;
}

function readJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        rejectBody(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveBody(text ? JSON.parse(text) : {});
      } catch (e) {
        rejectBody(new Error('invalid JSON: ' + e.message));
      }
    });
    req.on('error', rejectBody);
  });
}

function chatOnce(message) {
  return new Promise((resolveChat, rejectChat) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'bin', 'darwin'), 'chat', message], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', rejectChat);
    child.on('close', (code) => {
      if (code === 0) {
        resolveChat(stdout.trim());
      } else {
        const msg = (stderr || stdout).trim();
        rejectChat(new Error(msg || `darwin chat exited with code ${code}`));
      }
    });
  });
}

function streamChat(res, message) {
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'bin', 'darwin'), 'chat', '--stream', message],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  setCors(res);
  res.flushHeaders?.();

  let buf = '';
  let closed = false;

  const finish = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      child.kill('SIGTERM');
    } catch (_) {
      /* ignore */
    }
    try {
      res.end();
    } catch (_) {
      /* ignore */
    }
  };

  const sendFrame = (obj) => {
    if (closed) {
      return;
    }
    try {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
    } catch (_) {
      closed = true;
    }
  };

  child.stdout.on('data', (chunk) => {
    if (closed) {
      return;
    }
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith('chunk:')) {
        sendFrame({ type: 'chunk', text: line.slice('chunk:'.length) });
      } else if (line === 'done:') {
        sendFrame({ type: 'done' });
        finish();
        return;
      } else if (line.startsWith('error:')) {
        sendFrame({ type: 'error', error: line.slice('error:'.length) });
        finish();
        return;
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    if (closed) {
      return;
    }
    const text = chunk.toString('utf8').trim();
    if (text) {
      sendFrame({ type: 'error', error: text });
    }
    finish();
  });

  child.on('error', (e) => {
    sendFrame({ type: 'error', error: e.message });
    finish();
  });

  child.on('close', () => {
    if (!closed) {
      sendFrame({ type: 'done' });
    }
    finish();
  });

  res.on('close', () => {
    if (!closed) {
      try {
        child.kill('SIGTERM');
      } catch (_) {
        /* ignore */
      }
      closed = true;
    }
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Darwin-Token');
}

function send(res, status, body, contentType = 'application/json') {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType + '; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function handleOptions(_req, res) {
  setCors(res);
  res.statusCode = 204;
  res.end();
  return true;
}

async function handleGetRoot(_req, res) {
  send(res, 200, INDEX_HTML, 'text/html');
  return true;
}

async function handleGetHealth(_req, res) {
  send(res, 200, { ok: true, version: VERSION, auth_required: !!AUTH_TOKEN });
  return true;
}

async function handlePostChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    send(res, 400, { error: e.message });
    return true;
  }
  const message = body && typeof body.message === 'string' ? body.message : '';
  if (!message.trim()) {
    send(res, 400, { error: 'message is required' });
    return true;
  }
  const accept = String(req.headers['accept'] || '').toLowerCase();
  if (accept.includes('text/event-stream')) {
    streamChat(res, message);
    return true;
  }
  try {
    const reply = await chatOnce(message);
    send(res, 200, { reply });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
  return true;
}

// V36: channel webhook entry. URL: POST /api/webhook/<channel>.
// Body: { message, reply_url, user_id?, meta? }
// Headers (optional): X-Darwin-Channel-Secret: <secret>
// Behaviour:
//   1. V33 auth (handled upstream by requireAuth).
//   2. Channel allowlist (env WEBHOOK_CHANNELS, comma-separated;
//      empty = allow all).
//   3. Per-channel secret (env WEBHOOK_SECRET_<UPPER>) if set.
//   4. Run `darwin chat` synchronously and POST { reply, channel,
//      user_id?, meta? } to reply_url. We always 200 to the
//      caller as soon as the chat call returns, even if delivery
//      fails -- the caller's webhook is fire-and-forget; delivery
//      failures are reported in the JSON body so the caller can
//      decide to retry.
function authorizeChannel(req, channel) {
  if (!isChannelAllowed(channel)) {
    return { ok: false, status: 403, error: 'channel not allowed' };
  }
  const provided = req.headers['x-darwin-channel-secret'];
  if (!verifyChannelSecret(channel, provided)) {
    return { ok: false, status: 401, error: 'channel secret mismatch' };
  }
  return { ok: true };
}

async function readWebhookBody(req) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return { ok: false, status: 400, error: e.message };
  }
  const message = body && typeof body.message === 'string' ? body.message : '';
  if (!message.trim()) {
    return { ok: false, status: 400, error: 'message is required' };
  }
  const replyUrl = body && typeof body.reply_url === 'string' ? body.reply_url : '';
  if (!replyUrl) {
    return { ok: false, status: 400, error: 'reply_url is required' };
  }
  return {
    ok: true,
    value: {
      message,
      replyUrl,
      userId: body && typeof body.user_id === 'string' ? body.user_id : null,
      meta: body && body.meta && typeof body.meta === 'object' ? body.meta : null,
    },
  };
}

async function handlePostWebhook(req, res, _url, channel) {
  const auth = authorizeChannel(req, channel);
  if (!auth.ok) {
    send(res, auth.status, { error: auth.error, channel });
    return true;
  }
  const parsed = await readWebhookBody(req);
  if (!parsed.ok) {
    send(res, parsed.status, { error: parsed.error });
    return true;
  }
  const { message, replyUrl, userId, meta } = parsed.value;
  let reply;
  try {
    reply = await chatSync(message);
  } catch (e) {
    send(res, 500, { error: e.message, channel, delivered: false });
    return true;
  }
  let delivery;
  try {
    delivery = await deliverReply(replyUrl, {
      reply,
      channel,
      user_id: userId,
      meta,
    });
  } catch (e) {
    send(res, 200, {
      status: 'chat_ok_delivery_failed',
      channel,
      delivery_error: e.message,
    });
    return true;
  }
  send(res, 200, {
    status: delivery.ok ? 'delivered' : 'delivery_failed',
    channel,
    delivery_status: delivery.status,
  });
  return true;
}

async function handleNotFound(_req, res) {
  send(res, 404, { error: 'not found' });
  return true;
}

const ROUTES = [
  ['OPTIONS', null, handleOptions],
  ['GET', '/', handleGetRoot],
  ['GET', '/index.html', handleGetRoot],
  ['GET', '/api/health', handleGetHealth],
  ['POST', '/api/chat', handlePostChat],
];

// V36: prefix-matched routes. Each entry: [method, prefix, handler].
// The handler receives (req, res, url, capturedPath) where
// capturedPath is url.pathname.slice(prefix.length). Empty string
// when the URL ends at the prefix.
const PREFIX_ROUTES = [['POST', '/api/webhook/', handlePostWebhook]];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const method = req.method;

  // V33: gate everything except /api/health on the bearer token.
  // We do this BEFORE the route table so an unauthenticated request
  // never reaches a handler (even a 404).
  if (!requireAuth(req, res, url)) {
    return;
  }

  for (const [m, path, handler] of ROUTES) {
    if (method !== m) {
      continue;
    }
    if (path !== null && url.pathname !== path) {
      continue;
    }
    await handler(req, res);
    return;
  }

  for (const [m, prefix, handler] of PREFIX_ROUTES) {
    if (method !== m) {
      continue;
    }
    if (!url.pathname.startsWith(prefix)) {
      continue;
    }
    const captured = url.pathname.slice(prefix.length);
    await handler(req, res, url, captured);
    return;
  }

  await handleNotFound(req, res);
});

export { server, PORT, HOST, AUTH_TOKEN };

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Darwin web UI listening on http://${HOST}:${PORT}\n`);
    process.stdout.write('  GET  /              -> chat form\n');
    process.stdout.write('  GET  /api/health    -> { ok, version, auth_required }\n');
    process.stdout.write(
      '  POST /api/chat      -> { reply }            (Accept: application/json)\n',
    );
    process.stdout.write(
      '  POST /api/chat      -> text/event-stream    (Accept: text/event-stream, V31)\n',
    );
    process.stdout.write('  POST /api/webhook/<channel> -> channel webhook (V36)\n');
    if (AUTH_TOKEN) {
      process.stdout.write('Auth: WEB_AUTH_TOKEN is set; non-health routes require it.\n');
    } else {
      process.stdout.write('Auth: WEB_AUTH_TOKEN not set; all routes open (V28 compat).\n');
    }
    process.stdout.write('Press Ctrl+C to stop.\n');
  });
}
