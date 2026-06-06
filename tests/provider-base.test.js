/**
 * ProviderBase tests — TDD red→green for PR 6.
 * Key coverage: event order (BEFORE/AFTER/ERROR), error isolation, never-throw.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/event-bus.js';
import { ProviderBase } from '../provider/base.js';
import { EVENTS } from '../core/events.js';

describe('ProviderBase — construction', () => {
  test('throws without eventBus', () => {
    assert.throws(() => new ProviderBase({ name: 'x' }), /eventBus/);
  });

  test('exposes name + capabilities; defaults caps to ["chat"]', () => {
    const bus = new EventBus();
    const a = new ProviderBase({ name: 'a', capabilities: ['chat', 'embed'], eventBus: bus });
    const b = new ProviderBase({ name: 'b', eventBus: bus });
    assert.equal(a.name, 'a');
    assert.deepEqual(a.capabilities, ['chat', 'embed']);
    assert.deepEqual(b.capabilities, ['chat']);
  });
});

describe('ProviderBase — chat() event order + error isolation', () => {
  let bus;
  beforeEach(() => {
    bus = new EventBus();
  });

  test('successful chat emits BEFORE then AFTER with matching traceId', async () => {
    const order = [];
    let beforeP, afterP;
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, (p) => {
      order.push('B');
      beforeP = p;
    });
    bus.on(EVENTS.PROVIDER_CALL_AFTER, (p) => {
      order.push('A');
      afterP = p;
    });
    class Stub extends ProviderBase {
      async _doChat() {
        return { content: 'hi', usage: { t: 1 }, raw: null };
      }
    }
    const r = await new Stub({ name: 'stub', eventBus: bus }).chat([
      { role: 'user', content: 'x' },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'hi');
    assert.deepEqual(order, ['B', 'A']);
    assert.equal(beforeP.traceId, afterP.traceId);
    assert.equal(beforeP.provider, 'stub');
    assert.deepEqual(afterP.usage, { t: 1 });
  });

  test('chat throw → emits PROVIDER_CALL_ERROR + NEVER rethrows (returns ok:false)', async () => {
    const errored = [];
    bus.on(EVENTS.PROVIDER_CALL_ERROR, (p) => errored.push(p));
    class Boom extends ProviderBase {
      async _doChat() {
        throw new Error('upstream-down');
      }
    }
    const r = await new Boom({ name: 'boom', eventBus: bus }).chat([
      { role: 'user', content: 'x' },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.error.message, 'upstream-down');
    assert.equal(errored.length, 1);
    assert.equal(errored[0].error.message, 'upstream-down');
    assert.equal(errored[0].provider, 'boom');
  });

  test('async handler error on BEFORE does not block AFTER or result', async () => {
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, async () => {
      throw new Error('handler-bug');
    });
    let afterFired = false;
    bus.on(EVENTS.PROVIDER_CALL_AFTER, () => {
      afterFired = true;
    });
    class Stub extends ProviderBase {
      async _doChat() {
        return { content: 'ok', usage: {}, raw: null };
      }
    }
    const r = await new Stub({ name: 'x', eventBus: bus }).chat([{ role: 'user', content: 'y' }]);
    assert.equal(r.ok, true);
    assert.equal(r.value.content, 'ok');
    assert.equal(afterFired, true);
  });
});

describe('ProviderBase — listModels default', () => {
  test('default listModels() returns {ok:true, value:[]}', async () => {
    const p = new ProviderBase({ name: 'x', eventBus: new EventBus() });
    const r = await p.listModels();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, []);
  });

  test('embed() wraps _doEmbed; success path emits BEFORE+AFTER', async () => {
    const bus = new EventBus();
    const fired = [];
    bus.on(EVENTS.PROVIDER_CALL_BEFORE, () => fired.push('B'));
    bus.on(EVENTS.PROVIDER_CALL_AFTER, () => fired.push('A'));
    class Emb extends ProviderBase {
      async _doEmbed(t) {
        return [[0.1, 0.2, t.length]];
      }
    }
    const r = await new Emb({ name: 'emb', eventBus: bus }).embed('hi');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, [[0.1, 0.2, 2]]);
    assert.deepEqual(fired, ['B', 'A']);
  });
});
