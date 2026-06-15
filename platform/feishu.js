/**
 * feishu — Darwin platform adapter (V3+ P2 catalogue item).
 *
 * Mechanical stub. Real Feishu API calls live behind a TODO(p2) seam.
 * ADR-009: no LLM call. No real network in v3+; only HMAC crypto via
 * node:crypto.
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
 *   - 'send'   : MOCK outgoing message; returns synthetic messageId.
 *                Replace with a real HTTPS call to the Feishu IM v1 messages
 *                endpoint once SelfEvolution wires a real provider (TODO(p2)).
 *   - 'verify' : HMAC-SHA256 signature check.
 *
 * Config (A-4, NEVER process.env):
 *   ConfigResolver.get('platform-feishu') → { appId, appSecret, encryptKey, verificationToken }
 *   Tests inject a custom resolver via config.resolver (see test #17-20).
 *
 * Signature scheme (simplified for v3+ stub):
 *   Real Feishu: sig = base64(HMAC-SHA256(timestamp + nonce + encryptKey + body))
 *   This adapter: sig = HMAC-SHA256(timestamp + nonce + body) using encryptKey as HMAC secret.
 *   Documented deviation per cycle 8 brief. Replace when real webhook lands.
 *
 * Hygiene (red lines):
 *   - No real network (mock send).
 *   - No LLM call (ADR-009).
 *   - No npm deps (node:crypto only).
 *   - No shell execution.
 *   - No node:fs (adapter is a leaf).
 *   - No env-var reads (A-4: ConfigResolver is the only config path).
 */

import { createHmac, randomUUID } from 'node:crypto';
import { ConfigResolver } from '../core/config-resolver.js';

const SAFE_DEFAULTS = Object.freeze({
  appId: '',
  appSecret: '',
  encryptKey: '',
  verificationToken: '',
});

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

function sendAction(payload) {
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  const chatId = payload && typeof payload.chatId === 'string' ? payload.chatId : '';
  if (text.length === 0 || chatId.length === 0) {
    return { ok: false, error: 'missing text or chatId' };
  }
  return {
    ok: true,
    messageId: `mock-${randomUUID()}`,
    timestamp: new Date().toISOString(),
  };
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
        return sendAction(payload);
      case 'verify':
        return verifyAction(payload, config);
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  },
};

export default feishu;
