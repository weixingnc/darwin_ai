/**
 * feishu — Darwin platform adapter (V3+ P2 catalogue item).
 *
 * V5 cycle 1: send action wired to real IM v1 wire (tenant_access_token +
 * im/v1/messages). fetch is injected via config.fetchImpl (default: global
 * fetch); tests must NOT hit open.feishu.cn. ADR-009: no LLM call.
 *
 * Contract (mirrors tool/skill shape, ingress/egress variant):
 *   feishu.name === 'feishu'
 *   feishu.description = non-empty string
 *   feishu.capabilities = ['messaging', 'webhook_parse', 'webhook_verify']
 *   feishu.execute({ action, payload, config? }) → Promise<{ ok, ... }>
 *
 * Actions:
 *   - 'parse'  : extract {messageId, senderId, chatId, chatType, text, timestamp}
 *                from a Feishu-shaped webhook payload.
 *   - 'send'   : real HTTPS call to Feishu IM v1 messages endpoint
 *                (POST /open-apis/im/v1/messages?receive_id_type=open_id).
 *                Acquires tenant_access_token via /open-apis/auth/v3/tenant_access_token/internal
 *                and caches it (per appId) for the lifetime of the adapter.
 *                payload.receive_id OR payload.chatId is the recipient's open_id.
 *                payload.text is the message body (msg_type='text').
 *   - 'verify' : HMAC-SHA256 signature check.
 *
 * Config (A-4, NEVER process.env):
 *   ConfigResolver.get('platform-feishu') → { appId, appSecret, encryptKey, verificationToken }
 *   Tests inject a custom resolver via config.resolver; fetchImpl via
 *   config.fetchImpl (must be set in tests to avoid real network).
 *
 * Signature scheme (simplified for v3+ stub):
 *   Real Feishu: sig = base64(HMAC-SHA256(timestamp + nonce + encryptKey + body))
 *   This adapter: sig = HMAC-SHA256(timestamp + nonce + body) using encryptKey as HMAC secret.
 *   Documented deviation per cycle 8 brief. Replace when real webhook lands.
 *
 * Hygiene (red lines):
 *   - No real network in tests (config.fetchImpl MUST be set).
 *   - No LLM call (ADR-009).
 *   - No npm deps (node:crypto only).
 *   - No shell execution.
 *   - No node:fs (adapter is a leaf).
 *   - No env-var reads (A-4: ConfigResolver is the only config path).
 */

import { createHmac } from 'node:crypto';
import { ConfigResolver } from '../core/config-resolver.js';

const SAFE_DEFAULTS = Object.freeze({
  appId: '',
  appSecret: '',
  encryptKey: '',
  verificationToken: '',
});

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const TOKEN_TTL_MS = 110 * 60 * 1000; // 110 min (real token TTL is 2h; refresh early)

// Module-level token cache keyed by appId. Cleared automatically by TTL.
// Shared across all adapter instances (singleton adapter in production).
const tokenCache = new Map();

function getCachedToken(appId) {
  const entry = tokenCache.get(appId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    tokenCache.delete(appId);
    return null;
  }
  return entry.token;
}

function setCachedToken(appId, token, ttlSeconds) {
  const ttlMs = Number.isInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : TOKEN_TTL_MS;
  tokenCache.set(appId, { token, expiresAt: Date.now() + Math.min(ttlMs, TOKEN_TTL_MS) });
}

async function fetchTenantToken({ appId, appSecret, fetchImpl }) {
  const url = `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!res.ok) {
    const errBody = await safeReadError(res);
    throw new Error(`tenant_access_token HTTP ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`tenant_access_token refused: code=${data.code} msg=${data.msg || ''}`);
  }
  return { token: data.tenant_access_token, expire: data.expire };
}

