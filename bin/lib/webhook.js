/**
 * bin/lib/webhook.js -- V36: channel webhook delivery.
 *
 * Receives a Darwin envelope on /api/webhook/<channel>, runs it
 * through `darwin chat`, and POSTs the reply to a delivery URL.
 *
 * This is the smallest step from "web UI only" (V28-V35) toward
 * "multi-channel AI gateway" (the OpenClaw shape). The contract:
 *
 *   inbound  POST { message, reply_url, user_id?, meta? }
 *   outbound POST { reply, channel, user_id?, meta? } at reply_url
 *
 * Why async delivery, not synchronous:
 *   - A Slack/Telegram/Feishu adapter is typically behind several
 *     network hops and has its own latency budget. Forcing darwin
 *     to wait for the channel API would couple two unrelated
 *     timeouts. The webhook caller gets 200 immediately, darwin
 *     POSTs the reply in the background.
 *   - The same primitive scales to multi-channel fan-out: V37+
 *     can add per-channel adapters that register their own
 *     delivery URLs and let darwin route the reply.
 *
 * Why a separate file (not folded into web.js):
 *   - The surface is wide (allowlist, secret, delivery, audit)
 *     and we want each concern unit-testable in isolation.
 *   - V36 is the first step toward multi-channel; the same
 *     primitives will be reused by V37+ channel adapters.
 *
 * Channel allowlist (V36):
 *   - Read from env WEBHOOK_CHANNELS (comma-separated). Empty /
 *     unset = any channel name is accepted.
 *   - Channel secret verification: if env WEBHOOK_SECRET_<UPPER> is
 *     set (e.g. WEBHOOK_SECRET_SLACK), the inbound X-Darwin-Channel-
 *     Secret header must match. This is independent of the V33
 *     bearer token, which still gates the whole route.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const DARWIN_BIN = join(REPO_ROOT, 'bin', 'darwin');

let _allowlistCache = null;
function getAllowlist() {
  if (_allowlistCache !== null) {
    return _allowlistCache;
  }
  const raw = process.env.WEBHOOK_CHANNELS || '';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  _allowlistCache = list;
  return list;
}

// Reset allowlist cache (for tests that mutate env).
export function _resetAllowlistCache() {
  _allowlistCache = null;
}

export function isChannelAllowed(channel) {
  const list = getAllowlist();
  if (list.length === 0) {
    return true;
  }
  return list.includes(channel);
}

export function channelSecret(channel) {
  if (!channel) {
    return null;
  }
  const env = 'WEBHOOK_SECRET_' + channel.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return process.env[env] || null;
}

export function verifyChannelSecret(channel, provided) {
  const expected = channelSecret(channel);
  if (!expected) {
    return true; // no secret configured -> open for this channel
  }
  return typeof provided === 'string' && provided === expected;
}

/**
 * Run `node bin/darwin chat "<message>"` synchronously and return
 * the full reply (V23 / V28 behaviour, NOT V31 streaming). V36
 * webhook delivery wants the complete reply to forward, so we
 * skip SSE for now.
 */
export function chatSync(message) {
  return new Promise((resolveChat, rejectChat) => {
    const child = spawn(process.execPath, [DARWIN_BIN, 'chat', message], {
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
        return;
      }
      const msg = (stderr || stdout).trim();
      rejectChat(new Error(msg || `darwin chat exited with code ${code}`));
    });
  });
}

/**
 * POST a JSON body to a URL using Node's global fetch (Node 18+).
 * Returns { ok, status, body } where `ok` is true on 2xx. We never
 * throw on non-2xx so the caller can decide what to do.
 */
export async function deliverReply(replyUrl, payload) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available (Node 18+ required)');
  }
  const res = await fetch(replyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = '';
  try {
    body = await res.text();
  } catch (_) {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, body };
}
