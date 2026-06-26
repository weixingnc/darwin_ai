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
import { readFileSync, existsSync, statSync } from 'node:fs';
import {
  isChannelAllowed,
  verifyChannelSecret,
  chatSync,
  deliverReply,
} from '../bin/lib/webhook.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ConfigApi } from './config-api.js';

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

// V48 (security): CORS origin allowlist. Default = empty (same-origin only).
// Set CORS_ORIGIN to a comma-separated list of allowed origins (e.g.
// "http://localhost:3000,https://myapp.com") to enable cross-origin access.
// Use "*" to allow any origin (NOT recommended when AUTH_TOKEN is set, since
// stolen tokens have no same-origin protection in that mode).
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const CORS_ALLOWED_ORIGINS = CORS_ORIGIN
  ? CORS_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

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
function deny(req, res) {
  setCors(req, res);
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

// V33: gate API routes behind bearer auth. Static assets
// (HTML, JS, CSS, images) and /api/health are open so the web UI
// itself can boot before the user has logged in. The HTML
// includes the login form + boot() flow that prompts for a
// token; the JS then attaches the Authorization header on
// subsequent /api/* calls.
function requireAuth(req, res, url) {
  if (!AUTH_TOKEN) {
    return true; // auth disabled
  }
  // V44: open allow-list -- paths that are always reachable.
  if (url.pathname === '/api/health') {
    return true;
  }
  // Static assets referenced by index.html (storage.js, favicon,
  // future CSS) are served without auth. Anything that ends in a
  // common web asset extension is treated as static.
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.html')
  ) {
    return true;
  }
  // Everything else (the /api/* surface) needs a valid bearer.
  const candidate = extractToken(req, url);
  if (candidate && safeEqual(candidate, AUTH_TOKEN)) {
    return true;
  }
  deny(req, res);
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

// V47: extract a normalized messages array from the POST body. Accept
// either { messages: [{role, content}, ...] } (V47 multi-turn) or
// { message: "single string" } (V45.1 single-turn, kept for backward
// compat -- the test suite, curl scripts, and the bare-bones
// single-user UI all still work). Returns {error} when the body is
// malformed, so the handler can return 400.
const ALLOWED_ROLES = ['system', 'user', 'assistant', 'tool'];

function validateTurn(m, i) {
  if (!m || typeof m !== 'object') {
    return 'messages[' + i + '] must be an object';
  }
  if (ALLOWED_ROLES.indexOf(m.role) === -1) {
    return 'messages[' + i + '].role must be one of system|user|assistant|tool';
  }
  if (m.role !== 'tool' && (m.content === undefined || m.content === null || m.content === '')) {
    return 'messages[' + i + '].content is required';
  }
  return null;
}

function extractMessagesArray(arr) {
  if (arr.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }
  for (let i = 0; i < arr.length; i += 1) {
    const err = validateTurn(arr[i], i);
    if (err !== null) {
      return { error: err };
    }
  }
  return { messages: arr };
}

function parseMessagesBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'body must be a JSON object' };
  }
  if (Array.isArray(body.messages)) {
    return extractMessagesArray(body.messages);
  }
  if (typeof body.message === 'string' && body.message.trim().length > 0) {
    return { messages: [{ role: 'user', content: body.message }] };
  }
  return { error: 'message or non-empty messages array is required' };
}

function chatOnce(messages) {
  return new Promise((resolveChat, rejectChat) => {
    // V47: pass the full messages array via --messages <JSON>. The
    // JSON-encoded form survives argv cleanly because spawn() does
    // not re-parse each item, so quoting/newlines/UTF-8 are safe.
    const messagesJson = JSON.stringify(messages);
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'bin', 'darwin'), 'chat', '--messages', messagesJson],
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    );
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
        // V45.1: stdout now contains ONLY the model content (no banner,
        // no protocol tag -- those moved to stderr in V45.1). Trim
        // trailing newline; leading/trailing whitespace was always
        // intentional from the model's perspective.
        resolveChat(stdout.replace(/\n$/, ''));
        return;
      }
      // Failure path: prefer stderr (operator logs), fall back to stdout.
      const msg = (stderr || stdout).trim();
      rejectChat(new Error(msg || `darwin chat exited with code ${code}`));
    });
  });
}

