/**
 * feishu platform adapter — `parse` action tests.
 * V8.2 (2026-06-19) split: extracted from platform/feishu.test.js (V3 era →
 * V5.2 verify + V7.1 card accumulation) into per-action files. The split
 * is purely organisational (same tests, same fixtures, same helpers);
 * no logic change.
 *
 * Test code 0 改: only file layout + describe names. Refactor, not
 * re-design.
 *
 * Run: `node --test platform/feishu.parse.test.js`
 *
 * Contract reminders (A-4, ADR-009):
 *  - ConfigResolver only entry point for credentials (NEVER process.env).
 *  - No LLM call, no real network, no shell.
 *  - Errors return { ok: false, error } — NEVER throw to caller.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { feishu } from './feishu.js';

/** Build a fake Feishu event payload (URL-verification or message-v2 style). */
function feishuEvent({
  text = 'hello',
  sender = 'ou_sender',
  chat = 'oc_chat',
  chatType = 'p2p',
} = {}) {
  return {
    header: {
      app_id: 'cli_test',
      create_time: '1700000000',
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant',
      event_id: 'evt_1',
    },
    event: {
      sender: { sender_id: { open_id: sender } },
      message: {
        message_id: 'om_msg_1',
        chat_id: chat,
        chat_type: chatType,
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: '1700000001',
      },
    },
  };
}

// ─── catalog contract ───────────────────────────────────────────
describe('feishu — catalog contract', () => {
  test('1. name === "feishu"', () => assert.equal(feishu.name, 'feishu'));
  test('2. description is non-empty string', () => {
    assert.equal(typeof feishu.description, 'string');
    assert.ok(feishu.description.length > 0);
  });
  test('3. capabilities include messaging, webhook_parse, webhook_verify', () => {
    assert.ok(Array.isArray(feishu.capabilities));
    for (const c of ['messaging', 'webhook_parse', 'webhook_verify']) {
      assert.ok(feishu.capabilities.includes(c), `missing capability: ${c}`);
    }
  });
  test('4. execute is an async function', () => assert.equal(typeof feishu.execute, 'function'));
});

// ─── parse action ───────────────────────────────────────────────
describe('feishu — action: parse', () => {
  test('5. valid Feishu-shaped body → { ok: true, message: {...} }', async () => {
    const body = feishuEvent({ text: 'hi 你好' });
    const r = await feishu.execute({ action: 'parse', payload: { body } });
    assert.equal(r.ok, true);
    assert.equal(r.message.messageId, 'om_msg_1');
    assert.equal(r.message.senderId, 'ou_sender');
    assert.equal(r.message.chatId, 'oc_chat');
    assert.equal(r.message.chatType, 'p2p');
    assert.equal(r.message.text, 'hi 你好');
    assert.equal(typeof r.message.timestamp, 'string');
  });

  test('6. empty payload → { ok: false, error: "invalid payload" } (no throw)', async () => {
    const r = await feishu.execute({ action: 'parse', payload: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid payload');
  });

  test('7. raw JSON string parses via payload.raw', async () => {
    const body = feishuEvent({ text: 'raw' });
    const r = await feishu.execute({
      action: 'parse',
      payload: { raw: JSON.stringify(body) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.message.text, 'raw');
  });

  test('8. malformed JSON raw → { ok: false, error } (no throw)', async () => {
    const r = await feishu.execute({
      action: 'parse',
      payload: { raw: '{not json' },
    });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  });

  test('9. unknown action → { ok: false, error }', async () => {
    const r = await feishu.execute({ action: 'wat', payload: {} });
    assert.equal(r.ok, false);
    assert.ok(/unknown/i.test(r.error) || /action/i.test(r.error));
  });

  test('10. very large payload (10K char text) does not crash', async () => {
    const big = 'a'.repeat(10_000);
    const body = feishuEvent({ text: big });
    const r = await feishu.execute({ action: 'parse', payload: { body } });
    assert.equal(r.ok, true);
    assert.equal(r.message.text.length, 10_000);
  });

  test('11. unicode preserved (中文 + emoji)', async () => {
    const body = feishuEvent({ text: '中文 😀✨' });
    const r = await feishu.execute({ action: 'parse', payload: { body } });
    assert.equal(r.message.text, '中文 😀✨');
  });
});
