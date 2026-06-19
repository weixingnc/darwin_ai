/**
 * feishu-card e2e — V7 cycle 1 P2-ext 展示面升级 (2026-06-19).
 *
 * Three-part round-trip:
 *   (a) feishu-card skill — direct buildCard() + execute() on apply:after,
 *       audit, and overrides. Mechanical stub (ADR-009), no LLM.
 *   (b) plugin/feishu-notify — fake eventBus emit 'evolution:apply:after'
 *       + 'evolution:audit', stub feishu adapter injected via
 *       ctx.adapters.feishu, assert stub received a card (object, NOT
 *       text) with header.template colour matching the topic/outcome.
 *   (c) platform/feishu send — fetchImpl stub, payload={receive_id,card},
 *       assert fetchImpl got body.msg_type='interactive' and
 *       body.content is JSON.stringify(card). Mirrors V5 cycle 1
 *       send-e2e shape, exercises the V7.1 card path end-to-end.
 *
 * Catalogue closure (F-28/T7-W1 lesson): no real catalogue pollution.
 * addToCatalogue uses isolatedFile + _internal.LOG_FILE sandbox.
 *
 * LLM gate (ADR-009): stub adapter in plugin test, fetchImpl in
 * platform test, no real network anywhere. Skill is a deterministic
 * mechanical builder, no LLM.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventBus } from '../../core/event-bus.js';
import { feishu as feishuAdapter, _resetTokenCache } from '../../platform/feishu.js';
import feishuNotify from '../../plugin/feishu-notify.js';
import { feishuCard, buildCard } from '../../skill/examples/feishu-card.js';
import { addToCatalogue, _internal } from '../../evolution/catalogue.js';

// ─── (a) feishu-card skill unit (3 cases) ──────────────────────
describe('feishu-card e2e (a) — skill round-trip', () => {
  test('apply:after → green card with subject + tag fields, JSON round-trip', () => {
    const r = buildCard({
      topic: 'evolution:apply:after',
      payload: { subject: 'V7.1', tag: 'tag-v7c1' },
    });
    assert.equal(r.theme, 'green');
    assert.equal(typeof r.card, 'object');
    assert.equal(r.card.header.template, 'green');
    assert.equal(r.card.header.title.content, 'V7.1');
    assert.ok(r.card.elements.length >= 3, 'divider + div + note');
    const fields = r.card.elements.find((e) => e.tag === 'div').fields;
    const all = fields.map((f) => f.text.content).join(' | ');
    assert.match(all, /subject: V7\.1/);
    assert.match(all, /tag: tag-v7c1/);
    // output is JSON.stringify(card) — reparse must equal card.
    assert.deepEqual(JSON.parse(r.output), r.card);
  });

  test('audit warn / error / commit / unknown → orange / red / green / blue', () => {
    const mk = (outcome) =>
      buildCard({
        topic: 'evolution:audit',
        payload: { proposal_id: 'p', action: 'a', outcome },
      });
    assert.equal(mk('warn').theme, 'orange');
    assert.equal(mk('error').theme, 'red');
    assert.equal(mk('commit').theme, 'green');
    assert.equal(mk('whatever').theme, 'blue');
  });

  test('options.theme override + empty payload (no throw) + skill.execute context.options forward', async () => {
    const override = buildCard(
      { topic: 'evolution:apply:after', payload: { subject: 'x' } },
      { theme: 'red' },
    );
    assert.equal(override.theme, 'red');
    const empty = buildCard({ topic: 'evolution:apply:after', payload: {} });
    assert.equal(empty.theme, 'green');
    const viaExecute = await feishuCard.execute(
      { topic: 'evolution:apply:after', subject: 'x' },
      { options: { theme: 'orange' } },
    );
    assert.equal(viaExecute.theme, 'orange');
  });
});

// ─── (b) plugin/feishu-notify — card over the wire ──────────────
describe('feishu-card e2e (b) — plugin/feishu-notify pushes card', () => {
  let bus;
  beforeEach(() => {
    bus = new EventBus();
    if (feishuNotify._handlers) {
      feishuNotify.destroy();
    }
  });

  function stubFeishu() {
    const calls = [];
    return {
      stub: {
        async execute({ action, payload, config }) {
          calls.push({ action, payload, config });
          return { ok: true, messageId: 'om_stub' };
        },
      },
      calls,
    };
  }

  test('apply:after → stub receives payload.card (object) with green header + 3 elements', async () => {
    const { stub, calls } = stubFeishu();
    feishuNotify.init({
      eventBus: bus,
      config: { target: 'ou_e2e_user' },
      adapters: { feishu: stub },
    });
    bus.emit('evolution:apply:after', { subject: 'V7.1 e2e', tag: 'v7-c1' });
    await new Promise((r) => setImmediate(r));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'send');
    // V7 cycle 1: card is the body, NOT text.
    assert.equal(typeof calls[0].payload.receive_id, 'string');
    assert.equal(typeof calls[0].payload.card, 'object');
    assert.equal(calls[0].payload.card.header.template, 'green');
    assert.ok(calls[0].payload.card.elements.length >= 3);
    feishuNotify.destroy();
  });

  test('audit (commit/warn/error) → card header colour matches outcome (green/orange/red)', async () => {
    for (const [outcome, expected] of [
      ['commit', 'green'],
      ['warn', 'orange'],
      ['error', 'red'],
    ]) {
      if (feishuNotify._handlers) {
        feishuNotify.destroy();
      }
      const { stub, calls } = stubFeishu();
      feishuNotify.init({
        eventBus: bus,
        config: { target: 'ou_user' },
        adapters: { feishu: stub },
      });
      bus.emit('evolution:audit', { proposal_id: 'p', action: 'a', outcome });
      await new Promise((r) => setImmediate(r));
      assert.equal(calls[0].payload.card.header.template, expected, `outcome=${outcome}`);
    }
    feishuNotify.destroy();
  });

  test('stub returns {ok:false,error} → plugin logs to stderr, NEVER throws (A-5)', async () => {
    const stub = {
      async execute() {
        return { ok: false, error: 'feishu: code=99999' };
      },
    };
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => {
      stderrChunks.push(String(c));
      return true;
    };
    try {
      feishuNotify.init({
        eventBus: bus,
        config: { target: 'ou_user' },
        adapters: { feishu: stub },
      });
      bus.emit('evolution:apply:after', { subject: 'failure path' });
      await new Promise((r) => setImmediate(r));
      assert.match(stderrChunks.join(''), /push failed: feishu: code=99999/);
    } finally {
      process.stderr.write = origWrite;
      feishuNotify.destroy();
    }
  });
});

// ─── (c) platform/feishu — send-card e2e ────────────────────────
describe('feishu-card e2e (c) — platform/feishu send with payload.card', () => {
  const fakeResolver = { get: () => ({ appId: 'cli_test', appSecret: 'secret_test' }) };

  beforeEach(() => {
    _resetTokenCache();
  });

  function makeFetchMock() {
    const calls = [];
    const tokenRes = {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, tenant_access_token: 't-v7c1', expire: 7200 }),
      text: async () => '{}',
    };
    const msgRes = {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { message_id: 'om_card_v7c1' } }),
      text: async () => '{}',
    };
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

  test('payload.card → token call + im/v1/messages with msg_type=interactive + content=JSON.stringify(card)', async () => {
    const { fetchMock, calls } = makeFetchMock();
    const card = buildCard({
      topic: 'evolution:apply:after',
      payload: { subject: 'V7.1 e2e', tag: 'v7-c1' },
    }).card;

    const r = await feishuAdapter.execute({
      action: 'send',
      payload: { receive_id: 'ou_e2e_user', card },
      config: { resolver: fakeResolver, fetchImpl: fetchMock },
    });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'om_card_v7c1');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/auth\/v3\/tenant_access_token\/internal$/);
    assert.match(calls[1].url, /\/im\/v1\/messages\?receive_id_type=open_id$/);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.receive_id, 'ou_e2e_user');
    assert.equal(body.msg_type, 'interactive');
    // content is the card, not the legacy {"text":"…"}.
    const content = JSON.parse(body.content);
    assert.equal(content.header.template, 'green');
    assert.equal(content.header.title.content, 'V7.1 e2e');
  });

  test('card with no elements still passes (interactive header alone) → ok:true', async () => {
    const { fetchMock, calls } = makeFetchMock();
    const card = { header: { title: { tag: 'plain_text', content: 'min' }, template: 'blue' } };
    const r = await feishuAdapter.execute({
      action: 'send',
      payload: { receive_id: 'ou_user', card },
      config: { resolver: fakeResolver, fetchImpl: fetchMock },
    });
    assert.equal(r.ok, true);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.msg_type, 'interactive');
  });
});

// ─── (d) catalogue closure (T7-W1 sandbox pattern) ─────────────
describe('feishu-card e2e (d) — catalogue closure', () => {
  test('addToCatalogue(skills, feishu-card, sandboxed) → true; duplicate → false', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c1-feishu-card-'));
    const isolatedFile = join(tmp, 'catalogue-c1-feishu-card.json');

    const first = addToCatalogue('skills', 'feishu-card', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
      reason: 'V7 cycle 1 P2-ext: feishu interactive card for evolution events',
    });
    assert.equal(first, true);

    const second = addToCatalogue('skills', 'feishu-card', {
      file: isolatedFile,
      logFile: _internal.LOG_FILE,
      reason: 'V7 cycle 1 P2-ext: feishu interactive card for evolution events (replay)',
    });
    // Idempotent: second add returns false.
    assert.equal(second, false);
  });
});