function streamChat(req, res, messages) {
  const messagesJson = JSON.stringify(messages);
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'bin', 'darwin'), 'chat', '--stream', '--messages', messagesJson],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  setCors(req, res);
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
        // V45.1: chat.js#streamChat now JSON-encodes the chunk text so
        // any embedded \n in the reply survives a single-line frame
        // intact. Decode the same way before forwarding to the browser.
        // Falls back to the raw slice on JSON parse failure (older
        // chat.js / hand-rolled callers) so a regression in the encoder
        // does not silently drop content.
        const encoded = line.slice('chunk:'.length);
        let text = encoded;
        try {
          text = JSON.parse(encoded);
        } catch (_) {
          /* keep raw slice */
        }
        if (typeof text === 'string' && text.length > 0) {
          sendFrame({ type: 'chunk', text });
        }
      } else if (line.startsWith('reasoning:')) {
        // V46: separate reasoning channel for the collapsible thinking
        // panel. Same JSON-encoded line shape as chunk:. Empty strings
        // are dropped (model may emit a placeholder reasoning frame for
        // non-reasoning models and we don't want a flicker of an empty
        // panel).
        const encoded = line.slice('reasoning:'.length);
        let text = encoded;
        try {
          text = JSON.parse(encoded);
        } catch (_) {
          /* keep raw slice */
        }
        if (typeof text === 'string' && text.length > 0) {
          sendFrame({ type: 'reasoning', text });
        }
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

function setCors(req, res) {
  // V48 (security): CORS is opt-in via CORS_ORIGIN env var.
  // Default behavior (no env var): same-origin only — no Access-Control-Allow-Origin
  // header at all, so the browser blocks cross-origin XHR/fetch.
  const origin = req.headers.origin;
  if (CORS_ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Darwin-Token');
  // V48 (security): basic web hardening headers. These are safe defaults
  // for a localhost-only control-plane UI; they tighten behavior even when
  // auth is disabled.
  // - CSP: only self + inline (we use inline styles in index.html). No remote scripts.
  //   Upgrade-insecure-requests would force HTTPS, but the server is HTTP-only by
  //   default, so omit that directive to avoid mixed-content confusion.
  // - X-Content-Type-Options: prevent MIME sniffing.
  // - X-Frame-Options: deny embedding (anti-clickjacking).
  // - Referrer-Policy: don't leak the bearer token via Referer header.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function send(req, res, status, body, contentType = 'application/json') {
  setCors(req, res);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType + '; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function handleOptions(req, res) {
  setCors(req, res);
  res.statusCode = 204;
  res.end();
  return true;
}

async function handleGetRoot(req, res) {
  send(req, res, 200, INDEX_HTML, 'text/html');
  return true;
}

async function handleGetHealth(req, res) {
  send(req, res, 200, { ok: true, version: VERSION, auth_required: !!AUTH_TOKEN });
  return true;
}

// V44: serve a static file from web/ by relative path. The auth
// allow-list (V44 requireAuth) lets the request reach here
// without a token. We intentionally only serve files that are
// already checked into the repo; the path is hardcoded per route
// to avoid any user-controlled path traversal.
const STATIC_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};
function handleGetStatic(req, res, _url, relPath) {
  if (!relPath) {
    send(req, res, 400, { error: 'bad path' });
    return true;
  }
  if (relPath.includes('..') || relPath.startsWith('/')) {
    send(req, res, 400, { error: 'bad path' });
    return true;
  }
  const filePath = join(__dirname, relPath);
  if (!filePath.startsWith(__dirname + '/') && filePath !== __dirname) {
    send(req, res, 400, { error: 'bad path' });
    return true;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    send(req, res, 404, { error: 'not found' });
    return true;
  }
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const ct = STATIC_TYPES[ext] || 'application/octet-stream';
  try {
    const body = readFileSync(filePath);
    setCors(req, res);
    res.statusCode = 200;
    res.setHeader('Content-Type', ct + '; charset=utf-8');
    res.setHeader('Content-Length', body.length);
    res.end(body);
  } catch (e) {
    send(req, res, 500, { error: e.message });
  }
  return true;
}

async function handlePostChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    send(req, res, 400, { error: e.message });
    return true;
  }
  // V47: accept messages[] (multi-turn) or message (legacy single).
  const parsed = parseMessagesBody(body);
  if (parsed.error) {
    send(req, res, 400, { error: parsed.error });
    return true;
  }
  const messages = parsed.messages;
  const accept = String(req.headers['accept'] || '').toLowerCase();
  if (accept.includes('text/event-stream')) {
    streamChat(req, res, messages);
    return true;
  }
  try {
    const reply = await chatOnce(messages);
    send(req, res, 200, { reply });
  } catch (e) {
    send(req, res, 500, { error: e.message });
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
    send(req, res, auth.status, { error: auth.error, channel });
    return true;
  }
  const parsed = await readWebhookBody(req);
  if (!parsed.ok) {
    send(req, res, parsed.status, { error: parsed.error });
    return true;
  }
  const { message, replyUrl, userId, meta } = parsed.value;
  let reply;
  try {
    reply = await chatSync(message);
  } catch (e) {
    send(req, res, 500, { error: e.message, channel, delivered: false });
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
    send(req, res, 200, {
      status: 'chat_ok_delivery_failed',
      channel,
      delivery_error: e.message,
    });
    return true;
  }
  send(req, res, 200, {
    status: delivery.ok ? 'delivered' : 'delivery_failed',
    channel,
    delivery_status: delivery.status,
  });
  return true;
}

async function handleNotFound(req, res) {
  send(req, res, 404, { error: 'not found' });
  return true;
}

