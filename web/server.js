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
 * Env:
 *   PORT    default 8080
 *   HOST    default 127.0.0.1 (localhost only -- V28 doesn't ship auth;
 *           a future V29/V30 would add token auth or move to a reverse proxy)
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

// V28: synchronous chat. Returns the full reply.
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

// V31: stream `node bin/darwin chat --stream "<message>"` to the HTTP
// response as Server-Sent Events.
//
// Child line protocol:
//   "chunk:<text>"  -> SSE data frame { type: "chunk", text }
//   "done:"         -> SSE data frame { type: "done" } and closes
//   "error:<msg>"   -> SSE data frame { type: "error", error } and closes
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body, contentType = 'application/json') {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType + '; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Route handlers (V31: extracted to keep createServer's complexity
// under the 15 cap). Each returns true if it handled the request.
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
  send(res, 200, { ok: true, version: VERSION });
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
  // V31: Accept: text/event-stream -> SSE; otherwise JSON (V28 compat).
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const method = req.method;
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
  await handleNotFound(req, res);
});

export { server, PORT, HOST };

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Darwin web UI listening on http://${HOST}:${PORT}\n`);
    process.stdout.write('  GET  /              -> chat form\n');
    process.stdout.write('  GET  /api/health    -> { ok, version }\n');
    process.stdout.write(
      '  POST /api/chat      -> { reply }            (Accept: application/json)\n',
    );
    process.stdout.write(
      '  POST /api/chat      -> text/event-stream    (Accept: text/event-stream, V31)\n',
    );
    process.stdout.write('Press Ctrl+C to stop.\n');
  });
}
