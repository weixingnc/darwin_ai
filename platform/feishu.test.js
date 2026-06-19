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
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feishu, _resetTokenCache } from './feishu.js';

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

// ─── send action (real wire, fetch mocked) ─────────────────────
// V5 cycle 1: send calls /open-apis/auth/v3/tenant_access_token/internal
// then /open-apis/im/v1/messages?receive_id_type=open_id. fetchImpl is
// injected via config; tests must NOT touch the real network.
describe('feishu — action: send (V5 cycle 1 real wire)', () => {
  const fakeCfg = () => ({ appId: 'cli_test', appSecret: 'secret_test' });
  const fakeResolver = { get: () => fakeCfg() };

  // Reset module-level token cache before each test for deterministic call counts.
  beforeEach(() => {
    _resetTokenCache();
  });

  function makeFetchMock({ tokenRes, msgRes, throwOn } = {}) {
    const calls = [];
    const fetchMock = async (url, init = {}) => {
      calls.push({ url, init });
      if (throwOn && throwOn(url)) {
        throw new Error('ECONNREFUSED');
      }
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return tokenRes;
      }
      if (url.includes('/im/v1/messages')) {
        return msgRes;
      }
      throw new Error(`unexpected URL in fetchMock: ${url}`);
    };
    return { fetchMock, calls };
  }

  function cfg(fetchMock) {
    return { resolver: fakeResolver, fetchImpl: fetchMock };
  }

  const okToken = {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't-abc123', expire: 7200 }),
    text: async () => '{"code":0,"tenant_access_token":"t-abc123"}',
  };
  const okMsg = {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_msg_xyz' } }),
    text: async () => '{"code":0,"data":{"message_id":"om_msg_xyz"}}',
  };

  test('12. valid text + receive_id → real wire: token then im/v1/messages; messageId returned', async () => {
    const { fetchMock, calls } = makeFetchMock({ tokenRes: okToken, msgRes: okMsg });
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi', receive_id: 'ou_user_1' },
      config: cfg(fetchMock),
    });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'om_msg_xyz');
    assert.ok(typeof r.timestamp === 'string' && r.timestamp.length > 0);
    // Call order: token first, then messages.
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/auth\/v3\/tenant_access_token\/internal$/);
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].init.headers['Content-Type'], /application\/json/);
    const tokenBody = JSON.parse(calls[0].init.body);
    assert.equal(tokenBody.app_id, 'cli_test');
    assert.equal(tokenBody.app_secret, 'secret_test');
    assert.match(calls[1].url, /\/im\/v1\/messages\?receive_id_type=open_id$/);
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer t-abc123');
    const msgBody = JSON.parse(calls[1].init.body);
    assert.equal(msgBody.receive_id, 'ou_user_1');
    assert.equal(msgBody.msg_type, 'text');
    assert.equal(JSON.parse(msgBody.content).text, 'hi');
  });

  test('13. empty text → { ok: false, error } (guard fires before any fetch)', async () => {
    let called = false;
    const fetchMock = async () => {
      called = true;
      return okToken;
    };
    const r = await feishu.execute({
      action: 'send',
      payload: { text: '', receive_id: 'ou_user_1' },
      config: cfg(fetchMock),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /missing text or receive_id/);
    assert.equal(called, false, 'fetch must not be called when payload is invalid');
  });

  test('14. missing receive_id → { ok: false, error }', async () => {
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi' },
      config: {
        resolver: fakeResolver,
        fetchImpl: async () => okToken,
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /missing text or receive_id/);
  });

  test('15. legacy `chatId` alias is honoured as `receive_id`', async () => {
    const { fetchMock, calls } = makeFetchMock({ tokenRes: okToken, msgRes: okMsg });
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi', chatId: 'ou_legacy' },
      config: cfg(fetchMock),
    });
    assert.equal(r.ok, true);
    const msgBody = JSON.parse(calls[1].init.body);
    assert.equal(msgBody.receive_id, 'ou_legacy');
  });

  test('16. tenant_access_token is cached: second send skips the token call', async () => {
    const { fetchMock, calls } = makeFetchMock({ tokenRes: okToken, msgRes: okMsg });
    const config = cfg(fetchMock);
    const a = await feishu.execute({
      action: 'send',
      payload: { text: 'first', receive_id: 'ou_1' },
      config,
    });
    const b = await feishu.execute({
      action: 'send',
      payload: { text: 'second', receive_id: 'ou_2' },
      config,
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    // 2 messages calls + 1 token call = 3 total (not 4)
    const tokenCalls = calls.filter((c) => c.url.includes('tenant_access_token'));
    const msgCalls = calls.filter((c) => c.url.includes('/im/v1/messages'));
    assert.equal(tokenCalls.length, 1, 'token must be cached after first call');
    assert.equal(msgCalls.length, 2, 'both sends must hit /im/v1/messages');
  });

  test('17. fetch throw → { ok: false, error } (no throw to caller)', async () => {
    const fetchMock = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:443');
    };
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi', receive_id: 'ou_1' },
      config: cfg(fetchMock),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /ECONNREFUSED|send failed|tenant/i);
  });

  test('18. tenant_access_token non-zero code → { ok: false, error } (no throw)', async () => {
    const badToken = {
      ok: true,
      status: 200,
      json: async () => ({ code: 10003, msg: 'invalid app_secret' }),
      text: async () => '{"code":10003,"msg":"invalid app_secret"}',
    };
    const fetchMock = async () => badToken;
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi', receive_id: 'ou_1' },
      config: cfg(fetchMock),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /10003|invalid app_secret/);
  });

  test('19. im/v1/messages non-zero code → { ok: false, error } (no throw)', async () => {
    const badMsg = {
      ok: true,
      status: 200,
      json: async () => ({ code: 230020, msg: 'user not found' }),
      text: async () => '{"code":230020,"msg":"user not found"}',
    };
    const { fetchMock } = makeFetchMock({ tokenRes: okToken, msgRes: badMsg });
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi', receive_id: 'ou_1' },
      config: cfg(fetchMock),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /230020|user not found/);
  });

  test('20. missing appId/appSecret → { ok: false, error } (no fetch called)', async () => {
    let called = false;
    const fetchMock = async () => {
      called = true;
      return okToken;
    };
    const emptyResolver = { get: () => ({}) };
    const r = await feishu.execute({
      action: 'send',
      payload: { text: 'hi', receive_id: 'ou_1' },
      config: { resolver: emptyResolver, fetchImpl: fetchMock },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /appId|appSecret/);
    assert.equal(called, false);
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

// ─── send action: card path (V7 cycle 1 interactive) ────────────
// V7 cycle 1 added payload.card → msg_type='interactive'.
// Card wins over text when both are present. payload.card must be an
// object — a string is a misuse (V5 text path lives at .text).
describe('feishu — action: send (V7 cycle 1 card path)', () => {
  const fakeCfg = () => ({ appId: 'cli_test', appSecret: 'secret_test' });
  const fakeResolver = { get: () => fakeCfg() };
  beforeEach(() => {
    _resetTokenCache();
  });

  function makeFetchMock({ tokenRes, msgRes } = {}) {
    const calls = [];
    const fetchMock = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return tokenRes;
      }
      if (url.includes('/im/v1/messages')) {
        return msgRes;
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    return { fetchMock, calls };
  }

  const okToken = {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't-card', expire: 7200 }),
    text: async () => '{}',
  };
  const okMsg = {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_card_xyz' } }),
    text: async () => '{}',
  };

  test('25. payload.card object → im/v1/messages with msg_type=interactive + content=JSON.stringify(card)', async () => {
    const { fetchMock, calls } = makeFetchMock({ tokenRes: okToken, msgRes: okMsg });
    const card = {
      header: { title: { tag: 'plain_text', content: 'V7.1' }, template: 'green' },
      elements: [
        { tag: 'divider' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: 'x' }] },
      ],
    };
    const r = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_card_user', card },
      config: { resolver: fakeResolver, fetchImpl: fetchMock },
    });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'om_card_xyz');
    assert.equal(calls.length, 2);
    const msgCall = calls[1];
    assert.match(msgCall.url, /\/im\/v1\/messages\?receive_id_type=open_id$/);
    const body = JSON.parse(msgCall.init.body);
    assert.equal(body.msg_type, 'interactive');
    assert.equal(body.receive_id, 'ou_card_user');
    // content is the JSON-stringified card, not the text path's {"text":"…"}.
    const content = JSON.parse(body.content);
    assert.deepEqual(content, card);
    assert.equal(content.header.template, 'green');
  });

  test('26. payload.card + payload.text both present → card wins (interactive)', async () => {
    const { fetchMock, calls } = makeFetchMock({ tokenRes: okToken, msgRes: okMsg });
    const card = {
      header: { title: { tag: 'plain_text', content: 't' }, template: 'red' },
      elements: [],
    };
    await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_user', card, text: 'this should be ignored' },
      config: { resolver: fakeResolver, fetchImpl: fetchMock },
    });
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.msg_type, 'interactive');
    assert.equal(JSON.parse(body.content).header.template, 'red');
  });

  test('27. payload.card is a string (V5 misuse) → { ok:false, error } and NO fetch', async () => {
    let called = false;
    const fetchMock = async () => {
      called = true;
      return okToken;
    };
    const r = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_user', card: 'oops this is text not a card' },
      config: { resolver: fakeResolver, fetchImpl: fetchMock },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /payload\.card must be an object/);
    assert.equal(called, false, 'must reject before any network call');
  });

  test('28. payload.card object but receive_id missing → { ok:false, error } no fetch', async () => {
    let called = false;
    const fetchMock = async () => {
      called = true;
      return okToken;
    };
    const r = await feishu.execute({
      action: 'send',
      payload: { card: { header: {}, elements: [] } },
      config: { resolver: fakeResolver, fetchImpl: fetchMock },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /missing receive_id/);
    assert.equal(called, false);
  });

  test('29. payload.card object with no elements/header is still passed through (card is opaque to adapter)', async () => {
    const { fetchMock, calls } = makeFetchMock({ tokenRes: okToken, msgRes: okMsg });
    const card = { header: { title: { tag: 'plain_text', content: 'min' }, template: 'blue' } };
    const r = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_user', card },
      config: { resolver: fakeResolver, fetchImpl: fetchMock },
    });
    assert.equal(r.ok, true);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.msg_type, 'interactive');
  });
});
