/**
 * feishu platform adapter tests — P3+ cycle 8, V3+ P2 catalogue.
 * TDD red→green for platform/feishu.js (mechanical stub, no real Feishu API).
 *
 * Run: `node --test platform/feishu.test.js`
 *
 * Contract reminders (A-4, ADR-009):
 *  - ConfigResolver only entry point for credentials (NEVER process.env).
 *  - No LLM call, no real network, no shell.
 *  - Errors return { ok: false, error } — NEVER throw to caller.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feishu } from './feishu.js';

const D = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(D, './feishu.js');

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

/** Helper: compute HMAC signature the way feishu.verify expects. */
function sign(encryptKey, timestamp, nonce, body) {
  return createHmac('sha256', encryptKey).update(`${timestamp}${nonce}${body}`).digest('hex');
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

// ─── send action (mock, NO real network) ────────────────────────
describe('feishu — action: send', () => {
  test('12. valid text + chatId → { ok: true, messageId: "mock-...", timestamp }', async () => {
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi', chatId: 'oc_chat' },
    });
    assert.equal(r.ok, true);
    assert.ok(/^mock-/.test(r.messageId), `bad messageId: ${r.messageId}`);
    assert.ok(typeof r.timestamp === 'string' && r.timestamp.length > 0);
    // ISO-ish check
    assert.ok(!Number.isNaN(Date.parse(r.timestamp)));
  });

  test('13. empty text → { ok: false, error }', async () => {
    const r = await feishu.execute({
      action: 'send',
      payload: { text: '', chatId: 'oc_chat' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing text or chatId');
  });

  test('14. missing chatId → { ok: false, error }', async () => {
    const r = await feishu.execute({ action: 'send', payload: { text: 'hi' } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing text or chatId');
  });

  test('15. send is mock — does NOT make any real network call (source has no fetch to feishu.cn)', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(!/open\.feishu\.cn/.test(src), 'source must not reference real Feishu API');
    assert.ok(!/fetch\s*\(/.test(src), 'source must not call fetch()');
    assert.ok(!/https:\/\//.test(src), 'source must not embed any https URL');
  });

  test('16. concurrent send calls produce unique mock messageIds', async () => {
    const calls = await Promise.all(
      Array.from({ length: 5 }, () =>
        feishu.execute({ action: 'send', payload: { text: 'x', chatId: 'oc_chat' } }),
      ),
    );
    const ids = new Set(calls.map((r) => r.messageId));
    assert.ok(ids.size === 5, 'expected 5 unique mock messageIds');
  });
});

// ─── verify action (HMAC-SHA256) ────────────────────────────────
describe('feishu — action: verify', () => {
  // Use an injected resolver via execute({config:{resolver}}) so tests
  // don't depend on real ~/.darwin/.env. The adapter accepts an optional
  // `resolver` override for testability (A-4 friendly).
  const fakeKey = 'test-encrypt-key-1234';
  const fakeResolver = { get: () => ({ encryptKey: fakeKey }) };
  const cfg = () => ({ resolver: fakeResolver });

  test('17. correct HMAC signature → { ok: true }', async () => {
    const body = JSON.stringify({ header: {}, event: {} });
    const ts = '1700000000';
    const nonce = 'abc123';
    const sig = sign(fakeKey, ts, nonce, body);
    const r = await feishu.execute({
      action: 'verify',
      payload: { signature: sig, timestamp: ts, nonce, body },
      config: cfg(),
    });
    assert.equal(r.ok, true);
  });

  test('18. incorrect signature → { ok: false, error: "signature mismatch" }', async () => {
    const body = JSON.stringify({});
    const r = await feishu.execute({
      action: 'verify',
      payload: {
        signature: 'deadbeef',
        timestamp: '1700000000',
        nonce: 'n',
        body,
      },
      config: cfg(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'signature mismatch');
  });

  test('19. missing encryptKey (empty config) → { ok: false, error: "no encryptKey configured" } (no throw)', async () => {
    const emptyResolver = { get: () => ({}) };
    const r = await feishu.execute({
      action: 'verify',
      payload: { signature: 'x', timestamp: '1', nonce: 'n', body: '{}' },
      config: { resolver: emptyResolver },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no encryptKey configured');
  });

  test('20. no config at all → { ok: false, error: "no config" } (no throw, defaults safe)', async () => {
    const r = await feishu.execute({
      action: 'verify',
      payload: { signature: 'x', timestamp: '1', nonce: 'n', body: '{}' },
    });
    assert.equal(r.ok, false);
    assert.ok(/no config|encryptKey/i.test(r.error));
  });
});

// ─── A-4 hygiene ────────────────────────────────────────────────
describe('feishu — A-4 hygiene (no process.env, ConfigResolver is the only path)', () => {
  test('21. source does NOT reference process.env.FEISHU_*', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(!/process\.env\.FEISHU_/.test(src), 'must not hard-read process.env.FEISHU_*');
  });

  test('22. source imports ConfigResolver from core/config-resolver.js', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(
      /from\s+['"]\.\.\/core\/config-resolver\.js['"]/.test(src) ||
        /from\s+['"]\.\.\/\.\.\/core\/config-resolver\.js['"]/.test(src),
      'must import ConfigResolver from core/',
    );
  });

  test('23. source has no `import fs` / no `node:fs` (adapter is a leaf)', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(!/from\s+['"]node:fs/.test(src), 'must not import node:fs');
    assert.ok(!/from\s+['"]fs['"]/.test(src), 'must not import fs');
  });

  test('24. source has no execSync / no shell', () => {
    const src = readFileSync(SRC, 'utf8');
    assert.ok(!/execSync/.test(src), 'must not use execSync');
    assert.ok(!/node:child_process/.test(src), 'must not import child_process');
  });
});
