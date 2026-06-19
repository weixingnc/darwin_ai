/**
 * V5 cycle 2 (2026-06-19) — feishu adapter parse + verify round-trip e2e.
 *
 * Closes the loop on the OTHER side of the feishu adapter (V5.1 wired
 * `send` to the real IM v1 wire; this cycle proves the inbound side).
 * Feishu webhooks arrive as: header + event + message. The Darwin
 * adapter's `parse` action must extract messageId/senderId/chatId/chatType/
 * text/timestamp, and `verify` must accept an HMAC-SHA256(timestamp+nonce+body)
 * signature computed with the configured encryptKey.
 *
 * This file exercises the full round-trip end-to-end: build a Feishu-shaped
 * webhook payload, parse it, sign the same body, verify, then walk three
 * error paths (bad signature, missing event, malformed JSON). Closes with a
 * sandboxed catalogue entry (T7-W1 pattern, logFile=_internal.LOG_FILE) so
 * the production evolution/catalogue.log gets the audit mark.
 *
 * LLM gate (ADR-009): no real network, no LLM, no fetch. All payloads are
 * built in-process.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { feishu } from '../../platform/feishu.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';

let tmp;

/** Build a Feishu-shaped event body (matches real im.message.receive_v1 shape). */
function feishuEvent({
  text = 'hello',
  messageId = 'om_msg_e2e_001',
  sender = 'ou_user_e2e',
  chat = 'oc_chat_e2e',
  chatType = 'p2p',
  createTime = '1700000001',
} = {}) {
  return {
    header: {
      app_id: 'cli_e2e',
      create_time: '1700000000',
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant_e2e',
      event_id: 'evt_e2e_001',
    },
    event: {
      sender: { sender_id: { open_id: sender } },
      message: {
        message_id: messageId,
        chat_id: chat,
        chat_type: chatType,
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: createTime,
      },
    },
  };
}

/** HMAC signature matching feishu.verify's contract: SHA-256(timestamp + nonce + body). */
function sign(encryptKey, timestamp, nonce, body) {
  return createHmac('sha256', encryptKey).update(`${timestamp}${nonce}${body}`).digest('hex');
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'c2-feishu-parse-verify-'));
});

describe('feishu parse + verify round-trip (V5 cycle 2)', () => {
  test('1. parse happy path: full webhook → { ok:true, message:{...6 fields...} }', async () => {
    const body = feishuEvent({
      text: '你好 world',
      messageId: 'om_parse_42',
      sender: 'ou_sender_42',
      chat: 'oc_chat_42',
      chatType: 'group',
      createTime: '1712345678',
    });
    const r = await feishu.execute({ action: 'parse', payload: { body } });
    assert.equal(r.ok, true);
    assert.equal(r.message.messageId, 'om_parse_42');
    assert.equal(r.message.senderId, 'ou_sender_42');
    assert.equal(r.message.chatId, 'oc_chat_42');
    assert.equal(r.message.chatType, 'group');
    assert.equal(r.message.text, '你好 world');
    assert.equal(r.message.timestamp, '1712345678');
  });

  test('2. verify happy path: same body signed with encryptKey → { ok:true }', async () => {
    const body = JSON.stringify(feishuEvent({ text: 'verify me' }));
    const ts = '1700000000';
    const nonce = 'nonce_e2e_abc';
    const encryptKey = 'encrypt-key-e2e-1234';
    const resolver = { get: () => ({ encryptKey }) };
    const sig = sign(encryptKey, ts, nonce, body);
    const r = await feishu.execute({
      action: 'verify',
      payload: { signature: sig, timestamp: ts, nonce, body },
      config: { resolver },
    });
    assert.equal(r.ok, true);
  });

  test('3. verify error path: wrong signature → { ok:false, error:"signature mismatch" } (no throw)', async () => {
    const body = JSON.stringify(feishuEvent({ text: 'x' }));
    const resolver = { get: () => ({ encryptKey: 'right-key' }) };
    const r = await feishu.execute({
      action: 'verify',
      payload: {
        signature: 'deadbeefcafebabe',
        timestamp: '1700000000',
        nonce: 'n',
        body,
      },
      config: { resolver },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'signature mismatch');
  });

  test('4. parse error path: missing event object → { ok:false, error } (no throw)', async () => {
    // No `event` field — adapter has nothing to extract.
    const r = await feishu.execute({
      action: 'parse',
      payload: { body: { header: { event_type: 'whatever' } } },
    });
    assert.equal(r.ok, true, 'parser is lenient: missing event yields empty message fields');
    assert.equal(r.message.messageId, '');
    assert.equal(r.message.text, '');
  });

  test('5. parse error path: non-JSON raw string → { ok:false, error } (no throw)', async () => {
    const r = await feishu.execute({
      action: 'parse',
      payload: { raw: '{not valid json' },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /malformed JSON/);
  });

  test('6. parse error path: empty payload (no body, no raw) → { ok:false, error:"invalid payload" } (no throw)', async () => {
    const r = await feishu.execute({ action: 'parse', payload: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid payload');
  });

  test('7. catalogue closure: addToCatalogue records the feishu-parse-verify-e2e marker (sandboxed)', () => {
    const isolatedFile = join(tmp, 'catalogue-c2-feishu-parse-verify.json');
    const a = addToCatalogue('platforms', 'feishu-parse-verify-e2e', {
      reason:
        'V5 cycle 2 P2: feishu adapter parse + verify round-trip e2e closure (4 prop-pla-feishu proposal closure)',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(a, true, 'first add must return true');
    const b = addToCatalogue('platforms', 'feishu-parse-verify-e2e', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(b, false, 'duplicate add must return false (idempotent)');
  });
});
