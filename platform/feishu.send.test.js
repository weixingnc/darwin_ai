/**
 * feishu platform adapter — `send` action tests (text + V7.1 card path).
 * V8.2 (2026-06-19) split: extracted from platform/feishu.test.js (V3 era →
 * V5.1 text + V7.1 card accumulation) into per-action files. The split
 * is purely organisational (same tests, same fixtures, same helpers);
 * no logic change.
 *
 * Test code 0 改: only file layout + describe names. Refactor, not
 * re-design.
 *
 * Run: `node --test platform/feishu.send.test.js`
 *
 * Contract reminders (A-4, ADR-009):
 *  - ConfigResolver only entry point for credentials (NEVER process.env).
 *  - No LLM call, no real network, no shell.
 *  - Errors return { ok: false, error } — NEVER throw to caller.
 *
 * V5 cycle 1: send calls /open-apis/auth/v3/tenant_access_token/internal
 * then /open-apis/im/v1/messages?receive_id_type=open_id. fetchImpl is
 * injected via config; tests must NOT touch the real network.
 * V7 cycle 1 added payload.card → msg_type='interactive'. Card wins over
 * text when both are present. payload.card must be an object — a string
 * is a misuse (V5 text path lives at .text).
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { feishu, _resetTokenCache } from './feishu.js';

describe('feishu — action: send (V5 cycle 1 real wire, text path)', () => {
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