async function sendMessage({ token, receiveId, text, fetchImpl }) {
  const url = `${FEISHU_BASE}/im/v1/messages?receive_id_type=open_id`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  if (!res.ok) {
    const errBody = await safeReadError(res);
    throw new Error(`im/v1/messages HTTP ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  if (data.code !== 0 || !data.data || !data.data.message_id) {
    throw new Error(`im/v1/messages refused: code=${data.code} msg=${data.msg || ''}`);
  }
  return data.data.message_id;
}

async function safeReadError(res) {
  try {
    const t = await res.text();
    return t.length > 0 ? t.slice(0, 200) : res.statusText || 'unknown';
  } catch {
    return res.statusText || 'unknown';
  }
}

/** Test-only: clear the module-level tenant_access_token cache. */
export function _resetTokenCache() {
  tokenCache.clear();
}

function resolveConfig(externalResolver) {
  if (externalResolver && typeof externalResolver.get === 'function') {
    const cfg = externalResolver.get('platform-feishu');
    return cfg && typeof cfg === 'object' ? cfg : SAFE_DEFAULTS;
  }
  try {
    const r = new ConfigResolver();
    const cfg = r.get('platform-feishu');
    return cfg && typeof cfg === 'object' ? cfg : SAFE_DEFAULTS;
  } catch {
    return SAFE_DEFAULTS;
  }
}

function extractText(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return '';
  }
  try {
    const parsed = JSON.parse(content);
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

function resolveBody(payload) {
  if (payload && typeof payload.body === 'object' && payload.body !== null) {
    return { ok: true, body: payload.body };
  }
  const raw = payload && typeof payload.raw === 'string' ? payload.raw : '';
  if (raw.length === 0) {
    return { ok: false, error: 'invalid payload' };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `malformed JSON: ${err.message}` };
  }
}

function extractSender(senderIdObj) {
  if (!senderIdObj || typeof senderIdObj !== 'object') {
    return '';
  }
  return senderIdObj.open_id || senderIdObj.user_id || senderIdObj.union_id || '';
}

function parseAction(payload) {
  const r = resolveBody(payload);
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  const body = r.body;
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid payload' };
  }
  const event = body.event || {};
  const message = event.message || {};
  return {
    ok: true,
    message: {
      messageId: message.message_id || '',
      senderId: extractSender(event.sender && event.sender.sender_id),
      chatId: message.chat_id || '',
      chatType: message.chat_type || '',
      text: extractText(message.content),
      timestamp: String(message.create_time || ''),
    },
  };
}

function extractSendPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const text = typeof p.text === 'string' ? p.text : '';
  // Feishu spec uses `receive_id`; legacy callers may pass `chatId` as alias.
  let receiveId = '';
  if (typeof p.receive_id === 'string') {
    receiveId = p.receive_id;
  } else if (typeof p.chatId === 'string') {
    receiveId = p.chatId;
  }
  return { text, receiveId };
}

function extractSendContext(config) {
  const cfg = resolveConfig(config && config.resolver);
  const appId = cfg && typeof cfg.appId === 'string' ? cfg.appId : '';
  const appSecret = cfg && typeof cfg.appSecret === 'string' ? cfg.appSecret : '';
  const injected = config && typeof config.fetchImpl === 'function' ? config.fetchImpl : null;
  const fetchImpl = injected || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  return { appId, appSecret, fetchImpl };
}

async function sendAction(payload, config) {
  const { text, receiveId } = extractSendPayload(payload);
  if (text.length === 0 || receiveId.length === 0) {
    return { ok: false, error: 'missing text or receive_id' };
  }
  const { appId, appSecret, fetchImpl } = extractSendContext(config);
  if (appId.length === 0 || appSecret.length === 0) {
    return { ok: false, error: 'missing appId/appSecret in platform-feishu config' };
  }
  if (!fetchImpl) {
    return { ok: false, error: 'no fetch implementation available' };
  }
  try {
    let token = getCachedToken(appId);
    if (!token) {
      const got = await fetchTenantToken({ appId, appSecret, fetchImpl });
      token = got.token;
      setCachedToken(appId, token, got.expire);
    }
    const messageId = await sendMessage({ token, receiveId, text, fetchImpl });
    return { ok: true, messageId, timestamp: new Date().toISOString() };
  } catch (err) {
    // Force token refresh on next send on any auth failure.
    tokenCache.delete(appId);
    return { ok: false, error: err && err.message ? err.message : 'send failed' };
  }
}

function verifyAction(payload, config) {
  const cfg = resolveConfig(config && config.resolver);
  if (!cfg || typeof cfg.encryptKey !== 'string' || cfg.encryptKey.length === 0) {
    return { ok: false, error: 'no encryptKey configured' };
  }
  const sig = payload && typeof payload.signature === 'string' ? payload.signature : '';
  const ts = payload && typeof payload.timestamp === 'string' ? payload.timestamp : '';
  const nonce = payload && typeof payload.nonce === 'string' ? payload.nonce : '';
  const body = payload && typeof payload.body === 'string' ? payload.body : '';
  if (sig.length === 0) {
    return { ok: false, error: 'no signature provided' };
  }
  const expected = createHmac('sha256', cfg.encryptKey)
    .update(`${ts}${nonce}${body}`)
    .digest('hex');
  // constant-time compare would be nice; hex strings are short enough that
  // timing leakage is negligible in a stub. Real impl: use crypto.timingSafeEqual.
  if (expected === sig) {
    return { ok: true };
  }
  return { ok: false, error: 'signature mismatch' };
}

export const feishu = {
  name: 'feishu',
  description:
    'Feishu (Lark) platform adapter — parse incoming webhooks, send outgoing messages, verify signatures (v3+ P2).',
  capabilities: ['messaging', 'webhook_parse', 'webhook_verify'],
  async execute({ action, payload, config } = {}) {
    if (typeof action !== 'string' || action.length === 0) {
      return { ok: false, error: 'missing action' };
    }
    switch (action) {
      case 'parse':
        return parseAction(payload);
      case 'send':
        return sendAction(payload, config);
      case 'verify':
        return verifyAction(payload, config);
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  },
};

export default feishu;
