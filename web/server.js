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
 *   POST /api/chat      -> { reply: string }  (body: { message: string })
 *
 * Env:
 *   PORT    default 8080
 *   HOST    default 127.0.0.1 (localhost only -- V28 doesn't ship auth;
 *           a future V29/V30 would add token auth or move to a reverse proxy)
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

// Read package.json for the /api/health version stamp.
let VERSION = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  VERSION = pkg.version || VERSION;
} catch {
  /* keep default */
}

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

// Read JSON body of a request. Caps at 1MB to avoid OOM.
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

// Run `node bin/darwin chat "<message>"` and capture stdout.
// Returns a Promise<string> with the reply.
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
        // `darwin chat` writes errors to stderr; surface them so the
        // web UI can display "x provider not configured" or similar.
        const msg = (stderr || stdout).trim();
        rejectChat(new Error(msg || `darwin chat exited with code ${code}`));
      }
    });
  });
}

// Set CORS headers for local dev (the V28 UI is served by this same
// process, so CORS isn't strictly required, but it makes the API
// usable from a separately-hosted future frontend).
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const method = req.method;

  if (method === 'OPTIONS') {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    send(res, 200, INDEX_HTML, 'text/html');
    return;
  }

  if (method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, { ok: true, version: VERSION });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/chat') {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      send(res, 400, { error: e.message });
      return;
    }
    const message = body && typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) {
      send(res, 400, { error: 'message is required' });
      return;
    }
    try {
      const reply = await chatOnce(message);
      send(res, 200, { reply });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  send(res, 404, { error: 'not found' });
});

// Export for tests; only call listen when run as main.
export { server, PORT, HOST };

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Darwin web UI listening on http://${HOST}:${PORT}\n`);
    process.stdout.write('  GET  /            -> chat form\n');
    process.stdout.write('  GET  /api/health  -> { ok, version }\n');
    process.stdout.write('  POST /api/chat    -> { reply } (body: { message })\n');
    process.stdout.write('Press Ctrl+C to stop.\n');
  });
}
