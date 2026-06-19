/**
 * V5 cycle 1 (2026-06-19) — feishu adapter send real IM v1 wire e2e.
 *
 * Closes the loop on V3+ P2 catalogue "feishu adapter": send is no longer a
 * MOCK stub. It now POSTs to /open-apis/auth/v3/tenant_access_token/internal
 * then /open-apis/im/v1/messages?receive_id_type=open_id (via injected
 * fetchImpl). This file asserts the end-to-end wire against a serial
 * fetch mock: token first, then message, with the real URL/method/headers
 * the feishu backend expects. Plus an error-isolation case and a
 * sandboxed catalogue closure (T7-W1 pattern).
 *
 * LLM gate (ADR-009): no real network, no LLM. fetchImpl is faked.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { feishu, _resetTokenCache } from '../../platform/feishu.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';

let tmp;
let fetchCalls;

const fakeResolver = { get: () => ({ appId: 'cli_e2e', appSecret: 'sec_e2e' }) };

const tokenOk = {
  ok: true,
  status: 200,
  json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't-e2e-token', expire: 7200 }),
  text: async () => '{"code":0,"tenant_access_token":"t-e2e-token","expire":7200}',
};
const msgOk = {
  ok: true,
  status: 200,
  json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_e2e_xyz' } }),
  text: async () => '{"code":0,"data":{"message_id":"om_e2e_xyz"}}',
};

function makeFetch({ queue = [tokenOk, msgOk] } = {}) {
  fetchCalls = [];
  let i = 0;
  return async (url, init = {}) => {
    fetchCalls.push({ url, init });
    const next = queue[i] || queue[queue.length - 1];
    i += 1;
    return next;
  };
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'c1-feishu-send-'));
});

beforeEach(() => {
  _resetTokenCache();
  fetchCalls = [];
});

describe('feishu send real IM v1 wire (V5 cycle 1)', () => {
  test('1. execute({action: send}) hits tenant_access_token then im/v1/messages', async () => {
    const fetchImpl = makeFetch();
    const r = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_xxx', text: 'hello' },
      config: { resolver: fakeResolver, fetchImpl },
    });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'om_e2e_xyz');
    assert.equal(fetchCalls.length, 2, 'must be exactly 2 fetch calls');
    // 1) token
    assert.match(fetchCalls[0].url, /\/auth\/v3\/tenant_access_token\/internal$/);
    assert.equal(fetchCalls[0].init.method, 'POST');
    const tokenBody = JSON.parse(fetchCalls[0].init.body);
    assert.equal(tokenBody.app_id, 'cli_e2e');
    assert.equal(tokenBody.app_secret, 'sec_e2e');
    // 2) messages
    assert.match(fetchCalls[1].url, /\/im\/v1\/messages\?receive_id_type=open_id$/);
    assert.equal(fetchCalls[1].init.method, 'POST');
    assert.equal(fetchCalls[1].init.headers.Authorization, 'Bearer t-e2e-token');
    const msgBody = JSON.parse(fetchCalls[1].init.body);
    assert.equal(msgBody.receive_id, 'ou_xxx');
    assert.equal(msgBody.msg_type, 'text');
    assert.equal(JSON.parse(msgBody.content).text, 'hello');
  });

  test('2. cache: second send uses cached token (only 1 token call across 2 sends)', async () => {
    const fetchImpl = makeFetch();
    const config = { resolver: fakeResolver, fetchImpl };
    const a = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_a', text: 'a' },
      config,
    });
    const b = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_b', text: 'b' },
      config,
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const tokenCalls = fetchCalls.filter((c) => c.url.includes('tenant_access_token'));
    const msgCalls = fetchCalls.filter((c) => c.url.includes('/im/v1/messages'));
    assert.equal(tokenCalls.length, 1, 'token must be cached');
    assert.equal(msgCalls.length, 2, 'both sends must hit /im/v1/messages');
  });

  test('3. error isolation: fetch throw → { ok: false, error }; no throw to caller', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:443');
    };
    const r = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_xxx', text: 'hi' },
      config: { resolver: fakeResolver, fetchImpl },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /ECONNREFUSED|send failed|tenant/i);
  });

  test('4. error path: im/v1/messages non-zero code → ok:false, no throw', async () => {
    const badMsg = {
      ok: true,
      status: 200,
      json: async () => ({ code: 230020, msg: 'user not found' }),
      text: async () => '{"code":230020,"msg":"user not found"}',
    };
    const fetchImpl = makeFetch({ queue: [tokenOk, badMsg] });
    const r = await feishu.execute({
      action: 'send',
      payload: { receive_id: 'ou_missing', text: 'hi' },
      config: { resolver: fakeResolver, fetchImpl },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /230020|user not found/);
  });

  test('5. catalogue closure: addToCatalogue records the feishu-send-real marker (sandboxed)', () => {
    const isolatedFile = join(tmp, 'catalogue-c1-feishu-send.json');
    const a = addToCatalogue('platforms', 'feishu-send-real', {
      reason: 'V5 cycle 1 P2: feishu adapter send real IM v1 wire + tenant_access_token',
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(a, true, 'first add must return true');
    const b = addToCatalogue('platforms', 'feishu-send-real', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
    });
    assert.equal(b, false, 'duplicate add must return false (idempotent)');
  });
});
