/**
 * ProtocolBase tests — TDD red→green for PR 7.
 *
 * ProtocolBase is the concrete base class for IProtocol implementations.
 * It centralizes: event emission (BEFORE/AFTER/ERROR), error wrapping
 * via ErrorHandler, and never-throw semantics.
 *
 * v1 lesson: v0.25 飞书 bug had silent swallow of tool errors. v2
 * surfaces them as structured events + entries.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { ProtocolBase } from '../provider/protocol/base.js';
import { EVENTS } from '../core/events.js';

describe('ProtocolBase — construction', () => {
  test('throws without eventBus', () => {
    assert.throws(() => new ProtocolBase({ name: 'x' }), /eventBus/);
  });

  test('exposes name + default protocol kind', () => {
    const bus = new EventBus();
    const p = new ProtocolBase({ name: 'openai-compatible', eventBus: bus });
    assert.equal(p.name, 'openai-compatible');
    assert.equal(typeof p.kind, 'string');
  });
});

describe('ProtocolBase — buildRequest (happy path)', () => {
  let bus, p, events;
  beforeEach(() => {
    bus = new EventBus();
    p = new ProtocolBase({ name: 'openai-compatible', eventBus: bus });
    events = [];
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, (e) => events.push(['before', e]));
    bus.on(EVENTS.PROVIDER_CALL_AFTER, (e) => events.push(['after', e]));
    bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => events.push(['error', e]));
  });

  test('returns ok entry with payload', async () => {
    p._doBuildRequest = () => ({ url: '/x', body: { hi: 1 } });
    const entry = await p.buildRequest([{ role: 'user', content: 'hi' }], {}, 'm');
    assert.equal(entry.ok, true);
    assert.deepEqual(entry.value, { url: '/x', body: { hi: 1 } });
  });

  test('emits BEFORE then AFTER (in that order)', async () => {
    p._doBuildRequest = () => ({ ok: true });
    await p.buildRequest([], {}, 'm');
    assert.equal(events.length, 2);
    assert.equal(events[0][0], 'before');
    assert.equal(events[1][0], 'after');
    assert.equal(events[0][1].protocol, 'openai-compatible');
    assert.equal(events[0][1].phase, 'buildRequest');
    assert.equal(events[0][1].traceId, events[1][1].traceId);
  });
});

describe('ProtocolBase — buildRequest (error path, never throws)', () => {
  let bus, p, events;
  beforeEach(() => {
    bus = new EventBus();
    p = new ProtocolBase({ name: 'openai-compatible', eventBus: bus });
    events = [];
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, () => events.push('before'));
    bus.on(EVENTS.PROVIDER_CALL_AFTER, () => events.push('after'));
    bus.on(EVENTS.PROVIDER_CALL_ERROR, (e) => events.push(['error', e]));
  });

  test('catches sync throw → structured entry, emits ERROR', async () => {
    p._doBuildRequest = () => {
      throw new Error('boom');
    };
    const entry = await p.buildRequest([], {}, 'm');
    assert.equal(entry.ok, false);
    assert.equal(entry.error.message, 'boom');
    assert.deepEqual(events, ['before', ['error', events[1]?.[1]]]);
    // before + error (no after)
    assert.equal(events.length, 2);
  });

  test('catches async reject → structured entry', async () => {
    p._doBuildRequest = async () => {
      throw new Error('async-boom');
    };
    const entry = await p.buildRequest([], {}, 'm');
    assert.equal(entry.ok, false);
    assert.match(entry.error.message, /async-boom/);
  });
});

describe('ProtocolBase — parseResponse / parseStreamChunk', () => {
  let bus, p;
  beforeEach(() => {
    bus = new EventBus();
    p = new ProtocolBase({ name: 'openai-compatible', eventBus: bus });
  });

  test('parseResponse returns ok entry from _doParseResponse', async () => {
    p._doParseResponse = () => ({ content: 'hi', toolCalls: [] });
    const e = await p.parseResponse({ raw: 1 });
    assert.equal(e.ok, true);
    assert.equal(e.value.content, 'hi');
  });

  test('parseStreamChunk returns ok entry from _doParseStreamChunk', async () => {
    p._doParseStreamChunk = () => ({ delta: 'h' });
    const e = await p.parseStreamChunk('data: x');
    assert.equal(e.ok, true);
    assert.equal(e.value.delta, 'h');
  });
});

describe('ProtocolBase — default _do* throw not-implemented (override required)', () => {
  test('_doBuildRequest default throws "not implemented"', async () => {
    const bus = new EventBus();
    const p = new ProtocolBase({ name: 'x', eventBus: bus });
    const e = await p.buildRequest([], {}, 'm');
    assert.equal(e.ok, false);
    assert.match(e.error.message, /not implemented/);
  });
});

describe('ProtocolBase — one error must not break sibling emissions', () => {
  test('async event handler throw does not break the bus', async () => {
    const bus = new EventBus();
    const p = new ProtocolBase({ name: 'x', eventBus: bus });
    let afterSeen = false;
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, async () => {
      throw new Error('handler-boom');
    });
    bus.on(EVENTS.PROVIDER_CALL_AFTER, () => {
      afterSeen = true;
    });
    p._doBuildRequest = () => ({ ok: 1 });
    const e = await p.buildRequest([], {}, 'm');
    assert.equal(e.ok, true);
    // afterSeen will be true because the async handler error is isolated
    // by EventBus itself; the protocol still emits AFTER.
    assert.equal(afterSeen, true);
  });
});
