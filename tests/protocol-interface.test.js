/**
 * IProtocol contract tests — TDD red→green for PR 7.
 *
 * IProtocol is the contract for wire-format protocols (openai-compatible,
 * anthropic, etc.). It is INDEPENDENT of IProvider — protocol layer
 * does not know about provider classes.
 *
 * v1 lesson: tool-call format was hard-coded inside provider; v2 isolates
 * it behind a protocol interface.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IProtocol } from '../provider/protocol/interface.js';

describe('IProtocol — shape', () => {
  test('exposes name sentinel + 6 method stubs + 1 validator', () => {
    assert.equal(typeof IProtocol.name, 'string');
    assert.equal(IProtocol.name, '');
    assert.equal(typeof IProtocol.buildRequest, 'function');
    assert.equal(typeof IProtocol.parseResponse, 'function');
    assert.equal(typeof IProtocol.parseStreamChunk, 'function');
    assert.equal(typeof IProtocol.buildToolCallMessage, 'function');
    assert.equal(typeof IProtocol.parseToolCallDelta, 'function');
    assert.equal(typeof IProtocol.validate, 'function');
  });
});

describe('IProtocol.validate — accepts well-formed protocols', () => {
  test('accepts a valid openai-compatible-like protocol', () => {
    const proto = {
      name: 'openai-compatible',
      buildRequest: (m, o, model) => ({
        url: '/chat/completions',
        body: { messages: m, ...o, model },
      }),
      parseResponse: (r) => ({ content: r.choices?.[0]?.message?.content ?? '', toolCalls: [] }),
      parseStreamChunk: () => ({ delta: '' }),
      buildToolCallMessage: (tc, result) => ({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      }),
      parseToolCallDelta: () => null,
    };
    const r = IProtocol.validate(proto);
    assert.deepEqual(r, { ok: true });
  });
});

describe('IProtocol.validate — rejects malformed protocols', () => {
  test('rejects non-object', () => {
    assert.throws(() => IProtocol.validate(null), /object/);
    assert.throws(() => IProtocol.validate('x'), /object/);
    assert.throws(() => IProtocol.validate(42), /object/);
  });

  test('rejects empty name', () => {
    const bad = {
      name: '',
      buildRequest: () => {},
      parseResponse: () => {},
      parseStreamChunk: () => {},
      buildToolCallMessage: () => {},
      parseToolCallDelta: () => {},
    };
    assert.throws(() => IProtocol.validate(bad), /name/);
  });

  test('rejects non-string name', () => {
    const bad = {
      name: 42,
      buildRequest: () => {},
      parseResponse: () => {},
      parseStreamChunk: () => {},
      buildToolCallMessage: () => {},
      parseToolCallDelta: () => {},
    };
    assert.throws(() => IProtocol.validate(bad), /name/);
  });

  test('rejects missing buildRequest', () => {
    const bad = {
      name: 'x',
      parseResponse: () => {},
      parseStreamChunk: () => {},
      buildToolCallMessage: () => {},
      parseToolCallDelta: () => {},
    };
    assert.throws(() => IProtocol.validate(bad), /buildRequest/);
  });

  test('rejects non-function methods', () => {
    const bad = {
      name: 'x',
      buildRequest: 'no',
      parseResponse: () => {},
      parseStreamChunk: () => {},
      buildToolCallMessage: () => {},
      parseToolCallDelta: () => {},
    };
    assert.throws(() => IProtocol.validate(bad), /buildRequest/);
  });
});

describe('IProtocol — independence from IProvider', () => {
  test('protocol module does not import provider/base or registry', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../provider/protocol/interface.js', import.meta.url),
      'utf8',
    );
    assert.equal(/provider\/base/.test(src), false, 'must not import provider/base');
    assert.equal(/provider\/registry/.test(src), false, 'must not import provider/registry');
  });
});