const ROUTES = [
  ['OPTIONS', null, handleOptions],
  ['GET', '/', handleGetRoot],
  ['GET', '/index.html', handleGetRoot],
  // V44: explicit routes for static assets the HTML loads at
  // well-known paths (./storage.js and ./favicon.ico). The
  // same handler is reachable via /static/<path> below.
  ['GET', '/storage.js', (req, res) => handleGetStatic(req, res, null, 'storage.js')],
  ['GET', '/favicon.ico', (req, res) => handleGetStatic(req, res, null, 'favicon.ico')],
  ['GET', '/api/health', handleGetHealth],
  // V44: prefix route for static files in web/ (used by
  // future CSS or image assets referenced from HTML).
  ['GET', '/static/', handleStaticRoute],
  ['POST', '/api/chat', handlePostChat],
  ['GET', '/api/config/schema', handleGetConfigSchema],
  ['GET', '/api/config/providers', handleListConfigProviders],
  ['POST', '/api/config/providers', handleAddConfigProvider],
  ['GET', '/api/config/active', handleGetConfigActive],
  ['PUT', '/api/config/active', handleSetConfigActive],
];

// V36: prefix-matched routes. Each entry: [method, prefix, handler].
// The handler receives (req, res, url, capturedPath) where
// capturedPath is url.pathname.slice(prefix.length). Empty string
// when the URL ends at the prefix.
const PREFIX_ROUTES = [
  ['POST', '/api/webhook/', handlePostWebhook],
  // V43: /api/config/providers/* -- one prefix covers GET/PUT/DELETE on
  // /<id> and POST on /<id>/test. The handler is ConfigApi.dispatch
  // which inspects method + tail.
  ['GET', '/api/config/providers/', handleConfigProviderRoute],
  ['PUT', '/api/config/providers/', handleConfigProviderRoute],
  ['DELETE', '/api/config/providers/', handleConfigProviderRoute],
  ['POST', '/api/config/providers/', handleConfigProviderRoute],
];

// V43: thin wrappers that delegate to ConfigApi.dispatchConfigRoute.
// The prefix-matched handler receives (req, res, url, captured) where
// captured is everything after the prefix (e.g. "openai/test").
function handleStaticRoute(req, res, _url, captured) {
  return handleGetStatic(req, res, _url, captured);
}

function handleConfigProviderRoute(req, res, _url, captured) {
  return ConfigApi.dispatchConfigRoute(req.method, '/' + captured, req, res);
}

function handleGetConfigSchema(req, res) {
  return ConfigApi.dispatchConfigRoute('GET', '/schema', req, res);
}

function handleListConfigProviders(req, res) {
  return ConfigApi.dispatchConfigRoute('GET', '/providers', req, res);
}

function handleAddConfigProvider(req, res) {
  return ConfigApi.dispatchConfigRoute('POST', '/providers', req, res);
}

function handleGetConfigActive(req, res) {
  return ConfigApi.dispatchConfigRoute('GET', '/active', req, res);
}

function handleSetConfigActive(req, res) {
  return ConfigApi.dispatchConfigRoute('PUT', '/active', req, res);
}

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

// V47: parseMessagesBody is exported for unit tests (web/server.test.js)
// so the multi-turn validation contract can be exercised without
// spawning the bin/darwin child. The handler itself still uses
// parseMessagesBody() internally.
export { server, PORT, HOST, AUTH_TOKEN, ConfigApi, parseMessagesBody };

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
    process.stdout.write('  GET  /api/config/schema      -> vendor catalog (V43)\n');
    process.stdout.write('  GET  /api/config/providers   -> list providers (V43)\n');
    process.stdout.write('  POST /api/config/providers   -> add/overwrite (V43)\n');
    process.stdout.write('  *    /api/config/providers/<id>     [GET PUT DELETE] (V43)\n');
    process.stdout.write('  POST /api/config/providers/<id>/test -> test connection (V43)\n');
    process.stdout.write('  GET  /api/config/active      -> active provider/model (V43)\n');
    process.stdout.write('  PUT  /api/config/active      -> set active provider (V43)\n');
    if (AUTH_TOKEN) {
      process.stdout.write('Auth: WEB_AUTH_TOKEN is set; non-health routes require it.\n');
    } else {
      process.stdout.write('Auth: WEB_AUTH_TOKEN not set; all routes open (V28 compat).\n');
    }
    if (CORS_ALLOWED_ORIGINS.length === 0) {
      process.stdout.write('CORS: same-origin only (set CORS_ORIGIN to allow cross-origin).\n');
    } else if (CORS_ALLOWED_ORIGINS.includes('*')) {
      process.stdout.write('CORS: * (any origin; not recommended with auth)\n');
    } else {
      process.stdout.write(`CORS: ${CORS_ALLOWED_ORIGINS.join(', ')}\n`);
    }
    process.stdout.write('Press Ctrl+C to stop.\n');
  });
}
